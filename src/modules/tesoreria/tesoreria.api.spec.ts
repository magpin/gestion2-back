import type { CtxEmpresa } from '../../common/ctx';
import { BancoMovimientoService } from './servicios/banco-movimiento.service';
import { CajaMovimientoService } from './servicios/caja-movimiento.service';
import type { DatosCobro, DatosPago } from './tesoreria.api';
import { TesoreriaApi } from './tesoreria.api';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CAJA'],
};

function cajaMovimientosFalso(
  movimiento: { id: string; asiento_id: string | null } = {
    id: 'mov-1',
    asiento_id: 'asiento-1',
  },
) {
  const registrarMovimientoDocumento = jest.fn(() =>
    Promise.resolve(movimiento as never),
  );
  const fake = {
    registrarMovimientoDocumento,
  } as unknown as CajaMovimientoService;
  return { fake, registrarMovimientoDocumento };
}

function bancoMovimientosFalso(
  movimiento: { id: string; asiento_id: string | null } = {
    id: 'mov-banco-1',
    asiento_id: 'asiento-banco-1',
  },
) {
  const registrarMovimientoDocumento = jest.fn(() =>
    Promise.resolve(movimiento as never),
  );
  const fake = {
    registrarMovimientoDocumento,
  } as unknown as BancoMovimientoService;
  return { fake, registrarMovimientoDocumento };
}

const COBRO_CAJA: DatosCobro = {
  medio: 'CAJA',
  cajaId: 'c-1',
  fecha: '2026-09-12',
  valor: 50_000,
  concepto: 'Cobro FV-001',
  cuentaClientesId: 'cta-clientes',
  terceroId: 'ter-1',
  facturaVentaId: 'factura-1',
};

const COBRO_BANCO: DatosCobro = {
  medio: 'BANCO',
  cuentaBancariaId: 'cb-1',
  fecha: '2026-09-12',
  valor: 50_000,
  concepto: 'Cobro FV-001',
  cuentaClientesId: 'cta-clientes',
  terceroId: 'ter-1',
  facturaVentaId: 'factura-1',
};

const PAGO_CAJA: DatosPago = {
  medio: 'CAJA',
  cajaId: 'c-1',
  fecha: '2026-09-12',
  valor: 40_000,
  concepto: 'Pago CO-001',
  cuentaProveedoresId: 'cta-proveedores',
  terceroId: 'ter-2',
  compraId: 'compra-1',
};

const PAGO_BANCO: DatosPago = {
  medio: 'BANCO',
  cuentaBancariaId: 'cb-1',
  fecha: '2026-09-12',
  valor: 40_000,
  concepto: 'Pago CO-001',
  cuentaProveedoresId: 'cta-proveedores',
  terceroId: 'ter-2',
  compraId: 'compra-1',
};

describe('TesoreriaApi.registrarCobro', () => {
  it('con medio CAJA, delega en CajaMovimientoService como INGRESO/FACTURA_VENTA', async () => {
    const { fake: caja, registrarMovimientoDocumento } = cajaMovimientosFalso();
    const { fake: banco } = bancoMovimientosFalso();
    const api = new TesoreriaApi(caja, banco);

    const resultado = await api.registrarCobro(ctx, COBRO_CAJA);

    expect(resultado).toEqual({
      movimientoId: 'mov-1',
      asientoId: 'asiento-1',
    });
    expect(registrarMovimientoDocumento).toHaveBeenCalledWith(
      ctx,
      'c-1',
      {
        tipo: 'INGRESO',
        fecha: COBRO_CAJA.fecha,
        valor: COBRO_CAJA.valor,
        concepto: COBRO_CAJA.concepto,
        contraCuentaId: 'cta-clientes',
        documentoTipo: 'FACTURA_VENTA',
        documentoId: 'factura-1',
        terceroId: 'ter-1',
      },
      undefined,
    );
  });

  it('con medio BANCO, delega en BancoMovimientoService como TRANSFERENCIA_ENTRANTE/FACTURA_VENTA', async () => {
    const { fake: caja, registrarMovimientoDocumento: cajaRegistrar } =
      cajaMovimientosFalso();
    const { fake: banco, registrarMovimientoDocumento: bancoRegistrar } =
      bancoMovimientosFalso();
    const api = new TesoreriaApi(caja, banco);

    const resultado = await api.registrarCobro(ctx, COBRO_BANCO);

    expect(resultado).toEqual({
      movimientoId: 'mov-banco-1',
      asientoId: 'asiento-banco-1',
    });
    expect(bancoRegistrar).toHaveBeenCalledWith(
      ctx,
      'cb-1',
      {
        tipo: 'TRANSFERENCIA_ENTRANTE',
        fecha: COBRO_BANCO.fecha,
        valor: COBRO_BANCO.valor,
        concepto: COBRO_BANCO.concepto,
        contraCuentaId: 'cta-clientes',
        documentoTipo: 'FACTURA_VENTA',
        documentoId: 'factura-1',
        terceroId: 'ter-1',
      },
      undefined,
    );
    expect(cajaRegistrar).not.toHaveBeenCalled();
  });

  it('reenvía la transacción externa cuando se la pasan', async () => {
    const { fake: caja, registrarMovimientoDocumento } = cajaMovimientosFalso();
    const { fake: banco } = bancoMovimientosFalso();
    const api = new TesoreriaApi(caja, banco);
    const txExterna = {} as never;

    await api.registrarCobro(ctx, COBRO_CAJA, txExterna);

    expect(registrarMovimientoDocumento).toHaveBeenCalledWith(
      ctx,
      'c-1',
      expect.objectContaining({ tipo: 'INGRESO' }),
      txExterna,
    );
  });
});

describe('TesoreriaApi.registrarPago', () => {
  it('con medio CAJA, delega en CajaMovimientoService como EGRESO/COMPRA', async () => {
    const { fake: caja, registrarMovimientoDocumento } = cajaMovimientosFalso({
      id: 'mov-2',
      asiento_id: 'asiento-2',
    });
    const { fake: banco } = bancoMovimientosFalso();
    const api = new TesoreriaApi(caja, banco);

    const resultado = await api.registrarPago(ctx, PAGO_CAJA);

    expect(resultado).toEqual({
      movimientoId: 'mov-2',
      asientoId: 'asiento-2',
    });
    expect(registrarMovimientoDocumento).toHaveBeenCalledWith(
      ctx,
      'c-1',
      {
        tipo: 'EGRESO',
        fecha: PAGO_CAJA.fecha,
        valor: PAGO_CAJA.valor,
        concepto: PAGO_CAJA.concepto,
        contraCuentaId: 'cta-proveedores',
        documentoTipo: 'COMPRA',
        documentoId: 'compra-1',
        terceroId: 'ter-2',
      },
      undefined,
    );
  });

  it('con medio BANCO, delega en BancoMovimientoService como TRANSFERENCIA_SALIENTE/COMPRA', async () => {
    const { fake: caja } = cajaMovimientosFalso();
    const { fake: banco, registrarMovimientoDocumento: bancoRegistrar } =
      bancoMovimientosFalso({
        id: 'mov-banco-2',
        asiento_id: 'asiento-banco-2',
      });
    const api = new TesoreriaApi(caja, banco);

    const resultado = await api.registrarPago(ctx, PAGO_BANCO);

    expect(resultado).toEqual({
      movimientoId: 'mov-banco-2',
      asientoId: 'asiento-banco-2',
    });
    expect(bancoRegistrar).toHaveBeenCalledWith(
      ctx,
      'cb-1',
      {
        tipo: 'TRANSFERENCIA_SALIENTE',
        fecha: PAGO_BANCO.fecha,
        valor: PAGO_BANCO.valor,
        concepto: PAGO_BANCO.concepto,
        contraCuentaId: 'cta-proveedores',
        documentoTipo: 'COMPRA',
        documentoId: 'compra-1',
        terceroId: 'ter-2',
      },
      undefined,
    );
  });

  it('lanza si el servicio devolviera un movimiento sin asiento (invariante)', async () => {
    const { fake: caja } = cajaMovimientosFalso({
      id: 'mov-3',
      asiento_id: null,
    });
    const { fake: banco } = bancoMovimientosFalso();
    const api = new TesoreriaApi(caja, banco);

    await expect(api.registrarPago(ctx, PAGO_CAJA)).rejects.toThrow(
      /debería generar siempre un asiento/,
    );
  });
});
