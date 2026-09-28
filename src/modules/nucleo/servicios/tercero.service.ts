import { Injectable, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  armarPagina,
  type Pagina,
  type PaginacionDto,
} from '../../../common/dto/paginacion.dto';
import { fila } from '../../../common/db/filas';
import { hoyEnColombia } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CrearTerceroDto, EditarTerceroDto } from '../dto/tercero.dto';
import { exigirTipoDocumento } from './validaciones-catalogo';

/**
 * Hoy en Colombia, en SQL. `current_date` depende de la zona de la sesión:
 * con la base en UTC, a las 7 de la noche de Bogotá ya es mañana, y el alta
 * dejaba la primera versión del perfil con fecha futura (bug #7 de la
 * revisión del 27-09).
 */
const HOY_SQL = `(now() AT TIME ZONE 'America/Bogota')::date`;

/**
 * Los datos tributarios de hoy, del perfil con historia (plan motor de
 * retenciones, Fase 7): `tercero` ya no los tiene. Salen con los nombres de
 * las columnas viejas, que es lo que leen la ficha y los documentos.
 */
const PERFIL_VIGENTE = `LEFT JOIN LATERAL (
    SELECT p.es_responsable_iva AS responsable_iva, p.declarante_renta,
           p.es_agente_ret_renta AS es_agente_retenedor,
           p.es_autorretenedor_renta AS es_autorretenedor,
           p.es_gran_contribuyente, (p.regimen_renta = 'SIMPLE') AS regimen_simple
      FROM tercero_perfil_tributario p
     WHERE p.tercero_id = t.id AND p.vigencia_desde <= ${HOY_SQL}
     ORDER BY p.vigencia_desde DESC
     LIMIT 1) pv ON true`;

/** Lo tributario que se puede tocar desde la ficha del tercero. */
interface CalidadesFicha {
  responsableIva?: boolean;
  esAgenteRetenedor?: boolean;
  esAutorretenedor?: boolean;
  esGranContribuyente?: boolean;
  regimenSimple?: boolean;
}

export interface TerceroResumen {
  id: string;
  tipoDocumento: string;
  numeroDocumento: string;
  dv: string | null;
  nombre: string;
  esCliente: boolean;
  esProveedor: boolean;
  esEmpleado: boolean;
  responsableIva: boolean;
  /** Si declara renta. Decide la tarifa de retefuente en los conceptos que tienen dos. */
  declaranteRenta: boolean;
  tipoPersona: 'NATURAL' | 'JURIDICA';
  activo: boolean;
}

@Injectable()
export class TerceroService {
  constructor(private readonly tx: TxService) {}

  /**
   * Devuelve el resumen —la misma forma que `listar`— y no la fila cruda:
   * quien crea un tercero desde la digitación de una venta lo necesita para
   * dejarlo seleccionado, y la fila cruda no trae el `nombre` ya armado.
   */
  async crear(ctx: CtxEmpresa, dto: CrearTerceroDto): Promise<TerceroResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await exigirTipoDocumento(t, dto.tipoDocumento);

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO tercero
           (empresa_id, tipo_persona, tipo_documento, numero_documento, dv,
            razon_social, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
            nombre_comercial, email, telefono, direccion, municipio_codigo,
            es_cliente, es_proveedor, es_empleado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id`,
        [
          ctx.empresaId,
          dto.tipoPersona,
          dto.tipoDocumento,
          dto.numeroDocumento,
          dto.dv ?? null,
          dto.razonSocial ?? null,
          dto.primerNombre ?? null,
          dto.segundoNombre ?? null,
          dto.primerApellido ?? null,
          dto.segundoApellido ?? null,
          dto.nombreComercial ?? null,
          dto.email ?? null,
          dto.telefono ?? null,
          dto.direccion ?? null,
          dto.municipioCodigo ?? null,
          dto.esCliente ?? false,
          dto.esProveedor ?? false,
          dto.esEmpleado ?? false,
        ],
      );

      // Su primera versión del perfil, desde hoy. Sin aprobador: es la
      // automática, y Datos tributarios la reemplaza con la fecha de su RUT.
      await t.query(
        `INSERT INTO tercero_perfil_tributario
           (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
            es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
            es_agente_ret_renta, vigencia_desde, fuente)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, ${HOY_SQL}, 'MANUAL')`,
        [
          ctx.empresaId,
          fila.id,
          dto.tipoPersona,
          dto.regimenSimple === true ? 'SIMPLE' : 'ORDINARIO',
          dto.responsableIva ?? false,
          dto.esGranContribuyente ?? false,
          dto.esAutorretenedor ?? false,
          dto.esAgenteRetenedor ?? false,
        ],
      );

      await this.reemplazarResponsabilidades(
        t,
        ctx,
        fila.id as string,
        dto.responsabilidadesDian ?? [],
      );
      return (await this.buscarTercero(ctx, fila.id as string, t))!;
    });
  }

  /**
   * Búsqueda paginada. El texto se compara contra el índice normalizado, así que
   * "MEDELLIN" encuentra "Medellín" y "jose" encuentra "José".
   */
  async listar(
    ctx: CtxEmpresa,
    p: PaginacionDto,
    filtro: {
      esCliente?: boolean;
      esProveedor?: boolean;
      esEmpleado?: boolean;
      incluirInactivos?: boolean;
      soloInactivos?: boolean;
    },
  ): Promise<Pagina<TerceroResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      // Tres estados y no dos: "solo los activos" (lo normal), "todos" y "solo
      // los desactivados". El ultimo hace falta para que la pantalla pueda
      // paginar sobre ellos; acotar en el cliente descuadraba el conteo.
      if (filtro.soloInactivos === true) {
        condiciones.push('NOT activo');
      } else if (filtro.incluirInactivos !== true) {
        condiciones.push('activo');
      }
      if (filtro.esCliente === true) {
        condiciones.push('es_cliente');
      }
      if (filtro.esProveedor === true) {
        condiciones.push('es_proveedor');
      }
      if (filtro.esEmpleado === true) {
        condiciones.push('es_empleado');
      }
      if (p.q !== undefined && p.q.trim() !== '') {
        params.push(`%${p.q.trim()}%`);
        condiciones.push(
          `(fn_normalizar(coalesce(razon_social,'') || ' ' || coalesce(primer_nombre,'') || ' ' || coalesce(primer_apellido,''))
             LIKE fn_normalizar($${params.length})
           OR numero_documento LIKE $${params.length})`,
        );
      }

      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const [conteo] = await t.query<Array<{ total: string }>>(
        `SELECT count(*) AS total FROM tercero ${where}`,
        params,
      );

      params.push(p.tamano, p.salto);
      const filas = await t.query<Array<Record<string, unknown>>>(
        `SELECT id, tipo_documento, numero_documento, dv, razon_social,
                primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
                es_cliente, es_proveedor, es_empleado, responsable_iva, declarante_renta, activo
           FROM tercero t ${PERFIL_VIGENTE} ${where}
          ORDER BY coalesce(razon_social, primer_apellido || ' ' || primer_nombre)
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return armarPagina(
        filas.map((f) => this.resumir(f)),
        Number(conteo.total),
        p,
      );
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `SELECT t.*, pv.*, m.nombre AS municipio_nombre,
                COALESCE(
                  (SELECT array_agg(r.codigo ORDER BY r.codigo)
                     FROM tercero_responsabilidad_fiscal r WHERE r.tercero_id = t.id),
                  ARRAY[]::text[]
                ) AS responsabilidades_dian
           FROM tercero t
           ${PERFIL_VIGENTE}
           LEFT JOIN municipio m ON m.codigo = t.municipio_codigo
          WHERE t.id = $1`,
        [id],
      );
      if (fila === undefined) {
        throw new NotFoundException('Tercero no encontrado');
      }
      return fila;
    });
  }

  /**
   * Editar cambia el tercero de hoy en adelante. No reescribe los documentos ya
   * emitidos: cada factura guarda copia de los datos del tercero al momento de
   * emitirse, porque así es como se demuestra qué decía la factura.
   */
  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarTerceroDto,
  ): Promise<TerceroResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const editado = fila<Record<string, unknown>>(
        await t.query(
          `UPDATE tercero SET
            razon_social          = COALESCE($2, razon_social),
            primer_nombre         = COALESCE($3, primer_nombre),
            segundo_nombre        = COALESCE($4, segundo_nombre),
            primer_apellido       = COALESCE($5, primer_apellido),
            segundo_apellido      = COALESCE($6, segundo_apellido),
            nombre_comercial      = COALESCE($7, nombre_comercial),
            email                 = COALESCE($8, email),
            telefono              = COALESCE($9, telefono),
            direccion             = COALESCE($10, direccion),
            municipio_codigo      = COALESCE($11, municipio_codigo),
            es_cliente            = COALESCE($12, es_cliente),
            es_proveedor          = COALESCE($13, es_proveedor),
            es_empleado           = COALESCE($14, es_empleado)
          WHERE id = $1
          RETURNING id`,
          [
            id,
            dto.razonSocial ?? null,
            dto.primerNombre ?? null,
            dto.segundoNombre ?? null,
            dto.primerApellido ?? null,
            dto.segundoApellido ?? null,
            dto.nombreComercial ?? null,
            dto.email ?? null,
            dto.telefono ?? null,
            dto.direccion ?? null,
            dto.municipioCodigo ?? null,
            dto.esCliente ?? null,
            dto.esProveedor ?? null,
            dto.esEmpleado ?? null,
          ],
        ),
      );
      if (editado === undefined) {
        throw new NotFoundException('Tercero no encontrado');
      }
      if (dto.responsabilidadesDian !== undefined) {
        await this.reemplazarResponsabilidades(
          t,
          ctx,
          id,
          dto.responsabilidadesDian,
        );
      }
      await this.perfilDesdeFicha(t, id, dto);
      return (await this.buscarTercero(ctx, id, t))!;
    });
  }

  /**
   * Un cambio de calidad tributaria en la ficha abre una versión del perfil
   * desde hoy, con lo demás que el perfil sabe (ZOMAC, CIIU…). Si la versión
   * de hoy empezó hoy, se corrige: no se abre una de un día. Para decir desde
   * cuándo rige de verdad está Datos tributarios.
   *
   * Se compara con la versión que rige hoy —la que muestra la ficha—, no con
   * la abierta: si hay una con fecha futura, la abierta es esa, y cerrarla
   * ayer rompía `ck_perfil_vigencia` (error 500, bug #7 de la revisión del
   * 27-09). La futura no se toca: la versión nueva dura hasta el día antes.
   */
  private async perfilDesdeFicha(
    t: Tx,
    terceroId: string,
    c: CalidadesFicha,
  ): Promise<void> {
    type Version = {
      id: string;
      desde: string;
      hasta: string | null;
      responsable_iva: boolean;
      es_agente_retenedor: boolean;
      es_autorretenedor: boolean;
      es_gran_contribuyente: boolean;
      regimen_simple: boolean;
    };
    const hoy = hoyEnColombia();
    const versiones = await t.query<Version[]>(
      `SELECT id, vigencia_desde::text AS desde, vigencia_hasta::text AS hasta,
              es_responsable_iva AS responsable_iva,
              es_agente_ret_renta AS es_agente_retenedor,
              es_autorretenedor_renta AS es_autorretenedor,
              es_gran_contribuyente, (regimen_renta = 'SIMPLE') AS regimen_simple
         FROM tercero_perfil_tributario
        WHERE tercero_id = $1
        ORDER BY vigencia_desde
        FOR UPDATE`,
      [terceroId],
    );
    const deHoy = [...versiones]
      .reverse()
      .find((x) => x.desde <= hoy && (x.hasta === null || x.hasta >= hoy));
    const futura = versiones.find((x) => x.desde > hoy);
    // Sin versión que rija hoy, la nueva sale de la futura (o de la última).
    const v = deHoy ?? futura ?? versiones[versiones.length - 1];
    if (v === undefined) return;
    const nuevo = {
      responsable_iva: c.responsableIva ?? v.responsable_iva,
      es_agente_retenedor: c.esAgenteRetenedor ?? v.es_agente_retenedor,
      es_autorretenedor: c.esAutorretenedor ?? v.es_autorretenedor,
      es_gran_contribuyente: c.esGranContribuyente ?? v.es_gran_contribuyente,
      regimen_simple: c.regimenSimple ?? v.regimen_simple,
    };
    const igual = (Object.keys(nuevo) as Array<keyof typeof nuevo>).every(
      (k) => nuevo[k] === v[k],
    );
    if (igual) return;

    const valores = [
      nuevo.regimen_simple,
      nuevo.responsable_iva,
      nuevo.es_gran_contribuyente,
      nuevo.es_autorretenedor,
      nuevo.es_agente_retenedor,
    ];
    if (deHoy !== undefined && deHoy.desde === hoy) {
      await t.query(
        `UPDATE tercero_perfil_tributario
            SET regimen_renta = CASE WHEN $2 THEN 'SIMPLE'
                                     WHEN regimen_renta = 'SIMPLE' THEN 'ORDINARIO'
                                     ELSE regimen_renta END,
                es_responsable_iva = $3, es_gran_contribuyente = $4,
                es_autorretenedor_renta = $5, es_agente_ret_renta = $6
          WHERE id = $1`,
        [v.id, ...valores],
      );
      return;
    }
    if (deHoy !== undefined) {
      await t.query(
        `UPDATE tercero_perfil_tributario SET vigencia_hasta = $2::date - 1
          WHERE id = $1`,
        [deHoy.id, hoy],
      );
    }
    // Hasta el día antes de la futura, si la hay; si no, abierta.
    const hasta = futura?.desde ?? null;
    await t.query(
      `INSERT INTO tercero_perfil_tributario
         (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
          es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
          es_entidad_publica, es_agente_ret_renta, es_autorretenedor_especial,
          es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
          ciiu_principal, ciiu_secundarios, contrato_dos_o_mas_trabajadores,
          vigencia_desde, vigencia_hasta, fuente)
       SELECT empresa_id, tercero_id, tipo_persona,
              CASE WHEN $2 THEN 'SIMPLE'
                   WHEN regimen_renta = 'SIMPLE' THEN 'ORDINARIO'
                   ELSE regimen_renta END,
              declarante_renta, $3, $4, $5,
              es_entidad_publica, $6, es_autorretenedor_especial,
              es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
              ciiu_principal, ciiu_secundarios, contrato_dos_o_mas_trabajadores,
              $7::date, $8::date - 1, 'MANUAL'
         FROM tercero_perfil_tributario WHERE id = $1`,
      [v.id, ...valores, hoy, hasta],
    );
  }

  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE tercero SET activo = false WHERE id = $1', [id]),
    );
  }

  /**
   * Lo vuelve a poner en las listas de digitacion.
   *
   * Desactivar no destruye nada, asi que activar tampoco reconstruye nada: es la
   * misma fila con la bandera al derecho. Sin esto un tercero desactivado por
   * error solo se recuperaba con un UPDATE a mano contra la base.
   */
  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query('UPDATE tercero SET activo = true WHERE id = $1', [id]),
    );
  }

  /** Lo que necesita otro módulo para poner un tercero en un documento. */
  /**
   * Los terceros activos cuyo número de documento contiene lo buscado.
   *
   * Pocas filas: un NIT no se repite. El tope existe igual, porque una búsqueda
   * de dos dígitos traería media tabla.
   */
  async porNumeroDocumento(
    ctx: CtxEmpresa,
    numeroDocumento: string,
  ): Promise<TerceroResumen[]> {
    const digitos = numeroDocumento.replace(/\D/g, '');
    if (digitos === '') return [];
    return this.tx.enContexto(ctx, async (t) => {
      const filas = await t.query<Array<Record<string, unknown>>>(
        `SELECT id, tipo_documento, numero_documento, dv, razon_social,
                primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
                es_cliente, es_proveedor, es_empleado, responsable_iva, declarante_renta, activo
           FROM tercero t ${PERFIL_VIGENTE}
          WHERE activo AND numero_documento LIKE $1
          ORDER BY numero_documento
          LIMIT 20`,
        [`%${digitos}%`],
      );
      return filas.map((f) => this.resumir(f));
    });
  }

  async buscarTercero(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<TerceroResumen | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const [fila] = await t.query<Array<Record<string, unknown>>>(
          `SELECT id, tipo_documento, numero_documento, dv, razon_social,
                  primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
                  es_cliente, es_proveedor, es_empleado, responsable_iva, declarante_renta,
                  activo, tipo_persona
             FROM tercero t ${PERFIL_VIGENTE} WHERE id = $1`,
          [id],
        );
        return fila === undefined ? null : this.resumir(fila);
      },
      tx,
    );
  }

  /**
   * Las responsabilidades fiscales son un atributo, no un hecho contable: se
   * reemplazan enteras. Es la única excepción al "nada se borra" del sistema, y
   * por eso es la única tabla donde `gestion_app` tiene privilegio DELETE.
   */
  private async reemplazarResponsabilidades(
    t: Tx,
    ctx: CtxEmpresa,
    terceroId: string,
    codigos: string[],
  ): Promise<void> {
    await t.query(
      'DELETE FROM tercero_responsabilidad_fiscal WHERE tercero_id = $1',
      [terceroId],
    );
    for (const codigo of codigos) {
      await t.query(
        `INSERT INTO tercero_responsabilidad_fiscal (tercero_id, codigo, empresa_id)
         VALUES ($1, $2, $3)`,
        [terceroId, codigo, ctx.empresaId],
      );
    }
  }

  private resumir(f: Record<string, unknown>): TerceroResumen {
    const razon = f.razon_social as string | null;
    const nombre =
      razon !== null && razon !== undefined
        ? razon
        : [
            f.primer_nombre,
            f.segundo_nombre,
            f.primer_apellido,
            f.segundo_apellido,
          ]
            .filter((p) => p !== null && p !== undefined && p !== '')
            .join(' ');

    return {
      id: f.id as string,
      tipoDocumento: f.tipo_documento as string,
      numeroDocumento: f.numero_documento as string,
      dv: (f.dv as string | null) ?? null,
      nombre,
      esCliente: f.es_cliente as boolean,
      esProveedor: f.es_proveedor as boolean,
      esEmpleado: (f.es_empleado as boolean | undefined) ?? false,
      responsableIva: f.responsable_iva as boolean,
      // `true` cuando la consulta no lo trae: los listados no lo piden, y
      // asumir "declarante" retiene de menos —que se corrige— en vez de
      // retener de más, que hay que devolver.
      declaranteRenta: (f.declarante_renta as boolean | undefined) ?? true,
      // La ley de retenciones distingue persona natural y jurídica (honorarios,
      // comisiones). Si la consulta no lo trae, se deduce del documento: el NIT
      // de 9 dígitos que empieza en 8 o 9 es de persona jurídica.
      tipoPersona:
        (f.tipo_persona as 'NATURAL' | 'JURIDICA' | undefined) ??
        (f.tipo_documento === 'NIT' &&
        /^[89]\d{8}$/.test(String(f.numero_documento))
          ? 'JURIDICA'
          : 'NATURAL'),
      activo: f.activo as boolean,
    };
  }
}
