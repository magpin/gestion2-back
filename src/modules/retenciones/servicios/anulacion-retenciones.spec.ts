import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { MotorRentaService } from './motor-renta.service';
import { MotorVentaService } from './motor-venta.service';
import type { RetencionViva } from './retenciones-vivas';

/**
 * Los motores al anular y al reversar por nota, contra una transacción de
 * mentira: qué filas escriben según lo que `retencionesVivas` dice (bugs 1 y
 * 4). La lectura recursiva de `retencionesVivas` se probó contra la base, en
 * transacción deshecha.
 */

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CONTADOR'],
};

const viva = (p: Partial<RetencionViva>): RetencionViva => ({
  id: 'rc-nota',
  documento_tipo: 'NOTA_CREDITO_COMPRA',
  tercero_id: 'prov-1',
  concepto_nacional_id: 'cn-compras',
  concepto_codigo: 'COMPRAS_GENERALES',
  usa_acumulado_anual: false,
  impuesto: 'RENTA',
  municipio_codigo: null,
  fecha_causacion: '2026-09-12',
  tarifa_nominal: '0.025',
  factor_zomac: '1',
  tarifa_efectiva: '0.025',
  tarifa_id: null,
  uvt_valor: null,
  norma_aplicada: 'Decreto 572 de 2025',
  origen_clasificacion: 'CONFIRMADO',
  es_autorretencion: false,
  estado: 'ANULADA',
  base_original: '-400000',
  valor_original: '-10000',
  base: '-400000',
  valor: '-10000',
  base_documento: '-400000',
  valor_documento: '-10000',
  origen_anulado: false,
  ...p,
});

function txFalso(respuestas: {
  vivas: RetencionViva[];
  aportes?: Array<Record<string, unknown>>;
  comprasAnuladas?: string[];
}) {
  const escritas: Array<[string, unknown[]]> = [];
  const tx = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('WITH RECURSIVE propias')) {
        return Promise.resolve(respuestas.vivas);
      }
      if (sql.includes('FROM compra_documento')) {
        return Promise.resolve(
          (respuestas.comprasAnuladas ?? []).map((id) => ({ id })),
        );
      }
      if (sql.includes('FROM ica_acumulado_aporte')) {
        return Promise.resolve(respuestas.aportes ?? []);
      }
      if (sql.trimStart().startsWith('INSERT') || sql.includes('UPDATE')) {
        escritas.push([sql, params]);
        return Promise.resolve([{ id: `nueva-${escritas.length}` }]);
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }),
  } as unknown as Tx;
  const retenciones = () =>
    escritas.filter(([sql]) => sql.includes('INTO retencion_calculada'));
  const aportes = () =>
    escritas.filter(([sql]) => sql.includes('INTO ica_acumulado_aporte'));
  return { tx, escritas, retenciones, aportes };
}

const motorRenta = () =>
  new MotorRentaService({} as TxService, {} as never, {} as never);

describe('MotorRentaService.anularCompra — bug 1', () => {
  it('anular la nota de una compra ya anulada no devuelve la retención', async () => {
    const t = txFalso({
      vivas: [viva({ origen_anulado: true })],
      // Lo que la nota le había quitado al acumulado de ICA de su compra.
      aportes: [
        {
          compra_id: 'compra-1',
          tercero_id: 'prov-1',
          municipio_codigo: '05001',
          anio: 2026,
          periodo: 5,
          base: '-400000',
          retenido: '0',
        },
      ],
      comprasAnuladas: ['compra-1'],
    });

    await motorRenta().anularCompra(
      ctx,
      { compraId: 'nota-1', fecha: '2026-09-28', motivo: 'prueba' },
      t.tx,
    );

    expect(t.retenciones()).toEqual([]);
    expect(t.aportes()).toEqual([]);
    expect(t.escritas).toEqual([]);
  });

  it('anular la nota de una compra vigente sí devuelve lo que la nota quitó', async () => {
    const t = txFalso({
      vivas: [viva({})],
      aportes: [
        {
          compra_id: 'compra-1',
          tercero_id: 'prov-1',
          municipio_codigo: '05001',
          anio: 2026,
          periodo: 5,
          base: '-400000',
          retenido: '0',
        },
      ],
    });

    await motorRenta().anularCompra(
      ctx,
      { compraId: 'nota-1', fecha: '2026-09-28', motivo: 'prueba' },
      t.tx,
    );

    const [[, params]] = t.retenciones();
    // base y valor van en las posiciones 8 y 12 del INSERT.
    expect(params[7]).toBe(400000);
    expect(params[11]).toBe(10000);
    expect(t.aportes()).toHaveLength(1);
  });
});

describe('MotorRentaService.reversar — bug 4', () => {
  it('una sola fila por retención, con el ajuste adentro y al peso', async () => {
    const t = txFalso({
      vivas: [
        viva({
          id: 'rc-1',
          documento_tipo: 'COMPRA',
          estado: 'CONFIRMADA',
          base_original: '1000000',
          valor_original: '25000',
          // 25.000 de la compra + 5.000 del ajuste por recálculo.
          base: '1000000',
          valor: '30000',
          base_documento: '1000000',
          valor_documento: '30000',
        }),
      ],
    });

    const nuevas = await motorRenta().reversar(
      ctx,
      { compraId: 'c-1', notaId: 'n-1', proporcion: 0.4, fecha: '2026-09-12' },
      t.tx,
    );

    const filas = t.retenciones();
    expect(filas).toHaveLength(1);
    const [[, params]] = filas;
    expect(params[5]).toBe(-400000);
    expect(params[9]).toBe(-12000);
    expect(nuevas.get('COMPRAS_GENERALES|')).toBe('nueva-1');
  });

  it('reversaPrevista da la misma cifra que después escribe reversar', async () => {
    const vivas = [
      viva({
        id: 'rc-1',
        documento_tipo: 'COMPRA',
        estado: 'CONFIRMADA',
        base: '493800',
        valor: '12345',
        base_documento: '493800',
        valor_documento: '12345',
      }),
    ];
    const previstas = await motorRenta().reversaPrevista(
      txFalso({ vivas }).tx,
      { compraId: 'c-1', proporcion: 0.5 },
    );
    expect(previstas.map((p) => [p.retencionId, p.base, p.valor])).toEqual([
      ['rc-1', 246900, 6173],
    ]);
  });
});

describe('MotorVentaService.anular — bug 1 en ventas', () => {
  const autorretencion = (p: Partial<RetencionViva>) =>
    viva({
      documento_tipo: 'NOTA_CREDITO_VENTA',
      concepto_codigo: 'AUTORRETENCION_ESPECIAL',
      es_autorretencion: true,
      base: '-250000',
      valor: '-2000',
      ...p,
    });

  it('anular la nota de una venta ya anulada no revive la autorretención', async () => {
    const t = txFalso({ vivas: [autorretencion({ origen_anulado: true })] });
    await new MotorVentaService({} as never).anular(
      ctx,
      { documentoId: 'nc-1', fecha: '2026-09-28', motivo: 'prueba' },
      t.tx,
    );
    expect(t.retenciones()).toEqual([]);
  });

  it('con la venta vigente, anular la nota devuelve lo que quitó', async () => {
    const t = txFalso({ vivas: [autorretencion({})] });
    await new MotorVentaService({} as never).anular(
      ctx,
      { documentoId: 'nc-1', fecha: '2026-09-28', motivo: 'prueba' },
      t.tx,
    );
    const [[, params]] = t.retenciones();
    // -base y -valor: vuelven 250.000 de base y 2.000 de autorretención.
    expect(params[6]).toBe(250000);
    expect(params[8]).toBe(2000);
  });
});
