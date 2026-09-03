import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource, type EntityManager } from 'typeorm';

import { PasswordService } from '../../../common/cripto/password.service';
import { fila } from '../../../common/db/filas';
import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { ENTORNO, type Entorno } from '../../../config/env';
import type { CtxPlataforma } from '../../../common/ctx';
import type {
  CrearCuentaDto,
  CrearEmpresaEnCuentaDto,
  CrearUsuarioEnCuentaDto,
  EditarCuentaDto,
} from '../dto/cuentas.dto';

export interface ResumenCuenta {
  id: string;
  nombre: string;
  slug: string;
  plan: string;
  estado: string;
  maxEmpresas: number;
  maxUsuarios: number;
  empresas: number;
  usuarios: number;
  creadoEn: string;
}

/**
 * La administración del producto.
 *
 * Todo pasa por la conexión de aprovisionamiento, que se salta RLS. Es lo que
 * permite ver las cuentas de todos los clientes, y también lo que hace de este
 * servicio la superficie más delicada del sistema. Por eso el alcance está
 * cerrado por diseño:
 *
 *  - solo toca `tenant`, `empresa`, `usuario` y sus permisos;
 *  - no lee ni una tabla contable —ni asientos, ni facturas, ni terceros—;
 *  - no puede emitir un token con empresa, así que no hay puerta hacia esos datos;
 *  - todo lo que cambia queda en `plataforma_bitacora`.
 *
 * Autenticar tampoco es asunto suyo: el login es uno solo y lo resuelve `nucleo`
 * contra `plataforma_admin`, que no lleva RLS y no necesita esta conexión.
 */
@Injectable()
export class CuentasService {
  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
    @Inject(ENTORNO) private readonly env: Entorno,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {}

  // -------------------------------------------------------------------------
  // Cuentas
  // -------------------------------------------------------------------------

  async listar(q?: string): Promise<ResumenCuenta[]> {
    const filtro = q && q.trim() !== '' ? `%${q.trim()}%` : null;

    const filas = await this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT t.id, t.nombre, t.slug, t.plan, t.estado,
              t.max_empresas, t.max_usuarios, t.creado_en,
              (SELECT count(*)::int FROM empresa e WHERE e.tenant_id = t.id AND e.activo) AS empresas,
              (SELECT count(*)::int FROM usuario u WHERE u.tenant_id = t.id AND u.activo)  AS usuarios
         FROM tenant t
        WHERE $1::text IS NULL
           OR fn_normalizar(t.nombre) LIKE fn_normalizar($1)
           OR t.slug ILIKE $1
        ORDER BY t.creado_en DESC`,
      [filtro],
    );

    return filas.map((f) => this.mapear(f));
  }

  async detalle(id: string) {
    const ds = this.conexion();

    const [cuenta] = await ds.query(
      `SELECT t.id, t.nombre, t.slug, t.plan, t.estado, t.max_empresas, t.max_usuarios, t.creado_en,
              (SELECT count(*)::int FROM empresa e WHERE e.tenant_id = t.id AND e.activo) AS empresas,
              (SELECT count(*)::int FROM usuario u WHERE u.tenant_id = t.id AND u.activo)  AS usuarios
         FROM tenant t WHERE t.id = $1`,
      [id],
    );

    if (cuenta === undefined) {
      throw new NotFoundException('Cuenta no encontrada');
    }

    const empresas = await ds.query(
      `SELECT e.id, e.razon_social, e.nit, e.dv, e.activo,
              COALESCE((SELECT array_agg(s.sector ORDER BY s.sector)
                          FROM empresa_sector s WHERE s.empresa_id = e.id),
                       ARRAY[]::text[]) AS sectores,
              cc.grupo_niif,
              (SELECT count(*)::int FROM empresa_sede s WHERE s.empresa_id = e.id AND s.activo) AS sedes
         FROM empresa e
         LEFT JOIN empresa_configuracion_contable cc ON cc.empresa_id = e.id
        WHERE e.tenant_id = $1
        ORDER BY e.razon_social`,
      [id],
    );

    const usuarios = await ds.query(
      `SELECT u.id, u.email, u.nombre_completo, u.activo, u.ultimo_acceso_en,
              (SELECT count(*)::int > 0 FROM usuario_rol_tenant urt
                WHERE urt.usuario_id = u.id AND urt.revocado_en IS NULL) AS es_admin,
              COALESCE(
                (SELECT array_agg(DISTINCT uer.rol_codigo)
                   FROM usuario_empresa_rol uer
                  WHERE uer.usuario_id = u.id AND uer.revocado_en IS NULL),
                ARRAY[]::text[]
              ) AS roles
         FROM usuario u
        WHERE u.tenant_id = $1
        ORDER BY u.nombre_completo`,
      [id],
    );

    const bitacora = await ds.query(
      `SELECT b.accion, b.detalle, b.ocurrido_en, a.nombre_completo AS admin
         FROM plataforma_bitacora b
         JOIN plataforma_admin a ON a.id = b.admin_id
        WHERE b.tenant_id = $1
        ORDER BY b.ocurrido_en DESC
        LIMIT 20`,
      [id],
    );

    return { cuenta: this.mapear(cuenta), empresas, usuarios, bitacora };
  }

  /**
   * Crea la cuenta y su primer usuario. Nada más.
   *
   * De la empresa no se pregunta nada: el NIT, el marco NIIF y la fecha de inicio
   * de operaciones los sabe el contador del cliente, no quien vende el sistema.
   * El director la crea cuando entra, y ahí queda como su DIRECTOR.
   */
  async crearCuenta(admin: CtxPlataforma, dto: CrearCuentaDto) {
    const hash = await this.passwords.hashear(dto.password);
    const local = dto.email.split('@')[0];
    const nombre = dto.nombreAdministrador ?? local;

    return this.conexion().transaction(async (t) => {
      const [tenant] = await t.query<Array<{ id: string }>>(
        `INSERT INTO tenant (nombre, slug, plan, max_empresas, max_usuarios)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          nombre,
          await this.slugLibre(t, local),
          dto.plan ?? 'BASICO',
          dto.maxEmpresas ?? 1,
          dto.maxUsuarios ?? 3,
        ],
      );

      const [usuario] = await t.query<Array<{ id: string }>>(
        `INSERT INTO usuario (tenant_id, email, nombre_completo, hash_password)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.id, dto.email, nombre, hash],
      );

      // ADMIN_TENANT y no DIRECTOR: `DIRECTOR` se ejerce dentro de una
      // contabilidad y todavía no hay ninguna. Lo recibirá automáticamente sobre
      // la empresa que cree, que es cuando el rol significa algo.
      await t.query(
        `INSERT INTO usuario_rol_tenant (usuario_id, rol_codigo, tenant_id)
         VALUES ($1, 'ADMIN_TENANT', $2)`,
        [usuario.id, tenant.id],
      );

      await this.registrar(t, admin, 'CREAR_CUENTA', tenant.id, {
        email: dto.email,
      });

      return { tenantId: tenant.id, usuarioId: usuario.id, email: dto.email };
    });
  }

  /**
   * Un identificador libre a partir del correo.
   *
   * El slug es único y visible en la URL del cliente, pero no es un dato que
   * quien vende deba inventar: dos clientes con el mismo correo local —"contacto",
   * "admin"— chocarían, así que el segundo lleva sufijo.
   */
  private async slugLibre(t: EntityManager, local: string): Promise<string> {
    const base =
      local
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'cuenta';

    for (let intento = 0; intento < 50; intento += 1) {
      const candidato = intento === 0 ? base : `${base}-${intento + 1}`;
      // El slug exige al menos tres caracteres.
      const propuesto =
        candidato.length >= 3 ? candidato : `${candidato}-cuenta`;
      const filas = await t.query('SELECT 1 FROM tenant WHERE slug = $1', [
        propuesto,
      ]);
      if (filas.length === 0) return propuesto;
    }
    return `${base}-${Date.now()}`;
  }

  async editar(admin: CtxPlataforma, id: string, dto: EditarCuentaDto) {
    return this.conexion().transaction(async (t) => {
      const editada = fila<Record<string, unknown>>(
        await t.query(
          `UPDATE tenant SET
            plan         = COALESCE($2, plan),
            estado       = COALESCE($3, estado),
            max_empresas = COALESCE($4, max_empresas),
            max_usuarios = COALESCE($5, max_usuarios)
          WHERE id = $1
          RETURNING *`,
          [
            id,
            dto.plan ?? null,
            dto.estado ?? null,
            dto.maxEmpresas ?? null,
            dto.maxUsuarios ?? null,
          ],
        ),
      );

      if (editada === undefined) {
        throw new NotFoundException('Cuenta no encontrada');
      }

      await this.registrar(
        t,
        admin,
        dto.estado ? 'CAMBIAR_ESTADO' : 'CAMBIAR_PLAN',
        id,
        { ...dto },
      );

      return editada;
    });
  }

  // -------------------------------------------------------------------------
  // Empresas y usuarios dentro de una cuenta
  // -------------------------------------------------------------------------

  async crearEmpresa(
    admin: CtxPlataforma,
    tenantId: string,
    dto: CrearEmpresaEnCuentaDto,
  ) {
    return this.conexion().transaction(async (t) => {
      await this.verificarCupoEmpresas(t, tenantId);

      // El acceso lo recibe el administrador de la cuenta: si la empresa naciera
      // sin nadie que pueda entrar, habría que ir a arreglarla a mano.
      const [duenio] = await t.query<Array<{ id: string }>>(
        `SELECT u.id FROM usuario u
           JOIN usuario_rol_tenant urt ON urt.usuario_id = u.id AND urt.revocado_en IS NULL
          WHERE u.tenant_id = $1 AND u.activo
          ORDER BY u.creado_en
          LIMIT 1`,
        [tenantId],
      );

      if (duenio === undefined) {
        throw new BadRequestException(
          'La cuenta no tiene un administrador activo',
        );
      }

      const empresaId = await this.insertarEmpresa(t, tenantId, duenio.id, dto);
      await this.registrar(t, admin, 'CREAR_EMPRESA', tenantId, {
        razonSocial: dto.razonSocial,
        nit: dto.nit,
      });

      return { empresaId };
    });
  }

  async crearUsuario(
    admin: CtxPlataforma,
    tenantId: string,
    dto: CrearUsuarioEnCuentaDto,
  ) {
    const hash = await this.passwords.hashear(dto.password);

    return this.conexion().transaction(async (t) => {
      const [cupo] = await t.query<
        Array<{ max_usuarios: number; usados: string }>
      >(
        `SELECT t.max_usuarios,
                (SELECT count(*) FROM usuario u WHERE u.tenant_id = t.id AND u.activo) AS usados
           FROM tenant t WHERE t.id = $1`,
        [tenantId],
      );

      if (cupo === undefined) {
        throw new NotFoundException('Cuenta no encontrada');
      }
      if (Number(cupo.usados) >= cupo.max_usuarios) {
        throw new BadRequestException(
          `El plan permite ${cupo.max_usuarios} usuario(s) activo(s).`,
        );
      }

      const [usuario] = await t.query<Array<{ id: string }>>(
        `INSERT INTO usuario (tenant_id, email, nombre_completo, hash_password)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, dto.email, dto.nombreCompleto, hash],
      );

      if (dto.esAdminCuenta === true) {
        await t.query(
          `INSERT INTO usuario_rol_tenant (usuario_id, rol_codigo, tenant_id)
           VALUES ($1, 'ADMIN_TENANT', $2)`,
          [usuario.id, tenantId],
        );
      }

      if (dto.empresaId && dto.rol) {
        await t.query(
          `INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, rol_codigo, tenant_id)
           VALUES ($1, $2, $3, $4)`,
          [usuario.id, dto.empresaId, dto.rol, tenantId],
        );
      }

      await this.registrar(t, admin, 'CREAR_USUARIO', tenantId, {
        email: dto.email,
      });

      return { usuarioId: usuario.id, email: dto.email };
    });
  }

  // -------------------------------------------------------------------------

  private async insertarEmpresa(
    t: EntityManager,
    tenantId: string,
    usuarioId: string,
    e: CrearEmpresaEnCuentaDto,
  ): Promise<string> {
    await this.verificarCupoEmpresas(t, tenantId);

    const [empresa] = await t.query<Array<{ id: string }>>(
      `INSERT INTO empresa
         (tenant_id, tipo_persona, razon_social, nombre_comercial, nit, dv)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenantId,
        e.tipoPersona,
        e.razonSocial,
        e.nombreComercial ?? null,
        e.nit,
        e.dv,
      ],
    );

    // Esta conexion tiene BYPASSRLS, asi que no hace falta fijar app.empresa_id
    // para escribir los sectores. Es la unica que puede hacerlo sin contexto.
    for (const sector of e.sectores ?? []) {
      await t.query(
        'INSERT INTO empresa_sector (empresa_id, sector) VALUES ($1, $2)',
        [empresa.id, sector],
      );
    }

    // Sin configuración contable la empresa no puede recibir un asiento.
    await t.query(
      `INSERT INTO empresa_configuracion_contable (empresa_id, grupo_niif, fecha_inicio_operaciones)
       VALUES ($1, $2, $3)`,
      [empresa.id, e.grupoNiif, e.fechaInicioOperaciones],
    );

    await t.query(
      `INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, rol_codigo, tenant_id)
       VALUES ($1, $2, 'DIRECTOR', $3)
       ON CONFLICT (usuario_id, empresa_id, rol_codigo) DO NOTHING`,
      [usuarioId, empresa.id, tenantId],
    );

    return empresa.id;
  }

  private async verificarCupoEmpresas(
    t: EntityManager,
    tenantId: string,
  ): Promise<void> {
    const [cupo] = await t.query<
      Array<{ max_empresas: number; usadas: string }>
    >(
      `SELECT t.max_empresas,
              (SELECT count(*) FROM empresa e WHERE e.tenant_id = t.id AND e.activo) AS usadas
         FROM tenant t WHERE t.id = $1`,
      [tenantId],
    );
    if (cupo === undefined) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    if (Number(cupo.usadas) >= cupo.max_empresas) {
      throw new BadRequestException(
        `El plan permite ${cupo.max_empresas} empresa(s). Ampliar el plan primero.`,
      );
    }
  }

  /** El rastro solo agrega. Un registro que se puede reescribir no sirve. */
  private async registrar(
    t: EntityManager,
    admin: CtxPlataforma,
    accion: string,
    tenantId: string | null,
    detalle: Record<string, unknown>,
  ): Promise<void> {
    await t.query(
      `INSERT INTO plataforma_bitacora (admin_id, accion, tenant_id, detalle)
       VALUES ($1, $2, $3, $4)`,
      [admin.adminId, accion, tenantId, JSON.stringify(detalle)],
    );
  }

  private conexion(): DataSource {
    if (this.provision === null) {
      throw new ServiceUnavailableException(
        'Falta configurar DB_PROVISION_USERNAME y DB_PROVISION_PASSWORD.',
      );
    }
    return this.provision;
  }

  private mapear(f: Record<string, unknown>): ResumenCuenta {
    return {
      id: f.id as string,
      nombre: f.nombre as string,
      slug: f.slug as string,
      plan: f.plan as string,
      estado: f.estado as string,
      maxEmpresas: f.max_empresas as number,
      maxUsuarios: f.max_usuarios as number,
      empresas: f.empresas as number,
      usuarios: f.usuarios as number,
      creadoEn: String(f.creado_en),
    };
  }
}
