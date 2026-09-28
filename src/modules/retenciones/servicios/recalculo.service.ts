import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  claveDe,
  compararRecalculo,
  type RetencionNueva,
  type Diferencia,
  type RetencionVivaClave,
} from '../reglas/recalculo.reglas';
import { MOTOR_VERSION } from '../reglas/renta.reglas';
import { faltaCuentaAutorretencion } from '../reglas/venta.reglas';
import {
  MotorRentaService,
  type DocumentoRenta,
  type RespuestasRenta,
} from './motor-renta.service';
import { MotorVentaService } from './motor-venta.service';
import { retencionesVivas } from './retenciones-vivas';

/** La cuenta por pagar a proveedores: la contrapartida del ajuste (R-D15). */
const CODIGO_CUENTA_PROVEEDORES = '220505';
const CODIGO_COMPROBANTE_DIARIO = 'CD';

export interface ResumenEmpresa {
  documentos: number;
  diferencias: number;
  /** Compras registradas sin entrada guardada: antes del motor o «sin retención». */
  sinEntrada: number;
  /** Las que el motor no pudo recalcular (falta tarifa, perfil…), con el porqué. */
  sinCalcular: string[];
}

export interface DiferenciaFila {
  documento_tipo: 'COMPRA' | 'VENTA';
  id: string;
  documento_id: string;
  tercero_id: string;
  impuesto: string;
  concepto_nacional_id: string;
  concepto: string;
  municipio_codigo: string | null;
  retencion_id: string | null;
  base: string;
  valor_antes: string;
  valor_nuevo: string;
  diferencia: string;
  tarifa_nueva: string | null;
  estado: string;
  documento: string | null;
  explicacion: { texto?: string; base_antes?: number };
}

/**
 * El recálculo por cambio de norma y sus ajustes (plan motor de retenciones,
 * Fase 6, §6.3; R-D6).
 *
 * - **Recalcular** corre el mismo motor, con la misma entrada que guardó la
 *   compra al confirmarse y el mismo concepto que eligió la persona, contra la
 *   norma que rige hoy para esa fecha. Compara con lo vivo y deja las
 *   diferencias. No toca asientos ni retenciones.
 * - **Ajustar** lo decide una persona (DIRECTOR o CONTADOR): ve el asiento, lo
 *   aprueba, y entonces se asienta y entra la retención que corrige, apuntando
 *   a la original (R6). Nunca solo (R11).
 */
@Injectable()
export class RecalculoService {
  constructor(
    private readonly tx: TxService,
    private readonly motorRenta: MotorRentaService,
    private readonly motorVenta: MotorVentaService,
    private readonly contabilidad: ContabilidadApi,
    private readonly nucleo: NucleoApi,
  ) {}

  /* ── Recalcular ────────────────────────────────────────────────────────── */

  async recalcularEmpresa(
    ctx: CtxEmpresa,
    datos: { recalculoId: string; desde: string; hasta: string },
    tx?: Tx,
  ): Promise<ResumenEmpresa> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const compras = filas<{
          id: string;
          fecha: string;
          numero: string;
          subtotal: string;
          devuelto: string;
          entrada: DocumentoRenta | null;
          respuestas: RespuestasRenta | null;
        }>(
          await t.query(
            `SELECT c.id, c.fecha::text AS fecha, c.numero_factura_proveedor AS numero,
                  c.subtotal::text AS subtotal,
                  (SELECT coalesce(sum(n.subtotal), 0)::text FROM compra_documento n
                    WHERE n.documento_origen_id = c.id AND n.tipo = 'NOTA_CREDITO'
                      AND n.estado <> 'ANULADA') AS devuelto,
                  e.entrada, e.respuestas
             FROM compra_documento c
             LEFT JOIN retencion_documento_entrada e
               ON e.documento_tipo = 'COMPRA' AND e.documento_id = c.id
            WHERE c.tipo = 'FACTURA' AND c.estado <> 'ANULADA'
              AND c.fecha BETWEEN $1::date AND $2::date
            ORDER BY c.fecha, c.id`,
            [datos.desde, datos.hasta],
          ),
        );
        const codigos = new Map(
          filas<{ id: string; codigo: string }>(
            await t.query(`SELECT id, codigo FROM retencion_concepto_nacional`),
          ).map((c) => [c.id, c.codigo]),
        );

        const resumen: ResumenEmpresa = {
          documentos: 0,
          diferencias: 0,
          sinEntrada: 0,
          sinCalcular: [],
        };

        for (const c of compras) {
          if (c.entrada === null || c.respuestas === null) {
            resumen.sinEntrada += 1;
            continue;
          }
          resumen.documentos += 1;

          // El acumulado de ICA de antes de la compra: el de hoy ya la trae
          // adentro y la contaba dos veces (bug 3). Las entradas viejas no lo
          // guardaron: se reconstruye con los aportes.
          const entrada: DocumentoRenta =
            c.entrada.acumuladoIcaAnterior !== undefined
              ? c.entrada
              : {
                  ...c.entrada,
                  acumuladoIcaAnterior:
                    await this.motorRenta.acumuladoIcaAntesDe(t, c.id),
                };
          const propuesta = await this.motorRenta.proponer(
            ctx,
            entrada,
            c.respuestas,
            t,
          );
          if (propuesta.decision === 'REVISION' || propuesta.pendientes > 0) {
            resumen.sinCalcular.push(`${c.numero}: ${propuesta.motivo}`);
            continue;
          }

          const nuevas: RetencionNueva[] = propuesta.retenciones.map((r) => ({
            impuesto: r.impuesto,
            conceptoCodigo: r.conceptoCodigo,
            conceptoId: r.conceptoNacionalId,
            municipio: r.municipio,
            nombre: r.nombre,
            base: r.base,
            valor: r.valor,
            tarifa: r.tarifa / 100,
            texto: r.texto,
          }));

          // Lo vivo de la compra, sumado por clave: la original más sus notas,
          // anulaciones y ajustes.
          const porClave = new Map<string, RetencionVivaClave>();
          for (const v of await retencionesVivas(t, c.id)) {
            if (v.documento_tipo !== 'COMPRA') continue;
            const conceptoCodigo = codigos.get(v.concepto_nacional_id) ?? '';
            const clave = claveDe({
              impuesto: v.impuesto,
              conceptoCodigo,
              municipio: v.municipio_codigo,
            });
            const previa = porClave.get(clave);
            if (previa === undefined) {
              porClave.set(clave, {
                retencionId: v.id,
                impuesto: v.impuesto as RetencionVivaClave['impuesto'],
                conceptoCodigo,
                conceptoId: v.concepto_nacional_id,
                municipio: v.municipio_codigo,
                base: Number(v.base),
                valor: Number(v.valor),
                tarifa: Number(v.tarifa_efectiva),
              });
            } else {
              previa.base += Number(v.base);
              previa.valor += Number(v.valor);
            }
          }

          const subtotal = Number(c.subtotal);
          const fraccion =
            subtotal > 0 ? Math.max(0, 1 - Number(c.devuelto) / subtotal) : 1;
          const diferencias = compararRecalculo(
            [...porClave.values()],
            nuevas,
            fraccion,
          );

          for (const d of diferencias) {
            await this.guardarDiferencia(t, ctx, datos.recalculoId, {
              documentoTipo: 'COMPRA',
              documentoId: c.id,
              terceroId: c.entrada.terceroId,
              fecha: c.fecha,
              fraccion,
              d,
            });
            resumen.diferencias += 1;
          }
        }
        // Las ventas: su autorretención de renta (especial o por resolución).
        const ventas = filas<{
          id: string;
          fecha: string;
          subtotal: string;
          devuelto: string;
          tercero_id: string;
          numero: string;
          entrada: {
            terceroId: string;
            fecha: string;
            subtotal: number;
            iva: number;
          } | null;
        }>(
          await t.query(
            `SELECT v.id, v.fecha::text AS fecha, v.subtotal::text AS subtotal, v.tercero_id,
                    concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text) AS numero,
                    (SELECT coalesce(sum(n.subtotal), 0)::text FROM venta_documento n
                      WHERE n.documento_origen_id = v.id AND n.tipo = 'NOTA_CREDITO'
                        AND n.estado <> 'ANULADA') AS devuelto,
                    e.entrada
               FROM venta_documento v
               LEFT JOIN retencion_documento_entrada e
                 ON e.documento_tipo = 'VENTA' AND e.documento_id = v.id
              WHERE v.tipo = 'FACTURA' AND v.estado <> 'ANULADA' AND NOT v.historica
                AND v.fecha BETWEEN $1::date AND $2::date
              ORDER BY v.fecha, v.id`,
            [datos.desde, datos.hasta],
          ),
        );
        for (const v of ventas) {
          if (v.entrada === null) {
            resumen.sinEntrada += 1;
            continue;
          }
          resumen.documentos += 1;
          const { nuevas, faltan } = await this.motorVenta.autorretencionesDe(
            ctx,
            v.entrada,
            t,
          );
          if (faltan.length > 0) {
            resumen.sinCalcular.push(`Venta ${v.numero}: ${faltan.join(' ')}`);
            continue;
          }
          const porClave = new Map<string, RetencionVivaClave>();
          for (const x of await retencionesVivas(t, v.id)) {
            if (
              x.documento_tipo !== 'VENTA' ||
              !x.es_autorretencion ||
              x.impuesto !== 'RENTA'
            ) {
              continue;
            }
            const conceptoCodigo = codigos.get(x.concepto_nacional_id) ?? '';
            const clave = claveDe({
              impuesto: 'RENTA',
              conceptoCodigo,
              municipio: null,
            });
            const previa = porClave.get(clave);
            if (previa === undefined) {
              porClave.set(clave, {
                retencionId: x.id,
                impuesto: 'RENTA',
                conceptoCodigo,
                conceptoId: x.concepto_nacional_id,
                municipio: null,
                base: Number(x.base),
                valor: Number(x.valor),
                tarifa: Number(x.tarifa_efectiva),
              });
            } else {
              previa.base += Number(x.base);
              previa.valor += Number(x.valor);
            }
          }
          const subtotal = Number(v.subtotal);
          const fraccion =
            subtotal > 0 ? Math.max(0, 1 - Number(v.devuelto) / subtotal) : 1;
          for (const d of compararRecalculo(
            [...porClave.values()],
            nuevas,
            fraccion,
            'venta',
          )) {
            await this.guardarDiferencia(t, ctx, datos.recalculoId, {
              documentoTipo: 'VENTA',
              documentoId: v.id,
              terceroId: v.tercero_id,
              fecha: v.fecha,
              fraccion,
              d,
            });
            resumen.diferencias += 1;
          }
        }

        return resumen;
      },
      tx,
    );
  }

  /**
   * Guarda una diferencia. Una pendiente de un recálculo anterior sobre la
   * misma retención queda vieja: la de ahora la reemplaza.
   */
  private async guardarDiferencia(
    t: Tx,
    ctx: CtxEmpresa,
    recalculoId: string,
    x: {
      documentoTipo: 'COMPRA' | 'VENTA';
      documentoId: string;
      terceroId: string;
      fecha: string;
      fraccion: number;
      d: Diferencia;
    },
  ): Promise<void> {
    const { d } = x;
    await t.query(
      `UPDATE retencion_recalculo_diferencia
          SET estado = 'DESCARTADA', resuelta_en = now(),
              motivo = 'Reemplazada por un recálculo más reciente.'
        WHERE documento_id = $1 AND impuesto = $2 AND concepto_nacional_id = $3
          AND COALESCE(municipio_codigo, '') = COALESCE($4, '')
          AND estado = 'PENDIENTE'`,
      [x.documentoId, d.impuesto, d.conceptoId, d.municipio],
    );
    await t.query(
      `INSERT INTO retencion_recalculo_diferencia
         (empresa_id, recalculo_id, documento_tipo, documento_id, tercero_id,
          fecha_causacion, impuesto, concepto_nacional_id, municipio_codigo,
          retencion_id, base, valor_antes, valor_nuevo, diferencia,
          tarifa_antes, tarifa_nueva, explicacion)
       VALUES ($1,$2,$17,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        ctx.empresaId,
        recalculoId,
        x.documentoId,
        x.terceroId,
        x.fecha,
        d.impuesto,
        d.conceptoId,
        d.municipio,
        d.retencionId,
        d.base,
        d.antes,
        d.nuevo,
        d.diferencia,
        d.tarifaAntes,
        d.tarifaNueva,
        JSON.stringify({
          motor_version: MOTOR_VERSION,
          fraccion_viva: x.fraccion,
          base_antes: d.baseAntes,
          texto: d.texto,
        }),
        x.documentoTipo,
      ],
    );
  }

  /* ── Lo que ve la empresa ──────────────────────────────────────────────── */

  async listar(ctx: CtxEmpresa) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT d.id, d.estado, d.fecha_causacion::text AS fecha, d.impuesto,
                  n.nombre AS concepto, d.municipio_codigo AS municipio,
                  COALESCE(c.numero_factura_proveedor,
                           (SELECT concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text)
                              FROM venta_documento v WHERE v.id = d.documento_id)) AS documento,
                  d.documento_tipo AS "documentoTipo",
                  COALESCE(nullif(btrim(te.razon_social), ''),
                           nullif(btrim(concat_ws(' ', te.primer_nombre, te.primer_apellido)), ''),
                           'Tercero sin nombre') AS tercero,
                  d.base::text AS base, d.valor_antes::text AS "valorAntes",
                  d.valor_nuevo::text AS "valorNuevo", d.diferencia::text AS diferencia,
                  d.explicacion->>'texto' AS texto, r.motivo AS norma,
                  r.creado_en AS "recalculadoEn", d.motivo, d.resuelta_en AS "resueltaEn",
                  a.numero AS asiento
             FROM retencion_recalculo_diferencia d
             JOIN retencion_recalculo r ON r.id = d.recalculo_id
             JOIN retencion_concepto_nacional n ON n.id = d.concepto_nacional_id
             LEFT JOIN compra_documento c ON c.id = d.documento_id
             LEFT JOIN tercero te ON te.id = d.tercero_id
             LEFT JOIN asiento a ON a.id = d.asiento_id
            ORDER BY (d.estado = 'PENDIENTE') DESC, d.creado_en DESC
            LIMIT 500`,
        ),
      ),
    );
  }

  /**
   * Los ajustes por cambio de norma que se asentaron sobre una compra y siguen
   * vivos. Anular la compra los anula también (Fase 8, §8.3): su retención ya
   * se reversa con la compra, y un asiento suelto descuadraría el 350.
   */
  async ajustesDeCompra(
    ctx: CtxEmpresa,
    compraId: string,
    tx?: Tx,
  ): Promise<
    Array<{ asientoId: string; asiento: string; diferencia: number }>
  > {
    return this.tx.enContexto(
      ctx,
      async (t) =>
        filas<{ asiento_id: string; numero: string; diferencia: string }>(
          await t.query(
            `SELECT d.asiento_id, a.numero, d.diferencia::text AS diferencia
               FROM retencion_recalculo_diferencia d
               JOIN asiento a ON a.id = d.asiento_id
              WHERE d.documento_id = $1 AND d.estado = 'AJUSTADA'
                AND a.estado = 'REGISTRADO'
              ORDER BY a.numero`,
            [compraId],
          ),
        ).map((f) => ({
          asientoId: f.asiento_id,
          asiento: f.numero,
          diferencia: Number(f.diferencia),
        })),
      tx,
    );
  }

  /* ── Ajustar ───────────────────────────────────────────────────────────── */

  /**
   * El asiento que corrige una diferencia, sin registrar nada: lo que la
   * persona ve antes de aprobar.
   *
   * Contra la cuenta por pagar al proveedor (R-D15, pendiente de Yeris): si se
   * retuvo de menos, se le paga menos; si se retuvo de más, se le debe.
   */
  async verAjuste(ctx: CtxEmpresa, id: string, tx?: Tx) {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const d = await this.diferencia(t, id);
        const lineas = await this.lineas(ctx, d, t);
        // Con código y nombre: la persona aprueba lo que lee, no un id.
        const nombres = new Map(
          filas<{ id: string; codigo: string; nombre: string }>(
            await t.query(
              `SELECT id, codigo, nombre FROM empresa_cuenta WHERE id = ANY($1)`,
              [lineas.map((l) => l.cuentaId)],
            ),
          ).map((c) => [c.id, c]),
        );
        return {
          texto: d.explicacion.texto ?? null,
          diferencia: Number(d.diferencia),
          lineas: lineas.map((l) => ({
            codigo: nombres.get(l.cuentaId)?.codigo ?? '',
            cuenta: nombres.get(l.cuentaId)?.nombre ?? '',
            debito: l.debito,
            credito: l.credito,
          })),
        };
      },
      tx,
    );
  }

  async registrarAjuste(ctx: CtxEmpresa, id: string, tx?: Tx) {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const d = await this.diferencia(t, id, true);
        if (d.estado !== 'PENDIENTE') {
          throw new ConflictException(
            d.estado === 'AJUSTADA'
              ? 'Esta diferencia ya se ajustó.'
              : 'Esta diferencia se descartó: no se ajusta.',
          );
        }
        const lineas = await this.lineas(ctx, d, t);
        const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
          ctx,
          CODIGO_COMPROBANTE_DIARIO,
          t,
        );
        if (comprobante === null) {
          throw new BadRequestException(
            'La empresa no tiene el comprobante de diario (CD).',
          );
        }
        const fecha = hoyEnColombia();
        const asiento = await this.contabilidad.asentar(
          ctx,
          {
            comprobanteTipoId: comprobante.id,
            fecha,
            glosa: `Ajuste de ${d.concepto.toLowerCase()} de la ${d.documento_tipo === 'VENTA' ? 'venta' : 'compra'} ${d.documento ?? ''} por cambio de norma`,
            lineas,
          },
          { origenTipo: d.documento_tipo, origenId: d.documento_id },
          t,
        );

        // La retención que corrige: una fila nueva, nunca un UPDATE (R6). Va en
        // el mes del ajuste; si resta, el 350 la lleva a «Menos».
        const original =
          d.retencion_id === null
            ? undefined
            : fila<{
                tarifa_nominal: string;
                factor_zomac: string;
                origen_clasificacion: string;
                tarifa_id: string | null;
              }>(
                await t.query(
                  `SELECT tarifa_nominal, factor_zomac, origen_clasificacion, tarifa_id
                   FROM retencion_calculada WHERE id = $1`,
                  [d.retencion_id],
                ),
              );
        const tarifa = Number(d.tarifa_nueva ?? original?.tarifa_nominal ?? 0);
        const diferencia = Number(d.diferencia);
        const [ajuste] = filas<{ id: string }>(
          await t.query(
            `INSERT INTO retencion_calculada
             (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
              concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
              tarifa_efectiva, valor, norma_aplicada, origen_clasificacion, explicacion,
              estado, anula_a, motor_version, creado_por, municipio_codigo,
              es_autorretencion)
           VALUES ($1,$19,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'CONFIRMADA',$15,$16,$17,$18,$20)
           RETURNING id`,
            [
              ctx.empresaId,
              d.documento_id,
              d.tercero_id,
              d.impuesto,
              d.concepto_nacional_id,
              fecha,
              // La diferencia de bases: si solo cambió la tarifa, cero; así el
              // 350 no cuenta dos veces la misma base.
              Math.round(
                (Number(d.base) - (d.explicacion.base_antes ?? 0)) * 100,
              ) / 100,
              tarifa,
              original?.factor_zomac ?? 1,
              tarifa,
              diferencia,
              'Ajuste por cambio de norma (recálculo)',
              original?.origen_clasificacion ?? 'CONFIRMADO',
              JSON.stringify({
                motor_version: MOTOR_VERSION,
                ajuste_de: d.id,
                texto: d.explicacion.texto ?? 'Ajuste por cambio de norma.',
              }),
              d.retencion_id,
              MOTOR_VERSION,
              ctx.usuarioId,
              d.municipio_codigo,
              d.documento_tipo,
              d.documento_tipo === 'VENTA',
            ],
          ),
        );

        await t.query(
          `UPDATE retencion_recalculo_diferencia
            SET estado = 'AJUSTADA', asiento_id = $2, retencion_ajuste_id = $3,
                resuelta_por = $4, resuelta_en = now()
          WHERE id = $1 AND estado = 'PENDIENTE'`,
          [d.id, asiento.id, ajuste.id, ctx.usuarioId],
        );
        return { asiento: asiento.numero };
      },
      tx,
    );
  }

  async descartar(ctx: CtxEmpresa, id: string, motivo: string, tx?: Tx) {
    const limpio = motivo.trim();
    if (limpio.length === 0) {
      throw new BadRequestException('Decí por qué no se ajusta.');
    }
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const d = await this.diferencia(t, id, true);
        if (d.estado !== 'PENDIENTE') {
          throw new ConflictException('Esta diferencia ya está resuelta.');
        }
        await t.query(
          `UPDATE retencion_recalculo_diferencia
            SET estado = 'DESCARTADA', motivo = $2, resuelta_por = $3, resuelta_en = now()
          WHERE id = $1 AND estado = 'PENDIENTE'`,
          [id, limpio, ctx.usuarioId],
        );
      },
      tx,
    );
  }

  private async diferencia(
    t: Tx,
    id: string,
    bloquear = false,
  ): Promise<DiferenciaFila> {
    const d = fila<DiferenciaFila>(
      await t.query(
        `SELECT d.id, d.documento_id, d.tercero_id, d.impuesto, d.concepto_nacional_id,
                n.nombre AS concepto, d.municipio_codigo, d.retencion_id,
                d.base::text AS base, d.valor_antes::text AS valor_antes,
                d.valor_nuevo::text AS valor_nuevo, d.diferencia::text AS diferencia,
                d.tarifa_nueva::text AS tarifa_nueva, d.estado, d.explicacion,
                d.documento_tipo,
                COALESCE((SELECT c.numero_factura_proveedor FROM compra_documento c
                           WHERE c.id = d.documento_id),
                         (SELECT concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text)
                            FROM venta_documento v WHERE v.id = d.documento_id)) AS documento
           FROM retencion_recalculo_diferencia d
           JOIN retencion_concepto_nacional n ON n.id = d.concepto_nacional_id
          WHERE d.id = $1
          ${bloquear ? 'FOR UPDATE OF d' : ''}`,
        [id],
      ),
    );
    if (d === undefined)
      throw new NotFoundException('Diferencia no encontrada.');
    return d;
  }

  /**
   * Retuvo de menos: débito al proveedor (se le paga menos), crédito a la
   * retención. Retuvo de más: al revés.
   */
  private async lineas(ctx: CtxEmpresa, d: DiferenciaFila, t: Tx) {
    // Una venta: se autorretuvo de menos → más anticipo (135515) y más por
    // pagar (236575); de más, al revés. No toca al cliente.
    if (d.documento_tipo === 'VENTA') {
      const [c] = filas<{
        cuenta_id: string | null;
        cuenta_activo_id: string | null;
      }>(
        await t.query(
          `SELECT rc.cuenta_id, rc.cuenta_activo_id
             FROM retencion_concepto rc
             JOIN retencion_concepto_nacional n ON n.id = rc.concepto_nacional_id
            WHERE rc.empresa_id = $1 AND n.codigo = 'AUTORRETENCION_ESPECIAL'
              AND rc.anio IS NULL AND rc.activo
            LIMIT 1`,
          [ctx.empresaId],
        ),
      );
      const falta = faltaCuentaAutorretencion(c ?? null, 'RENTA');
      if (
        falta !== null ||
        c?.cuenta_id == null ||
        c.cuenta_activo_id == null
      ) {
        const texto = falta ?? '';
        throw new BadRequestException(
          texto.charAt(0).toUpperCase() + texto.slice(1),
        );
      }
      const valor = Math.abs(Number(d.diferencia));
      const pasivo = {
        cuentaId: c.cuenta_id,
        baseGravable:
          Math.abs(Number(d.base)) || Math.abs(d.explicacion.base_antes ?? 0),
      };
      const activo = { cuentaId: c.cuenta_activo_id };
      return Number(d.diferencia) > 0
        ? [
            { ...activo, debito: valor, credito: 0 },
            { ...pasivo, debito: 0, credito: valor },
          ]
        : [
            { ...pasivo, debito: valor, credito: 0 },
            { ...activo, debito: 0, credito: valor },
          ];
    }
    const [cuenta] = filas<{ cuenta_id: string | null }>(
      await t.query(
        `SELECT cuenta_id FROM retencion_concepto
          WHERE empresa_id = $1 AND concepto_nacional_id = $2
            AND anio IS NULL AND activo
          LIMIT 1`,
        [ctx.empresaId, d.concepto_nacional_id],
      ),
    );
    if (cuenta?.cuenta_id == null) {
      throw new BadRequestException(
        `No tenés la cuenta donde va la ${d.concepto.toLowerCase()}. Se crea sola en el plan de cuentas cuando sos agente de ese impuesto.`,
      );
    }
    const proveedores = await this.nucleo.cuenta(
      ctx,
      CODIGO_CUENTA_PROVEEDORES,
      t,
    );
    if (proveedores === null) {
      throw new BadRequestException(
        `No existe o está inactiva la cuenta de proveedores (${CODIGO_CUENTA_PROVEEDORES}).`,
      );
    }
    const valor = Math.abs(Number(d.diferencia));
    const retencion = {
      cuentaId: cuenta.cuenta_id,
      terceroId: d.tercero_id,
      baseGravable:
        Math.abs(Number(d.base)) || Math.abs(d.explicacion.base_antes ?? 0),
    };
    const proveedor = { cuentaId: proveedores.id, terceroId: d.tercero_id };
    return Number(d.diferencia) > 0
      ? [
          { ...proveedor, debito: valor, credito: 0 },
          { ...retencion, debito: 0, credito: valor },
        ]
      : [
          { ...retencion, debito: valor, credito: 0 },
          { ...proveedor, debito: 0, credito: valor },
        ];
  }
}
