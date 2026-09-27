import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { filas } from '../../../common/db/filas';
import type { CtxPlataforma } from '../../../common/ctx';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import type {
  NuevaAutorretencionDto,
  NuevaTarifaDto,
  NuevaUvtDto,
  NuevoIcaMunicipioDto,
  RecalcularRetencionesDto,
} from '../dto/ley-retenciones.dto';
import { planearVigencia } from '../reglas/ley-retenciones';
import { registrar } from './bitacora';

/**
 * La ley de retenciones desde la consola: la UVT de cada año y las vigencias de
 * cada tarifa (plan motor de retenciones, Fase 0, §0.8 y R-D7).
 *
 * Es de todos —no tiene RLS— y solo la escribe la conexión de provisión: una
 * empresa no puede cambiarle la tarifa a otra, ni a sí misma. Cada carga queda
 * en la bitácora con la norma y quién la validó.
 */
@Injectable()
export class LeyRetencionesService {
  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
    private readonly retenciones: RetencionesApi,
  ) {}

  async ley() {
    const ds = this.conexion();
    const [conceptos, uvt, migracion] = await Promise.all([
      ds.query<Array<Record<string, unknown>>>(
        `SELECT n.codigo, n.nombre, n.impuesto,
                coalesce(json_agg(json_build_object(
                  'tipoPersona', r.tipo_persona, 'declarante', r.declarante,
                  'baseUvt', r.base_uvt, 'tarifa', r.tarifa,
                  'vigenciaDesde', r.vigencia_desde, 'vigenciaHasta', r.vigencia_hasta,
                  'norma', r.norma, 'validadoPor', r.validado_por, 'validadoEn', r.validado_en)
                  ORDER BY r.vigencia_desde DESC)
                  FILTER (WHERE r.id IS NOT NULL), '[]') AS tarifas
           FROM retencion_concepto_nacional n
           LEFT JOIN retencion_tarifa r ON r.concepto_id = n.id
          WHERE n.activo
          GROUP BY n.id
          ORDER BY n.impuesto DESC, n.prioridad, n.nombre`,
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT anio, valor, norma, validado_por AS "validadoPor", validado_en::text AS "validadoEn"
           FROM uvt ORDER BY anio DESC`,
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT migracion, que, detalle, creado_en AS "creadoEn"
           FROM retencion_migracion_registro ORDER BY creado_en DESC`,
      ),
    ]);
    return { conceptos, uvt, migracion };
  }

  async nuevaTarifa(admin: CtxPlataforma, dto: NuevaTarifaDto) {
    const resultado = await this.conexion().transaction(async (t) => {
      const [concepto] = await t.query<Array<{ id: string; nombre: string }>>(
        'SELECT id, nombre FROM retencion_concepto_nacional WHERE codigo = $1',
        [dto.conceptoCodigo],
      );
      if (concepto === undefined) {
        throw new BadRequestException(
          `No existe el concepto ${dto.conceptoCodigo}.`,
        );
      }

      // La misma fila de la ley: mismo tipo de persona y misma condición de
      // declarante (NULL = aplica a todos, y es una fila propia).
      const existentes = await t.query<
        Array<{ id: string; desde: string; hasta: string | null }>
      >(
        `SELECT id, vigencia_desde::text AS desde, vigencia_hasta::text AS hasta
           FROM retencion_tarifa
          WHERE concepto_id = $1
            AND tipo_persona IS NOT DISTINCT FROM $2
            AND declarante IS NOT DISTINCT FROM $3
          FOR UPDATE`,
        [concepto.id, dto.tipoPersona ?? null, dto.declarante ?? null],
      );

      const plan = planearVigencia(existentes, {
        desde: dto.vigenciaDesde,
        hasta: dto.vigenciaHasta ?? null,
      });
      if (!plan.ok) throw new ConflictException(plan.motivo);

      if (plan.cerrar !== null) {
        await t.query(
          'UPDATE retencion_tarifa SET vigencia_hasta = $2 WHERE id = $1',
          [plan.cerrar.id, plan.cerrar.hasta],
        );
      }
      const [nueva] = filas<{ id: string }>(
        await t.query(
          `INSERT INTO retencion_tarifa
             (concepto_id, tipo_persona, declarante, base_uvt, tarifa, vigencia_desde,
              vigencia_hasta, norma, observacion, validado_por, validado_en)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            concepto.id,
            dto.tipoPersona ?? null,
            dto.declarante ?? null,
            dto.baseUvt,
            dto.tarifaPorcentaje / 100,
            dto.vigenciaDesde,
            dto.vigenciaHasta ?? null,
            dto.norma.trim(),
            dto.observacion?.trim() || null,
            dto.validadoPor.trim(),
            dto.validadoEn,
          ],
        ),
      );

      await registrar(t, admin, 'CARGAR_TARIFA_RETENCION', null, {
        concepto: dto.conceptoCodigo,
        tipoPersona: dto.tipoPersona ?? null,
        declarante: dto.declarante ?? null,
        tarifa: dto.tarifaPorcentaje,
        baseUvt: dto.baseUvt,
        desde: dto.vigenciaDesde,
        hasta: dto.vigenciaHasta ?? null,
        norma: dto.norma.trim(),
        validadoPor: dto.validadoPor.trim(),
        cerro: plan.cerrar,
      });
      return { id: nueva?.id ?? null, cerro: plan.cerrar };
    });

    this.retenciones.olvidarParametros();
    return resultado;
  }

  /** La ley de ICA cargada: parámetros por municipio y año, con cuántas tarifas. */
  async ica() {
    return this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT p.municipio_codigo, m.nombre AS municipio, p.anio,
              p.base_minima_uvt_compras, p.base_minima_uvt_servicios,
              p.tarifa_general_por_mil, p.usa_tarifa_por_actividad,
              p.acumula_en_periodo, p.periodicidad, p.acuerdo,
              p.validado_por AS "validadoPor", p.validado_en::text AS "validadoEn",
              (SELECT count(*)::int FROM ica_tarifa x
                WHERE x.municipio_codigo = p.municipio_codigo AND x.anio = p.anio) AS tarifas,
              (SELECT count(*)::int FROM ica_matriz_agente x
                WHERE x.municipio_codigo = p.municipio_codigo AND x.anio = p.anio) AS matriz
         FROM ica_parametro p JOIN municipio m ON m.codigo = p.municipio_codigo
        ORDER BY p.anio DESC, m.nombre`,
    );
  }

  /**
   * La ley de ICA de un municipio para un año nuevo. No se edita la de un año
   * ya cargado: los documentos de ese año se calcularon con ella.
   */
  async nuevoIcaMunicipio(admin: CtxPlataforma, dto: NuevoIcaMunicipioDto) {
    if (!dto.usaTarifaPorActividad && dto.tarifaGeneralPorMil === undefined) {
      throw new BadRequestException(
        'Sin tarifas por actividad, hace falta la tarifa general de retención.',
      );
    }
    // Todo se valida antes de escribir nada.
    for (const x of dto.tarifas ?? []) {
      // Art. 342 Ley 1819/2016: 2–7 ‰ industria, 2–10 ‰ comercio y
      // servicios. La base lo sostiene; acá se dice en palabras cuál falló.
      const [min, max] = x.tipo === 'INDUSTRIAL' ? [2, 7] : [2, 10];
      if (
        x.tipo !== 'FINANCIERA' &&
        (x.tarifaPorMil < min || x.tarifaPorMil > max)
      ) {
        throw new BadRequestException(
          `La actividad ${x.codigoActividad} (${x.tipo.toLowerCase()}) tiene ${x.tarifaPorMil} por mil, fuera del rango legal de ${min} a ${max}. Casi siempre es un error de digitación.`,
        );
      }
    }
    return this.conexion().transaction(async (t) => {
      const [ya] = await t.query<Array<{ id: string }>>(
        'SELECT id FROM ica_parametro WHERE municipio_codigo = $1 AND anio = $2',
        [dto.municipioCodigo, dto.anio],
      );
      if (ya !== undefined) {
        throw new ConflictException(
          `La ley de ICA de ese municipio para ${dto.anio} ya está cargada. No se cambia: se carga la del año siguiente.`,
        );
      }
      const [municipio] = await t.query<Array<{ nombre: string }>>(
        'SELECT nombre FROM municipio WHERE codigo = $1',
        [dto.municipioCodigo],
      );
      if (municipio === undefined) {
        throw new BadRequestException(
          `No existe el municipio ${dto.municipioCodigo}.`,
        );
      }
      await t.query(
        `INSERT INTO ica_parametro
           (municipio_codigo, anio, base_minima_uvt_compras, base_minima_uvt_servicios,
            tarifa_general_por_mil, usa_tarifa_por_actividad, acumula_en_periodo,
            periodicidad, acuerdo, validado_por, validado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          dto.municipioCodigo,
          dto.anio,
          dto.baseMinimaUvtCompras ?? null,
          dto.baseMinimaUvtServicios ?? null,
          dto.tarifaGeneralPorMil ?? null,
          dto.usaTarifaPorActividad,
          dto.acumulaEnPeriodo,
          dto.periodicidad,
          dto.acuerdo.trim(),
          dto.validadoPor.trim(),
          dto.validadoEn,
        ],
      );
      for (const x of dto.tarifas ?? []) {
        await t.query(
          `INSERT INTO ica_tarifa
             (municipio_codigo, anio, codigo_actividad, ciiu, descripcion, tipo,
              tarifa_por_mil, acuerdo, validado_por, validado_en)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            dto.municipioCodigo,
            dto.anio,
            x.codigoActividad.trim(),
            x.ciiu ?? null,
            x.descripcion?.trim() || null,
            x.tipo,
            x.tarifaPorMil,
            dto.acuerdo.trim(),
            dto.validadoPor.trim(),
            dto.validadoEn,
          ],
        );
      }
      for (const x of dto.matriz ?? []) {
        await t.query(
          `INSERT INTO ica_matriz_agente
             (municipio_codigo, anio, perfil_pagador, perfil_beneficiario, retiene, fundamento)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            dto.municipioCodigo,
            dto.anio,
            x.perfilPagador,
            x.perfilBeneficiario,
            x.retiene,
            x.fundamento ?? null,
          ],
        );
      }
      await registrar(t, admin, 'CARGAR_PARAMETRO_ICA', null, {
        municipio: municipio.nombre,
        anio: dto.anio,
        acuerdo: dto.acuerdo.trim(),
        tarifas: dto.tarifas?.length ?? 0,
        matriz: dto.matriz?.length ?? 0,
        validadoPor: dto.validadoPor.trim(),
      });
      return { municipio: municipio.nombre, anio: dto.anio };
    });
  }

  /**
   * Los aciertos del clasificador por fuente, de todas las empresas (Fase 5):
   * cuántas veces se aceptó el concepto propuesto tal cual y cuántas se
   * cambió. Solo cifras.
   */
  async aciertos(dias = 90) {
    return this.conexion().query<
      Array<{
        origen: string | null;
        total: number;
        aciertos: number;
        empresas: number;
      }>
    >(
      `SELECT origen_propuesto AS origen, count(*)::int AS total,
              count(*) FILTER (WHERE acerto)::int AS aciertos,
              count(DISTINCT empresa_id)::int AS empresas
         FROM retencion_clasificacion_uso
        WHERE creado_en >= now() - make_interval(days => $1)
        GROUP BY origen_propuesto
        ORDER BY total DESC`,
      [dias],
    );
  }

  /** Las tarifas de autorretención especial por CIIU, la vigente primero. */
  async autorretenciones() {
    return this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT ciiu, tarifa, vigencia_desde::text AS "vigenciaDesde",
              vigencia_hasta::text AS "vigenciaHasta", norma,
              validado_por AS "validadoPor", validado_en::text AS "validadoEn"
         FROM retencion_autorretencion_ciiu
        ORDER BY ciiu, vigencia_desde DESC`,
    );
  }

  async nuevaAutorretencion(admin: CtxPlataforma, dto: NuevaAutorretencionDto) {
    const ciiu = dto.ciiu.trim();
    return this.conexion().transaction(async (t) => {
      const existentes = await t.query<
        Array<{ id: string; desde: string; hasta: string | null }>
      >(
        `SELECT id, vigencia_desde::text AS desde, vigencia_hasta::text AS hasta
           FROM retencion_autorretencion_ciiu WHERE ciiu = $1 FOR UPDATE`,
        [ciiu],
      );
      const plan = planearVigencia(existentes, {
        desde: dto.vigenciaDesde,
        hasta: dto.vigenciaHasta ?? null,
      });
      if (!plan.ok) throw new ConflictException(plan.motivo);
      if (plan.cerrar !== null) {
        await t.query(
          'UPDATE retencion_autorretencion_ciiu SET vigencia_hasta = $2 WHERE id = $1',
          [plan.cerrar.id, plan.cerrar.hasta],
        );
      }
      await t.query(
        `INSERT INTO retencion_autorretencion_ciiu
           (ciiu, tarifa, vigencia_desde, vigencia_hasta, norma, validado_por, validado_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ciiu,
          dto.tarifaPorcentaje / 100,
          dto.vigenciaDesde,
          dto.vigenciaHasta ?? null,
          dto.norma.trim(),
          dto.validadoPor.trim(),
          dto.validadoEn,
        ],
      );
      await registrar(t, admin, 'CARGAR_AUTORRETENCION', null, {
        ciiu,
        tarifa: dto.tarifaPorcentaje,
        desde: dto.vigenciaDesde,
        hasta: dto.vigenciaHasta ?? null,
        norma: dto.norma.trim(),
        validadoPor: dto.validadoPor.trim(),
        cerro: plan.cerrar,
      });
      return { ciiu, cerro: plan.cerrar };
    });
  }

  async nuevaUvt(admin: CtxPlataforma, dto: NuevaUvtDto) {
    const resultado = await this.conexion().transaction(async (t) => {
      const [ya] = await t.query<Array<{ valor: string }>>(
        'SELECT valor FROM uvt WHERE anio = $1',
        [dto.anio],
      );
      if (ya !== undefined) {
        throw new ConflictException(
          `La UVT del ${dto.anio} ya está cargada (${ya.valor}). No se cambia: los documentos de ese año ya se calcularon con ella.`,
        );
      }
      await t.query(
        `INSERT INTO uvt (anio, valor, norma, validado_por, validado_en)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          dto.anio,
          dto.valor,
          dto.norma.trim(),
          dto.validadoPor.trim(),
          dto.validadoEn,
        ],
      );
      await registrar(t, admin, 'CARGAR_UVT', null, {
        anio: dto.anio,
        valor: dto.valor,
        norma: dto.norma.trim(),
        validadoPor: dto.validadoPor.trim(),
      });
      return { anio: dto.anio, valor: dto.valor };
    });

    this.retenciones.olvidarParametros();
    return resultado;
  }

  /**
   * Recalcula las retenciones de un rango con la norma que rige hoy, empresa
   * por empresa (plan motor de retenciones, Fase 6, §6.3).
   *
   * La corrida se anota primero —las diferencias la referencian— y cada
   * empresa corre en su propia transacción y con su contexto (RLS): si una
   * falla, las demás quedan. No toca asientos ni retenciones registradas.
   */
  async recalcular(admin: CtxPlataforma, dto: RecalcularRetencionesDto) {
    if (dto.hasta < dto.desde) {
      throw new BadRequestException(
        'El rango va de la fecha menor a la mayor.',
      );
    }
    const ds = this.conexion();
    const empresas = await ds.query<
      Array<{ id: string; tenant_id: string; razon_social: string }>
    >(
      `SELECT id, tenant_id, razon_social FROM empresa
        WHERE activo AND ($1::uuid IS NULL OR id = $1)
        ORDER BY razon_social`,
      [dto.empresaId ?? null],
    );
    if (dto.empresaId !== undefined && empresas.length === 0) {
      throw new BadRequestException('No hay una empresa activa con ese id.');
    }

    const [corrida] = await ds.query<Array<{ id: string }>>(
      `INSERT INTO retencion_recalculo (desde, hasta, empresa_id, motivo, creado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        dto.desde,
        dto.hasta,
        dto.empresaId ?? null,
        dto.motivo.trim(),
        admin.adminId,
      ],
    );

    // La foto de parámetros tiene caché: el recálculo tiene que leer la ley
    // de hoy, no la de la última vez que alguien calculó.
    this.retenciones.olvidarParametros();

    const porEmpresa: Array<Record<string, unknown>> = [];
    for (const e of empresas) {
      try {
        const r = await this.retenciones.recalcularEmpresa(
          {
            tenantId: e.tenant_id,
            empresaId: e.id,
            usuarioId: admin.adminId,
            roles: ['DIRECTOR'],
          },
          { recalculoId: corrida.id, desde: dto.desde, hasta: dto.hasta },
        );
        porEmpresa.push({ empresaId: e.id, empresa: e.razon_social, ...r });
      } catch (err) {
        porEmpresa.push({
          empresaId: e.id,
          empresa: e.razon_social,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const suma = (clave: string) =>
      porEmpresa.reduce((s, p) => s + (Number(p[clave]) || 0), 0);
    const resumen = {
      empresas: porEmpresa.length,
      documentos: suma('documentos'),
      diferencias: suma('diferencias'),
      sinEntrada: suma('sinEntrada'),
      conError: porEmpresa.filter((p) => p.error !== undefined).length,
      porEmpresa,
    };
    await ds.transaction(async (t) => {
      await t.query(
        'UPDATE retencion_recalculo SET resumen = $2 WHERE id = $1',
        [corrida.id, JSON.stringify(resumen)],
      );
      await registrar(t, admin, 'RECALCULAR_RETENCIONES', null, {
        recalculo: corrida.id,
        desde: dto.desde,
        hasta: dto.hasta,
        empresaId: dto.empresaId ?? null,
        motivo: dto.motivo.trim(),
        documentos: resumen.documentos,
        diferencias: resumen.diferencias,
      });
    });
    return { id: corrida.id, ...resumen };
  }

  async recalculos() {
    return this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT r.id, r.desde::text AS desde, r.hasta::text AS hasta, r.motivo,
              r.creado_en AS "creadoEn", e.razon_social AS empresa,
              r.resumen - 'porEmpresa' AS resumen
         FROM retencion_recalculo r
         LEFT JOIN empresa e ON e.id = r.empresa_id
        ORDER BY r.creado_en DESC
        LIMIT 50`,
    );
  }

  /** El reporte de diferencias de un recálculo: todas las empresas, con su estado. */
  async recalculo(id: string) {
    const ds = this.conexion();
    const [corrida] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT id, desde::text AS desde, hasta::text AS hasta, motivo,
              creado_en AS "creadoEn", resumen
         FROM retencion_recalculo WHERE id = $1`,
      [id],
    );
    if (corrida === undefined) {
      throw new BadRequestException('No existe ese recálculo.');
    }
    const diferencias = await ds.query<Array<Record<string, unknown>>>(
      `SELECT d.id, em.razon_social AS empresa, d.fecha_causacion::text AS fecha,
              c.numero_factura_proveedor AS documento, d.impuesto, n.nombre AS concepto,
              d.municipio_codigo AS municipio, d.valor_antes::text AS "valorAntes",
              d.valor_nuevo::text AS "valorNuevo", d.diferencia::text AS diferencia,
              d.estado, d.motivo, d.explicacion->>'texto' AS texto
         FROM retencion_recalculo_diferencia d
         JOIN empresa em ON em.id = d.empresa_id
         JOIN retencion_concepto_nacional n ON n.id = d.concepto_nacional_id
         LEFT JOIN compra_documento c ON c.id = d.documento_id
        WHERE d.recalculo_id = $1
        ORDER BY em.razon_social, d.fecha_causacion`,
      [id],
    );
    return { ...corrida, diferencias };
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
