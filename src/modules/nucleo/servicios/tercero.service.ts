import { Injectable, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  armarPagina,
  type Pagina,
  type PaginacionDto,
} from '../../../common/dto/paginacion.dto';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CrearTerceroDto, EditarTerceroDto } from '../dto/tercero.dto';
import { exigirTipoDocumento } from './validaciones-catalogo';

export interface TerceroResumen {
  id: string;
  tipoDocumento: string;
  numeroDocumento: string;
  dv: string | null;
  nombre: string;
  esCliente: boolean;
  esProveedor: boolean;
  responsableIva: boolean;
  activo: boolean;
}

@Injectable()
export class TerceroService {
  constructor(private readonly tx: TxService) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearTerceroDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      await exigirTipoDocumento(t, dto.tipoDocumento);

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO tercero
           (empresa_id, tipo_persona, tipo_documento, numero_documento, dv,
            razon_social, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
            nombre_comercial, email, telefono, direccion, municipio_codigo,
            es_cliente, es_proveedor, responsable_iva, es_agente_retenedor,
            es_autorretenedor, es_gran_contribuyente, regimen_simple)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING *`,
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
          dto.responsableIva ?? false,
          dto.esAgenteRetenedor ?? false,
          dto.esAutorretenedor ?? false,
          dto.esGranContribuyente ?? false,
          dto.regimenSimple ?? false,
        ],
      );

      await this.reemplazarResponsabilidades(
        t,
        ctx,
        fila.id as string,
        dto.responsabilidadesDian ?? [],
      );
      return fila;
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
                es_cliente, es_proveedor, responsable_iva, activo
           FROM tercero ${where}
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
        `SELECT t.*, m.nombre AS municipio_nombre,
                COALESCE(
                  (SELECT array_agg(r.codigo ORDER BY r.codigo)
                     FROM tercero_responsabilidad_fiscal r WHERE r.tercero_id = t.id),
                  ARRAY[]::text[]
                ) AS responsabilidades_dian
           FROM tercero t
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
  ): Promise<Record<string, unknown>> {
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
            responsable_iva       = COALESCE($14, responsable_iva),
            es_agente_retenedor   = COALESCE($15, es_agente_retenedor),
            es_autorretenedor     = COALESCE($16, es_autorretenedor),
            es_gran_contribuyente = COALESCE($17, es_gran_contribuyente),
            regimen_simple        = COALESCE($18, regimen_simple)
          WHERE id = $1
          RETURNING *`,
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
            dto.responsableIva ?? null,
            dto.esAgenteRetenedor ?? null,
            dto.esAutorretenedor ?? null,
            dto.esGranContribuyente ?? null,
            dto.regimenSimple ?? null,
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
      return editado;
    });
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
                  es_cliente, es_proveedor, responsable_iva, activo
             FROM tercero WHERE id = $1`,
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
      responsableIva: f.responsable_iva as boolean,
      activo: f.activo as boolean,
    };
  }
}
