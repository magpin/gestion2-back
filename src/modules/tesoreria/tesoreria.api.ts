import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import type { Tx } from '../../common/db/tx.service';
import { BancoMovimientoService } from './servicios/banco-movimiento.service';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';
import { CajaService } from './servicios/caja.service';
import type { Contrapartida } from './servicios/contrapartida';
import { CuentaBancariaService } from './servicios/cuenta-bancaria.service';
import {
  MovimientoConceptoService,
  type DatosMovimientoConcepto,
} from './servicios/movimiento-concepto.service';

export type {
  DatosMovimientoConcepto,
  MovimientoConcepto,
} from './servicios/movimiento-concepto.service';

/** La plata de un medio, hoy. Lo que el asistente contesta a «¿cuánto hay en el banco?». */
export interface SaldoDeMedio {
  /** El id de la caja o la cuenta: con esto el asistente arma una propuesta de cobro o de pago. */
  id: string;
  medio: 'CAJA' | 'BANCO';
  nombre: string;
  saldo: string;
  ultimoMovimiento: string | null;
}

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
 * El cobro o pago de un documento de contado que ya asentó la plata en su
 * propio asiento: solo falta el movimiento de caja o banco que apunte a él.
 */
export type DatosMovimientoEnAsiento = Medio & {
  documentoTipo: 'FACTURA_VENTA' | 'COMPRA';
  documentoId: string;
  asientoId: string;
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
 * `medio: 'CAJA' | 'BANCO'` — el consumidor real es
 * `VentaDocumentoService.cobrar`/`CompraService.pagar` (pasos 12 y 20),
 * que reciben el medio elegido en su propio DTO (`CobrarDto`/`PagarDto`)
 * y arman este `Medio` a partir de él.
 */
@Injectable()
export class TesoreriaApi {
  constructor(
    private readonly cajaMovimientos: CajaMovimientoService,
    private readonly bancoMovimientos: BancoMovimientoService,
    private readonly cajas: CajaService,
    private readonly cuentas: CuentaBancariaService,
    private readonly porConcepto: MovimientoConceptoService,
  ) {}

  /**
   * El saldo de hoy de cada caja y cuenta bancaria activa. Solo lectura: lo
   * pide el asistente (paso 6 de `asistente-conversacion.md`), con los
   * mismos datos que `GET /cajas` y `GET /cuentas-bancarias`. **No mira
   * roles**: eso lo hace quien llama, igual que el controlador.
   */
  async saldos(ctx: CtxEmpresa): Promise<SaldoDeMedio[]> {
    const [cajas, cuentas] = await Promise.all([
      this.cajas.listar(ctx),
      this.cuentas.listar(ctx),
    ]);
    return [
      ...cuentas.map((c) => ({
        id: c.id,
        medio: 'BANCO' as const,
        nombre: `${c.banco} ${c.tipo_cuenta === 'AHORROS' ? 'ahorros' : 'corriente'} ${c.numero_cuenta}`,
        saldo: c.saldo,
        ultimoMovimiento: c.ultimo_movimiento,
      })),
      ...cajas.map((c) => ({
        id: c.id,
        medio: 'CAJA' as const,
        nombre: c.nombre,
        saldo: c.saldo,
        ultimoMovimiento: c.ultimo_movimiento,
      })),
    ];
  }

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
   * Devuelve parte de un cobro: sale plata del medio elegido y vuelve a
   * `cuentaClientesId` —el cliente vuelve a quedar como acreedor de eso—.
   * Es el asiento del cobro al revés, y por eso reusa la misma fachada con
   * la dirección invertida en vez de abrir un camino propio.
   *
   * Por caja puede fallar: `calcularEgreso` rechaza dejar el cajón en
   * negativo y lo dice con su propio mensaje. Por banco pasa igual que
   * cualquier salida —el sobregiro está admitido, decisión de
   * `caja-bancos-fase2.md`—.
   */
  async registrarDevolucionCobro(
    ctx: CtxEmpresa,
    datos: DatosCobro,
    t?: Tx,
  ): Promise<ResultadoTesoreria> {
    const movimiento = await this.moverMedio(
      ctx,
      datos,
      'SALIDA',
      { documentoTipo: 'FACTURA_VENTA', documentoId: datos.facturaVentaId },
      datos.cuentaClientesId,
      t,
    );
    return this.exigirAsiento(movimiento);
  }

  /**
   * El proveedor nos devuelve parte de lo pagado: entra plata al medio
   * elegido y vuelve a `cuentaProveedoresId`. Espejo de
   * `registrarDevolucionCobro`; acá no hay saldo que se quede corto, porque
   * es una entrada.
   */
  async registrarDevolucionPago(
    ctx: CtxEmpresa,
    datos: DatosPago,
    t?: Tx,
  ): Promise<ResultadoTesoreria> {
    const movimiento = await this.moverMedio(
      ctx,
      datos,
      'ENTRADA',
      { documentoTipo: 'COMPRA', documentoId: datos.compraId },
      datos.cuentaProveedoresId,
      t,
    );
    return this.exigirAsiento(movimiento);
  }

  /**
   * Plata que entra o sale por un concepto —un anticipo, la comisión del
   * datáfono—. Ver `MovimientoConceptoService.registrar`.
   */
  registrarPorConcepto(ctx: CtxEmpresa, datos: DatosMovimientoConcepto, t: Tx) {
    return this.porConcepto.registrar(ctx, datos, t);
  }

  /**
   * Plata que sale de una caja o un banco contra **varias cuentas** a la vez:
   * el pago de una declaración (una 2365 por concepto, la autorretención y los
   * intereses). Las contrapartidas son los débitos; su suma tiene que dar el
   * valor que sale. Por caja no deja el cajón en negativo; por banco admite
   * sobregiro, como toda salida.
   */
  async registrarSalidaConPartidas(
    ctx: CtxEmpresa,
    datos: {
      medio: 'CAJA' | 'BANCO';
      cajaId?: string | null;
      cuentaBancariaId?: string | null;
      fecha: string;
      valor: number;
      concepto: string;
      terceroId: string | null;
      contrapartidas: Contrapartida[];
    },
    t: Tx,
  ): Promise<ResultadoTesoreria> {
    const debitos = datos.contrapartidas.reduce(
      (s, c) => s + c.debito - c.credito,
      0,
    );
    if (Math.abs(debitos - datos.valor) > 0.005) {
      throw new Error(
        `Inconsistencia: las partidas suman ${debitos} y sale ${datos.valor}.`,
      );
    }
    const comun = {
      fecha: datos.fecha,
      valor: datos.valor,
      concepto: datos.concepto,
      terceroId: datos.terceroId,
      contrapartidas: datos.contrapartidas,
    };
    if (datos.medio === 'CAJA') {
      if (!datos.cajaId) throw new Error('Falta la caja.');
      return this.exigirAsiento(
        await this.cajaMovimientos.registrarConContrapartidas(
          ctx,
          datos.cajaId,
          { ...comun, tipo: 'EGRESO' },
          t,
        ),
      );
    }
    if (!datos.cuentaBancariaId) throw new Error('Falta la cuenta bancaria.');
    return this.exigirAsiento(
      await this.bancoMovimientos.registrarConContrapartidas(
        ctx,
        datos.cuentaBancariaId,
        { ...comun, tipo: 'TRANSFERENCIA_SALIENTE' },
        t,
      ),
    );
  }

  /** Lo anula con su contrario en el mismo libro. */
  anularPorConcepto(ctx: CtxEmpresa, id: string, motivo: string, t: Tx) {
    return this.porConcepto.anular(ctx, id, motivo, t);
  }

  /** El 4×1000 de una salida de banco; `null` si la cuenta es exenta. */
  cobrarGmf(
    ctx: CtxEmpresa,
    datos: {
      cuentaBancariaId: string;
      base: number;
      fecha: string;
      detalle: string;
      origenId?: string;
    },
    t: Tx,
  ) {
    return this.porConcepto.cobrarGmf(ctx, datos, t);
  }

  /** El 4×1000 que va dentro de `total` cuando lo asume quien recibe la plata. */
  gmfIncluidoEn(
    _ctx: CtxEmpresa,
    cuentaBancariaId: string,
    total: number,
    t: Tx,
  ): Promise<number> {
    return this.porConcepto.gmfIncluidoEn(cuentaBancariaId, total, t);
  }

  /** Los movimientos por concepto, filtrados. */
  movimientosPorConcepto(
    ctx: CtxEmpresa,
    filtro: Parameters<MovimientoConceptoService['listar']>[1],
    t?: Tx,
  ) {
    return this.porConcepto.listar(ctx, filtro, t);
  }

  /**
   * La cuenta contable de una caja o cuenta bancaria y cómo se llama —«Caja
   * general», «Bancolombia ···1234»—. La usa la factura de contado para
   * llevar la plata en su propio asiento, un renglón por medio.
   */
  async cuentaDelMedio(
    ctx: CtxEmpresa,
    medio:
      | { medio: 'CAJA'; cajaId: string }
      | { medio: 'BANCO'; cuentaBancariaId: string },
    t: Tx,
  ): Promise<{ cuentaId: string; nombre: string }> {
    if (medio.medio === 'CAJA') {
      return this.cajaMovimientos.cuentaDe(ctx, medio.cajaId, t);
    }
    const c = await this.bancoMovimientos.cuentaDe(
      ctx,
      medio.cuentaBancariaId,
      t,
    );
    return {
      cuentaId: c.cuentaId,
      nombre: `${c.banco} ···${c.nombre.slice(-4)}`,
    };
  }

  /**
   * El movimiento de caja o banco de un documento de contado cuyo asiento ya
   * lleva la plata (`cuentaDelMedio`): corre el saldo y lo liga a ese asiento
   * sin asentar otro. Así una factura de contado repartida entre caja y banco
   * queda en un solo asiento, y cada libro igual ve su parte.
   */
  async registrarEnAsiento(
    ctx: CtxEmpresa,
    datos: DatosMovimientoEnAsiento,
    direccion: 'ENTRADA' | 'SALIDA',
    t: Tx,
  ): Promise<{ movimientoId: string }> {
    const base = {
      fecha: datos.fecha,
      valor: datos.valor,
      concepto: datos.concepto,
      documentoTipo: datos.documentoTipo,
      documentoId: datos.documentoId,
      terceroId: datos.terceroId,
      asientoId: datos.asientoId,
    };
    const movimiento =
      datos.medio === 'CAJA'
        ? await this.cajaMovimientos.registrarDocumentoConAsiento(
            ctx,
            datos.cajaId,
            { ...base, tipo: direccion === 'ENTRADA' ? 'INGRESO' : 'EGRESO' },
            t,
          )
        : await this.bancoMovimientos.registrarDocumentoConAsiento(
            ctx,
            datos.cuentaBancariaId,
            {
              ...base,
              tipo:
                direccion === 'ENTRADA'
                  ? 'TRANSFERENCIA_ENTRANTE'
                  : 'TRANSFERENCIA_SALIENTE',
            },
            t,
          );
    return { movimientoId: movimiento.id };
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
