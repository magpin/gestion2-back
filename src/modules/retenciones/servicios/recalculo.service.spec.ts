import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { DocumentoRenta } from './motor-renta.service';
import { RecalculoService } from './recalculo.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CONTADOR'],
};

const entradaVieja: DocumentoRenta = {
  terceroId: 'prov-1',
  fecha: '2026-09-10',
  municipioCompra: '05001',
  renglones: [
    {
      orden: 1,
      subtotal: 500_000,
      productoId: 'p-1',
      texto: 'Tornillos',
      cuentaCodigo: null,
    },
  ],
};

function armar(entrada: DocumentoRenta) {
  const tx = {
    query: jest.fn((sql: string) => {
      if (sql.includes('FROM compra_documento c')) {
        return Promise.resolve([
          {
            id: 'compra-1',
            fecha: '2026-09-10',
            numero: 'FP-1',
            subtotal: '500000',
            devuelto: '0',
            entrada,
            respuestas: { conceptos: [] },
          },
        ]);
      }
      if (sql.includes('FROM retencion_concepto_nacional')) {
        return Promise.resolve([]);
      }
      if (sql.includes('WITH RECURSIVE propias')) return Promise.resolve([]);
      if (sql.includes('FROM venta_documento v')) return Promise.resolve([]);
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
  } as unknown as Tx;
  const txService = {
    enContexto: (_c: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
  const motorRenta = {
    proponer: jest.fn(() =>
      Promise.resolve({
        decision: 'BAJO_BASE',
        motivo: '',
        pendientes: 0,
        retenciones: [],
      }),
    ),
    acumuladoIcaAntesDe: jest.fn(() => Promise.resolve({ '05001': 0 })),
  };
  const servicio = new RecalculoService(
    txService,
    motorRenta as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { servicio, motorRenta, tx };
}

describe('RecalculoService — ReteICA acumulada (bug 3)', () => {
  it('a una compra vieja le pasa al motor el acumulado de ICA de antes de ella', async () => {
    const { servicio, motorRenta, tx } = armar(entradaVieja);
    await servicio.recalcularEmpresa(ctx, {
      recalculoId: 'rec-1',
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(motorRenta.acumuladoIcaAntesDe).toHaveBeenCalledWith(tx, 'compra-1');
    const [, entrada] = motorRenta.proponer.mock.calls[0] as unknown as [
      unknown,
      DocumentoRenta,
    ];
    expect(entrada.acumuladoIcaAnterior).toEqual({ '05001': 0 });
  });

  it('si la entrada ya lo guardó al confirmar, usa ese', async () => {
    const { servicio, motorRenta } = armar({
      ...entradaVieja,
      acumuladoIcaAnterior: { '05001': 300_000 },
    });
    await servicio.recalcularEmpresa(ctx, {
      recalculoId: 'rec-1',
      desde: '2026-09-01',
      hasta: '2026-09-30',
    });
    expect(motorRenta.acumuladoIcaAntesDe).not.toHaveBeenCalled();
    const [, entrada] = motorRenta.proponer.mock.calls[0] as unknown as [
      unknown,
      DocumentoRenta,
    ];
    expect(entrada.acumuladoIcaAnterior).toEqual({ '05001': 300_000 });
  });
});
