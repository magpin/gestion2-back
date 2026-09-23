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

    const numero = respuestas.numero?.trim() ?? cruzada.factura.numero;
    if (numero === null || numero === '') {
      throw new BadRequestException(
        'Falta el número de la factura del proveedor.',
      );
    }

    const terceroId = respuestas.terceroId ?? cruzada.proveedor?.id;
    if (terceroId === undefined) {
      throw new BadRequestException('Falta decir quién es el proveedor.');
    }

    const lineas = this.armarLineas(cruzada, respuestas);

    // El prefijo va pegado al número, como lo imprime el proveedor: es así como
    // alguien lo va a buscar después.
    const conPrefijo =
      cruzada.factura.prefijo === null || respuestas.numero !== undefined
        ? numero
        : `${cruzada.factura.prefijo}-${numero}`;

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
        },
        // De qué documento salió. Va por acá y no en el cuerpo de la petición:
        // si viniera del navegador, cualquiera podría decir que una compra
        // digitada salió de un documento que María leyó.
        { documentoLeidoId: documentoId },
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
    for (const linea of lineas) {
      const previa =
        'productoId' in linea && linea.productoId !== undefined
          ? juntas.find(
              (j) => 'productoId' in j && j.productoId === linea.productoId,
            )
          : undefined;

      if (previa === undefined) {
        juntas.push(linea);
        continue;
      }

      const valor =
        previa.cantidad * previa.costoUnitario +
        linea.cantidad * linea.costoUnitario;
      previa.cantidad += linea.cantidad;
      previa.costoUnitario = Math.round((valor / previa.cantidad) * 1e6) / 1e6;
    }

    return juntas;
  }
}

function idSi(
  renglon: FacturaCruzada['renglones'][number],
  clase: 'PRODUCTO' | 'GASTO',
): string | undefined {
  return renglon.resuelto?.clase === clase ? renglon.resuelto.id : undefined;
}
