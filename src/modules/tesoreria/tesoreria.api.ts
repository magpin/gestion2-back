import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';

export interface ResultadoTesoreria {
  movimientoId: string;
  asientoId: string;
}

/**
 * Cobra una factura de venta. `cajaId` es la caja que recibe la plata;
 * `cuentaClientesId` es la cuenta de Clientes que se acredita (la conoce
 * quien vende, es la misma que usó al asentar la factura).
 */
export interface DatosCobro {
  medio: 'CAJA';
  cajaId: string;
  fecha: string;
  valor: number;
  concepto: string;
  cuentaClientesId: string;
  terceroId: string;
  facturaVentaId: string;
}

/**
 * Paga una compra. `cuentaProveedoresId` es la cuenta de Proveedores que
 * se debita (la conoce quien compra, es la misma que usó al asentar la
 * compra).
 */
export interface DatosPago {
  medio: 'CAJA';
  cajaId: string;
  fecha: string;
  valor: number;
  concepto: string;
  cuentaProveedoresId: string;
  terceroId: string;
  compraId: string;
}

/**
 * La única clase que `tesoreria` expone a otros módulos.
 *
 * Todo lo demás —servicios, controladores, DTOs— es interno. Ventas y Compras
 * llaman acá para cobrar/pagar en efectivo, no a `CajaMovimientoService`
 * directamente — esa regla es lo que permite cambiar cómo se guarda el
 * movimiento sin que se entere nadie más, mismo patrón que
 * `ContabilidadApi`/`InventarioApi`.
 *
 * `medio: 'CAJA'` es el único que existe por ahora: Bancos agrega `'BANCO'`
 * en la Fase 2, y esta fachada es la que va a distinguir uno de otro
 * cuando llegue. Hoy nadie la llama todavía —el primer consumidor real
 * llega en el paso 12, el botón "Cobrar/Pagar en efectivo" de Ventas y
 * Compras—.
 */
@Injectable()
export class TesoreriaApi {
  constructor(private readonly cajaMovimientos: CajaMovimientoService) {}

  /**
   * Cobra una factura de venta en efectivo: débito a la caja, crédito a
   * `cuentaClientesId`. Rechaza si la caja no existe o la empresa no tiene
   * el comprobante `CI` sembrado — nunca deja la factura "cobrada a
   * medias".
   */
  async registrarCobro(
    ctx: CtxEmpresa,
    datos: DatosCobro,
  ): Promise<ResultadoTesoreria> {
    const movimiento = await this.cajaMovimientos.registrarMovimientoDocumento(
      ctx,
      datos.cajaId,
      {
        tipo: 'INGRESO',
        fecha: datos.fecha,
        valor: datos.valor,
        concepto: datos.concepto,
        contraCuentaId: datos.cuentaClientesId,
        documentoTipo: 'FACTURA_VENTA',
        documentoId: datos.facturaVentaId,
        terceroId: datos.terceroId,
      },
    );
    return this.exigirAsiento(movimiento);
  }

  /**
   * Paga una compra en efectivo: débito a `cuentaProveedoresId`, crédito a
   * la caja. Rechaza en negativo (no hay con qué pagar) y si la empresa no
   * tiene el comprobante `CE` sembrado.
   */
  async registrarPago(
    ctx: CtxEmpresa,
    datos: DatosPago,
  ): Promise<ResultadoTesoreria> {
    const movimiento = await this.cajaMovimientos.registrarMovimientoDocumento(
      ctx,
      datos.cajaId,
      {
        tipo: 'EGRESO',
        fecha: datos.fecha,
        valor: datos.valor,
        concepto: datos.concepto,
        contraCuentaId: datos.cuentaProveedoresId,
        documentoTipo: 'COMPRA',
        documentoId: datos.compraId,
        terceroId: datos.terceroId,
      },
    );
    return this.exigirAsiento(movimiento);
  }

  /**
   * `asiento_id` es `null` en el tipo porque `MovimientoCajaResumen` lo
   * comparte con `SALDO_INICIAL` — un cobro o un pago nunca es
   * `SALDO_INICIAL`, así que siempre trae uno. Si esto disparara, sería un
   * bug de `CajaMovimientoService`, no una entrada inválida de quien llama.
   */
  private exigirAsiento(movimiento: {
    id: string;
    asiento_id: string | null;
  }): ResultadoTesoreria {
    if (movimiento.asiento_id === null) {
      throw new Error(
        'Inconsistencia: un cobro o pago debería generar siempre un asiento.',
      );
    }
    return { movimientoId: movimiento.id, asientoId: movimiento.asiento_id };
  }
}
