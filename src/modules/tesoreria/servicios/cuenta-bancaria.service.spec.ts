import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { CuentaBancariaService } from './cuenta-bancaria.service';

const ctx = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CAJA'],
} as CtxEmpresa;

function montar(
  cuenta: { codigo: string; activa: boolean; es_auxiliar: boolean } | null,
) {
  const query = jest.fn((sql: string, p: unknown[]) =>
    Promise.resolve(
      sql.includes('INSERT INTO cuenta_bancaria')
        ? [{ id: 'cb-1', cuenta_id: p[4] }]
        : [],
    ),
  );
  const tx = { query } as unknown as Tx;
  const crearAuxiliar = jest.fn(() =>
    Promise.resolve({
      id: 'aux-1',
      codigo: '11100501',
      nombre: 'Bancos - Bancolombia ···1234',
    }),
  );
  const nucleo = {
    crearAuxiliar,
    cuentaPorId: jest.fn(() =>
      Promise.resolve(cuenta && { id: 'aux-1', nombre: '', ...cuenta }),
    ),
  };
  const servicio = new CuentaBancariaService(
    {
      enContexto: (_c: unknown, fn: (t: Tx) => unknown) => fn(tx),
    } as unknown as TxService,
    nucleo as never,
  );
  return { servicio, query, crearAuxiliar };
}

describe('CuentaBancariaService.crearConAuxiliar', () => {
  it('crea el auxiliar bajo 111005 y la cuenta bancaria sobre él', async () => {
    const { servicio, query, crearAuxiliar } = montar({
      codigo: '11100501',
      activa: true,
      es_auxiliar: true,
    });
    const creada = await servicio.crearConAuxiliar(ctx, {
      banco: 'Bancolombia',
      numeroCuenta: '123-456-1234',
      tipoCuenta: 'AHORROS',
    });
    expect(crearAuxiliar).toHaveBeenCalledWith(
      ctx,
      { madre: '111005', nombre: 'Bancos - Bancolombia ···1234' },
      { sistema: true },
      expect.anything(),
    );
    expect(creada.cuenta_id).toBe('aux-1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('si la cuenta no sirve, no inserta el banco (y la transacción deshace el auxiliar)', async () => {
    const { servicio, query } = montar({
      codigo: '11050501',
      activa: true,
      es_auxiliar: true,
    });
    await expect(
      servicio.crearConAuxiliar(ctx, {
        banco: 'X',
        numeroCuenta: '1',
        tipoCuenta: 'AHORROS',
      }),
    ).rejects.toThrow(/1110/);
    expect(query).not.toHaveBeenCalled();
  });
});
