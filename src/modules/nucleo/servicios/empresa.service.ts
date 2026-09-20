import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Ctx, CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import type {
  CrearEmpresaDto,
  CrearSedeDto,
  EditarEmpresaDto,
  EditarSedeDto,
} from '../dto/empresa.dto';
import { exigirFormaAsociativa } from './validaciones-catalogo';

export interface Empresa {
  id: string;
  tenantId: string;
  tipoPersona: 'JURIDICA' | 'NATURAL';
  razonSocial: string;
  nombreComercial: string | null;
  nit: string;
  dv: string;
  sectores: string[];
  activo: boolean;
}

@Injectable()
export class EmpresaService {
  constructor(
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /**
   * Crea la empresa y su configuración contable en la misma transacción.
   *
   * Van juntas porque una empresa sin configuración contable no puede recibir un
   * solo asiento: el módulo de contabilidad necesita el grupo NIIF y el mes de
   * cierre antes de permitir nada. Crearlas por separado deja la puerta abierta a
   * una empresa a medio nacer.
   */
  async crear(ctx: Ctx, dto: CrearEmpresaDto): Promise<Empresa> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.verificarCupo(t, ctx);

      // Una persona natural no tiene tipo societario. El CHECK de la tabla lo
      // rechaza igual; acá se dice con palabras antes de llegar al motor.
      if (dto.formaAsociativaCodigo !== undefined) {
        if (dto.tipoPersona === 'NATURAL') {
          throw new BadRequestException(
            'Una persona natural no tiene forma asociativa: eso es de las sociedades.',
          );
        }
        await exigirFormaAsociativa(t, dto.formaAsociativaCodigo);
      }

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa (tenant_id, tipo_persona, razon_social, nombre_comercial, nit, dv,
                              forma_asociativa_codigo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          ctx.tenantId,
          dto.tipoPersona,
          dto.razonSocial,
          dto.nombreComercial ?? null,
          dto.nit,
          dto.dv,
          dto.formaAsociativaCodigo ?? null,
        ],
      );

      // La empresa recien creada pasa a ser el contexto de la transaccion: sin
      // esto, la politica de `empresa_configuracion_contable` rechaza la fila
      // que estamos creando para ella.
      await this.tx.fijarEmpresa(t, fila.id as string);

      // Va despues de fijar el contexto: la politica RLS de `empresa_sector`
      // compara contra app.empresa_id, y antes de fijarlo rechaza sus propias filas.
      await this.reemplazarSectores(t, fila.id as string, dto.sectores ?? []);

      await t.query(
        `INSERT INTO empresa_configuracion_contable
           (empresa_id, grupo_niif, moneda_funcional, mes_cierre_fiscal,
            metodo_valoracion_inventario, fecha_inicio_operaciones)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fila.id,
          dto.grupoNiif,
          dto.monedaFuncional ?? 'COP',
          dto.mesCierreFiscal ?? 12,
          dto.metodoValoracionInventario ?? 'PROMEDIO_PONDERADO',
          dto.fechaInicioOperaciones,
        ],
      );

      // Quien la crea queda con acceso de DIRECTOR: si no, acabaria de crear una
      // empresa a la que no puede entrar.
      await t.query(
        `INSERT INTO usuario_empresa_rol (usuario_id, empresa_id, rol_codigo, tenant_id, asignado_por_id)
         VALUES ($1, $2, 'DIRECTOR', $3, $1)`,
        [ctx.usuarioId, fila.id, ctx.tenantId],
      );

      // Sin esto la empresa no tiene donde asentar: ventas, compras y kardex
      // buscan sus tipos de comprobante por código y no aceptan crearlos solos.
      await this.contabilidad.sembrarComprobantes(fila.id as string, t);

      // El RETURNING de arriba no ve los sectores: se insertaron despues.
      return this.mapear({ ...fila, sectores: dto.sectores ?? [] });
    });
  }

  async listar(ctx: Ctx): Promise<Empresa[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const filas = await t.query<Array<Record<string, unknown>>>(
        `SELECT e.*, COALESCE((SELECT array_agg(s.sector ORDER BY s.sector)
                          FROM empresa_sector s WHERE s.empresa_id = e.id),
                        ARRAY[]::text[]) AS sectores
           FROM empresa e ORDER BY e.razon_social`,
      );
      return filas.map((f) => this.mapear(f));
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<Empresa> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `SELECT e.*, COALESCE((SELECT array_agg(s.sector ORDER BY s.sector)
                          FROM empresa_sector s WHERE s.empresa_id = e.id),
                        ARRAY[]::text[]) AS sectores
           FROM empresa e WHERE e.id = $1`,
        [id],
      );
      if (fila === undefined) {
        throw new NotFoundException('Empresa no encontrada');
      }
      return this.mapear(fila);
    });
  }

  /**
   * El NIT no se edita acá. Cambiar de NIT no es corregir un dato: es otra
   * persona jurídica, con otra contabilidad y otra numeración fiscal. Si se
   * digitó mal, se desactiva la empresa y se crea la correcta.
   */
  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarEmpresaDto,
  ): Promise<Empresa> {
    return this.tx.enContexto(ctx, async (t) => {
      const editada = fila<Record<string, unknown>>(
        await t.query(
          `UPDATE empresa
            SET razon_social     = COALESCE($2, razon_social),
                nombre_comercial = COALESCE($3, nombre_comercial),
                actualizado_en   = now()
          WHERE id = $1
          RETURNING *`,
          [id, dto.razonSocial ?? null, dto.nombreComercial ?? null],
        ),
      );
      if (editada === undefined) {
        throw new NotFoundException('Empresa no encontrada');
      }

      // La lista llega completa o no llega: `undefined` es "no lo toques" y `[]`
      // es "quitalos todos". Sin esa distincion no habria forma de desmarcar el
      // ultimo sector.
      if (dto.sectores !== undefined) {
        await this.reemplazarSectores(t, id, dto.sectores);
      }

      return this.mapear({
        ...editada,
        sectores: await this.sectoresDe(t, id),
      });
    });
  }

  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE empresa SET activo = false WHERE id = $1', [id]),
    );
  }

  // ---------------------------------------------------------------------------
  // Sedes
  // ---------------------------------------------------------------------------

  async crearSede(
    ctx: CtxEmpresa,
    dto: CrearSedeDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      // Marcar una nueva sede como principal baja la anterior. El indice unico
      // parcial rechazaria dos principales, asi que el orden importa: primero
      // bajar, despues insertar.
      if (dto.esPrincipal === true) {
        await t.query(
          'UPDATE empresa_sede SET es_principal = false WHERE empresa_id = $1 AND es_principal',
          [ctx.empresaId],
        );
      }
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_sede
           (empresa_id, codigo, nombre, direccion, municipio_codigo, telefono, email, es_principal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          ctx.empresaId,
          dto.codigo,
          dto.nombre,
          dto.direccion,
          dto.municipioCodigo,
          dto.telefono ?? null,
          dto.email ?? null,
          dto.esPrincipal ?? false,
        ],
      );
      return fila;
    });
  }

  async listarSedes(ctx: CtxEmpresa): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT s.*, m.nombre AS municipio_nombre, d.nombre AS departamento_nombre
           FROM empresa_sede s
           LEFT JOIN municipio m ON m.codigo = s.municipio_codigo
           LEFT JOIN departamento d ON d.codigo = m.departamento_codigo
          ORDER BY s.es_principal DESC, s.nombre`,
      ),
    );
  }

  async editarSede(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarSedeDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      if (dto.esPrincipal === true) {
        await t.query(
          'UPDATE empresa_sede SET es_principal = false WHERE empresa_id = $1 AND es_principal AND id <> $2',
          [ctx.empresaId, id],
        );
      }
      const editada = fila<Record<string, unknown>>(
        await t.query(
          `UPDATE empresa_sede
            SET nombre           = COALESCE($2, nombre),
                direccion        = COALESCE($3, direccion),
                municipio_codigo = COALESCE($4, municipio_codigo),
                telefono         = COALESCE($5, telefono),
                email            = COALESCE($6, email),
                es_principal     = COALESCE($7, es_principal)
          WHERE id = $1
          RETURNING *`,
          [
            id,
            dto.nombre ?? null,
            dto.direccion ?? null,
            dto.municipioCodigo ?? null,
            dto.telefono ?? null,
            dto.email ?? null,
            dto.esPrincipal ?? null,
          ],
        ),
      );
      if (editada === undefined) {
        throw new NotFoundException('Sede no encontrada');
      }
      return editada;
    });
  }

  /**
   * Deja la sede principal con estos datos, exista o no todavía.
   *
   * Nace con el modo IA del asistente: del RUT salen dirección, municipio,
   * teléfono y correo, pero no si la empresa ya tiene una sede cargada. Decidir
   * eso es de acá —las sedes son de este servicio— y no de quien trae los datos.
   *
   * La primera sede queda como `001 · Principal`. El nombre y el código se
   * cambian después desde la pantalla; lo que no se puede es no tener ninguno.
   */
  async fijarSedePrincipal(
    ctx: CtxEmpresa,
    dto: {
      direccion: string;
      municipioCodigo: string;
      telefono?: string;
      email?: string;
    },
  ): Promise<Record<string, unknown>> {
    const sedes = await this.listarSedes(ctx);
    const principal = sedes.find((s) => s.es_principal === true) ?? sedes[0];

    if (principal === undefined) {
      return this.crearSede(ctx, {
        codigo: '001',
        nombre: 'Principal',
        esPrincipal: true,
        ...dto,
      });
    }

    return this.editarSede(ctx, principal.id as string, {
      ...dto,
      esPrincipal: true,
    });
  }

  /** Una sede no se borra: se desactiva. Puede tener documentos emitidos colgando. */
  async desactivarSede(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<{ es_principal: boolean }>>(
        'SELECT es_principal FROM empresa_sede WHERE id = $1',
        [id],
      );
      if (fila === undefined) {
        throw new NotFoundException('Sede no encontrada');
      }
      if (fila.es_principal) {
        throw new BadRequestException(
          'No se puede desactivar la sede principal. Marcar otra como principal primero.',
        );
      }
      await t.query('UPDATE empresa_sede SET activo = false WHERE id = $1', [
        id,
      ]);
    });
  }

  // ---------------------------------------------------------------------------

  /** El plan del tenant limita cuántas empresas puede tener. */
  private async verificarCupo(t: Tx, ctx: Ctx): Promise<void> {
    const [cupo] = await t.query<
      Array<{ max_empresas: number; usadas: string; estado: string }>
    >(
      `SELECT t.max_empresas, t.estado,
              (SELECT count(*) FROM empresa e WHERE e.tenant_id = t.id AND e.activo) AS usadas
         FROM tenant t WHERE t.id = $1`,
      [ctx.tenantId],
    );
    if (cupo === undefined) {
      throw new ForbiddenException('Cuenta no encontrada');
    }
    if (cupo.estado !== 'ACTIVO') {
      throw new ForbiddenException(
        `La cuenta esta ${cupo.estado.toLowerCase()}`,
      );
    }
    if (Number(cupo.usadas) >= cupo.max_empresas) {
      throw new ForbiddenException(
        `El plan permite ${cupo.max_empresas} empresa(s). Ampliar el plan para agregar mas.`,
      );
    }
  }

  /**
   * Deja la lista de sectores exactamente como la mandaron. Se borra y se
   * reinserta en vez de calcular diferencias: son tres valores como maximo y el
   * `DELETE` esta permitido a proposito —un sector es un atributo, no un hecho
   * contable, y desmarcarlo no deja huerfanos—.
   */
  private async reemplazarSectores(
    t: Tx,
    empresaId: string,
    sectores: string[],
  ): Promise<void> {
    await t.query('DELETE FROM empresa_sector WHERE empresa_id = $1', [
      empresaId,
    ]);
    for (const sector of sectores) {
      await t.query(
        'INSERT INTO empresa_sector (empresa_id, sector) VALUES ($1, $2)',
        [empresaId, sector],
      );
    }
  }

  private async sectoresDe(t: Tx, empresaId: string): Promise<string[]> {
    const filas = await t.query<Array<{ sector: string }>>(
      'SELECT sector FROM empresa_sector WHERE empresa_id = $1 ORDER BY sector',
      [empresaId],
    );
    return filas.map((f) => f.sector);
  }

  private mapear(f: Record<string, unknown>): Empresa {
    return {
      id: f.id as string,
      tenantId: f.tenant_id as string,
      tipoPersona: f.tipo_persona as Empresa['tipoPersona'],
      razonSocial: f.razon_social as string,
      nombreComercial: (f.nombre_comercial as string | null) ?? null,
      nit: f.nit as string,
      dv: f.dv as string,
      sectores: (f.sectores as string[] | null) ?? [],
      activo: f.activo as boolean,
    };
  }
}
