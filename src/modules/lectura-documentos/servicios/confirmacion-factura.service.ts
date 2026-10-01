import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { TxService } from '../../../common/db/tx.service';
import { ComprasApi } from '../../compras/compras.api';
import { cuadra } from '../reglas/factura-compra.reglas';
import { queAprender } from '../reglas/memoria.reglas';
import type { FacturaCruzada } from './cruce.service';
import { DocumentoService } from './documento.service';
import { MemoriaService } from './memoria.service';

/**
 * Registra la compra de una factura leída, cuando una persona lo confirma.
 *
 * **Hermano de `confirmacion.service.ts`** y con la misma idea, que es la que
 * sostiene el módulo entero: los valores **no vienen de la petición**, salen de
 * lo que quedó guardado al leer el documento. De la petición viene lo que la
 * persona decidió —la forma de pago, y las respuestas a lo que faltaba—.
 *
 * Y como allá, **se registra por la misma puerta que el endpoint manual**:
 * `ComprasApi.registrar`. Un camino propio a la base daría dos verdades sobre
 * qué es una compra válida.
 *
 * Lo que María hace acá es proponer. Registrar lo pide una persona, siempre.
 */

/** Lo que la persona resolvió de lo que el cruce no pudo. */
export interface RespuestasDeFactura {
  /** Si el documento no traía número, o hay que cambiarlo. */
  numero?: string;
  /** Si el proveedor no se encontró por NIT. */
  terceroId?: string;
  /** Qué hacer con cada renglón que quedó sin resolver, por su orden. */
  renglones?: Array<{
    orden: number;
    productoId?: string;
    cuentaId?: string;
  }>;
  formaPago?: 'CREDITO' | 'CONTADO';
  /**
   * El concepto de retención de renta de los renglones que lo necesitaban,
   * **por el orden del renglón en el papel** (plan motor de retenciones,
   * Fase 1, §1.6). Lo visto claro no hace falta mandarlo.
   */
  conceptosRenta?: Array<{ orden: number; conceptoCodigo: string }>;
  /** «Sin retención», con el porqué. */
  sinRetencionMotivo?: string;
  /** Si la factura informa la categoría ZOMAC del proveedor. */
  zomacEnFactura?: boolean;
  /** El centro de costo de la compra. */
  centroCostoId?: string;
}

@Injectable()
export class ConfirmacionFacturaService {
  private readonly log = new Logger(ConfirmacionFacturaService.name);

  constructor(
    private readonly documentos: DocumentoService,
    private readonly compras: ComprasApi,
    private readonly memoria: MemoriaService,
    private readonly tx: TxService,
  ) {}

  async confirmar(
    ctx: CtxEmpresa,
    documentoId: string,
    respuestas: RespuestasDeFactura = {},
  ) {
    const { cruzada, terceroId, lineas, conPrefijo, aLinea } =
      await this.preparar(ctx, documentoId, respuestas, true);

    // Lo que una persona contestó, para no volver a preguntarlo. Solo eso: lo
    // que el cruce encontró solo no se aprende nunca.
    const aprendizajes = queAprender(
      cruzada.renglones,
      respuestas.renglones ?? [],
    );

    // La compra y lo aprendido van en la misma transacción: si la compra no
    // entra, no se aprende nada. Contestar no es comprometerse; registrar sí.
    const compra = await this.tx.enContexto(ctx, async (t) => {
      const registrada = await this.compras.registrar(
        ctx,
        {
          terceroId,
          fecha: cruzada.factura.fecha,
          numeroFacturaProveedor: conPrefijo,
          lineas,
          // Crédito salvo que digan otra cosa: contado exige rol CAJA o
          // DIRECTOR y los medios de pago, que no salen de la factura.
          formaPago: respuestas.formaPago ?? 'CREDITO',
          // Renta por la misma puerta que la compra manual: el motor.
          conceptosRenta: this.conceptosEnLineas(respuestas, aLinea),
          sinRetencionMotivo: respuestas.sinRetencionMotivo,
          zomacEnFactura: respuestas.zomacEnFactura,
          centroCostoId: respuestas.centroCostoId,
        },
        // De qué documento salió y qué retención traía impresa. Va por acá y
        // no en el cuerpo de la petición: si viniera del navegador,
        // cualquiera podría decir que una compra digitada salió de un
        // documento que María leyó.
        {
          documentoLeidoId: documentoId,
          retencionImpresa: cruzada.factura.impreso?.retencion ?? null,
        },
        t,
      );
      await this.memoria.aprender(
        ctx,
        terceroId,
        registrada.id,
        aprendizajes,
        t,
      );
      return registrada;
    });

    this.log.log(
      `Factura ${documentoId} registrada como compra ${compra.id} (${conPrefijo}), ${lineas.length} líneas, ${aprendizajes.length} renglones aprendidos.`,
    );

    return compra;
  }

  /**
   * La retención de renta que llevaría la factura, sin registrar nada, con los
   * renglones por **su orden en el papel** y la retención que el papel trae
   * impresa al lado. Es lo que muestra «Revisar y aprobar».
   */
  async simularRetencion(
    ctx: CtxEmpresa,
    documentoId: string,
    respuestas: RespuestasDeFactura = {},
  ) {
    const { cruzada, terceroId, lineas, aLinea } = await this.preparar(
      ctx,
      documentoId,
      respuestas,
      false,
    );
    const propuesta = await this.compras.simularRenta(ctx, {
      terceroId,
      fecha: cruzada.factura.fecha,
      lineas,
      conceptosRenta: this.conceptosEnLineas(respuestas, aLinea),
      zomacEnFactura: respuestas.zomacEnFactura,
    });

    // De línea de la compra a renglón del papel: dos renglones del mismo
    // producto se juntan en una línea, y la pantalla habla del papel.
    const aRenglones = new Map<number, number[]>();
    for (const [renglon, linea] of aLinea) {
      aRenglones.set(linea, [...(aRenglones.get(linea) ?? []), renglon]);
    }
    const calculada = propuesta.retenciones.reduce((s, r) => s + r.valor, 0);
    const impresa = cruzada.factura.impreso?.retencion ?? null;

    return {
      ...propuesta,
      renglones: propuesta.renglones.flatMap((r) =>
        (aRenglones.get(r.orden) ?? [r.orden]).map((orden) => ({
          ...r,
          orden,
        })),
      ),
      retenciones: propuesta.retenciones.map((r) => ({
        ...r,
        renglones: r.renglones.flatMap((o) => aRenglones.get(o) ?? [o]),
      })),
      calculada,
      impresa,
      difiere: impresa !== null && Math.abs(impresa - calculada) >= 1,
    };
  }

  /** Lo contestado por renglón del papel, pasado a línea de la compra. */
  private conceptosEnLineas(
    respuestas: RespuestasDeFactura,
    aLinea: Map<number, number>,
  ) {
    const porLinea = new Map<number, string>();
    for (const c of respuestas.conceptosRenta ?? []) {
      const linea = aLinea.get(c.orden);
      if (linea !== undefined) porLinea.set(linea, c.conceptoCodigo);
    }
    return [...porLinea].map(([orden, conceptoCodigo]) => ({
      orden,
      conceptoCodigo,
    }));
  }

  /**
   * Lo que registrar y simular necesitan por igual: la factura leída
   * validada, el proveedor y las líneas. Simular no exige el número: se puede
   * ver la retención antes de haberlo contestado.
   */
  private async preparar(
    ctx: CtxEmpresa,
    documentoId: string,
    respuestas: RespuestasDeFactura,
    exigirNumero: boolean,
  ) {
    const documento = await this.documentos.porId(ctx, documentoId);
    if (documento.tipo !== 'FACTURA_COMPRA') {
      throw new BadRequestException(
        'Ese documento no es una factura de compra.',
      );
    }

    const cruzada = documento.extraido as FacturaCruzada | null;
    if (cruzada?.factura === undefined) {
      throw new BadRequestException(
        'Esa lectura no tiene una factura que registrar.',
      );
    }

    // Las cuentas tienen que dar, y esto **no se puede responder**: no es un
    // dato que falte, es que lo leído se contradice con lo impreso. Registrar
    // igual sería meter a la contabilidad una factura que nadie verificó.
    if (!cuadra(cruzada.comprobaciones)) {
      const cuales = cruzada.comprobaciones
        .filter((c) => !c.cuadra)
        .map(
          (c) =>
            `${c.que.toLowerCase()} (sumé ${c.calculado}, dice ${c.impreso})`,
        )
        .join('; ');
      throw new BadRequestException(
        `Las cuentas de la factura no dan: ${cuales}. Registrala a mano.`,
      );
    }

    const numero = respuestas.numero?.trim() ?? cruzada.factura.numero ?? '';
    if (exigirNumero && numero === '') {
      throw new BadRequestException(
        'Falta el número de la factura del proveedor.',
      );
    }

    const terceroId = respuestas.terceroId ?? cruzada.proveedor?.id;
    if (terceroId === undefined) {
      throw new BadRequestException('Falta decir quién es el proveedor.');
    }

    const { lineas, aLinea } = this.armarLineas(cruzada, respuestas);

    // El prefijo va pegado al número, como lo imprime el proveedor: es así como
    // alguien lo va a buscar después.
    const conPrefijo =
      cruzada.factura.prefijo === null || respuestas.numero !== undefined
        ? numero
        : `${cruzada.factura.prefijo}-${numero}`;

    return { cruzada, terceroId, lineas, conPrefijo, aLinea };
  }

  /**
   * Las líneas que van a `POST /compras`: las que el cruce resolvió, más las
   * que la persona resolvió a mano.
   *
   * **Se recorren los renglones del documento, no las líneas del cruce.** Así
   * el orden es el del papel y no puede quedarse afuera un renglón que alguien
   * acaba de resolver.
   */
  private armarLineas(
    cruzada: FacturaCruzada,
    respuestas: RespuestasDeFactura,
  ) {
    const aMano = new Map(
      (respuestas.renglones ?? []).map((r) => [r.orden, r]),
    );

    const renglonesOrden = cruzada.renglones.map((r) => r.orden);
    const lineas = cruzada.renglones.map((renglon) => {
      const respuesta = aMano.get(renglon.orden);
      const productoId = respuesta?.productoId ?? idSi(renglon, 'PRODUCTO');
      const cuentaId = respuesta?.cuentaId ?? idSi(renglon, 'GASTO');

      if (productoId === undefined && cuentaId === undefined) {
        throw new BadRequestException(
          `Falta decir qué es el renglón ${renglon.orden}: «${renglon.leido.descripcion}».`,
        );
      }
      if (productoId !== undefined && cuentaId !== undefined) {
        throw new BadRequestException(
          `El renglón ${renglon.orden} no puede ser un producto y un gasto a la vez.`,
        );
      }

      return productoId !== undefined
        ? {
            productoId,
            cantidad: renglon.leido.cantidad,
            costoUnitario: renglon.leido.valorUnitario,
          }
        : {
            cuentaId,
            detalle: renglon.leido.descripcion,
            ivaTarifa: renglon.leido.ivaTarifa,
            cantidad: renglon.leido.cantidad,
            costoUnitario: renglon.leido.valorUnitario,
          };
    });

    // El mismo producto dos veces lo rechaza la compra, y una factura de
    // sesenta renglones lo trae. Se juntan al promedio ponderado: tomar el
    // primero o el último cambiaría el costo del inventario según el orden.
    const juntas: typeof lineas = [];
    /** Renglón del papel → línea de la compra (empezando en 1). */
    const aLinea = new Map<number, number>();
    for (const [i, linea] of lineas.entries()) {
      const previa =
        'productoId' in linea && linea.productoId !== undefined
          ? juntas.find(
              (j) => 'productoId' in j && j.productoId === linea.productoId,
            )
          : undefined;

      if (previa === undefined) {
        juntas.push(linea);
        aLinea.set(renglonesOrden[i], juntas.length);
        continue;
      }
      aLinea.set(renglonesOrden[i], juntas.indexOf(previa) + 1);

      const valor =
        previa.cantidad * previa.costoUnitario +
        linea.cantidad * linea.costoUnitario;
      previa.cantidad += linea.cantidad;
      previa.costoUnitario = Math.round((valor / previa.cantidad) * 1e6) / 1e6;
    }

    return { lineas: juntas, aLinea };
  }
}

function idSi(
  renglon: FacturaCruzada['renglones'][number],
  clase: 'PRODUCTO' | 'GASTO',
): string | undefined {
  return renglon.resuelto?.clase === clase ? renglon.resuelto.id : undefined;
}
