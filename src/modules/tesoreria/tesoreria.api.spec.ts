import type { CtxEmpresa } from '../../common/ctx';
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

const COBRO: DatosCobro = {
  medio: 'CAJA',
  cajaId: 'c-1',
  fecha: '2026-09-12',
  valor: 50_000,
  concepto: 'Cobro FV-001',
  cuentaClientesId: 'cta-clientes',
  terceroId: 'ter-1',
  facturaVentaId: 'factura-1',
};

const PAGO: DatosPago = {
  medio: 'CAJA',
  cajaId: 'c-1',
  fecha: '2026-09-12',
  valor: 40_000,
  concepto: 'Pago CO-001',
  cuentaProveedoresId: 'cta-proveedores',
  terceroId: 'ter-2',
  compraId: 'compra-1',
};

describe('TesoreriaApi.registrarCobro', () => {
  it('delega en CajaMovimientoService.registrarMovimientoDocumento como INGRESO/FACTURA_VENTA', async () => {
    const { fake, registrarMovimientoDocumento } = cajaMovimientosFalso();
    const api = new TesoreriaApi(fake);

    const resultado = await api.registrarCobro(ctx, COBRO);

    expect(resultado).toEqual({
      movimientoId: 'mov-1',
      asientoId: 'asiento-1',
    });
    expect(registrarMovimientoDocumento).toHaveBeenCalledWith(ctx, 'c-1', {
      tipo: 'INGRESO',
      fecha: COBRO.fecha,
      valor: COBRO.valor,
      concepto: COBRO.concepto,
      contraCuentaId: 'cta-clientes',
      documentoTipo: 'FACTURA_VENTA',
      documentoId: 'factura-1',
      terceroId: 'ter-1',
    });
  });
});

describe('TesoreriaApi.registrarPago', () => {
  it('delega en CajaMovimientoService.registrarMovimientoDocumento como EGRESO/COMPRA', async () => {
    const { fake, registrarMovimientoDocumento } = cajaMovimientosFalso({
      id: 'mov-2',
      asiento_id: 'asiento-2',
    });
    const api = new TesoreriaApi(fake);

    const resultado = await api.registrarPago(ctx, PAGO);

    expect(resultado).toEqual({
      movimientoId: 'mov-2',
      asientoId: 'asiento-2',
    });
    expect(registrarMovimientoDocumento).toHaveBeenCalledWith(ctx, 'c-1', {
      tipo: 'EGRESO',
      fecha: PAGO.fecha,
      valor: PAGO.valor,
      concepto: PAGO.concepto,
      contraCuentaId: 'cta-proveedores',
      documentoTipo: 'COMPRA',
      documentoId: 'compra-1',
      terceroId: 'ter-2',
    });
  });

  it('lanza si CajaMovimientoService devolviera un movimiento sin asiento (invariante)', async () => {
    const { fake } = cajaMovimientosFalso({ id: 'mov-3', asiento_id: null });
    const api = new TesoreriaApi(fake);

    await expect(api.registrarPago(ctx, PAGO)).rejects.toThrow(
      /debería generar siempre un asiento/,
    );
  });
});
