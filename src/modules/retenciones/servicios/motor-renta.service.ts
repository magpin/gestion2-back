import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  clasificar,
  llaveDe,
  type Aprendido,
  type Clasificacion,
  type PropuestaIa,
} from '../reglas/clasificacion.reglas';
import {
  acumuladoIcaAntes,
  calcularIca,
  municipioDeCausacion,
  periodoDe,
  type FilaMatriz,
  type ParametroIca,
  type PerfilIcaTercero,
  type ResultadoIca,
} from '../reglas/ica.reglas';
import {
  calcularIva,
  esBien,
  type BeneficiarioIva,
  type ConceptoIva,
  type ResultadoIva,
} from '../reglas/iva.reglas';
import {
  aplicarConvenio,
  calcularRenta,
  MOTOR_VERSION,
  type ConceptoRenta,
  type Explicacion,
  type PerfilBeneficiario,
  type RenglonRenta,
  type ResultadoRenta,
} from '../reglas/renta.reglas';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  avisoPagoExterior,
  subcuentaIvaPorCrear,
  subcuentasPorCrear,
} from '../reglas/exterior.reglas';
import { ParametrosService } from './parametros.service';
import {
  paraReversar,
  retencionesVivas,
  type RetencionViva,
} from './retenciones-vivas';
import {
  contrarrestoAlAnular,
  reversaProporcional,
} from '../reglas/anulacion.reglas';

/** Un renglón del documento, como lo ve el motor. */
export interface RenglonDocumento {
  orden: number;
  /** Sin IVA. */
  subtotal: number;
  descuento?: number;
  productoId: string | null;
  /** El detalle del gasto o el nombre del producto. */
  texto: string | null;
  /** La cuenta de gasto, si es un gasto. */
  cuentaCodigo: string | null;
  /** La retención que sugiere el concepto del gasto (PC23), si la trae. */
  sugerida?: { concepto: string; nombreConcepto: string } | null;
  /** El IVA que factura el proveedor en el renglón (ReteIVA, Fase 2). */
  iva?: number;
  /** Si el renglón se causa en otro municipio que la compra (ReteICA). */
  municipio?: string | null;
  /**
   * El AIU del renglón, cuando la factura lo discrimina: temporales, aseo y
   * vigilancia retienen sobre el AIU (R-D3, Fase 8, §8.13).
   */
  aiu?: number;
}

export interface DocumentoRenta {
  terceroId: string;
  fecha: string;
  /** Si la factura informa la categoría ZOMAC del proveedor. */
  zomacEnFactura?: boolean;
  /** Pagada con tarjeta: retiene la entidad de la tarjeta, no la empresa. */
  pagadaConTarjeta?: boolean;
  /** El municipio de la sede que recibe la compra; sin dato, la principal. */
  municipioCompra?: string | null;
  /**
   * Los aportes a salud y pensión que el proveedor persona natural soporta
   * con su planilla: bajan la base de la tabla del art. 383 (§8.14).
   */
  aportesSeguridadSocial?: number;
  /**
   * El acumulado del año por concepto que usó el motor al confirmar: el
   * recálculo lo usa en vez del de hoy (Fase 8, §8.10).
   */
  acumuladoAnterior?: Record<string, number>;
  /**
   * El acumulado de ICA del período por municipio que había antes de este
   * documento, el que usó el motor al confirmar. El recálculo lo usa en vez
   * del de hoy, que ya trae la compra adentro y la contaba dos veces (bug 3).
   */
  acumuladoIcaAnterior?: Record<string, number>;
  renglones: RenglonDocumento[];
}

/** Lo que la persona contestó: el concepto de cada renglón que lo necesitaba. */
export interface RespuestasRenta {
  conceptos?: Array<{ orden: number; conceptoCodigo: string }>;
  /**
   * La tarifa de convenio que la persona eligió aplicar a un renglón de un pago
   * al exterior (Fase 8, §8.15). Nunca se aplica sola.
   */
  convenios?: Array<{ orden: number; tipo: 'INTERESES' | 'REGALIAS' }>;
}

export interface RenglonPropuesto extends Clasificacion {
  /**
   * Las tarifas de convenio que se pueden aplicar a este renglón: el proveedor
   * es del exterior, tiene certificado de residencia vigente y su país tiene
   * convenio (§8.15). La persona elige; el motor no.
   */
  convenios?: Array<{
    tipo: 'INTERESES' | 'REGALIAS';
    tarifa: number;
    pais: string;
    paisNombre: string;
    ley: string;
  }>;
  /** El tipo de renta del convenio que se aplicó, si se aplicó. */
  convenioAplicado?: 'INTERESES' | 'REGALIAS' | null;
  /** Su concepto retiene sobre el AIU: la pantalla pide el AIU (§8.13). */
  pideAiu?: boolean;
  /** El concepto con el que se va a calcular: el propuesto o el que eligieron. */
  elegido: string | null;
  /** «La deduje» sin aceptar o «Te pregunto» sin respuesta. */
  pendiente: boolean;
  /**
   * Ninguna fuente dijo nada y a la IA todavía no se le preguntó por este
   * renglón (fuente 5). Lo usa `ClasificadorIaService`; la pantalla no.
   */
  pideIa: boolean;
}

export interface RetencionPropuesta {
  impuesto: 'RENTA' | 'IVA' | 'ICA';
  /** Solo en ReteICA: dónde se causó. */
  municipio: string | null;
  /**
   * IVA que asume la empresa (servicios del exterior): no baja lo que se le
   * paga al proveedor, se debita como IVA descontable.
   */
  asumida: boolean;
  conceptoCodigo: string;
  conceptoNacionalId: string;
  nombre: string;
  renglones: number[];
  base: number;
  /** En porcentaje: 2.5. */
  tarifa: number;
  valor: number;
  /** La cuenta 2365xx (renta) o 2367xx (IVA) de la empresa; `null` si no la tiene. */
  cuentaId: string | null;
  texto: string;
  explicacion: Explicacion;
}

export interface PropuestaRenta {
  decision: ResultadoRenta['decision'];
  motivo: string;
  renglones: RenglonPropuesto[];
  retenciones: RetencionPropuesta[];
  sinRetener: Array<{ conceptoCodigo: string; nombre: string; texto: string }>;
  pendientes: number;
  /**
   * Si algún renglón va por la tabla del art. 383: la pantalla pide los
   * aportes a seguridad social del proveedor (§8.14).
   */
  pideAportes: boolean;
  /** El acumulado por concepto que se usó (Fase 8, §8.10). Solo del servidor. */
  acumuladoAnterior?: Record<string, number>;
  /** El acumulado de ICA del período que se usó, por municipio (bug 3). */
  acumuladoIcaAnterior?: Record<string, number>;
  conceptos: Array<{ codigo: string; nombre: string }>;
  /** Lo que conviene saber aunque no cambie nada hoy (plan §1.10). */
  avisos: string[];
  /** Lo que suma al acumulado de ICA del período, por municipio (Fase 3). */
  acumularIca: Array<{
    municipio: string;
    anio: number;
    periodo: number;
    base: number;
    retenido: number;
  }>;
}

/** Lo que una nota crédito reversaría de una retención de la compra (bug 4). */
export interface ReversaPrevista {
  /** La retención original de la compra. */
  retencionId: string;
  /** `concepto|municipio`, como la guarda `compra_retencion`. */
  clave: string;
  /** En positivo, al peso en el valor. */
  base: number;
  valor: number;
  viva: RetencionViva;
}

export interface RentaConfirmada {
  decision: 'CALCULADA' | 'BAJO_BASE' | 'NO_SUJETO';
  motivo: string;
  retenciones: Array<
    RetencionPropuesta & { cuentaId: string; retencionCalculadaId: string }
  >;
}

interface ConceptoFila {
  id: string;
  codigo: string;
  nombre: string;
  usa_acumulado_anual: boolean;
  umbral_acumulado_uvt: string | null;
  usa_tabla_383: boolean;
  base_es_aiu: boolean;
  subcuenta_pasivo: string;
  cuenta_id: string | null;
}

interface PerfilFila {
  tipo_persona: 'NATURAL' | 'JURIDICA';
  es_responsable_iva: boolean;
  es_agente_ret_iva: boolean;
  agente_iva_numeral: number | null;
  tipo_documento: string;
  regimen_renta: PerfilBeneficiario['regimenRenta'];
  declarante_renta: boolean;
  es_autorretenedor_renta: boolean;
  es_gran_contribuyente: boolean;
  es_zomac: boolean;
  zomac_tamano: PerfilBeneficiario['zomacTamano'];
  contrato_dos_o_mas_trabajadores: boolean;
  ciiu_principal: string | null;
  desde: string;
}

/** Quien puede practicar retención de renta (art. 368 ET). */
const AGENTE_RENTA = [
  'AGENTE_RETENEDOR_RENTA',
  'AUTORRETENEDOR_RENTA',
  'GRAN_CONTRIBUYENTE',
];

/** Quien retiene IVA (art. 437-2 ET). El gran contribuyente, por el numeral 1. */
const AGENTE_IVA = ['AGENTE_RETENEDOR_IVA', 'GRAN_CONTRIBUYENTE'];

/** La tarifa general de IVA, para el que asume la empresa en servicios del exterior. */
const TARIFA_IVA_GENERAL = 0.19;

/** Documentos de quien no está en Colombia: sus servicios vienen del exterior. */
const DOCUMENTOS_EXTERIOR = ['NIT_EXTRANJERO', 'DOC_EXTRANJERO'];

/**
 * El motor de renta con la base al lado: arma el contexto, llama a las reglas
 * puras, guarda lo calculado y aprende lo que se confirma (plan motor de
 * retenciones, Fase 1, §1.3 y §1.6).
 *
 * Dos momentos, y los dos pasan por aquí —la compra manual, la de María y las
 * notas—, así que un mismo renglón da la misma retención venga de donde venga:
 *
 * - `proponer`: sin guardar nada. Clasifica, calcula y dice qué falta
 *   contestar. Es lo que muestran las pantallas.
 * - `confirmar`: exige que todo lo deducido esté aceptado, guarda cada
 *   retención con su explicación y devuelve lo que va al asiento.
 */
@Injectable()
export class MotorRentaService {
  constructor(
    private readonly tx: TxService,
    private readonly parametros: ParametrosService,
    private readonly nucleo: NucleoApi,
  ) {}

  async proponer(
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    respuestas: RespuestasRenta = {},
    tx?: Tx,
  ): Promise<PropuestaRenta> {
    return this.tx.enContexto(
      ctx,
      (t) => this.proponerEn(t, ctx, doc, respuestas),
      tx,
    );
  }

  async confirmar(
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    respuestas: RespuestasRenta,
    documento: { tipo: 'COMPRA' | 'NOTA_DEBITO_COMPRA'; id: string },
    t: Tx,
  ): Promise<RentaConfirmada> {
    const propuesta = await this.proponerEn(t, ctx, doc, respuestas);

    if (propuesta.decision === 'REVISION') {
      throw new BadRequestException(
        `${propuesta.motivo} Complételo, o registre la compra «sin retención» con el motivo.`,
      );
    }
    if (propuesta.pendientes > 0) {
      const cuales = propuesta.renglones
        .filter((r) => r.pendiente)
        .map((r) => `renglón ${r.orden}`)
        .join(', ');
      throw new BadRequestException(
        `Falta confirmar el concepto de retención de ${cuales}. «La deduje» se acepta o se cambia antes de registrar.`,
      );
    }

    // Lo que recibió el motor y el concepto que quedó en cada renglón: con
    // esto, un cambio de norma se recalcula con la misma entrada (Fase 6,
    // §6.3). La compra no guarda todo lo que el motor usa.
    await t.query(
      `INSERT INTO retencion_documento_entrada
         (empresa_id, documento_tipo, documento_id, entrada, respuestas, motor_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ctx.empresaId,
        documento.tipo,
        documento.id,
        JSON.stringify({
          ...doc,
          acumuladoAnterior: propuesta.acumuladoAnterior ?? {},
          acumuladoIcaAnterior: propuesta.acumuladoIcaAnterior ?? {},
        }),
        JSON.stringify({
          conceptos: propuesta.renglones
            .filter((r) => r.elegido !== null)
            .map((r) => ({ orden: r.orden, conceptoCodigo: r.elegido })),
          convenios: respuestas.convenios ?? [],
        }),
        MOTOR_VERSION,
      ],
    );

    const confirmadas: RentaConfirmada['retenciones'] = [];
    for (const r of propuesta.retenciones) {
      if (r.cuentaId === null) {
        throw new BadRequestException(
          `No tiene la cuenta donde va la ${r.nombre.toLowerCase()}. Se crea sola en el plan de cuentas cuando es agente de ese impuesto.`,
        );
      }
      const [fila] = filas<{ id: string }>(
        await t.query(
          `INSERT INTO retencion_calculada
             (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
              concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
              tarifa_efectiva, valor, tarifa_id, uvt_valor, norma_aplicada,
              origen_clasificacion, explicacion, estado, motor_version, creado_por,
              municipio_codigo)
           VALUES ($1,$2,$3,$4,$19,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CONFIRMADA',$17,$18,$20)
           RETURNING id`,
          [
            ctx.empresaId,
            documento.tipo,
            documento.id,
            doc.terceroId,
            r.conceptoNacionalId,
            doc.fecha,
            r.base,
            r.explicacion.tarifa?.nominal ?? 0,
            r.explicacion.tarifa?.factor_zomac ?? 1,
            r.explicacion.tarifa?.efectiva ?? 0,
            r.valor,
            // ICA no tiene fila en retencion_tarifa: su norma es el acuerdo.
            r.impuesto === 'ICA'
              ? null
              : (r.explicacion.tarifa?.tarifa_id ?? null),
            r.explicacion.uvt,
            r.explicacion.tarifa?.norma ?? '',
            r.impuesto !== 'RENTA'
              ? 'PRODUCTO'
              : (r.explicacion.clasificacion?.origen ?? 'MANUAL'),
            JSON.stringify(r.explicacion),
            MOTOR_VERSION,
            ctx.usuarioId,
            r.impuesto,
            r.municipio,
          ],
        ),
      );
      confirmadas.push({
        ...r,
        cuentaId: r.cuentaId,
        retencionCalculadaId: fila.id,
      });
    }

    await this.sumarAcumulado(t, ctx, doc, propuesta);
    await this.aprender(t, ctx, doc, propuesta);

    // Los aciertos por fuente (Fase 5): qué propuso cada una y qué se eligió.
    for (const r of propuesta.renglones) {
      if (r.elegido === null) continue;
      await t.query(
        `INSERT INTO retencion_clasificacion_uso
           (empresa_id, documento_tipo, documento_id, orden, origen_propuesto,
            concepto_propuesto, concepto_elegido, acerto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ctx.empresaId,
          documento.tipo,
          documento.id,
          r.orden,
          r.origen,
          r.concepto,
          r.elegido,
          r.concepto === r.elegido,
        ],
      );
    }

    // ReteICA: lo causado en el período suma, retenga o no (Medellín acumula
    // el bimestre: las compras pequeñas juntas pueden pasar la base).
    for (const a of propuesta.acumularIca) {
      await this.aportarIca(
        t,
        ctx,
        {
          compraId: documento.id,
          documentoId: documento.id,
          terceroId: doc.terceroId,
          municipio: a.municipio,
          anio: a.anio,
          periodo: a.periodo,
        },
        a.base,
        a.retenido,
      );
    }

    return {
      decision: propuesta.decision,
      // Lo que no se pudo calcular queda escrito en la compra, no solo en pantalla.
      motivo: [propuesta.motivo, ...propuesta.avisos].join(' '),
      retenciones: confirmadas,
    };
  }

  /**
   * Cuánto reversaría una nota crédito de cada retención de la compra, sin
   * escribir nada. Lo usa la nota para su asiento y `reversar` para sus
   * filas: la misma cifra en los dos lados, al peso (bug 4).
   *
   * Por retención original de la compra (renta, IVA e ICA; no las de una
   * nota débito, que es otro documento): la proporción de lo que puso la
   * compra —la original más sus ajustes por cambio de norma—, sin pasar de lo
   * que le queda viva.
   */
  async reversaPrevista(
    t: Tx,
    datos: { compraId: string; proporcion: number },
  ): Promise<ReversaPrevista[]> {
    const vivas = (await retencionesVivas(t, datos.compraId)).filter(
      (o) =>
        o.documento_tipo === 'COMPRA' &&
        !o.es_autorretencion &&
        ['RENTA', 'IVA', 'ICA'].includes(o.impuesto),
    );
    const previstas: ReversaPrevista[] = [];
    for (const o of vivas) {
      const r = reversaProporcional(paraReversar(o), datos.proporcion);
      if (r === null) continue;
      previstas.push({
        retencionId: o.id,
        clave: `${o.concepto_codigo}|${o.municipio_codigo ?? ''}`,
        base: r.base,
        valor: r.valor,
        viva: o,
      });
    }
    return previstas;
  }

  /**
   * Una nota crédito devuelve parte de la compra: la retención baja en la
   * misma proporción (caso borde 4). Nada se edita: por cada retención de la
   * compra entra una fila nueva, en negativo, que apunta a la original
   * (`anula_a`), y el acumulado de honorarios baja lo devuelto.
   *
   * La cifra es la de `reversaPrevista`: con los ajustes por cambio de norma
   * adentro y al peso, igual que el asiento de la nota.
   *
   * Devuelve, por `concepto|municipio`, el id de la fila nueva, para
   * `compra_retencion`.
   */
  async reversar(
    ctx: CtxEmpresa,
    datos: {
      compraId: string;
      notaId: string;
      proporcion: number;
      fecha: string;
    },
    t: Tx,
  ): Promise<Map<string, string>> {
    const nuevas = new Map<string, string>();
    const pct = Math.round(datos.proporcion * 10000) / 100;
    for (const p of await this.reversaPrevista(t, datos)) {
      const o = p.viva;
      const [fila] = filas<{ id: string }>(
        await t.query(
          `INSERT INTO retencion_calculada
             (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
              concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
              tarifa_efectiva, valor, tarifa_id, uvt_valor, norma_aplicada,
              origen_clasificacion, explicacion, estado, anula_a, motor_version, creado_por,
              municipio_codigo)
           VALUES ($1,'NOTA_CREDITO_COMPRA',$2,$3,$19,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ANULADA',$16,$17,$18,$20)
           RETURNING id`,
          [
            ctx.empresaId,
            datos.notaId,
            o.tercero_id,
            o.concepto_nacional_id,
            datos.fecha,
            -p.base,
            o.tarifa_nominal,
            o.factor_zomac,
            o.tarifa_efectiva,
            -p.valor,
            o.tarifa_id,
            o.uvt_valor,
            o.norma_aplicada,
            o.origen_clasificacion,
            JSON.stringify({
              motor_version: MOTOR_VERSION,
              reversa_de: o.id,
              proporcion: datos.proporcion,
              texto: `Nota crédito: reversé el ${pct.toLocaleString('es-CO')} % de la retención (${p.valor.toLocaleString('es-CO')} de ${Math.round(Number(o.valor_documento)).toLocaleString('es-CO')}), con la misma tarifa y norma de la compra.`,
            }),
            o.id,
            MOTOR_VERSION,
            ctx.usuarioId,
            o.impuesto,
            o.municipio_codigo,
          ],
        ),
      );
      nuevas.set(p.clave, fila.id);

      if (o.usa_acumulado_anual) {
        await t.query(
          `UPDATE retencion_acumulado
              SET base_acumulada = greatest(base_acumulada - $5, 0), actualizado_en = now()
            WHERE empresa_id = $1 AND tercero_id = $2 AND concepto_nacional_id = $3 AND anio = $4`,
          [
            ctx.empresaId,
            o.tercero_id,
            o.concepto_nacional_id,
            Number(o.fecha_causacion.slice(0, 4)),
            p.base,
          ],
        );
      }
    }
    // Lo que la compra aportó al acumulado de ICA del período baja en la
    // misma proporción (Fase 8, §8.4).
    for (const a of await this.aportesIca(
      t,
      'compra_id = $1 AND documento_id = $1',
      datos.compraId,
    )) {
      await this.aportarIca(
        t,
        ctx,
        { ...a, compraId: datos.compraId, documentoId: datos.notaId },
        -Math.round(a.base * datos.proporcion * 100) / 100,
        -Math.round(a.retenido * datos.proporcion * 100) / 100,
      );
    }
    return nuevas;
  }

  /**
   * Anular una compra —o una nota de compra— deja su retención en cero. Sin
   * esto la compra anulada seguía sumando en el 350 y en el acumulado de
   * honorarios, y una nota anulada seguía restando.
   *
   * Por cada retención propia del documento entra una fila que la contrarresta
   * por **lo que le quede viva** (`retencionesVivas`): en una compra, lo
   * original menos lo que devolvieron sus notas; en una nota, lo que la nota
   * había quitado, que vuelve. Va con la fecha de la anulación, que es cuando
   * se declara la corrección.
   *
   * Si la nota es de una compra que ya se anuló, no vuelve nada: la
   * anulación de la compra ya reversó solo lo que quedaba, contando lo que la
   * nota había quitado. Devolverlo revivía la retención de una compra anulada
   * (bug 1). Lo mismo con el acumulado de honorarios y el de ICA.
   */
  async anularCompra(
    ctx: CtxEmpresa,
    datos: { compraId: string; fecha: string; motivo: string },
    t: Tx,
  ): Promise<void> {
    const vivas = await retencionesVivas(t, datos.compraId);

    for (const o of vivas) {
      const c = contrarrestoAlAnular(paraReversar(o));
      if (c === null) continue;
      const { valor, base } = c;
      const texto =
        valor > 0
          ? `Compra anulada: reversé los ${Math.round(valor).toLocaleString('es-CO')} que quedaban de esta retención. Motivo: ${datos.motivo}`
          : `Nota anulada: volvieron los ${Math.round(-valor).toLocaleString('es-CO')} de retención que la nota había reversado. Motivo: ${datos.motivo}`;
      await t.query(
        `INSERT INTO retencion_calculada
           (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
            concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
            tarifa_efectiva, valor, tarifa_id, uvt_valor, norma_aplicada,
            origen_clasificacion, explicacion, estado, anula_a, motor_version, creado_por,
            municipio_codigo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'ANULADA',$18,$19,$20,$21)`,
        [
          ctx.empresaId,
          o.documento_tipo,
          datos.compraId,
          o.tercero_id,
          o.impuesto,
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
            anulacion: datos.motivo,
            texto,
          }),
          o.id,
          MOTOR_VERSION,
          ctx.usuarioId,
          o.municipio_codigo,
        ],
      );

      // Con una compra baja lo acumulado; con una nota, vuelve a subir.
      if (o.usa_acumulado_anual) {
        await t.query(
          `UPDATE retencion_acumulado
              SET base_acumulada = greatest(base_acumulada - $5, 0), actualizado_en = now()
            WHERE empresa_id = $1 AND tercero_id = $2 AND concepto_nacional_id = $3 AND anio = $4`,
          [
            ctx.empresaId,
            o.tercero_id,
            o.concepto_nacional_id,
            Number(o.fecha_causacion.slice(0, 4)),
            base,
          ],
        );
      }
    }

    // El acumulado de ICA: una compra resta lo que le quede (lo suyo menos lo
    // que devolvieron sus notas); una nota devuelve lo que había quitado,
    // salvo que su compra ya esté anulada (bug 1).
    const anuladas = new Set(
      filas<{ id: string }>(
        await t.query(
          `SELECT id FROM compra_documento
            WHERE estado = 'ANULADA'
              AND id IN (SELECT compra_id FROM ica_acumulado_aporte
                          WHERE documento_id = $1 AND compra_id <> $1)`,
          [datos.compraId],
        ),
      ).map((c) => c.id),
    );
    for (const a of await this.aportesIca(
      t,
      'compra_id = $1 OR documento_id = $1',
      datos.compraId,
    )) {
      if (a.compraId !== datos.compraId && anuladas.has(a.compraId)) continue;
      await this.aportarIca(
        t,
        ctx,
        { ...a, documentoId: datos.compraId },
        -a.base,
        -a.retenido,
      );
    }
  }

  /**
   * El acumulado de ICA del período que había **antes** de una compra, por
   * municipio, reconstruido con los aportes (0090): lo que aportaron los
   * demás documentos del mismo proveedor, municipio y período antes del
   * primer aporte de la compra. Para recalcular compras que se confirmaron
   * antes de que la entrada guardara `acumuladoIcaAnterior` (bug 3).
   *
   * `undefined` si la compra no aportó nada: entonces el acumulado de hoy no
   * la trae adentro.
   */
  async acumuladoIcaAntesDe(
    t: Tx,
    compraId: string,
  ): Promise<Record<string, number> | undefined> {
    const crudas = filas<{ municipio_codigo: string; base: string }>(
      await t.query(
        `WITH propio AS (
           SELECT tercero_id, municipio_codigo, anio, periodo, min(creado_en) AS desde
             FROM ica_acumulado_aporte
            WHERE compra_id = $1 AND documento_id = $1
            GROUP BY tercero_id, municipio_codigo, anio, periodo
         )
         SELECT p.municipio_codigo,
                coalesce(sum(a.base), 0)::text AS base
           FROM propio p
           LEFT JOIN ica_acumulado_aporte a
             ON a.tercero_id = p.tercero_id AND a.municipio_codigo = p.municipio_codigo
            AND a.anio = p.anio AND a.periodo = p.periodo
            AND a.compra_id <> $1 AND a.creado_en < p.desde
          GROUP BY p.municipio_codigo`,
        [compraId],
      ),
    );
    if (crudas.length === 0) return undefined;
    return Object.fromEntries(
      crudas.map((c) => [c.municipio_codigo, Number(c.base)]),
    );
  }

  /** Lo que queda aportado al acumulado de ICA, por período y municipio. */
  private async aportesIca(t: Tx, donde: string, id: string) {
    return filas<{
      compra_id: string;
      tercero_id: string;
      municipio_codigo: string;
      anio: number;
      periodo: number;
      base: string;
      retenido: string;
    }>(
      await t.query(
        `SELECT compra_id, tercero_id, municipio_codigo, anio, periodo,
                sum(base)::text AS base, sum(retenido)::text AS retenido
           FROM ica_acumulado_aporte
          WHERE ${donde}
          GROUP BY compra_id, tercero_id, municipio_codigo, anio, periodo
         HAVING sum(base) <> 0 OR sum(retenido) <> 0`,
        [id],
      ),
    ).map((a) => ({
      compraId: a.compra_id,
      terceroId: a.tercero_id,
      municipio: a.municipio_codigo,
      anio: a.anio,
      periodo: a.periodo,
      base: Number(a.base),
      retenido: Number(a.retenido),
    }));
  }

  /**
   * Un aporte al acumulado de ICA del período: la fila que dice de qué
   * documento salió (solo inserción) y el total del período, en la misma
   * transacción.
   */
  private async aportarIca(
    t: Tx,
    ctx: CtxEmpresa,
    a: {
      compraId: string;
      documentoId: string;
      terceroId: string;
      municipio: string;
      anio: number;
      periodo: number;
    },
    base: number,
    retenido: number,
  ): Promise<void> {
    if (base === 0 && retenido === 0) return;
    await t.query(
      `INSERT INTO ica_acumulado_aporte
         (empresa_id, compra_id, documento_id, tercero_id, municipio_codigo, anio, periodo, base, retenido)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.empresaId,
        a.compraId,
        a.documentoId,
        a.terceroId,
        a.municipio,
        a.anio,
        a.periodo,
        base,
        retenido,
      ],
    );
    await t.query(
      `INSERT INTO ica_acumulado_periodo
         (empresa_id, tercero_id, municipio_codigo, anio, periodo, base_acumulada, retenido_acumulado)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (empresa_id, tercero_id, municipio_codigo, anio, periodo)
       DO UPDATE SET base_acumulada = ica_acumulado_periodo.base_acumulada + EXCLUDED.base_acumulada,
                     retenido_acumulado = ica_acumulado_periodo.retenido_acumulado + EXCLUDED.retenido_acumulado,
                     actualizado_en = now()`,
      [
        ctx.empresaId,
        a.terceroId,
        a.municipio,
        a.anio,
        a.periodo,
        base,
        retenido,
      ],
    );
  }

  /**
   * Las retenciones calculadas, con su explicación, para que María responda
   * «¿por qué le retuviste esto a X?» o «¿cuánto retuve este mes?» sin
   * reconstruir nada: lee lo que quedó guardado al registrar.
   */
  async consultar(
    ctx: CtxEmpresa,
    filtros: {
      proveedor?: string;
      numero?: string;
      desde?: string;
      hasta?: string;
    },
  ) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT rc.fecha_causacion::text AS fecha, rc.documento_tipo,
                  c.numero_factura_proveedor AS documento,
                  coalesce(nullif(te.razon_social, ''), concat_ws(' ', te.primer_nombre, te.primer_apellido)) AS proveedor,
                  rc.impuesto, n.nombre AS concepto, rc.base, rc.tarifa_efectiva, rc.valor,
                  rc.norma_aplicada, rc.origen_clasificacion, rc.estado, rc.explicacion
             FROM retencion_calculada rc
             JOIN retencion_concepto_nacional n ON n.id = rc.concepto_nacional_id
             JOIN tercero te ON te.id = rc.tercero_id
             LEFT JOIN compra_documento c ON c.id = rc.documento_id
            WHERE ($1::text IS NULL OR fn_normalizar(coalesce(te.razon_social, concat_ws(' ', te.primer_nombre, te.primer_apellido)))
                                        LIKE '%' || fn_normalizar($1) || '%')
              AND ($2::text IS NULL OR upper(c.numero_factura_proveedor) LIKE '%' || upper($2) || '%')
              AND ($3::date IS NULL OR rc.fecha_causacion >= $3::date)
              AND ($4::date IS NULL OR rc.fecha_causacion <= $4::date)
            ORDER BY rc.fecha_causacion DESC, rc.creado_en DESC
            LIMIT 30`,
          [
            filtros.proveedor?.trim() || null,
            filtros.numero?.trim() || null,
            filtros.desde ?? null,
            filtros.hasta ?? null,
          ],
        ),
      ),
    );
  }

  /** La explicación guardada de las retenciones de un documento. */
  async deDocumento(ctx: CtxEmpresa, tipo: string, id: string) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT rc.id, rc.impuesto, n.codigo AS concepto, n.nombre AS concepto_nombre,
                  rc.base, rc.tarifa_efectiva, rc.valor, rc.norma_aplicada,
                  rc.origen_clasificacion, rc.estado, rc.explicacion, rc.fecha_causacion::text
             FROM retencion_calculada rc
             JOIN retencion_concepto_nacional n ON n.id = rc.concepto_nacional_id
            WHERE rc.documento_tipo = $1 AND rc.documento_id = $2
            ORDER BY rc.creado_en`,
          [tipo, id],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------

  private async proponerEn(
    t: Tx,
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    respuestas: RespuestasRenta,
  ): Promise<PropuestaRenta> {
    // Una tras otra: comparten la conexión de la transacción.
    const conceptos = await this.conceptos(t, ctx);
    const conceptosIva = await this.conceptosIva(t, ctx, 'IVA');
    const conceptosIca = await this.conceptosIva(t, ctx, 'ICA');
    const regimenes = await this.regimenes(t, ctx, doc.fecha);
    const perfil = await this.perfil(t, doc.terceroId, doc.fecha);
    const tercero = await this.tercero(t, doc.terceroId);
    const aprendidos = await this.aprendidos(t, doc.terceroId);
    const propuestasIa = await this.propuestasIa(t, doc.terceroId);
    const foto = await this.parametros.fotoEn(ctx, doc.fecha, t);
    const factores = await this.factoresZomac(t);
    // Al recalcular, el acumulado que había al confirmar; si no, el de hoy.
    const acumulados =
      doc.acumuladoAnterior !== undefined
        ? new Map(Object.entries(doc.acumuladoAnterior))
        : await this.acumulados(
            t,
            doc.terceroId,
            Number(doc.fecha.slice(0, 4)),
          );

    const porCodigo = new Map(conceptos.map((c) => [c.codigo, c]));
    const nombreDe = (codigo: string) =>
      porCodigo.get(codigo)?.nombre ?? codigo;

    const beneficiario: PerfilBeneficiario | null =
      perfil === null
        ? null
        : {
            tipoPersona: perfil.tipo_persona,
            regimenRenta: perfil.regimen_renta,
            declaranteRenta: perfil.declarante_renta,
            esAutorretenedorRenta: perfil.es_autorretenedor_renta,
            esGranContribuyente: perfil.es_gran_contribuyente,
            esZomac: perfil.es_zomac,
            zomacTamano: perfil.zomac_tamano,
            contratoDosOMasTrabajadores: perfil.contrato_dos_o_mas_trabajadores,
            desde: perfil.desde,
          };
    const beneficiarioIva: BeneficiarioIva | null =
      perfil === null
        ? null
        : {
            esResponsableIva: perfil.es_responsable_iva,
            esAgenteRetIva:
              perfil.es_agente_ret_iva || perfil.es_gran_contribuyente,
            agenteIvaNumeral:
              perfil.agente_iva_numeral ??
              (perfil.es_gran_contribuyente ? 1 : null),
            esExterior: DOCUMENTOS_EXTERIOR.includes(perfil.tipo_documento),
          };

    const contexto = {
      fecha: doc.fecha,
      empresaEsAgente: regimenes.some((r) => AGENTE_RENTA.includes(r)),
      beneficiario,
      zomacEnFactura: doc.zomacEnFactura === true,
      pagadaConTarjeta: doc.pagadaConTarjeta === true,
      foto,
      conceptos: new Map<string, ConceptoRenta>(
        conceptos.map((c) => [
          c.id,
          {
            id: c.id,
            codigo: c.codigo,
            nombre: c.nombre,
            usaAcumuladoAnual: c.usa_acumulado_anual,
            usaTabla383: c.usa_tabla_383,
            baseEsAiu: c.base_es_aiu,
            umbralAcumuladoUvt:
              c.umbral_acumulado_uvt === null
                ? null
                : Number(c.umbral_acumulado_uvt),
          },
        ]),
      ),
      factorZomac: (tamano: string, anio: number) =>
        factores.find(
          (f) =>
            f.tamano === tamano && f.anio_desde <= anio && f.anio_hasta >= anio,
        )?.factor ?? null,
      acumulado: (conceptoId: string) => acumulados.get(conceptoId) ?? 0,
      aportesSeguridadSocial: doc.aportesSeguridadSocial,
    };
    const contextoIva = {
      fecha: doc.fecha,
      empresaEsAgenteIva: regimenes.some((r) => AGENTE_IVA.includes(r)),
      // El gran contribuyente es agente de IVA por el numeral 1.
      empresaNumeral: regimenes.includes('GRAN_CONTRIBUYENTE') ? 1 : null,
      beneficiario: beneficiarioIva,
      pagadaConTarjeta: doc.pagadaConTarjeta === true,
      tarifaIvaGeneral: TARIFA_IVA_GENERAL,
      foto,
      conceptos: conceptosIva.map((c) => ({
        id: c.id,
        codigo: c.codigo as ConceptoIva['codigo'],
        nombre: c.nombre,
      })),
    };

    // Un proveedor del exterior se clasifica solo con los conceptos del
    // exterior (R-D14), y uno de aquí nunca con ellos.
    const exterior = beneficiarioIva?.esExterior === true;
    const esDelExterior = (codigo: string) => codigo.startsWith('EXT_');
    const listaConceptos = conceptos
      .filter((c) => esDelExterior(c.codigo) === exterior)
      .map((c) => ({
        codigo: c.codigo,
        nombre: c.nombre,
      }));

    // Las guardas primero: si ninguno de los dos impuestos aplica, no se
    // pregunta nada. Renta e IVA son independientes: a un proveedor del SIMPLE
    // no se le retiene renta pero sí IVA (caso borde 14).
    // Pago al exterior (R-D14, art. 406 ET): la tarifa del art. 408, sin base
    // mínima. Las guardas del perfil —SIMPLE, declarante, autorretenedor,
    // ZOMAC— son de residentes y no aplican. La tarifa de un convenio (CDI)
    // pide el certificado de residencia fiscal: no se aplica sola.
    const contextoRenta =
      exterior && beneficiario !== null
        ? {
            ...contexto,
            zomacEnFactura: false,
            beneficiario: {
              ...beneficiario,
              regimenRenta: 'ORDINARIO' as const,
              declaranteRenta: true,
              esAutorretenedorRenta: false,
              esGranContribuyente: false,
              esZomac: false,
              zomacTamano: null,
            },
          }
        : contexto;
    const guardasRenta: ResultadoRenta = calcularRenta([], contextoRenta);
    const rentaAplica = !(
      guardasRenta.decision === 'NO_SUJETO' ||
      (guardasRenta.decision === 'REVISION' && beneficiario === null)
    );
    const guardasIva = calcularIva(
      doc.renglones.map((r) => ({
        orden: r.orden,
        subtotal: r.subtotal,
        iva: r.iva ?? 0,
        esBien: null,
      })),
      contextoIva,
    );
    const ivaAplica =
      guardasIva.decision !== 'NO_SUJETO' && beneficiarioIva !== null;
    // Para IVA solo importa si el renglón de gasto es bien o servicio.
    const ivaPideConcepto = (r: RenglonDocumento) =>
      ivaAplica &&
      r.productoId === null &&
      (beneficiarioIva.esExterior || (r.iva ?? 0) > 0);

    // ReteICA: la empresa agente en algún municipio, el proveedor no del
    // SIMPLE ni del exterior. Lo demás lo decide cada municipio.
    const icaEmpresa = await this.icaEmpresa(t, ctx, doc.fecha);
    const icaAplica =
      icaEmpresa.agenteEn.size > 0 &&
      perfil !== null &&
      perfil.regimen_renta !== 'SIMPLE' &&
      !exterior;

    if (!rentaAplica && !ivaAplica && !icaAplica) {
      const soloGuardas = [guardasRenta.motivo, guardasIva.motivo].join(' ');
      return {
        decision:
          guardasRenta.decision === 'REVISION' ||
          guardasIva.decision === 'REVISION'
            ? 'REVISION'
            : 'NO_SUJETO',
        motivo: soloGuardas,
        renglones: [],
        retenciones: [],
        sinRetener: [],
        pendientes: 0,
        pideAportes: false,
        conceptos: listaConceptos,
        avisos: [],
        acumularIca: [],
      };
    }

    // El convenio del país de residencia del proveedor del exterior, si tiene
    // certificado vigente a la fecha (§8.15).
    const convenio = exterior
      ? await this.convenioDe(t, doc.terceroId, doc.fecha)
      : [];
    const conConvenio = new Set(['EXT_GENERAL', 'EXT_CREDITOS_LARGO']);
    const elegidosConvenio = new Map(
      (respuestas.convenios ?? []).map((c) => [c.orden, c.tipo]),
    );

    const contestadas = new Map(
      (respuestas.conceptos ?? []).map((c) => [c.orden, c.conceptoCodigo]),
    );
    for (const codigo of contestadas.values()) {
      if (!porCodigo.has(codigo)) {
        throw new BadRequestException(
          `No conozco el concepto de retención ${codigo}.`,
        );
      }
      if (esDelExterior(codigo) !== exterior) {
        throw new BadRequestException(
          exterior
            ? `Es un pago al exterior: el concepto tiene que ser uno del exterior, no ${nombreDe(codigo).toLowerCase()}.`
            : `${nombreDe(codigo)} es para pagos al exterior, y este proveedor no es del exterior.`,
        );
      }
    }

    // Se clasifica lo que algún impuesto necesita: todo, si aplica renta; si
    // solo aplican IVA o ICA, los gastos (para saber si son bien o servicio:
    // en IVA cambia el concepto, en ICA la base y dónde se causa).
    // Mercancía comprada al exterior (importación) no es renta de fuente
    // nacional (art. 25 ET): no lleva retención de renta.
    const rentaDe = (r: RenglonDocumento) =>
      rentaAplica && !(exterior && r.productoId !== null);
    const necesita = (r: RenglonDocumento) =>
      rentaDe(r) || ivaPideConcepto(r) || (icaAplica && r.productoId === null);
    const renglones: RenglonPropuesto[] = doc.renglones
      .filter(necesita)
      .map((r) => {
        const deducida = clasificar(
          {
            orden: r.orden,
            productoId: r.productoId,
            texto: r.texto,
            cuentaCodigo: r.cuentaCodigo,
            sugerida: r.sugerida ?? null,
          },
          {
            aprendidos,
            ciiuProveedor: perfil?.ciiu_principal ?? null,
            nombreProveedor: tercero,
            nombreDe,
            // Solo lo que sigue en la lista: un concepto retirado no se propone.
            ia: (llave) => {
              const p = propuestasIa.get(llave);
              return p?.propuesta != null && porCodigo.has(p.propuesta.concepto)
                ? {
                    ...p.propuesta,
                    alternativas: p.propuesta.alternativas.filter((a) =>
                      porCodigo.has(a),
                    ),
                  }
                : null;
            },
          },
        );
        // Lo que las fuentes propongan fuera de la lista que corresponde (un
        // concepto nacional para un proveedor del exterior) se pregunta.
        const fuera =
          deducida.concepto !== null &&
          esDelExterior(deducida.concepto) !== exterior;
        const c = fuera
          ? {
              ...deducida,
              concepto: null,
              origen: null,
              certeza: 'PREGUNTA' as const,
              razon:
                'Es un pago al exterior: indíqueme qué concepto del exterior es.',
              opciones: undefined,
              alternativas: undefined,
            }
          : deducida;
        const respuesta = contestadas.get(r.orden);
        const elegido =
          respuesta ?? (c.certeza === 'CLARA' ? c.concepto : null);
        const llave = r.productoId === null ? llaveDe(r.texto) : null;
        const pideIa =
          !exterior &&
          c.certeza === 'PREGUNTA' &&
          c.opciones === undefined &&
          respuesta === undefined &&
          llave !== null &&
          (propuestasIa.get(llave)?.reintentar ?? true);
        return {
          ...c,
          elegido,
          pendiente: elegido === null,
          pideIa,
          pideAiu:
            elegido !== null && porCodigo.get(elegido)?.base_es_aiu === true,
          ...(elegido !== null &&
          conConvenio.has(elegido) &&
          convenio.length > 0
            ? {
                convenios: convenio,
                convenioAplicado: elegidosConvenio.get(r.orden) ?? null,
              }
            : {}),
        };
      });
    const elegidoDe = (orden: number) =>
      renglones.find((x) => x.orden === orden)?.elegido ?? null;

    let resultadoRenta: ResultadoRenta = guardasRenta;
    if (rentaAplica) {
      const paraCalcular: RenglonRenta[] = [];
      for (const r of doc.renglones) {
        const p = renglones.find((x) => x.orden === r.orden);
        if (p === undefined || p.elegido === null || !rentaDe(r)) continue;
        paraCalcular.push({
          orden: r.orden,
          subtotal: r.subtotal,
          descuento: r.descuento ?? 0,
          aiu: r.aiu,
          conceptoCodigo: p.elegido,
          // Aceptar lo deducido conserva de dónde salió; cambiarlo es manual.
          origen:
            p.origen !== null && p.elegido === p.concepto ? p.origen : 'MANUAL',
        });
      }
      resultadoRenta = calcularRenta(paraCalcular, contextoRenta);

      // El convenio, solo si la persona lo eligió para todos los renglones de
      // esa retención y con el mismo tipo de renta (§8.15).
      if (resultadoRenta.decision === 'CALCULADA' && convenio.length > 0) {
        resultadoRenta = {
          ...resultadoRenta,
          retenciones: resultadoRenta.retenciones.map((ret) => {
            const tipos = new Set(
              ret.renglones.map((o) => elegidosConvenio.get(o) ?? null),
            );
            const [tipo] = [...tipos];
            if (tipos.size !== 1 || tipo === null || tipo === undefined) {
              return ret;
            }
            const tarifa = convenio.find((c) => c.tipo === tipo);
            return tarifa === undefined
              ? ret
              : aplicarConvenio(ret, {
                  pais: tarifa.pais,
                  paisNombre: tarifa.paisNombre,
                  tipoRenta: tipo,
                  tarifa: tarifa.tarifa,
                  ley: tarifa.ley,
                });
          }),
        };
      }
    }

    let resultadoIva: ResultadoIva = guardasIva;
    if (ivaAplica) {
      resultadoIva = calcularIva(
        doc.renglones.map((r) => ({
          orden: r.orden,
          subtotal: r.subtotal,
          iva: r.iva ?? 0,
          esBien: esBien(r.productoId, elegidoDe(r.orden)),
        })),
        contextoIva,
      );
    }

    let resultadoIca: ResultadoIca | null = null;
    const acumularIca: PropuestaRenta['acumularIca'] = [];
    const acumuladoIcaUsado: Record<string, number> = {};
    const anio = Number(doc.fecha.slice(0, 4));
    if (icaAplica) {
      const municipioCompra = doc.municipioCompra ?? icaEmpresa.principal;
      const municipioProveedor = await this.terceroMunicipio(t, doc.terceroId);
      const renglonesIca = doc.renglones.map((r) => {
        const bien = esBien(r.productoId, elegidoDe(r.orden));
        return {
          orden: r.orden,
          subtotal: r.subtotal,
          esBien: bien,
          municipio: municipioDeCausacion({
            municipioRenglon: r.municipio ?? null,
            esBien: bien,
            ciiuProveedor: perfil?.ciiu_principal ?? null,
            municipioProveedor,
            municipioCompra,
          }),
        };
      });
      const municipios = [
        ...new Set(
          renglonesIca.flatMap((r) =>
            r.municipio === null ? [] : [r.municipio],
          ),
        ),
      ];
      const ica = await this.datosIca(
        t,
        doc.terceroId,
        municipios,
        anio,
        doc.fecha,
      );
      // Al recalcular, el acumulado de antes de la compra; si no, el de hoy.
      const acumuladoIca = (m: string): number =>
        acumuladoIcaAntes(doc.acumuladoIcaAnterior, ica.acumulados, m);
      for (const m of ica.acumulados.keys()) {
        acumuladoIcaUsado[m] = acumuladoIca(m);
      }
      const gc = (esGc: boolean) =>
        esGc ? 'GRAN_CONTRIBUYENTE_DIAN' : 'ORDINARIO';
      resultadoIca = calcularIca(renglonesIca, {
        fecha: doc.fecha,
        uvt: foto.uvt,
        beneficiarioSimple: false,
        perfilPagador: gc(regimenes.includes('GRAN_CONTRIBUYENTE')),
        perfilBeneficiario: gc(perfil?.es_gran_contribuyente === true),
        agenteEn: icaEmpresa.agenteEn,
        nombreMunicipio: (c) => ica.nombres.get(c) ?? c,
        parametro: (m) => ica.parametros.get(m) ?? null,
        perfilProveedor: (m) => ica.perfiles.get(m) ?? null,
        // Primero el código de actividad que informó el proveedor en ese
        // municipio; si no lo informó, su CIIU. Un CIIU con varias tarifas
        // apunta a la más alta: la regla de los estatutos cuando no se puede
        // establecer la actividad (Fase 8, carga de ReteICA).
        tarifaActividad: (m, actividad) => {
          const delMunicipio = ica.tarifas.filter((x) => x.municipio === m);
          const ciiu = perfil?.ciiu_principal?.slice(0, 4) ?? null;
          return (
            (
              (actividad !== null
                ? delMunicipio.find((x) => x.codigo === actividad)
                : undefined) ??
              (ciiu !== null
                ? delMunicipio.find((x) => x.ciiu === ciiu)
                : undefined)
            )?.tarifa ?? null
          );
        },
        matriz: (m) => ica.matriz.filter((x) => x.municipio === m),
        acumulado: (m) => acumuladoIca(m),
      });
      for (const a of resultadoIca.acumular) {
        const param = ica.parametros.get(a.municipio);
        if (param === undefined || !param.acumulaEnPeriodo) continue;
        acumularIca.push({
          municipio: a.municipio,
          anio,
          periodo: periodoDe(doc.fecha, param.periodicidad),
          base: a.base,
          retenido: a.retenido,
        });
      }
    }

    const pendientes = renglones.filter((r) => r.pendiente).length;

    // Honorarios de persona natural cerca del umbral anual: la próxima factura
    // puede pasar del 10 % al 11 %, y conviene saberlo antes.
    // La tabla del art. 383 sin los aportes: retiene de más. Se avisa.
    const porTabla = [
      ...resultadoRenta.retenciones.map((r) => r.explicacion),
      ...resultadoRenta.sinRetener.map((r) => r.explicacion),
    ].some((e) => e.tabla_383 !== undefined);
    const avisos = [
      ...(porTabla &&
      !(
        doc.aportesSeguridadSocial !== undefined &&
        doc.aportesSeguridadSocial > 0
      )
        ? [
            `A ${tercero} le calculo por la tabla del art. 383 sin restarle aportes a salud y pensión. Si le dio su planilla, escriba el valor: baja la retención.`,
          ]
        : []),
      ...(resultadoIca?.avisos ?? []),
      ...(exterior && rentaAplica
        ? [avisoPagoExterior(renglones.some((r) => r.convenios !== undefined))]
        : []),
      ...resultadoRenta.retenciones.flatMap((r) => {
        const a = r.explicacion.acumulado;
        if (a === undefined || a.supera || a.con_este < a.umbral * 0.9)
          return [];
        const falta = Math.round(a.umbral - a.con_este).toLocaleString('es-CO');
        return [
          `${tercero} está a ${falta} de cruzar las ${a.umbral_uvt.toLocaleString('es-CO')} UVT de ${r.concepto.nombre.toLowerCase()} del año: la próxima factura pasa del 10 % al 11 %.`,
        ];
      }),
    ];

    // Una retención de renta sin cuenta siendo la empresa agente: la
    // subcuenta del decreto se crea como las del plan sugerido (la 236550 de
    // pagos al exterior no venía en él) y el trigger de 0076 la enlaza.
    const porCrear = subcuentasPorCrear(
      resultadoRenta.retenciones.map((x) => ({
        cuentaId: porCodigo.get(x.concepto.codigo)?.cuenta_id ?? null,
        subcuentaPasivo:
          porCodigo.get(x.concepto.codigo)?.subcuenta_pasivo ?? null,
      })),
      contexto.empresaEsAgente,
    );
    if (porCrear.length > 0) {
      await this.crearSubcuentasRenta(t, ctx, porCrear);
      for (const c of await this.conceptos(t, ctx)) {
        const actual = porCodigo.get(c.codigo);
        if (actual !== undefined) actual.cuenta_id = c.cuenta_id;
      }
    }

    // Una ReteIVA sin cuenta: la 2367 se crea sola (bug #17). El plan sugerido
    // solo la trae al agente de IVA, pero el responsable que contrata servicios
    // del exterior también retiene (art. 437-2 num. 3 ET). El trigger de 0076
    // la enlaza a los conceptos de IVA.
    const cuentaIva = new Map(conceptosIva.map((c) => [c.codigo, c.cuenta_id]));
    const ivaPorCrear = subcuentaIvaPorCrear(
      resultadoIva.retenciones.map((x) => ({
        cuentaId: cuentaIva.get(x.concepto.codigo) ?? null,
      })),
    );
    if (ivaPorCrear !== null) {
      await this.nucleo.asegurarCuenta(
        ctx,
        { codigo: ivaPorCrear, nombre: 'IVA retenido', exigeTercero: true },
        t,
      );
      for (const c of await this.conceptosIva(t, ctx, 'IVA')) {
        cuentaIva.set(c.codigo, c.cuenta_id);
      }
    }
    const reteica = conceptosIca[0];
    const retenciones: RetencionPropuesta[] = [
      ...resultadoRenta.retenciones.map((x) => ({
        impuesto: 'RENTA' as const,
        asumida: false,
        municipio: null,
        conceptoCodigo: x.concepto.codigo,
        conceptoNacionalId: x.concepto.id,
        nombre: x.concepto.nombre,
        renglones: x.renglones,
        base: x.base,
        tarifa: Math.round(x.tarifaEfectiva * 100 * 10000) / 10000,
        valor: x.valor,
        cuentaId: porCodigo.get(x.concepto.codigo)?.cuenta_id ?? null,
        texto: x.explicacion.texto,
        explicacion: x.explicacion,
      })),
      ...resultadoIva.retenciones.map((x) => ({
        impuesto: 'IVA' as const,
        asumida: x.asumida,
        municipio: null,
        conceptoCodigo: x.concepto.codigo,
        conceptoNacionalId: x.concepto.id,
        nombre: x.concepto.nombre,
        renglones: x.renglones,
        base: x.base,
        tarifa: Math.round(x.tarifa.tarifa * 100 * 10000) / 10000,
        valor: x.valor,
        cuentaId: cuentaIva.get(x.concepto.codigo) ?? null,
        texto: x.explicacion.texto,
        explicacion: x.explicacion,
      })),
      ...(resultadoIca?.retenciones ?? []).flatMap((x) =>
        reteica === undefined
          ? []
          : [
              {
                impuesto: 'ICA' as const,
                asumida: false,
                municipio: x.municipio,
                conceptoCodigo: reteica.codigo,
                conceptoNacionalId: reteica.id,
                nombre: x.explicacion.clasificacion?.nombre ?? reteica.nombre,
                renglones: x.renglones,
                base: x.base,
                // En porcentaje, como las demás: 2 por mil es 0,2 %.
                tarifa: x.tarifaPorMil / 10,
                valor: x.valor,
                cuentaId: reteica.cuenta_id,
                texto: x.explicacion.texto,
                explicacion: x.explicacion,
              },
            ],
      ),
    ];

    const decisiones = [
      rentaAplica ? resultadoRenta.decision : null,
      ivaAplica ? resultadoIva.decision : null,
      // Un municipio sin parámetros no frena la compra: se avisa.
      resultadoIca !== null && resultadoIca.decision !== 'REVISION'
        ? resultadoIca.decision
        : null,
    ].filter((d) => d !== null);
    const decision: PropuestaRenta['decision'] =
      retenciones.length > 0
        ? 'CALCULADA'
        : decisiones.includes('REVISION')
          ? 'REVISION'
          : decisiones.includes('BAJO_BASE')
            ? 'BAJO_BASE'
            : 'NO_SUJETO';

    // El porqué de lo que no aplica también se dice: «no retengo renta: es
    // del SIMPLE» explica por qué solo hay ReteIVA.
    const motivos = [
      rentaAplica ? resultadoRenta.motivo : guardasRenta.motivo,
      ivaAplica
        ? resultadoIva.motivo
        : guardasIva.decision === 'NO_SUJETO' &&
            regimenes.some((r) => AGENTE_IVA.includes(r))
          ? guardasIva.motivo
          : null,
      resultadoIca?.motivo ?? null,
    ].filter((m) => m !== null && m !== '');

    return {
      decision,
      motivo:
        pendientes > 0
          ? `Falta confirmar ${pendientes} renglón(es).`
          : motivos.join(' '),
      renglones,
      retenciones,
      sinRetener: [
        ...resultadoRenta.sinRetener.map((x) => ({
          conceptoCodigo: x.concepto.codigo,
          nombre: x.concepto.nombre,
          texto: x.explicacion.texto,
        })),
        ...resultadoIva.sinRetener.map((x) => ({
          conceptoCodigo: x.concepto.codigo,
          nombre: x.concepto.nombre,
          texto: x.explicacion.texto,
        })),
        ...(resultadoIca?.sinRetener ?? []).map((x) => ({
          conceptoCodigo: 'RETEICA',
          nombre: 'ReteICA',
          texto: x.texto,
        })),
        // Una guarda que cortó un impuesto cuando el otro sí aplica.
        ...(!rentaAplica && (ivaAplica || icaAplica)
          ? [
              {
                conceptoCodigo: 'RENTA',
                nombre: 'Retención en la fuente',
                texto: guardasRenta.motivo,
              },
            ]
          : []),
      ],
      pendientes,
      pideAportes: porTabla,
      acumuladoAnterior: Object.fromEntries(acumulados),
      acumuladoIcaAnterior: acumuladoIcaUsado,
      conceptos: listaConceptos,
      avisos,
      acumularIca,
    };
  }

  /** Honorarios y comisiones: la base del año sube con cada documento. */
  private async sumarAcumulado(
    t: Tx,
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    p: PropuestaRenta,
  ) {
    const anio = Number(doc.fecha.slice(0, 4));
    const sumas = new Map<string, number>();
    for (const r of p.retenciones) {
      if (r.explicacion.acumulado === undefined) continue;
      sumas.set(
        r.conceptoNacionalId,
        (sumas.get(r.conceptoNacionalId) ?? 0) + r.base,
      );
    }
    for (const [conceptoId, base] of sumas) {
      await t.query(
        `INSERT INTO retencion_acumulado (empresa_id, tercero_id, concepto_nacional_id, anio, base_acumulada)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (empresa_id, tercero_id, concepto_nacional_id, anio)
         DO UPDATE SET base_acumulada = retencion_acumulado.base_acumulada + EXCLUDED.base_acumulada,
                       actualizado_en = now()`,
        [ctx.empresaId, doc.terceroId, conceptoId, anio, base],
      );
    }
  }

  /**
   * Lo contestado se aprende: la próxima vez, con este proveedor y este
   * renglón, es «La vi clara». Lo que ya era claro no se vuelve a guardar.
   */
  private async aprender(
    t: Tx,
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    p: PropuestaRenta,
  ) {
    const porCodigo = new Map(p.conceptos.map((c) => [c.codigo, c]));
    for (const r of p.renglones) {
      if (r.certeza === 'CLARA' && r.elegido === r.concepto) continue;
      if (r.elegido === null) continue;
      const renglon = doc.renglones.find((x) => x.orden === r.orden);
      if (renglon === undefined) continue;
      const llave = renglon.productoId === null ? llaveDe(renglon.texto) : null;
      if (renglon.productoId === null && llave === null) continue;
      if (!porCodigo.has(r.elegido)) continue;

      const origen = r.elegido === r.concepto ? 'CONFIRMADO' : 'CORREGIDO';
      const existentes = filas<{ id: string }>(
        await t.query(
          `UPDATE retencion_mapeo_concepto
              SET concepto_nacional_id = (SELECT id FROM retencion_concepto_nacional WHERE codigo = $5),
                  origen = $6, veces = veces + 1, confirmado_por = $7, actualizado_en = now()
            WHERE empresa_id = $1 AND tercero_id = $2 AND activo
              AND producto_id IS NOT DISTINCT FROM $3 AND llave_renglon IS NOT DISTINCT FROM $4
           RETURNING id`,
          [
            ctx.empresaId,
            doc.terceroId,
            renglon.productoId,
            llave,
            r.elegido,
            origen,
            ctx.usuarioId,
          ],
        ),
      );
      if (existentes.length > 0) continue;
      await t.query(
        `INSERT INTO retencion_mapeo_concepto
           (empresa_id, tercero_id, producto_id, llave_renglon, concepto_nacional_id, origen, confirmado_por)
         VALUES ($1, $2, $3, $4, (SELECT id FROM retencion_concepto_nacional WHERE codigo = $5), $6, $7)`,
        [
          ctx.empresaId,
          doc.terceroId,
          renglon.productoId,
          llave,
          r.elegido,
          origen,
          ctx.usuarioId,
        ],
      );
    }
  }

  // --- Lecturas -----------------------------------------------------------

  /**
   * Lo que la IA ya dijo de los renglones de este proveedor, por llave. Un
   * fallo se reintenta pasados diez minutos; lo demás no se vuelve a preguntar.
   */
  private async propuestasIa(
    t: Tx,
    terceroId: string,
  ): Promise<
    Map<string, { propuesta: PropuestaIa | null; reintentar: boolean }>
  > {
    const filasIa = filas<{
      llave_renglon: string;
      estado: string;
      codigo: string | null;
      razon: string | null;
      alternativas: string[];
      reintentar: boolean;
    }>(
      await t.query(
        `SELECT c.llave_renglon, c.estado, n.codigo, c.razon, c.alternativas,
                (c.estado = 'FALLO' AND c.creado_en < now() - interval '10 minutes') AS reintentar
           FROM retencion_clasificacion_ia c
           LEFT JOIN retencion_concepto_nacional n ON n.id = c.concepto_nacional_id
          WHERE c.tercero_id = $1`,
        [terceroId],
      ),
    );
    return new Map(
      filasIa.map((f) => [
        f.llave_renglon,
        {
          propuesta:
            f.estado === 'PROPUESTA' && f.codigo !== null
              ? {
                  concepto: f.codigo,
                  razon: f.razon ?? '',
                  alternativas: f.alternativas,
                }
              : null,
          reintentar: f.reintentar,
        },
      ]),
    );
  }

  /** Por fuente: cuántas veces se aceptó lo propuesto tal cual y cuántas se cambió. */
  async aciertos(ctx: CtxEmpresa) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<{ origen: string | null; total: number; aciertos: number }>(
        await t.query(
          `SELECT origen_propuesto AS origen, count(*)::int AS total,
                  count(*) FILTER (WHERE acerto)::int AS aciertos
             FROM retencion_clasificacion_uso
            GROUP BY origen_propuesto
            ORDER BY total DESC`,
        ),
      ),
    );
  }

  /**
   * Crea las subcuentas de retefuente que falten, con el nombre del decreto.
   * Una que ya existe —aunque esté inactiva— no se toca: quien la desactivó
   * tuvo un motivo, y la retención sigue pidiendo cuenta.
   */
  private async crearSubcuentasRenta(
    t: Tx,
    ctx: CtxEmpresa,
    codigos: string[],
  ): Promise<void> {
    const nombres = new Map(
      filas<{ codigo: string; nombre: string }>(
        await t.query(
          'SELECT codigo, nombre FROM cuenta_puc WHERE codigo = ANY($1::varchar[])',
          [codigos],
        ),
      ).map((f) => [f.codigo, f.nombre]),
    );
    for (const codigo of codigos) {
      const delDecreto = nombres.get(codigo);
      await this.nucleo.asegurarCuenta(
        ctx,
        {
          codigo,
          nombre:
            delDecreto === undefined
              ? 'Retención en la fuente'
              : `Retención en la fuente - ${delDecreto.toLowerCase()}`,
          exigeTercero: true,
        },
        t,
      );
    }
  }

  private async conceptos(t: Tx, ctx: CtxEmpresa): Promise<ConceptoFila[]> {
    return filas<ConceptoFila>(
      await t.query(
        `SELECT n.id, n.codigo, n.nombre, n.usa_acumulado_anual, n.umbral_acumulado_uvt, n.usa_tabla_383, n.base_es_aiu, n.subcuenta_pasivo,
                (SELECT rc.cuenta_id FROM retencion_concepto rc
                  WHERE rc.empresa_id = $1 AND rc.concepto_nacional_id = n.id
                    AND rc.anio IS NULL AND rc.activo
                  LIMIT 1) AS cuenta_id
           FROM retencion_concepto_nacional n
          WHERE n.impuesto = 'RENTA' AND n.activo
            AND n.codigo <> 'AUTORRETENCION_ESPECIAL'
          ORDER BY n.prioridad, n.nombre`,
        [ctx.empresaId],
      ),
    );
  }

  /** Los conceptos de ReteIVA (2367xx) o ReteICA (2368xx) con la cuenta de la empresa. */
  private async conceptosIva(t: Tx, ctx: CtxEmpresa, impuesto: 'IVA' | 'ICA') {
    return filas<{
      id: string;
      codigo: string;
      nombre: string;
      cuenta_id: string | null;
    }>(
      await t.query(
        `SELECT n.id, n.codigo, n.nombre,
                (SELECT rc.cuenta_id FROM retencion_concepto rc
                  WHERE rc.empresa_id = $1 AND rc.concepto_nacional_id = n.id
                    AND rc.anio IS NULL AND rc.activo
                  LIMIT 1) AS cuenta_id
           FROM retencion_concepto_nacional n
          WHERE n.impuesto = $2 AND n.activo`,
        [ctx.empresaId, impuesto],
      ),
    );
  }

  /**
   * Dónde es agente de ICA la empresa a la fecha (paso «Impuestos», 0077) y el
   * municipio de su sede principal, que es donde se recibe la compra si no se
   * dice otro.
   */
  private async icaEmpresa(t: Tx, ctx: CtxEmpresa, fecha: string) {
    const agente = filas<{ municipio_codigo: string }>(
      await t.query(
        `SELECT municipio_codigo FROM empresa_ica_municipio
          WHERE empresa_id = $1 AND es_agente_retenedor
            AND fecha_inicio <= $2::date AND (fecha_fin IS NULL OR fecha_fin >= $2::date)`,
        [ctx.empresaId, fecha],
      ),
    );
    const [principal] = filas<{ municipio_codigo: string }>(
      await t.query(
        `SELECT municipio_codigo FROM empresa_sede
          WHERE empresa_id = $1 AND es_principal AND activo LIMIT 1`,
        [ctx.empresaId],
      ),
    );
    return {
      agenteEn: new Set(agente.map((a) => a.municipio_codigo)),
      principal: principal?.municipio_codigo ?? null,
    };
  }

  private async terceroMunicipio(
    t: Tx,
    terceroId: string,
  ): Promise<string | null> {
    const [f] = filas<{ municipio_codigo: string | null }>(
      await t.query('SELECT municipio_codigo FROM tercero WHERE id = $1', [
        terceroId,
      ]),
    );
    return f?.municipio_codigo ?? null;
  }

  /** La ley municipal y lo del proveedor en los municipios de la compra. */
  private async datosIca(
    t: Tx,
    terceroId: string,
    municipios: string[],
    anio: number,
    fecha: string,
  ) {
    const nombres = new Map(
      filas<{ codigo: string; nombre: string }>(
        await t.query(
          'SELECT codigo, nombre FROM municipio WHERE codigo = ANY($1)',
          [municipios],
        ),
      ).map((m) => [m.codigo, m.nombre]),
    );
    const parametros = new Map<string, ParametroIca>(
      filas<{
        municipio_codigo: string;
        anio: number;
        base_minima_uvt_compras: string | null;
        base_minima_uvt_servicios: string | null;
        tarifa_general_por_mil: string | null;
        usa_tarifa_por_actividad: boolean;
        acumula_en_periodo: boolean;
        periodicidad: ParametroIca['periodicidad'];
        acuerdo: string;
      }>(
        await t.query(
          `SELECT municipio_codigo, anio, base_minima_uvt_compras, base_minima_uvt_servicios,
                  tarifa_general_por_mil, usa_tarifa_por_actividad, acumula_en_periodo,
                  periodicidad, acuerdo
             FROM ica_parametro WHERE municipio_codigo = ANY($1) AND anio = $2`,
          [municipios, anio],
        ),
      ).map((f) => [
        f.municipio_codigo,
        {
          municipio: f.municipio_codigo,
          anio: f.anio,
          baseMinimaUvtCompras:
            f.base_minima_uvt_compras === null
              ? null
              : Number(f.base_minima_uvt_compras),
          baseMinimaUvtServicios:
            f.base_minima_uvt_servicios === null
              ? null
              : Number(f.base_minima_uvt_servicios),
          tarifaGeneralPorMil:
            f.tarifa_general_por_mil === null
              ? null
              : Number(f.tarifa_general_por_mil),
          usaTarifaPorActividad: f.usa_tarifa_por_actividad,
          acumulaEnPeriodo: f.acumula_en_periodo,
          periodicidad: f.periodicidad,
          acuerdo: f.acuerdo,
        },
      ]),
    );
    const perfiles = new Map<string, PerfilIcaTercero>(
      filas<{
        municipio_codigo: string;
        ica_regimen: PerfilIcaTercero['regimen'];
        es_autorretenedor_ica: boolean;
        codigo_actividad_local: string | null;
      }>(
        await t.query(
          `SELECT municipio_codigo, ica_regimen, es_autorretenedor_ica, codigo_actividad_local
             FROM tercero_perfil_ica
            WHERE tercero_id = $1 AND municipio_codigo = ANY($2)
              AND vigencia_desde <= $3::date AND (vigencia_hasta IS NULL OR vigencia_hasta >= $3::date)`,
          [terceroId, municipios, fecha],
        ),
      ).map((f) => [
        f.municipio_codigo,
        {
          regimen: f.ica_regimen,
          esAutorretenedor: f.es_autorretenedor_ica,
          codigoActividad: f.codigo_actividad_local,
        },
      ]),
    );
    const tarifas = filas<{
      municipio_codigo: string;
      codigo_actividad: string;
      ciiu: string | null;
      tarifa_por_mil: string;
    }>(
      await t.query(
        `SELECT municipio_codigo, codigo_actividad, ciiu, tarifa_por_mil
           FROM ica_tarifa WHERE municipio_codigo = ANY($1) AND anio = $2`,
        [municipios, anio],
      ),
    ).map((f) => ({
      municipio: f.municipio_codigo,
      codigo: f.codigo_actividad,
      ciiu: f.ciiu,
      tarifa: Number(f.tarifa_por_mil),
    }));
    const matriz = filas<{
      municipio_codigo: string;
      perfil_pagador: string;
      perfil_beneficiario: string;
      retiene: boolean;
      fundamento: string | null;
    }>(
      await t.query(
        `SELECT municipio_codigo, perfil_pagador, perfil_beneficiario, retiene, fundamento
           FROM ica_matriz_agente WHERE municipio_codigo = ANY($1) AND anio = $2`,
        [municipios, anio],
      ),
    ).map((f): FilaMatriz & { municipio: string } => ({
      municipio: f.municipio_codigo,
      perfilPagador: f.perfil_pagador,
      perfilBeneficiario: f.perfil_beneficiario,
      retiene: f.retiene,
      fundamento: f.fundamento,
    }));
    const acumulados = new Map<string, number>();
    for (const [m, param] of parametros) {
      if (!param.acumulaEnPeriodo) continue;
      const [a] = filas<{ base_acumulada: string }>(
        await t.query(
          `SELECT base_acumulada FROM ica_acumulado_periodo
            WHERE tercero_id = $1 AND municipio_codigo = $2 AND anio = $3 AND periodo = $4`,
          [terceroId, m, anio, periodoDe(fecha, param.periodicidad)],
        ),
      );
      acumulados.set(m, a === undefined ? 0 : Number(a.base_acumulada));
    }
    return { nombres, parametros, perfiles, tarifas, matriz, acumulados };
  }

  private async regimenes(
    t: Tx,
    ctx: CtxEmpresa,
    fecha: string,
  ): Promise<string[]> {
    return filas<{ tipo_regimen: string }>(
      await t.query(
        `SELECT tipo_regimen FROM empresa_regimen_tributario
          WHERE empresa_id = $1 AND fecha_inicio <= $2::date
            AND (fecha_fin IS NULL OR fecha_fin >= $2::date)`,
        [ctx.empresaId, fecha],
      ),
    ).map((r) => r.tipo_regimen);
  }

  /**
   * El perfil vigente a la fecha. Si la compra es anterior al primer perfil
   * que se tiene —un proveedor creado hoy con una factura de hace un mes—, se
   * usa ese primero y la explicación lo dice: es lo más cercano que se sabe.
   */
  private async perfil(
    t: Tx,
    terceroId: string,
    fecha: string,
  ): Promise<PerfilFila | null> {
    const [vigente] = filas<PerfilFila>(
      await t.query(
        `SELECT tipo_persona, regimen_renta, declarante_renta, es_autorretenedor_renta,
                es_gran_contribuyente, es_zomac, zomac_tamano, ciiu_principal,
                contrato_dos_o_mas_trabajadores,
                es_responsable_iva, es_agente_ret_iva, agente_iva_numeral,
                (SELECT te.tipo_documento FROM tercero te WHERE te.id = tercero_id) AS tipo_documento,
                vigencia_desde::text AS desde
           FROM tercero_perfil_tributario
          WHERE tercero_id = $1
            AND vigencia_desde <= $2::date
            AND (vigencia_hasta IS NULL OR vigencia_hasta >= $2::date)`,
        [terceroId, fecha],
      ),
    );
    if (vigente !== undefined) return vigente;
    const [primero] = filas<PerfilFila>(
      await t.query(
        `SELECT tipo_persona, regimen_renta, declarante_renta, es_autorretenedor_renta,
                es_gran_contribuyente, es_zomac, zomac_tamano, ciiu_principal,
                contrato_dos_o_mas_trabajadores,
                es_responsable_iva, es_agente_ret_iva, agente_iva_numeral,
                (SELECT te.tipo_documento FROM tercero te WHERE te.id = tercero_id) AS tipo_documento,
                vigencia_desde::text AS desde
           FROM tercero_perfil_tributario
          WHERE tercero_id = $1 AND vigencia_desde > $2::date
          ORDER BY vigencia_desde LIMIT 1`,
        [terceroId, fecha],
      ),
    );
    return primero ?? null;
  }

  /**
   * Las tarifas de convenio del país de residencia del proveedor, si tiene un
   * certificado de residencia fiscal que cubre la fecha (§8.15). Vacío si no.
   */
  private async convenioDe(
    t: Tx,
    terceroId: string,
    fecha: string,
  ): Promise<NonNullable<RenglonPropuesto['convenios']>> {
    return filas<{
      tipo_renta: 'INTERESES' | 'REGALIAS';
      tarifa: string;
      pais_codigo: string;
      pais_nombre: string;
      ley: string;
    }>(
      await t.query(
        `SELECT c.tipo_renta, c.tarifa::text AS tarifa, c.pais_codigo, c.pais_nombre, c.ley
           FROM tercero_residencia_fiscal r
           JOIN cdi_tarifa c ON c.pais_codigo = r.pais_codigo
                            AND c.vigencia_desde <= $2::date
                            AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= $2::date)
          WHERE r.tercero_id = $1
            AND r.certificado_desde <= $2::date AND r.certificado_hasta >= $2::date
          ORDER BY c.tipo_renta`,
        [terceroId, fecha],
      ),
    ).map((c) => ({
      tipo: c.tipo_renta,
      tarifa: Number(c.tarifa),
      pais: c.pais_codigo,
      paisNombre: c.pais_nombre,
      ley: c.ley,
    }));
  }

  private async tercero(t: Tx, terceroId: string): Promise<string> {
    const [f] = filas<{ nombre: string }>(
      await t.query(
        `SELECT coalesce(nullif(razon_social, ''), nullif(nombre_comercial, ''),
                         concat_ws(' ', primer_nombre, primer_apellido)) AS nombre
           FROM tercero WHERE id = $1`,
        [terceroId],
      ),
    );
    return f?.nombre ?? 'el proveedor';
  }

  private async aprendidos(t: Tx, terceroId: string): Promise<Aprendido[]> {
    return filas<{
      producto_id: string | null;
      llave_renglon: string | null;
      tercero_id: string | null;
      codigo: string;
    }>(
      await t.query(
        `SELECT m.producto_id, m.llave_renglon, m.tercero_id, n.codigo
           FROM retencion_mapeo_concepto m
           JOIN retencion_concepto_nacional n ON n.id = m.concepto_nacional_id
          WHERE m.activo AND (m.tercero_id = $1 OR m.tercero_id IS NULL)`,
        [terceroId],
      ),
    ).map((a) => ({
      productoId: a.producto_id,
      llaveRenglon: a.llave_renglon,
      deEsteProveedor: a.tercero_id !== null,
      conceptoCodigo: a.codigo,
    }));
  }

  private async factoresZomac(t: Tx) {
    return filas<{
      tamano: string;
      anio_desde: number;
      anio_hasta: number;
      factor: string;
    }>(
      await t.query(
        'SELECT tamano, anio_desde, anio_hasta, factor FROM retencion_zomac_factor',
      ),
    ).map((f) => ({ ...f, factor: Number(f.factor) }));
  }

  private async acumulados(
    t: Tx,
    terceroId: string,
    anio: number,
  ): Promise<Map<string, number>> {
    return new Map(
      filas<{ concepto_nacional_id: string; base_acumulada: string }>(
        await t.query(
          `SELECT concepto_nacional_id, base_acumulada FROM retencion_acumulado
            WHERE tercero_id = $1 AND anio = $2`,
          [terceroId, anio],
        ),
      ).map((a) => [a.concepto_nacional_id, Number(a.base_acumulada)]),
    );
  }
}
