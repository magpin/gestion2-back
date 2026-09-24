import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { KardexService } from './kardex.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['VENTAS'],
};

const CONFIG_PROMEDIO_PONDERADO = {
  metodo_valoracion_inventario: 'PROMEDIO_PONDERADO',
  decimales_cantidad: '2',
  decimales_valor: '2',
};

/**
 * `NucleoApi` falso: lo que `exigirPromedioPonderado` necesita, y el hecho
 * VENDE_SIN_EXISTENCIA, que cada prueba decide en su transacción falsa.
 */
function nucleoFalso(
  config: Record<string, unknown> = CONFIG_PROMEDIO_PONDERADO,
) {
  return {
    configuracionContable: jest.fn(() => Promise.resolve(config)),
    tieneHechoOperativo: jest.fn((_ctx: unknown, _hecho: string, tx: unknown) =>
      Promise.resolve(
        (tx as { vendeSinExistencia?: boolean }).vendeSinExistencia === true,
      ),
    ),
  } as unknown as ConstructorParameters<typeof KardexService>[1];
}

/**
 * Transacción falsa: responde según qué tabla consulta la query. `saldo`
 * `undefined` simula un producto sin movimientos todavía.
 */
function txFalso(
  saldo: { saldo_cantidad: string; saldo_costo_promedio: string } | undefined,
  permiteExistenciaNegativa = false,
) {
  const insertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM producto WHERE')) {
        return [{ id: 'p-1', cuenta_inventario_id: 'c-inv' }];
      }
      if (sql.startsWith('SELECT saldo_cantidad')) {
        return saldo === undefined ? [] : [saldo];
      }
      if (sql.startsWith('INSERT INTO producto_movimiento')) {
        insertadas.push(params ?? []);
        // Columnas en el mismo orden que arma `insertarMovimiento`.
        const [
          id,
          ,
          producto_id,
          fecha,
          tipo,
          cantidad,
          costo_unitario,
          valor_total,
          saldo_cantidad,
          saldo_costo_promedio,
          saldo_valor,
          motivo,
          asiento_id,
        ] = params as unknown[];
        // Postgres devuelve `numeric` como texto — el mock lo imita para que
        // el resultado se comporte como el `MovimientoResumen` real.
        return [
          {
            id,
            producto_id,
            fecha,
            tipo,
            cantidad: String(cantidad),
            costo_unitario: String(costo_unitario),
            valor_total: String(valor_total),
            saldo_cantidad: String(saldo_cantidad),
            saldo_costo_promedio: String(saldo_costo_promedio),
            saldo_valor: String(saldo_valor),
            motivo,
            asiento_id,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
    // Lo lee el `NucleoApi` falso: si la empresa declaró VENDE_SIN_EXISTENCIA.
    vendeSinExistencia: permiteExistenciaNegativa,
  } as unknown as Tx;
  return { tx, insertadas };
}

describe('KardexService.costearSalida', () => {
  const servicio = new KardexService(
    {} as never, // TxService: ninguno de los dos métodos bajo prueba lo usa — reciben `tx` directo.
    nucleoFalso(),
    {} as never, // ContabilidadApi: no interviene en una salida por venta.
    {} as never, // ConfiguracionService: solo la usan los ajustes.
  );

  it('devuelve el costo promedio vigente, sin insertar nada', async () => {
    const { tx } = txFalso({
      saldo_cantidad: '10.000000',
      saldo_costo_promedio: '5000.00',
    });

    const resultado = await servicio.costearSalida(ctx, 'p-1', 4, tx);

    expect(resultado).toEqual({
      costoUnitario: 5000,
      valorTotal: 20000,
      faltante: 0,
    });
    const consultas = (tx.query as jest.Mock).mock.calls.map(
      ([sql]: [string]) => sql,
    );
    expect(
      consultas.some((sql) => sql.includes('INSERT INTO producto_movimiento')),
    ).toBe(false);
  });

  it('rechaza si la cantidad deja el saldo negativo', async () => {
    const { tx } = txFalso({
      saldo_cantidad: '3.000000',
      saldo_costo_promedio: '5000.00',
    });

    await expect(servicio.costearSalida(ctx, 'p-1', 5, tx)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza si la empresa está en PEPS', async () => {
    const pepsServicio = new KardexService(
      {} as never,
      nucleoFalso({
        ...CONFIG_PROMEDIO_PONDERADO,
        metodo_valoracion_inventario: 'PEPS',
      }),
      {} as never,
      {} as never,
    );
    const { tx } = txFalso({
      saldo_cantidad: '10.000000',
      saldo_costo_promedio: '5000.00',
    });

    await expect(pepsServicio.costearSalida(ctx, 'p-1', 1, tx)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('sin movimientos previos, el saldo es cero y no hay costo que descontar', async () => {
    const { tx } = txFalso(undefined);

    await expect(servicio.costearSalida(ctx, 'p-1', 1, tx)).rejects.toThrow(
      /Solo hay 0/,
    );
  });
});

describe('KardexService.costearSalida en descubierto', () => {
  const servicio = new KardexService(
    {} as never, // TxService: recibe `tx` directo.
    nucleoFalso(),
    {} as never, // ContabilidadApi: no interviene en una salida por venta.
    {} as never, // ConfiguracionService: solo la usan los ajustes.
  );

  it('rechaza si la empresa no habilitó la existencia negativa, aunque quien factura confirme', async () => {
    const { tx } = txFalso(
      { saldo_cantidad: '3.000000', saldo_costo_promedio: '5000.00' },
      false,
    );

    await expect(
      servicio.costearSalida(ctx, 'p-1', 10, tx, true),
    ).rejects.toThrow(/Solo hay 3 en existencia/);
  });

  it('con la empresa habilitada y el producto confirmado, cuesta al último promedio y dice cuánto faltó', async () => {
    const { tx } = txFalso(
      { saldo_cantidad: '3.000000', saldo_costo_promedio: '5000.00' },
      true,
    );

    const resultado = await servicio.costearSalida(ctx, 'p-1', 10, tx, true);

    // El costo es el último promedio conocido: 10 * 5.000.
    expect(resultado).toEqual({
      costoUnitario: 5000,
      valorTotal: 50000,
      faltante: 7,
    });
  });

  it('sin confirmación, la empresa habilitada no alcanza: rechaza igual', async () => {
    const { tx } = txFalso(
      { saldo_cantidad: '3.000000', saldo_costo_promedio: '5000.00' },
      true,
    );

    await expect(servicio.costearSalida(ctx, 'p-1', 10, tx)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza un producto que nunca tuvo una entrada: no hay costo con el que valorar la venta', async () => {
    const { tx } = txFalso(undefined, true);

    await expect(
      servicio.costearSalida(ctx, 'p-1', 10, tx, true),
    ).rejects.toThrow(/nunca ha tenido una entrada/);
  });

  it('con existencia suficiente, la confirmación no cambia nada', async () => {
    const { tx } = txFalso(
      { saldo_cantidad: '10.000000', saldo_costo_promedio: '5000.00' },
      true,
    );

    const resultado = await servicio.costearSalida(ctx, 'p-1', 4, tx, true);

    expect(resultado.faltante).toBe(0);
  });
});

describe('KardexService.registrarSalidaVenta', () => {
  const servicio = new KardexService(
    {} as never,
    nucleoFalso(),
    {} as never,
    {} as never,
  );

  it('inserta el movimiento con tipo SALIDA_VENTA y el asiento ya resuelto', async () => {
    const { tx, insertadas } = txFalso({
      saldo_cantidad: '10.000000',
      saldo_costo_promedio: '5000.00',
    });

    const movimiento = await servicio.registrarSalidaVenta(
      ctx,
      'p-1',
      4,
      '2026-09-07',
      'Factura FV-1',
      'asiento-1',
      tx,
    );

    expect(movimiento.tipo).toBe('SALIDA_VENTA');
    expect(movimiento.asiento_id).toBe('asiento-1');
    expect(movimiento.cantidad).toBe('4');
    expect(movimiento.costo_unitario).toBe('5000');
    expect(movimiento.saldo_cantidad).toBe('6');

    // El movimiento se insertó una sola vez.
    expect(insertadas).toHaveLength(1);
  });

  it('rechaza sin insertar si la cantidad deja el saldo negativo', async () => {
    const { tx, insertadas } = txFalso({
      saldo_cantidad: '3.000000',
      saldo_costo_promedio: '5000.00',
    });

    await expect(
      servicio.registrarSalidaVenta(
        ctx,
        'p-1',
        5,
        '2026-09-07',
        'Factura FV-2',
        'asiento-2',
        tx,
      ),
    ).rejects.toThrow(/Solo hay 3/);
    expect(insertadas).toHaveLength(0);
  });
});

describe('KardexService.registrarEntradaCompra', () => {
  const servicio = new KardexService(
    {} as never,
    nucleoFalso(),
    {} as never,
    {} as never,
  );

  it('inserta el movimiento con tipo ENTRADA_COMPRA y recalcula el promedio', async () => {
    const { tx, insertadas } = txFalso({
      saldo_cantidad: '10.000000',
      saldo_costo_promedio: '5000.00',
    });

    const movimiento = await servicio.registrarEntradaCompra(
      ctx,
      'p-1',
      10,
      6000,
      '2026-09-07',
      'Factura FC-1',
      'asiento-1',
      tx,
    );

    expect(movimiento.tipo).toBe('ENTRADA_COMPRA');
    expect(movimiento.asiento_id).toBe('asiento-1');
    expect(movimiento.cantidad).toBe('10');
    expect(movimiento.costo_unitario).toBe('6000');
    // (10*5000 + 10*6000) / 20 = 5500.
    expect(movimiento.saldo_cantidad).toBe('20');
    expect(movimiento.saldo_costo_promedio).toBe('5500');
    expect(insertadas).toHaveLength(1);
  });

  it('sin movimientos previos, el costo promedio queda exactamente el de la entrada', async () => {
    const { tx } = txFalso(undefined);

    const movimiento = await servicio.registrarEntradaCompra(
      ctx,
      'p-1',
      5,
      1000,
      '2026-09-07',
      'Factura FC-2',
      'asiento-2',
      tx,
    );

    expect(movimiento.saldo_cantidad).toBe('5');
    expect(movimiento.saldo_costo_promedio).toBe('1000');
  });

  it('rechaza si la empresa está en PEPS, sin insertar nada', async () => {
    const pepsServicio = new KardexService(
      {} as never,
      nucleoFalso({
        ...CONFIG_PROMEDIO_PONDERADO,
        metodo_valoracion_inventario: 'PEPS',
      }),
      {} as never,
      {} as never,
    );
    const { tx, insertadas } = txFalso({
      saldo_cantidad: '10.000000',
      saldo_costo_promedio: '5000.00',
    });

    await expect(
      pepsServicio.registrarEntradaCompra(
        ctx,
        'p-1',
        1,
        1000,
        '2026-09-07',
        'Factura FC-3',
        'asiento-3',
        tx,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(insertadas).toHaveLength(0);
  });

  it('rechaza si el producto no existe o está inactivo', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM producto WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(
      servicio.registrarEntradaCompra(
        ctx,
        'inexistente',
        1,
        1000,
        '2026-09-07',
        'Factura FC-4',
        'asiento-4',
        tx,
      ),
    ).rejects.toThrow(/no encontrado/);
  });
});
