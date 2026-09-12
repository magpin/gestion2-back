import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { ExtractoService } from './extracto.service';
import type {
  AgregarLineaExtractoDto,
  CrearExtractoDto,
} from '../dto/extracto.dto';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CONTADOR'],
};

function txServiceFalso(tx: Tx): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
}

const extractoAbiertoFila = {
  id: 'ext-1',
  cuenta_bancaria_id: 'cb-1',
  fecha_desde: '2026-09-01',
  fecha_hasta: '2026-09-30',
  saldo_inicial_banco: '1000000',
  saldo_final_banco: '1300000',
  estado: 'ABIERTO',
  conciliado_en: null,
  conciliado_por: null,
};

describe('ExtractoService.crear', () => {
  const DTO: CrearExtractoDto = {
    fechaDesde: '2026-09-01',
    fechaHasta: '2026-09-30',
    saldoInicialBanco: 1_000_000,
    saldoFinalBanco: 1_300_000,
  };

  it('crea el extracto si la cuenta bancaria existe y está activa', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM cuenta_bancaria WHERE')) {
          return [{ id: 'cb-1' }];
        }
        if (sql.includes('INSERT INTO extracto_bancario')) {
          return [{ ...extractoAbiertoFila, id: 'ext-nuevo' }];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    const creado = await new ExtractoService(txServiceFalso(tx)).crear(
      ctx,
      'cb-1',
      DTO,
    );

    expect(creado.id).toBe('ext-nuevo');
  });

  it('rechaza si la cuenta bancaria no existe o está inactiva', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM cuenta_bancaria WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(
      new ExtractoService(txServiceFalso(tx)).crear(ctx, 'inexistente', DTO),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ExtractoService.agregarLinea', () => {
  const DTO: AgregarLineaExtractoDto = {
    fecha: '2026-09-15',
    descripcion: 'Consignación cliente X',
    valor: 100_000,
    tipo: 'CREDITO',
  };

  function txFalso(extracto: typeof extractoAbiertoFila | undefined) {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return extracto === undefined ? [] : [extracto];
        }
        if (sql.includes('INSERT INTO extracto_linea')) {
          return [
            {
              id: 'linea-1',
              extracto_id: extracto?.id,
              fecha: DTO.fecha,
              descripcion: DTO.descripcion,
              valor: String(DTO.valor),
              tipo: DTO.tipo,
              banco_movimiento_id: null,
            },
          ];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return tx;
  }

  it('agrega la línea si el extracto está ABIERTO', async () => {
    const tx = txFalso(extractoAbiertoFila);

    const linea = await new ExtractoService(txServiceFalso(tx)).agregarLinea(
      ctx,
      'ext-1',
      DTO,
    );

    expect(linea.descripcion).toBe('Consignación cliente X');
  });

  it('rechaza si el extracto ya está conciliado', async () => {
    const tx = txFalso({ ...extractoAbiertoFila, estado: 'CONCILIADO' });

    await expect(
      new ExtractoService(txServiceFalso(tx)).agregarLinea(ctx, 'ext-1', DTO),
    ).rejects.toThrow(BadRequestException);
  });

  it('lanza NotFoundException si el extracto no existe', async () => {
    const tx = txFalso(undefined);

    await expect(
      new ExtractoService(txServiceFalso(tx)).agregarLinea(
        ctx,
        'inexistente',
        DTO,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ExtractoService.conciliarAutomatico', () => {
  function txFalso(
    lineas: Array<{ id: string; fecha: string; valor: string }>,
    movimientos: Array<{ id: string; fecha: string; valor: string }>,
  ) {
    const actualizacionesLinea: unknown[][] = [];
    const actualizacionesMovimiento: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) return [extractoAbiertoFila];
        if (sql.startsWith('SELECT id, fecha, valor FROM extracto_linea'))
          return lineas;
        if (sql.startsWith('SELECT id, fecha, valor FROM banco_movimiento'))
          return movimientos;
        if (sql.startsWith('UPDATE extracto_linea')) {
          actualizacionesLinea.push(params ?? []);
          return [];
        }
        if (sql.startsWith('UPDATE banco_movimiento')) {
          actualizacionesMovimiento.push(params ?? []);
          return [];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizacionesLinea, actualizacionesMovimiento };
  }

  it('aparea una línea con un movimiento exacto y marca los dos lados', async () => {
    const { tx, actualizacionesLinea, actualizacionesMovimiento } = txFalso(
      [{ id: 'linea-1', fecha: '2026-09-01', valor: '100000' }],
      [{ id: 'mov-1', fecha: '2026-09-01', valor: '100000' }],
    );

    const resumen = await new ExtractoService(
      txServiceFalso(tx),
    ).conciliarAutomatico(ctx, 'ext-1');

    expect(resumen).toEqual({
      pares: 1,
      lineasSinAparear: 0,
      movimientosSinAparear: 0,
    });
    expect(actualizacionesLinea).toEqual([['linea-1', 'mov-1']]);
    expect(actualizacionesMovimiento).toEqual([['mov-1']]);
  });

  it('el caso ambiguo (dos movimientos iguales) no aparea ninguno de los dos lados', async () => {
    const { tx, actualizacionesLinea, actualizacionesMovimiento } = txFalso(
      [{ id: 'linea-1', fecha: '2026-09-01', valor: '100000' }],
      [
        { id: 'mov-1', fecha: '2026-09-01', valor: '100000' },
        { id: 'mov-2', fecha: '2026-09-01', valor: '100000' },
      ],
    );

    const resumen = await new ExtractoService(
      txServiceFalso(tx),
    ).conciliarAutomatico(ctx, 'ext-1');

    expect(resumen).toEqual({
      pares: 0,
      lineasSinAparear: 1,
      movimientosSinAparear: 2,
    });
    expect(actualizacionesLinea).toHaveLength(0);
    expect(actualizacionesMovimiento).toHaveLength(0);
  });
});

describe('ExtractoService.conciliarManual', () => {
  function txFalso(opciones: {
    linea?: { id: string; banco_movimiento_id: string | null };
    movimiento?: { id: string; conciliado: boolean };
  }) {
    const {
      linea = { id: 'linea-1', banco_movimiento_id: null },
      movimiento = { id: 'mov-1', conciliado: false },
    } = opciones;
    const actualizaciones: string[] = [];
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FOR UPDATE')) return [extractoAbiertoFila];
        if (sql.startsWith('SELECT id, banco_movimiento_id')) return [linea];
        if (sql.startsWith('SELECT id, conciliado')) return [movimiento];
        if (sql.startsWith('UPDATE extracto_linea')) {
          actualizaciones.push('linea');
          return [];
        }
        if (sql.startsWith('UPDATE banco_movimiento')) {
          actualizaciones.push('movimiento');
          return [];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizaciones };
  }

  it('aparea la línea con el movimiento cuando los dos están sueltos', async () => {
    const { tx, actualizaciones } = txFalso({});

    await new ExtractoService(txServiceFalso(tx)).conciliarManual(
      ctx,
      'ext-1',
      {
        lineaId: 'linea-1',
        movimientoId: 'mov-1',
      },
    );

    expect(actualizaciones).toEqual(['linea', 'movimiento']);
  });

  it('rechaza si la línea ya está conciliada', async () => {
    const { tx } = txFalso({
      linea: { id: 'linea-1', banco_movimiento_id: 'otro-mov' },
    });

    await expect(
      new ExtractoService(txServiceFalso(tx)).conciliarManual(ctx, 'ext-1', {
        lineaId: 'linea-1',
        movimientoId: 'mov-1',
      }),
    ).rejects.toThrow(/ya está conciliada/);
  });

  it('rechaza si el movimiento ya está conciliado', async () => {
    const { tx } = txFalso({ movimiento: { id: 'mov-1', conciliado: true } });

    await expect(
      new ExtractoService(txServiceFalso(tx)).conciliarManual(ctx, 'ext-1', {
        lineaId: 'linea-1',
        movimientoId: 'mov-1',
      }),
    ).rejects.toThrow(/ya está conciliado/);
  });
});

describe('ExtractoService.cerrar', () => {
  function txFalso(datos: {
    extracto?: typeof extractoAbiertoFila;
    lineas: Array<{ valor: string; tipo: 'DEBITO' | 'CREDITO' }>;
    saldoLibro: string | undefined;
    pendientes: Array<{ valor: string; tipo: string }>;
  }) {
    const {
      extracto = extractoAbiertoFila,
      lineas,
      saldoLibro,
      pendientes,
    } = datos;
    const actualizaciones: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) return [extracto];
        if (sql.startsWith('SELECT valor, tipo FROM extracto_linea'))
          return lineas;
        if (sql.startsWith('SELECT saldo_valor FROM banco_movimiento'))
          return saldoLibro === undefined ? [] : [{ saldo_valor: saldoLibro }];
        if (sql.startsWith('SELECT valor, tipo FROM banco_movimiento'))
          return pendientes;
        if (sql.startsWith('UPDATE extracto_bancario')) {
          actualizaciones.push(params ?? []);
          return [{ ...extracto, estado: 'CONCILIADO' }];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizaciones };
  }

  it('cierra como CONCILIADO cuando las dos cuentas cuadran', async () => {
    const { tx, actualizaciones } = txFalso({
      lineas: [
        { valor: '500000', tipo: 'CREDITO' },
        { valor: '200000', tipo: 'DEBITO' },
      ],
      saldoLibro: '1300000',
      pendientes: [],
    });

    const cerrado = await new ExtractoService(txServiceFalso(tx)).cerrar(
      ctx,
      'ext-1',
    );

    expect(cerrado.estado).toBe('CONCILIADO');
    expect(actualizaciones).toHaveLength(1);
  });

  it('rechaza sin cerrar si el libro no cuadra con el extracto (cheque no cobrado sin marcar pendiente)', async () => {
    const { tx, actualizaciones } = txFalso({
      lineas: [
        { valor: '500000', tipo: 'CREDITO' },
        { valor: '200000', tipo: 'DEBITO' },
      ],
      // El libro ya restó un cheque de 150000 que nadie dejó pendiente.
      saldoLibro: '1150000',
      pendientes: [],
    });

    await expect(
      new ExtractoService(txServiceFalso(tx)).cerrar(ctx, 'ext-1'),
    ).rejects.toThrow(/movimientos sin conciliar/);
    expect(actualizaciones).toHaveLength(0);
  });

  it('el saldo pendiente correcto sí permite cerrar (cheque no cobrado)', async () => {
    const { tx } = txFalso({
      lineas: [
        { valor: '500000', tipo: 'CREDITO' },
        { valor: '200000', tipo: 'DEBITO' },
      ],
      saldoLibro: '1150000',
      pendientes: [{ valor: '150000', tipo: 'CHEQUE' }],
    });

    const cerrado = await new ExtractoService(txServiceFalso(tx)).cerrar(
      ctx,
      'ext-1',
    );

    expect(cerrado.estado).toBe('CONCILIADO');
  });

  it('rechaza si el extracto ya está conciliado', async () => {
    const { tx } = txFalso({
      extracto: { ...extractoAbiertoFila, estado: 'CONCILIADO' },
      lineas: [],
      saldoLibro: '1000000',
      pendientes: [],
    });

    await expect(
      new ExtractoService(txServiceFalso(tx)).cerrar(ctx, 'ext-1'),
    ).rejects.toThrow(/ya está conciliado/);
  });
});
