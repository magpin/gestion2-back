import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { MOTOR_VERSION } from '../reglas/renta.reglas';
import {
  MotorRentaService,
  type DocumentoRenta,
  type PropuestaRenta,
} from './motor-renta.service';

/** Lo que el anticipo retuvo, por cuenta: lo que va al asiento. */
export interface RetencionDeAnticipo {
  retencionCalculadaId: string;
  cuentaId: string;
  conceptoCodigo: string;
  base: number;
  valor: number;
}

/**
 * La retención de un anticipo a proveedor (decisión D11b del plan del menú
 * nuevo, que cierra la 8.11 del motor).
 *
 * La ley manda retener en el pago o abono en cuenta, lo que ocurra primero
 * (art. 394 ET): el anticipo es un pago, así que se retiene al entregarlo. Se
 * calcula con **el mismo motor que una compra**, como un documento de un solo
 * renglón por el valor del anticipo, así que valen las mismas guardas —agente
 * de retención, régimen simple, autorretenedor, ZOMAC, base mínima— y la
 * misma elección de concepto (nunca la aplica la IA sola).
 *
 * Solo se guarda la de **renta**: un anticipo no trae IVA y el ICA se
 * causa con la factura. Tampoco suma al acumulado anual del proveedor: lo
 * suma la compra cuando llega, y contarlo dos veces movería el umbral.
 *
 * Cuando el anticipo se cruza con la compra, la compra ya retuvo lo correcto
 * —con su concepto y su base—. Lo retenido en el anticipo por la parte
 * cruzada sobra, y se reversa en proporción: eso es «ajustar la diferencia en
 * la factura» cuando el concepto cambió, y evita retener dos veces cuando no.
 */
@Injectable()
export class AnticipoRetencionService {
  constructor(
    private readonly tx: TxService,
    private readonly motor: MotorRentaService,
  ) {}

  /** La propuesta del motor para el anticipo, sin guardar nada. */
  proponer(
    ctx: CtxEmpresa,
    datos: {
      terceroId: string;
      fecha: string;
      base: number;
      texto: string;
      conceptoCodigo?: string;
    },
    tx?: Tx,
  ): Promise<PropuestaRenta> {
    return this.motor.proponer(
      ctx,
      documento(datos),
      respuestas(datos.conceptoCodigo),
      tx,
    );
  }

  /**
   * Retiene y guarda. Exige lo que exige una compra: si el motor necesita el
   * perfil del proveedor o que se confirme el concepto, no se registra.
   * Devuelve lo retenido por cuenta —vacío si no corresponde retener—.
   */
  async confirmar(
    ctx: CtxEmpresa,
    datos: {
      anticipoId: string;
      terceroId: string;
      fecha: string;
      base: number;
      texto: string;
      conceptoCodigo?: string;
    },
    t: Tx,
  ): Promise<RetencionDeAnticipo[]> {
    const propuesta = await this.proponer(ctx, datos, t);
    if (propuesta.decision === 'REVISION') {
      throw new BadRequestException(
        `${propuesta.motivo} Completalo antes de entregar el anticipo.`,
      );
    }
    if (propuesta.pendientes > 0) {
      throw new BadRequestException(
        'Falta confirmar el concepto de retención del anticipo: elegilo antes de registrarlo.',
      );
    }

    const guardadas: RetencionDeAnticipo[] = [];
    for (const r of propuesta.retenciones) {
      if (r.impuesto !== 'RENTA' || r.asumida || r.valor <= 0) continue;
      if (r.cuentaId === null) {
        throw new BadRequestException(
          `No tenés la cuenta donde va la ${r.nombre.toLowerCase()}. Se crea sola cuando sos agente de ese impuesto.`,
        );
      }
      const creada = fila<{ id: string }>(
        await t.query(
          `INSERT INTO retencion_calculada
             (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
              concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
              tarifa_efectiva, valor, tarifa_id, uvt_valor, norma_aplicada,
              origen_clasificacion, explicacion, estado, motor_version, creado_por)
           VALUES ($1,'ANTICIPO_PROVEEDOR',$2,$3,'RENTA',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   'CONFIRMADA',$16,$17)
           RETURNING id`,
          [
            ctx.empresaId,
            datos.anticipoId,
            datos.terceroId,
            r.conceptoNacionalId,
            datos.fecha,
            r.base,
            r.explicacion.tarifa?.nominal ?? 0,
            r.explicacion.tarifa?.factor_zomac ?? 1,
            r.explicacion.tarifa?.efectiva ?? 0,
            r.valor,
            r.explicacion.tarifa?.tarifa_id ?? null,
            r.explicacion.uvt,
            r.explicacion.tarifa?.norma ?? '',
            r.explicacion.clasificacion?.origen ?? 'MANUAL',
            JSON.stringify({ ...r.explicacion, anticipo: true }),
            MOTOR_VERSION,
            ctx.usuarioId,
          ],
        ),
      );
      if (creada === undefined)
        throw new BadRequestException('No se pudo guardar la retención.');
      guardadas.push({
        retencionCalculadaId: creada.id,
        cuentaId: r.cuentaId,
        conceptoCodigo: r.conceptoCodigo,
        base: r.base,
        valor: r.valor,
      });
    }
    return guardadas;
  }

  /**
   * Reversa una proporción de lo que el anticipo retuvo y sigue vivo: una
   * fila en negativo por cada retención, con la misma tarifa y norma, en la
   * fecha del cruce. `proporcion` 1 lo reversa todo (anular el anticipo).
   * Devuelve lo reversado por cuenta, para el asiento.
   */
  async reversar(
    ctx: CtxEmpresa,
    datos: {
      anticipoId: string;
      proporcion: number;
      fecha: string;
      texto: string;
      /** El cruce que la reversa, para poder restablecerla si se anula. */
      cruceId?: string;
    },
    t: Tx,
  ): Promise<Array<{ cuentaId: string; base: number; valor: number }>> {
    const originales = filas<{
      id: string;
      tercero_id: string;
      concepto_nacional_id: string;
      base: string;
      valor: string;
      tarifa_nominal: string;
      factor_zomac: string;
      tarifa_efectiva: string;
      tarifa_id: string | null;
      uvt_valor: string | null;
      norma_aplicada: string;
      origen_clasificacion: string;
      vivo: string;
      base_viva: string;
      cuenta_id: string | null;
    }>(
      await t.query(
        `SELECT o.id, o.tercero_id, o.concepto_nacional_id, o.base, o.valor, o.tarifa_nominal,
                o.factor_zomac, o.tarifa_efectiva, o.tarifa_id, o.uvt_valor, o.norma_aplicada,
                o.origen_clasificacion,
                o.valor + coalesce((SELECT sum(r.valor) FROM retencion_calculada r
                                     WHERE r.anula_a = o.id), 0) AS vivo,
                o.base + coalesce((SELECT sum(r.base) FROM retencion_calculada r
                                    WHERE r.anula_a = o.id), 0) AS base_viva,
                (SELECT rc.cuenta_id FROM retencion_concepto rc
                  WHERE rc.concepto_nacional_id = o.concepto_nacional_id AND rc.activo
                  ORDER BY rc.creado_en DESC LIMIT 1) AS cuenta_id
           FROM retencion_calculada o
          WHERE o.documento_tipo = 'ANTICIPO_PROVEEDOR' AND o.documento_id = $1
            AND o.anula_a IS NULL AND o.estado = 'CONFIRMADA'`,
        [datos.anticipoId],
      ),
    );

    const porCuenta = new Map<string, { base: number; valor: number }>();
    for (const o of originales) {
      const vivo = Number(o.vivo);
      if (vivo <= 0) continue;
      const valor = Math.min(
        Math.round(Number(o.valor) * datos.proporcion),
        vivo,
      );
      const base = Math.min(
        Math.round(Number(o.base) * datos.proporcion * 100) / 100,
        Number(o.base_viva),
      );
      if (valor <= 0) continue;
      if (o.cuenta_id === null) {
        throw new BadRequestException(
          'No encuentro la cuenta de la retención del anticipo.',
        );
      }
      await t.query(
        `INSERT INTO retencion_calculada
           (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
            concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
            tarifa_efectiva, valor, tarifa_id, uvt_valor, norma_aplicada,
            origen_clasificacion, explicacion, estado, anula_a, motor_version, creado_por)
         VALUES ($1,'ANTICIPO_PROVEEDOR',$2,$3,'RENTA',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 'ANULADA',$16,$17,$18)`,
        [
          ctx.empresaId,
          datos.anticipoId,
          o.tercero_id,
          o.concepto_nacional_id,
          datos.fecha,
          -base,
          o.tarifa_nominal,
          o.factor_zomac,
          o.tarifa_efectiva,
          -valor,
          o.tarifa_id,
          o.uvt_valor,
          o.norma_aplicada,
          o.origen_clasificacion,
          JSON.stringify({
            motor_version: MOTOR_VERSION,
            reversa_de: o.id,
            proporcion: datos.proporcion,
            cruce_id: datos.cruceId ?? null,
            texto: datos.texto,
          }),
          o.id,
          MOTOR_VERSION,
          ctx.usuarioId,
        ],
      );
      const suma = porCuenta.get(o.cuenta_id) ?? { base: 0, valor: 0 };
      porCuenta.set(o.cuenta_id, {
        base: suma.base + base,
        valor: suma.valor + valor,
      });
    }
    return [...porCuenta].map(([cuentaId, v]) => ({ cuentaId, ...v }));
  }

  /**
   * Vuelve a poner lo que un cruce reversó, al anular el cruce: una fila en
   * positivo por cada reversa suya. Devuelve lo restablecido por cuenta.
   */
  async restablecer(
    ctx: CtxEmpresa,
    datos: { cruceId: string; fecha: string; texto: string },
    t: Tx,
  ): Promise<Array<{ cuentaId: string; base: number; valor: number }>> {
    const reversas = filas<{
      id: string;
      documento_id: string;
      tercero_id: string;
      concepto_nacional_id: string;
      base: string;
      valor: string;
      tarifa_nominal: string;
      factor_zomac: string;
      tarifa_efectiva: string;
      tarifa_id: string | null;
      uvt_valor: string | null;
      norma_aplicada: string;
      origen_clasificacion: string;
      anula_a: string;
      cuenta_id: string | null;
    }>(
      await t.query(
        `SELECT r.id, r.documento_id, r.tercero_id, r.concepto_nacional_id, r.base, r.valor,
                r.tarifa_nominal, r.factor_zomac, r.tarifa_efectiva, r.tarifa_id, r.uvt_valor,
                r.norma_aplicada, r.origen_clasificacion, r.anula_a,
                (SELECT rc.cuenta_id FROM retencion_concepto rc
                  WHERE rc.concepto_nacional_id = r.concepto_nacional_id AND rc.activo
                  ORDER BY rc.creado_en DESC LIMIT 1) AS cuenta_id
           FROM retencion_calculada r
          WHERE r.documento_tipo = 'ANTICIPO_PROVEEDOR' AND r.estado = 'ANULADA'
            AND r.explicacion->>'cruce_id' = $1`,
        [datos.cruceId],
      ),
    );
    const porCuenta = new Map<string, { base: number; valor: number }>();
    for (const r of reversas) {
      const valor = -Number(r.valor);
      const base = -Number(r.base);
      if (r.cuenta_id === null) {
        throw new BadRequestException(
          'No encuentro la cuenta de la retención del anticipo.',
        );
      }
      // Anula la reversa con su contraria: la retención original vuelve a
      // quedar viva por lo que el cruce le había quitado.
      await t.query(
        `INSERT INTO retencion_calculada
           (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
            concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
            tarifa_efectiva, valor, tarifa_id, uvt_valor, norma_aplicada,
            origen_clasificacion, explicacion, estado, anula_a, motor_version, creado_por)
         VALUES ($1,'ANTICIPO_PROVEEDOR',$2,$3,'RENTA',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 'ANULADA',$16,$17,$18)`,
        [
          ctx.empresaId,
          r.documento_id,
          r.tercero_id,
          r.concepto_nacional_id,
          datos.fecha,
          base,
          r.tarifa_nominal,
          r.factor_zomac,
          r.tarifa_efectiva,
          valor,
          r.tarifa_id,
          r.uvt_valor,
          r.norma_aplicada,
          r.origen_clasificacion,
          JSON.stringify({
            motor_version: MOTOR_VERSION,
            restablece: r.id,
            texto: datos.texto,
          }),
          r.anula_a,
          MOTOR_VERSION,
          ctx.usuarioId,
        ],
      );
      const suma = porCuenta.get(r.cuenta_id) ?? { base: 0, valor: 0 };
      porCuenta.set(r.cuenta_id, {
        base: suma.base + base,
        valor: suma.valor + valor,
      });
    }
    return [...porCuenta].map(([cuentaId, v]) => ({ cuentaId, ...v }));
  }

  /** Lo que retuvo el anticipo y sigue vivo, en total. */
  async vivo(t: Tx, anticipoId: string): Promise<number> {
    const r = fila<{ vivo: string }>(
      await t.query(
        `SELECT coalesce(sum(valor), 0) AS vivo FROM retencion_calculada
          WHERE documento_tipo = 'ANTICIPO_PROVEEDOR' AND documento_id = $1`,
        [anticipoId],
      ),
    );
    return Number(r?.vivo ?? 0);
  }
}

/** El documento de un renglón con que el motor calcula el anticipo. */
function documento(datos: {
  terceroId: string;
  fecha: string;
  base: number;
  texto: string;
}): DocumentoRenta {
  return {
    terceroId: datos.terceroId,
    fecha: datos.fecha,
    renglones: [
      {
        orden: 1,
        subtotal: datos.base,
        productoId: null,
        texto: datos.texto,
        cuentaCodigo: null,
      },
    ],
  };
}

function respuestas(conceptoCodigo: string | undefined) {
  return conceptoCodigo === undefined
    ? {}
    : { conceptos: [{ orden: 1, conceptoCodigo }] };
}
