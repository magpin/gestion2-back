import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import type { Tx } from '../../common/db/tx.service';
import { BancoMovimientoService } from './servicios/banco-movimiento.service';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';

export interface ResultadoTesoreria {
  movimientoId: string;
  asientoId: string;
}

/**
 * Por dónde entra o sale la plata — `cajaId`/`cuentaBancariaId` son
 * mutuamente excluyentes, discriminados por `medio`. Compartido entre
 * `DatosCobro`/`DatosPago`: lo único que cada uno agrega es la cuenta
 * contraria y el documento.
 */
type Medio =
  | {
      medio: 'CAJA';
      cajaId: string;
      fecha: string;
      valor: number;
      concepto: string;
      terceroId: string;
    }
  | {
      medio: 'BANCO';
      cuentaBancariaId: string;
      fecha: string;
      valor: number;
      concepto: string;
      terceroId: string;
    };

/**
 * Cobra una factura de venta. `cuentaClientesId` es la cuenta de
 * Clientes que se acredita (la conoce quien vende, es la misma que usó
 * al asentar la factura).
 */
export type DatosCobro = Medio & {
  cuentaClientesId: string;
  facturaVentaId: string;
};

/**
 * Paga una compra. `cuentaProveedoresId` es la cuenta de Proveedores que
 * se debita (la conoce quien compra, es la misma que usó al asentar la
 * compra).
 */
export type DatosPago = Medio & {
  cuentaProveedoresId: string;
  compraId: string;
};

/**
 * La única clase que `tesoreria` expone a otros módulos.
 *
 * Todo lo demás —servicios, controladores, DTOs— es interno. Ventas y Compras
 * llaman acá para cobrar/pagar, no a `CajaMovimientoService`/
 * `BancoMovimientoService` directamente — esa regla es lo que permite
 * cambiar cómo se guarda el movimiento sin que se entere nadie más,
 * mismo patrón que `ContabilidadApi`/`InventarioApi`.
 *
 * `medio: 'CAJA' | 'BANCO'` — el primer consumidor real es
 * `VentaDocumentoService.cobrarEfectivo`/`CompraService.pagarEfectivo`
 * (paso 12), hoy solo con `'CAJA'`; conectar `'BANCO'` desde ahí es el
 * paso 20.
 */
@Injectable()
export class TesoreriaApi {
  constructor(
    private readonly cajaMovimientos: CajaMovimientoService,
    private readonly bancoMovimientos: BancoMovimientoService,
  ) {}

  /**
   * Cobra una factura de venta: débito al medio elegido, crédito a
   * `cuentaClientesId`. Rechaza si la caja/cuenta no existe o la empresa
   * no tiene el comprobante `CI` sembrado — nunca deja la factura
   * "cobrada a medias".
   *
   * `t` es opcional pero quien cobra una factura real SIEMPRE debería
   * pasar la transacción que ya tiene abierta: el cobro y la actualización
   * de `monto_pagado` del documento tienen que confirmarse juntos o
   * ninguno, mismo principio que `ContabilidadApi.asentar`.
   */
  async registrarCobro(
    ctx: CtxEmpresa,
    datos: DatosCobro,
    t?: Tx,
  ): Promise<ResultadoTesoreria> {
    const movimiento = await this.moverMedio(
      ctx,
      datos,
      'ENTRADA',
      { documentoTipo: 'FACTURA_VENTA', documentoId: datos.facturaVentaId },
      datos.cuentaClientesId,
      t,
    );
    return this.exigirAsiento(movimiento);
  }

  /**
   * Paga una compra: débito a `cuentaProveedoresId`, crédito al medio
   * elegido. Por caja rechaza en negativo (no hay con qué pagar); por
   * banco puede dejar sobregiro, mismo criterio que
   * `BancoMovimientoService`. Rechaza si la empresa no tiene el
   * comprobante `CE` sembrado. Mismo motivo que `registrarCobro` para el
   * `t` opcional.
   */
  async registrarPago(
    ctx: CtxEmpresa,
    datos: DatosPago,
    t?: Tx,
  ): Promise<ResultadoTesoreria> {
    const movimiento = await this.moverMedio(
      ctx,
      datos,
      'SALIDA',
      { documentoTipo: 'COMPRA', documentoId: datos.compraId },
      datos.cuentaProveedoresId,
      t,
    );
    return this.exigirAsiento(movimiento);
  }

  /**
   * Despacha a `CajaMovimientoService` o `BancoMovimientoService` según
   * `medio` — el resto (documento, tercero, contracuenta) es idéntico
   * para los dos, solo cambia el `tipo` que cada servicio entiende
   * (`INGRESO`/`EGRESO` en caja, `TRANSFERENCIA_ENTRANTE`/
   * `TRANSFERENCIA_SALIENTE` en banco).
   */
  private async moverMedio(
    ctx: CtxEmpresa,
    medio: Medio,
    direccion: 'ENTRADA' | 'SALIDA',
    documento: {
      documentoTipo: 'FACTURA_VENTA' | 'COMPRA';
      documentoId: string;
    },
    contraCuentaId: string,
    t: Tx | undefined,
  ): Promise<{ id: string; asiento_id: string | null }> {
    const base = {
      fecha: medio.fecha,
      valor: medio.valor,
      concepto: medio.concepto,
      contraCuentaId,
      documentoTipo: documento.documentoTipo,
      documentoId: documento.documentoId,
      terceroId: medio.terceroId,
    };

    if (medio.medio === 'CAJA') {
      return this.cajaMovimientos.registrarMovimientoDocumento(
        ctx,
        medio.cajaId,
        { ...base, tipo: direccion === 'ENTRADA' ? 'INGRESO' : 'EGRESO' },
        t,
      );
    }

    return this.bancoMovimientos.registrarMovimientoDocumento(
      ctx,
      medio.cuentaBancariaId,
      {
        ...base,
        tipo:
          direccion === 'ENTRADA'
            ? 'TRANSFERENCIA_ENTRANTE'
            : 'TRANSFERENCIA_SALIENTE',
      },
      t,
    );
  }

  /**
   * `asiento_id` es `null` en el tipo porque `MovimientoCajaResumen`/
   * `MovimientoBancoResumen` lo comparten con `SALDO_INICIAL` — un cobro
   * o un pago nunca es `SALDO_INICIAL`, así que siempre trae uno. Si esto
   * disparara, sería un bug de `CajaMovimientoService`/
   * `BancoMovimientoService`, no una entrada inválida de quien llama.
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
