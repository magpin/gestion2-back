import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import { DataSource, type EntityManager } from 'typeorm';

import { PasswordService } from '../../../common/cripto/password.service';
import { fila } from '../../../common/db/filas';
import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { hoyEnColombia } from '../../../common/fecha';
import type { CtxPlataforma } from '../../../common/ctx';
import { ConsumoIaApi } from '../../consumo-ia/consumo-ia.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type {
  AjustarCuposDto,
  CambiarEstadoDto,
  CambiarPlanDto,
  CrearCuentaDto,
  CrearEmpresaEnCuentaDto,
  CrearUsuarioEnCuentaDto,
} from '../dto/cuentas.dto';
import { contrasenaParaDictar } from '../reglas/contrasena';
import {
  excesoFrente,
  FILTROS,
  listarCuentas,
  ORDENES,
  seleccionar,
  type Cuenta,
  type EstadoCuenta,
  type Filtro,
  type Orden,
  type PaginaCuentas,
  type Seleccion,
} from '../reglas/cuentas';
import { inicioDeMes } from '../reglas/inicio';
import { iso, registrar } from './bitacora';
import { CobrosService } from './cobros.service';

/** El avance de la configuración inicial de una empresa, para la consola. */
export interface AvanceConfiguracion {
  completados: number;
  total: number;
  porcentaje: number;
  completa: boolean;
  /** Los pasos obligatorios que no están listos, por su nombre. */
  pendientes: string[];
}

export interface ConsultaCuentas {
  q?: string;
  filtro?: string;
  orden?: string;
  dir?: string;
  pagina?: string;
}

/**
 * Todas las cuentas con lo que la consola muestra de cada una. Son cientos, no
 * millones: se traen de una vez y se filtran en `reglas/cuentas`.
 */
const SQL_CUENTAS = `
  SELECT t.id, t.nombre, t.slug, t.plan, t.estado,
         t.max_empresas, t.max_usuarios, t.creado_en,
         (SELECT count(*)::int FROM empresa e WHERE e.tenant_id = t.id AND e.activo) AS empresas,
         (SELECT count(*)::int FROM usuario u WHERE u.tenant_id = t.id AND u.activo)  AS usuarios,
         (SELECT max(u.ultimo_acceso_en) FROM usuario u WHERE u.tenant_id = t.id)      AS ultimo_acceso,
         coalesce((SELECT max(b.ocurrido_en) FROM plataforma_bitacora b
                    WHERE b.tenant_id = t.id AND b.accion = 'CAMBIAR_ESTADO'),
                  t.creado_en)                                                         AS estado_desde
    FROM tenant t
   WHERE $1::uuid IS NULL OR t.id = $1::uuid`;

/**
 * La administración del producto.
 *
 * Todo pasa por la conexión de aprovisionamiento, que se salta RLS. Es lo que
 * permite ver las cuentas de todos los clientes, y también lo que hace de este
 * servicio la superficie más delicada del sistema. Por eso el alcance está
 * cerrado por diseño:
 *
 *  - solo escribe en `tenant`, `empresa`, `usuario` y sus permisos;
 *  - no lee ni una tabla contable —ni asientos, ni facturas, ni terceros—. Lo
 *    más cerca que llega es el avance de la configuración, que `nucleo` calcula
 *    con la ficha de la empresa y su plan de cuentas;
 *  - de la IA solo lee cifras, y por `ConsumoIaApi`;
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
    private readonly passwords: PasswordService,
    private readonly nucleo: NucleoApi,
    private readonly consumo: ConsumoIaApi,
    private readonly cobros: CobrosService,
  ) {}

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /** Todas las cuentas, con el gasto de IA del mes. */
  async todas(id: string | null = null): Promise<Cuenta[]> {
    const hoy = hoyEnColombia();
    const [filas, gasto] = await Promise.all([
      this.conexion().query<Array<Record<string, unknown>>>(SQL_CUENTAS, [id]),
      this.consumo.gastoPorEmpresa(inicioDeMes(hoy), hoy, id ?? undefined),
    ]);

    const iaPorCuenta = new Map<string, number>();
    for (const g of gasto) {
      iaPorCuenta.set(
        g.cuentaId,
        (iaPorCuenta.get(g.cuentaId) ?? 0) + g.costoUsd,
      );
    }

    return filas.map((f) => ({
      id: f.id as string,
      nombre: f.nombre as string,
      slug: f.slug as string,
      plan: f.plan as string,
      estado: f.estado as EstadoCuenta,
      maxEmpresas: f.max_empresas as number,
      maxUsuarios: f.max_usuarios as number,
      empresas: f.empresas as number,
      usuarios: f.usuarios as number,
      creadoEn: iso(f.creado_en) as string,
      ultimoAcceso: iso(f.ultimo_acceso),
      estadoDesde: iso(f.estado_desde) as string,
      iaMesUsd: iaPorCuenta.get(f.id as string) ?? 0,
    }));
  }

  async listar(c: ConsultaCuentas): Promise<PaginaCuentas> {
    return listarCuentas(await this.buscadas(c.q), {
      ...seleccionDe(c),
      pagina: Number(c.pagina) || 1,
    });
  }

  /** Las que coinciden con la búsqueda, por nombre o identificador. */
  private async buscadas(texto: string | undefined): Promise<Cuenta[]> {
    const q = normalizar(texto ?? '');
    const todas = await this.todas();
    return q === ''
      ? todas
      : todas.filter(
          (x) => normalizar(x.nombre).includes(q) || x.slug.includes(q),
        );
  }

  /** Las cuentas del filtro, todas y no solo una página, en un Excel. */
  async exportar(c: ConsultaCuentas): Promise<Buffer> {
    const todas = seleccionar(await this.buscadas(c.q), seleccionDe(c));

    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Cuentas');
    hoja.columns = [
      { header: 'Cuenta', key: 'nombre', width: 36 },
      { header: 'Plan', key: 'plan', width: 14 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Empresas', key: 'empresas', width: 10 },
      { header: 'Cupo de empresas', key: 'maxEmpresas', width: 10 },
      { header: 'Usuarios', key: 'usuarios', width: 10 },
      { header: 'Cupo de usuarios', key: 'maxUsuarios', width: 10 },
      { header: 'IA del mes (US$)', key: 'iaMesUsd', width: 14 },
      { header: 'Último acceso', key: 'ultimoAcceso', width: 18 },
      { header: 'Alta', key: 'creadoEn', width: 12 },
    ];
    hoja.getRow(1).font = { bold: true };
    for (const x of todas) {
      hoja.addRow({
        ...x,
        iaMesUsd: Math.round(x.iaMesUsd * 100) / 100,
        ultimoAcceso: x.ultimoAcceso ? new Date(x.ultimoAcceso) : null,
        creadoEn: new Date(x.creadoEn),
      });
    }
    hoja.getColumn('iaMesUsd').numFmt = '#,##0.00';
    hoja.getColumn('ultimoAcceso').numFmt = 'dd/mm/yyyy hh:mm';
    hoja.getColumn('creadoEn').numFmt = 'dd/mm/yyyy';
    return Buffer.from(await libro.xlsx.writeBuffer());
  }

  async detalle(id: string) {
    const ds = this.conexion();
    const [cuenta] = await this.todas(id);
    if (cuenta === undefined) {
      throw new NotFoundException('Cuenta no encontrada');
    }

    const hoy = hoyEnColombia();
    const [empresas, usuarios, bitacora, plan, gasto] = await Promise.all([
      ds.query<Array<Record<string, unknown>>>(
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
      ),
      ds.query<Array<Record<string, unknown>>>(
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
          ORDER BY u.activo DESC, u.nombre_completo`,
        [id],
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT b.id, b.accion, b.detalle, b.ocurrido_en, coalesce(a.nombre_completo, 'El sistema') AS admin
           FROM plataforma_bitacora b
           LEFT JOIN plataforma_admin a ON a.id = b.admin_id
          WHERE b.tenant_id = $1
          ORDER BY b.ocurrido_en DESC
          LIMIT 20`,
        [id],
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT clave, nombre, max_empresas, max_usuarios, precio_mensual, tope_ia_usd, al_llegar_tope
           FROM plan_catalogo WHERE clave = $1`,
        [cuenta.plan],
      ),
      this.consumo.gastoPorEmpresa(inicioDeMes(hoy), hoy, id),
    ]);

    const iaDe = new Map(gasto.map((g) => [g.empresaId, g.costoUsd]));
    const avances = await Promise.all(
      empresas.map((e) => this.avance(e.id as string)),
    );

    const cobro = (await this.cobros.resumenes(hoy)).get(id) ?? null;

    return {
      cuenta,
      plan: plan[0] === undefined ? null : aPlan(plan[0]),
      cobro:
        cobro === null
          ? null
          : {
              precio: cobro.precio,
              precioPactado: cobro.precioPactado,
              diaCorte: cobro.diaCorte,
              proximoCobro: cobro.proximoCobro,
              saldo: cobro.estado.saldo,
              vencido: cobro.estado.vencido,
              diasMora: cobro.estado.diasMora,
              ultimoPago: cobro.ultimoPago,
            },
      empresas: empresas.map((e, i) => ({
        id: e.id as string,
        razonSocial: e.razon_social as string,
        nit: e.nit as string,
        dv: e.dv as string,
        activo: e.activo as boolean,
        sectores: e.sectores as string[],
        grupoNiif: (e.grupo_niif as string | null) ?? null,
        sedes: e.sedes as number,
        configuracion: avances[i],
        iaMesUsd: iaDe.get(e.id as string) ?? 0,
      })),
      usuarios: usuarios.map((u) => ({
        id: u.id as string,
        email: u.email as string,
        nombreCompleto: u.nombre_completo as string,
        activo: u.activo as boolean,
        ultimoAcceso: iso(u.ultimo_acceso_en),
        esAdmin: u.es_admin as boolean,
        roles: u.roles as string[],
      })),
      bitacora: bitacora.map((b) => ({
        id: b.id as string,
        accion: b.accion as string,
        detalle: b.detalle as Record<string, unknown>,
        ocurridoEn: iso(b.ocurrido_en) as string,
        admin: b.admin as string,
      })),
    };
  }

  /** El avance de una empresa, con la misma regla que ve su director. */
  async avance(empresaId: string): Promise<AvanceConfiguracion> {
    const e = await this.nucleo.estadoConfiguracionCon(
      this.conexion().manager,
      empresaId,
    );
    const obligatorios = e.pasos.filter((p) => p.obligatorio);
    return {
      completados: e.completados,
      total: e.totalObligatorios,
      porcentaje: e.porcentaje,
      completa: e.completa,
      pendientes: obligatorios
        .filter((p) => p.estado !== 'LISTO')
        .map((p) => p.nombre),
    };
  }

  // -------------------------------------------------------------------------
  // La cuenta
  // -------------------------------------------------------------------------

  /**
   * Crea la cuenta y su primer usuario. Nada más.
   *
   * De la empresa no se pregunta nada: el NIT, el marco NIIF y la fecha de inicio
   * de operaciones los sabe el contador del cliente, no quien vende el sistema.
   * El director la crea cuando entra, y ahí queda como su DIRECTOR.
   *
   * Si no viene contraseña, se genera una para dictar y se devuelve **una sola
   * vez**: no queda en la bitácora ni en ningún otro lado.
   */
  async crearCuenta(admin: CtxPlataforma, dto: CrearCuentaDto) {
    const generada = dto.password === undefined;
    const password = dto.password ?? contrasenaParaDictar();
    const hash = await this.passwords.hashear(password);
    const local = dto.email.split('@')[0];
    const nombreAdmin = dto.nombreAdministrador ?? local;
    const nombreCuenta = dto.nombreCuenta ?? nombreAdmin;
    const planClave = dto.plan ?? 'BASICO';

    return this.conexion().transaction(async (t) => {
      const plan = await this.planDe(t, planClave);

      const [tenant] = await t.query<Array<{ id: string }>>(
        `INSERT INTO tenant (nombre, slug, plan, max_empresas, max_usuarios)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          nombreCuenta,
          await this.slugLibre(t, local),
          planClave,
          dto.maxEmpresas ?? plan.maxEmpresas,
          dto.maxUsuarios ?? plan.maxUsuarios,
        ],
      );

      const [usuario] = await t.query<Array<{ id: string }>>(
        `INSERT INTO usuario (tenant_id, email, nombre_completo, hash_password)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.id, dto.email, nombreAdmin, hash],
      );

      // ADMIN_TENANT y no DIRECTOR: `DIRECTOR` se ejerce dentro de una
      // contabilidad y todavía no hay ninguna. Lo recibirá automáticamente sobre
      // la empresa que cree, que es cuando el rol significa algo.
      await t.query(
        `INSERT INTO usuario_rol_tenant (usuario_id, rol_codigo, tenant_id)
         VALUES ($1, 'ADMIN_TENANT', $2)`,
        [usuario.id, tenant.id],
      );

      await registrar(t, admin, 'CREAR_CUENTA', tenant.id, {
        nombre: nombreCuenta,
        email: dto.email,
        plan: planClave,
      });

      return {
        tenantId: tenant.id,
        usuarioId: usuario.id,
        email: dto.email,
        nombreAdministrador: nombreAdmin,
        password: generada ? password : undefined,
      };
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
      const filas = await t.query<unknown[]>(
        'SELECT 1 FROM tenant WHERE slug = $1',
        [propuesto],
      );
      if (filas.length === 0) return propuesto;
    }
    return `${base}-${Date.now()}`;
  }

  /**
   * El plan nuevo trae sus cupos. Si la cuenta ya usa más, se responde 409
   * con el detalle y no se cambia nada, salvo `aceptarExceso`.
   */
  async cambiarPlan(admin: CtxPlataforma, id: string, dto: CambiarPlanDto) {
    return this.conexion().transaction(async (t) => {
      const antes = await this.bloquear(t, id);
      const plan = await this.planDe(t, dto.plan);
      const exceso = excesoFrente(antes, plan);

      if (exceso.length > 0 && dto.aceptarExceso !== true) {
        throw new ConflictException({
          message: 'La cuenta usa más de lo que permite el plan nuevo.',
          exceso,
        });
      }

      await t.query(
        `UPDATE tenant SET plan = $2, max_empresas = $3, max_usuarios = $4 WHERE id = $1`,
        [id, dto.plan, plan.maxEmpresas, plan.maxUsuarios],
      );
      await registrar(t, admin, 'CAMBIAR_PLAN', id, {
        antes: {
          plan: antes.plan,
          maxEmpresas: antes.maxEmpresas,
          maxUsuarios: antes.maxUsuarios,
        },
        despues: {
          plan: dto.plan,
          maxEmpresas: plan.maxEmpresas,
          maxUsuarios: plan.maxUsuarios,
        },
        ...(exceso.length > 0 ? { exceso } : {}),
      });
      return { ok: true };
    });
  }

  /**
   * Suspender o cancelar pide motivo. Suspender no borra nada: sus usuarios
   * dejan de emitir hasta que se reactive.
   */
  async cambiarEstado(admin: CtxPlataforma, id: string, dto: CambiarEstadoDto) {
    if (
      (dto.estado === 'SUSPENDIDO' || dto.estado === 'CANCELADO') &&
      (dto.motivo ?? '').trim() === ''
    ) {
      throw new BadRequestException('Suspender o cancelar pide un motivo.');
    }
    return this.conexion().transaction(async (t) => {
      const antes = await this.bloquear(t, id);
      if (antes.estado === dto.estado) {
        throw new BadRequestException('La cuenta ya está en ese estado.');
      }
      await t.query('UPDATE tenant SET estado = $2 WHERE id = $1', [
        id,
        dto.estado,
      ]);
      await registrar(t, admin, 'CAMBIAR_ESTADO', id, {
        antes: antes.estado,
        despues: dto.estado,
        ...(dto.motivo ? { motivo: dto.motivo.trim() } : {}),
      });
      return { ok: true };
    });
  }

  /** Los cupos no bajan de lo que la cuenta ya usa. */
  async ajustarCupos(admin: CtxPlataforma, id: string, dto: AjustarCuposDto) {
    return this.conexion().transaction(async (t) => {
      const antes = await this.bloquear(t, id);
      const despues = {
        maxEmpresas: dto.maxEmpresas ?? antes.maxEmpresas,
        maxUsuarios: dto.maxUsuarios ?? antes.maxUsuarios,
      };
      const exceso = excesoFrente(antes, despues);
      if (exceso.length > 0) {
        throw new BadRequestException({
          message:
            'Los cupos no pueden quedar por debajo de lo que la cuenta ya usa.',
          exceso,
        });
      }
      await t.query(
        'UPDATE tenant SET max_empresas = $2, max_usuarios = $3 WHERE id = $1',
        [id, despues.maxEmpresas, despues.maxUsuarios],
      );
      await registrar(t, admin, 'AJUSTAR_CUPOS', id, {
        antes: {
          maxEmpresas: antes.maxEmpresas,
          maxUsuarios: antes.maxUsuarios,
        },
        despues,
      });
      return { ok: true };
    });
  }

  async renombrar(admin: CtxPlataforma, id: string, nombre: string) {
    return this.conexion().transaction(async (t) => {
      const antes = await this.bloquear(t, id);
      await t.query('UPDATE tenant SET nombre = $2 WHERE id = $1', [
        id,
        nombre.trim(),
      ]);
      await registrar(t, admin, 'RENOMBRAR_CUENTA', id, {
        antes: antes.nombre,
        despues: nombre.trim(),
      });
      return { ok: true };
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
      await registrar(t, admin, 'CREAR_EMPRESA', tenantId, {
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
    const generada = dto.password === undefined;
    const password = dto.password ?? contrasenaParaDictar();
    const hash = await this.passwords.hashear(password);

    return this.conexion().transaction(async (t) => {
      await this.verificarCupoUsuarios(t, tenantId);

      if (dto.empresaId) {
        const [empresa] = await t.query<unknown[]>(
          'SELECT 1 FROM empresa WHERE id = $1 AND tenant_id = $2',
          [dto.empresaId, tenantId],
        );
        if (empresa === undefined) {
          throw new BadRequestException('La empresa no es de esta cuenta.');
        }
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

      await registrar(t, admin, 'CREAR_USUARIO', tenantId, {
        email: dto.email,
        ...(dto.esAdminCuenta ? { administrador: true } : {}),
        ...(dto.rol ? { rol: dto.rol } : {}),
      });

      return {
        usuarioId: usuario.id,
        email: dto.email,
        password: generada ? password : undefined,
      };
    });
  }

  /**
   * Una contraseña nueva para dictar por teléfono. La anterior deja de servir
   * en ese momento. Se devuelve **una sola vez**.
   */
  async restablecer(admin: CtxPlataforma, tenantId: string, usuarioId: string) {
    const password = contrasenaParaDictar();
    const hash = await this.passwords.hashear(password);
    return this.conexion().transaction(async (t) => {
      const u = await this.usuarioDe(t, tenantId, usuarioId);
      await t.query('UPDATE usuario SET hash_password = $2 WHERE id = $1', [
        usuarioId,
        hash,
      ]);
      await registrar(t, admin, 'RESTABLECER_PASSWORD', tenantId, {
        email: u.email,
      });
      return { email: u.email, nombreCompleto: u.nombre_completo, password };
    });
  }

  /**
   * Un usuario desactivado no entra y deja libre su cupo. El último
   * administrador activo no se puede desactivar: la cuenta quedaría sin nadie
   * que la administre.
   */
  async desactivar(admin: CtxPlataforma, tenantId: string, usuarioId: string) {
    return this.conexion().transaction(async (t) => {
      const u = await this.usuarioDe(t, tenantId, usuarioId);
      if (!u.activo) {
        throw new BadRequestException('El usuario ya está desactivado.');
      }
      if (u.es_admin) {
        const [otros] = await t.query<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM usuario x
             JOIN usuario_rol_tenant urt ON urt.usuario_id = x.id AND urt.revocado_en IS NULL
            WHERE x.tenant_id = $1 AND x.activo AND x.id <> $2`,
          [tenantId, usuarioId],
        );
        if (otros.n === 0) {
          throw new ConflictException(
            'Es el único administrador activo de la cuenta. Primero hay que nombrar otro.',
          );
        }
      }
      await t.query('UPDATE usuario SET activo = false WHERE id = $1', [
        usuarioId,
      ]);
      await registrar(t, admin, 'DESACTIVAR_USUARIO', tenantId, {
        email: u.email,
      });
      return { ok: true };
    });
  }

  async reactivar(admin: CtxPlataforma, tenantId: string, usuarioId: string) {
    return this.conexion().transaction(async (t) => {
      const u = await this.usuarioDe(t, tenantId, usuarioId);
      if (u.activo) {
        throw new BadRequestException('El usuario ya está activo.');
      }
      await this.verificarCupoUsuarios(t, tenantId);
      await t.query('UPDATE usuario SET activo = true WHERE id = $1', [
        usuarioId,
      ]);
      await registrar(t, admin, 'REACTIVAR_USUARIO', tenantId, {
        email: u.email,
      });
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------

  /** La cuenta, bloqueada para el resto de la transacción. */
  private async bloquear(t: EntityManager, id: string) {
    const f = fila<Record<string, unknown>>(
      await t.query(
        `SELECT t.nombre, t.plan, t.estado, t.max_empresas, t.max_usuarios,
                (SELECT count(*)::int FROM empresa e WHERE e.tenant_id = t.id AND e.activo) AS empresas,
                (SELECT count(*)::int FROM usuario u WHERE u.tenant_id = t.id AND u.activo)  AS usuarios
           FROM tenant t WHERE t.id = $1 FOR UPDATE`,
        [id],
      ),
    );
    if (f === undefined) {
      throw new NotFoundException('Cuenta no encontrada');
    }
    return {
      nombre: f.nombre as string,
      plan: f.plan as string,
      estado: f.estado as string,
      maxEmpresas: f.max_empresas as number,
      maxUsuarios: f.max_usuarios as number,
      empresas: f.empresas as number,
      usuarios: f.usuarios as number,
    };
  }

  private async planDe(t: EntityManager, clave: string) {
    const [p] = await t.query<Array<Record<string, unknown>>>(
      `SELECT clave, nombre, max_empresas, max_usuarios, precio_mensual, tope_ia_usd, al_llegar_tope
         FROM plan_catalogo WHERE clave = $1`,
      [clave],
    );
    if (p === undefined) {
      throw new BadRequestException('El plan no existe.');
    }
    return aPlan(p);
  }

  private async usuarioDe(
    t: EntityManager,
    tenantId: string,
    usuarioId: string,
  ) {
    const [u] = await t.query<
      Array<{
        email: string;
        nombre_completo: string;
        activo: boolean;
        es_admin: boolean;
      }>
    >(
      `SELECT u.email, u.nombre_completo, u.activo,
              EXISTS (SELECT 1 FROM usuario_rol_tenant urt
                       WHERE urt.usuario_id = u.id AND urt.revocado_en IS NULL) AS es_admin
         FROM usuario u
        WHERE u.id = $1 AND u.tenant_id = $2
        FOR UPDATE`,
      [usuarioId, tenantId],
    );
    if (u === undefined) {
      throw new NotFoundException('Usuario no encontrado en esta cuenta');
    }
    return u;
  }

  private async insertarEmpresa(
    t: EntityManager,
    tenantId: string,
    usuarioId: string,
    e: CrearEmpresaEnCuentaDto,
  ): Promise<string> {
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
    const c = await this.bloquear(t, tenantId);
    if (c.empresas >= c.maxEmpresas) {
      throw new BadRequestException(
        `El plan permite ${c.maxEmpresas} empresa(s). Ampliar el cupo primero.`,
      );
    }
  }

  private async verificarCupoUsuarios(
    t: EntityManager,
    tenantId: string,
  ): Promise<void> {
    const c = await this.bloquear(t, tenantId);
    if (c.usuarios >= c.maxUsuarios) {
      throw new BadRequestException(
        `El plan permite ${c.maxUsuarios} usuario(s) activo(s). Ampliar el cupo primero.`,
      );
    }
  }

  private conexion(): DataSource {
    if (this.provision === null) {
      throw new ServiceUnavailableException(
        'Falta configurar DB_PROVISION_USERNAME y DB_PROVISION_PASSWORD.',
      );
    }
    return this.provision;
  }
}

function seleccionDe(c: ConsultaCuentas): Seleccion {
  return {
    filtro: (FILTROS as readonly string[]).includes(c.filtro ?? '')
      ? (c.filtro as Filtro)
      : 'TODAS',
    orden: (ORDENES as readonly string[]).includes(c.orden ?? '')
      ? (c.orden as Orden)
      : 'alta',
    dir: c.dir === 'asc' ? 'asc' : 'desc',
    ahora: new Date(),
  };
}

/** Sin tildes ni mayúsculas, para buscar como escribe la gente. */
export const normalizar = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

export interface PlanCatalogo {
  clave: string;
  nombre: string;
  maxEmpresas: number;
  maxUsuarios: number;
  /** Nulos hasta la fase 2: la consola dice «sin configurar». */
  precioMensual: number | null;
  topeIaUsd: number | null;
  alLlegarTope: 'AVISAR' | 'FRENAR' | null;
}

export function aPlan(p: Record<string, unknown>): PlanCatalogo {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    clave: p.clave as string,
    nombre: p.nombre as string,
    maxEmpresas: p.max_empresas as number,
    maxUsuarios: p.max_usuarios as number,
    precioMensual: n(p.precio_mensual),
    topeIaUsd: n(p.tope_ia_usd),
    alLlegarTope: (p.al_llegar_tope as 'AVISAR' | 'FRENAR' | null) ?? null,
  };
}
