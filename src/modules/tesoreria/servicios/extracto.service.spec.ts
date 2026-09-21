import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { BancoMovimientoService } from './banco-movimiento.service';
import { ExtractoService } from './extracto.service';
import type {
  AgregarLineaExtractoDto,
  CrearExtractoDto,
  ImportarExtractoDto,
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

function servicio(
  tx: Tx,
  movimientos: Partial<BancoMovimientoService> = {},
): ExtractoService {
  return new ExtractoService(
    txServiceFalso(tx),
    movimientos as BancoMovimientoService,
  );
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
  archivo_nombre: null,
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

    const creado = await servicio(tx).crear(ctx, 'cb-1', DTO);

    expect(creado.id).toBe('ext-nuevo');
  });

  it('rechaza si la cuenta bancaria no existe o está inactiva', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM cuenta_bancaria WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(servicio(tx).crear(ctx, 'inexistente', DTO)).rejects.toThrow(
      NotFoundException,
    );
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

    const linea = await servicio(tx).agregarLinea(ctx, 'ext-1', DTO);

    expect(linea.descripcion).toBe('Consignación cliente X');
  });

  it('rechaza si el extracto ya está conciliado', async () => {
    const tx = txFalso({ ...extractoAbiertoFila, estado: 'CONCILIADO' });

    await expect(servicio(tx).agregarLinea(ctx, 'ext-1', DTO)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lanza NotFoundException si el extracto no existe', async () => {
    const tx = txFalso(undefined);

    await expect(
      servicio(tx).agregarLinea(ctx, 'inexistente', DTO),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ExtractoService.importar', () => {
  const DTO: ImportarExtractoDto = {
    fechaDesde: '2026-09-01',
    fechaHasta: '2026-09-30',
    saldoInicialBanco: 1_000_000,
    saldoFinalBanco: 1_296_000,
    archivoNombre: 'extracto-sep.xlsx',
    archivoHuella: 'a'.repeat(64),
    formato: { filaEncabezado: 1 },
    lineas: [
      {
        fila: 2,
        fecha: '2026-09-05',
        descripcion: 'ABONO',
        valor: 300_000,
        tipo: 'CREDITO',
      },
      {
        fila: 3,
        fecha: '2026-09-06',
        descripcion: 'GMF',
        valor: 4_000,
        tipo: 'DEBITO',
      },
    ],
  };

  function txFalso(repetido = false) {
    const consultas: string[] = [];
    const tx = {
      query: jest.fn((sql: string) => {
        consultas.push(sql);
        if (sql.includes('FROM cuenta_bancaria WHERE')) return [{ id: 'cb-1' }];
        if (sql.includes('archivo_huella = $2')) {
          return repetido
            ? [{ fecha_desde: '2026-08-01', fecha_hasta: '2026-08-31' }]
            : [];
        }
        if (sql.includes('INSERT INTO extracto_bancario')) {
          return [{ ...extractoAbiertoFila, id: 'ext-nuevo' }];
        }
        if (sql.includes('INSERT INTO extracto_linea')) return [];
        if (sql.includes('UPDATE cuenta_bancaria SET formato_extracto'))
          return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, consultas };
  }

  it('crea el extracto, las líneas y recuerda el formato', async () => {
    const { tx, consultas } = txFalso();

    const creado = await servicio(tx).importar(ctx, 'cb-1', DTO);

    expect(creado.id).toBe('ext-nuevo');
    expect(
      consultas.some((c) => c.includes('INSERT INTO extracto_linea')),
    ).toBe(true);
    expect(consultas.some((c) => c.includes('formato_extracto'))).toBe(true);
  });

  it('rechaza sin tocar la base si el extracto no cuadra (débito y crédito cruzados)', async () => {
    const { tx, consultas } = txFalso();

    await expect(
      servicio(tx).importar(ctx, 'cb-1', {
        ...DTO,
        saldoFinalBanco: 1_304_000,
      }),
    ).rejects.toThrow(/no cuadra/);
    expect(consultas).toHaveLength(0);
  });

  it('señala las filas con fecha fuera del extracto', async () => {
    const { tx } = txFalso();

    await expect(
      servicio(tx).importar(ctx, 'cb-1', {
        ...DTO,
        lineas: [{ ...DTO.lineas[0], fecha: '2026-10-01' }, DTO.lineas[1]],
        saldoFinalBanco: 1_296_000,
      }),
    ).rejects.toThrow(/fila 2/);
  });

  it('rechaza el mismo archivo subido dos veces, diciendo cuál era', async () => {
    const { tx } = txFalso(true);

    await expect(servicio(tx).importar(ctx, 'cb-1', DTO)).rejects.toThrow(
      /ya se subió.*2026-08-01/,
    );
  });
});

/** Un extracto abierto con líneas y movimientos sueltos, que registra lo que se escribe. */
function txConciliacion(datos: {
  lineas: Array<{
    id: string;
    valor: string;
    tipo: 'DEBITO' | 'CREDITO';
    suelta?: boolean;
    nota?: string | null;
  }>;
  movimientos: Array<{
    id: string;
    valor: string;
    tipo: string;
    conciliado?: boolean;
  }>;
}) {
  const escrituras: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM extracto_bancario WHERE id = $1 FOR UPDATE')) {
        return [extractoAbiertoFila];
      }
      if (
        sql.includes('FROM extracto_linea el') &&
        sql.includes('ANY($2::uuid[])')
      ) {
        const ids = params[1] as string[];
        return datos.lineas
          .filter((l) => ids.includes(l.id))
          .map((l) => ({
            fecha: '2026-09-10',
            referencia: null,
            nota: null,
            ...l,
            suelta: l.suelta ?? true,
          }));
      }
      if (sql.includes('FROM banco_movimiento') && sql.includes('FOR UPDATE')) {
        const ids = params[1] as string[];
        return datos.movimientos
          .filter((m) => ids.includes(m.id))
          .map((m) => ({ conciliado: false, ...m }));
      }
      if (sql.includes('INSERT INTO conciliacion_grupo')) {
        escrituras.push({ sql, params });
        return [{ id: `g-${escrituras.length}` }];
      }
      if (
        sql.includes('INSERT INTO conciliacion_partida') ||
        sql.includes('UPDATE banco_movimiento SET conciliado')
      ) {
        escrituras.push({ sql, params });
        return [];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, escrituras };
}

describe('ExtractoService.conciliar', () => {
  it('cruza uno contra uno y marca el movimiento conciliado', async () => {
    const { tx, escrituras } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '100000', tipo: 'CREDITO' }],
      movimientos: [{ id: 'm-1', valor: '100000', tipo: 'CONSIGNACION' }],
    });

    await servicio(tx).conciliar(ctx, 'ext-1', {
      grupos: [
        { lineaIds: ['l-1'], movimientoIds: ['m-1'], criterio: 'MISMA_FECHA' },
      ],
    });

    expect(escrituras[0].params).toEqual([
      'e-1',
      'ext-1',
      'MISMA_FECHA',
      'u-1',
    ]);
    expect(escrituras[2].params).toEqual([['m-1']]);
  });

  it('cruza el renglón del banco que junta dos consignaciones', async () => {
    const { tx, escrituras } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '300000', tipo: 'CREDITO' }],
      movimientos: [
        { id: 'm-1', valor: '100000', tipo: 'CONSIGNACION' },
        { id: 'm-2', valor: '200000', tipo: 'TRANSFERENCIA_ENTRANTE' },
      ],
    });

    await servicio(tx).conciliar(ctx, 'ext-1', {
      grupos: [
        {
          lineaIds: ['l-1'],
          movimientoIds: ['m-1', 'm-2'],
          criterio: 'MANUAL',
        },
      ],
    });

    expect(escrituras).toHaveLength(3);
  });

  it('rechaza valores distintos y dice cuánto y hacia dónde, sin escribir nada', async () => {
    const { tx, escrituras } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '510000', tipo: 'DEBITO' }],
      movimientos: [{ id: 'm-1', valor: '500000', tipo: 'CHEQUE' }],
    });

    await expect(
      servicio(tx).conciliar(ctx, 'ext-1', {
        grupos: [
          { lineaIds: ['l-1'], movimientoIds: ['m-1'], criterio: 'MANUAL' },
        ],
      }),
    ).rejects.toThrow(/10\.000 menos/);
    expect(escrituras).toHaveLength(0);
  });

  it('rechaza un débito del banco contra una entrada del libro', async () => {
    const { tx } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '100000', tipo: 'DEBITO' }],
      movimientos: [{ id: 'm-1', valor: '100000', tipo: 'CONSIGNACION' }],
    });

    await expect(
      servicio(tx).conciliar(ctx, 'ext-1', {
        grupos: [
          { lineaIds: ['l-1'], movimientoIds: ['m-1'], criterio: 'MANUAL' },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza una línea que ya está en otro cruce', async () => {
    const { tx } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '100000', tipo: 'CREDITO', suelta: false }],
      movimientos: [{ id: 'm-1', valor: '100000', tipo: 'CONSIGNACION' }],
    });

    await expect(
      servicio(tx).conciliar(ctx, 'ext-1', {
        grupos: [
          { lineaIds: ['l-1'], movimientoIds: ['m-1'], criterio: 'MANUAL' },
        ],
      }),
    ).rejects.toThrow(/ya está cruzada/);
  });

  it('rechaza una línea anotada como error del banco: primero se quita la nota', async () => {
    const { tx, escrituras } = txConciliacion({
      lineas: [
        {
          id: 'l-1',
          valor: '100000',
          tipo: 'CREDITO',
          nota: 'Cobró dos veces',
        },
      ],
      movimientos: [{ id: 'm-1', valor: '100000', tipo: 'CONSIGNACION' }],
    });

    await expect(
      servicio(tx).conciliar(ctx, 'ext-1', {
        grupos: [
          {
            lineaIds: ['l-1'],
            movimientoIds: ['m-1'],
            criterio: 'MISMA_FECHA',
          },
        ],
      }),
    ).rejects.toThrow(/anotada como error del banco/);
    expect(escrituras).toEqual([]);
  });

  it('rechaza la misma línea en dos cruces del mismo pedido', async () => {
    const { tx } = txConciliacion({ lineas: [], movimientos: [] });

    await expect(
      servicio(tx).conciliar(ctx, 'ext-1', {
        grupos: [
          { lineaIds: ['l-1'], movimientoIds: ['m-1'], criterio: 'MANUAL' },
          { lineaIds: ['l-1'], movimientoIds: ['m-2'], criterio: 'MANUAL' },
        ],
      }),
    ).rejects.toThrow(/dos veces/);
  });
});

describe('ExtractoService.registrar y completar', () => {
  function movimientosFalso() {
    const registrarNota = jest.fn(
      (_ctx: unknown, _cuenta: string, datos: object) =>
        Promise.resolve({ id: 'nota-1', ...datos }),
    );
    return {
      registrarNota,
      fake: { registrarNota } as unknown as Partial<BancoMovimientoService>,
    };
  }

  it('registra el 4×1000 como nota débito con la fecha y el valor del banco, y lo cruza', async () => {
    const { tx, escrituras } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '4000', tipo: 'DEBITO' }],
      movimientos: [],
    });
    const { registrarNota, fake } = movimientosFalso();

    await servicio(tx, fake).registrar(ctx, 'ext-1', {
      lineaIds: ['l-1'],
      contraCuentaId: 'cta-gmf',
      concepto: '4×1000',
    });

    expect(registrarNota).toHaveBeenCalledWith(
      ctx,
      'cb-1',
      expect.objectContaining({
        tipo: 'NOTA_DEBITO',
        fecha: '2026-09-10',
        valor: 4000,
        contraCuentaId: 'cta-gmf',
      }),
      tx,
    );
    expect(escrituras[0].params[2]).toBe('REGISTRADA');
  });

  it('el cheque cobrado por 10.000 más: registra la nota débito por la diferencia y cruza los tres', async () => {
    const { tx, escrituras } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '510000', tipo: 'DEBITO' }],
      movimientos: [{ id: 'm-1', valor: '500000', tipo: 'CHEQUE' }],
    });
    const { registrarNota, fake } = movimientosFalso();

    const r = await servicio(tx, fake).completar(ctx, 'ext-1', {
      lineaIds: ['l-1'],
      movimientoIds: ['m-1'],
      contraCuentaId: 'cta-comisiones',
      concepto: 'Comisión cheque',
    });

    expect(r.diferencia).toBe(-10_000);
    expect(registrarNota).toHaveBeenCalledWith(
      ctx,
      'cb-1',
      expect.objectContaining({ tipo: 'NOTA_DEBITO', valor: 10_000 }),
      tx,
    );
    expect(escrituras[1].params[3]).toEqual(['m-1', 'nota-1']);
  });

  it('completar rechaza un cruce que ya cuadra', async () => {
    const { tx } = txConciliacion({
      lineas: [{ id: 'l-1', valor: '500000', tipo: 'DEBITO' }],
      movimientos: [{ id: 'm-1', valor: '500000', tipo: 'CHEQUE' }],
    });

    await expect(
      servicio(tx, movimientosFalso().fake).completar(ctx, 'ext-1', {
        lineaIds: ['l-1'],
        movimientoIds: ['m-1'],
        contraCuentaId: 'cta',
        concepto: 'Nada',
      }),
    ).rejects.toThrow(/ya cuadra/);
  });
});

describe('ExtractoService.cerrar', () => {
  function txFalso(datos: {
    extracto?: typeof extractoAbiertoFila;
    lineas: Array<{
      valor: string;
      tipo: 'DEBITO' | 'CREDITO';
      suelta?: boolean;
      nota?: string | null;
    }>;
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
        if (sql.includes('FROM extracto_linea el'))
          return lineas.map((l) => ({ suelta: false, nota: null, ...l }));
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

    const cerrado = await servicio(tx).cerrar(ctx, 'ext-1');

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

    await expect(servicio(tx).cerrar(ctx, 'ext-1')).rejects.toThrow(
      /movimientos sin conciliar/,
    );
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

    const cerrado = await servicio(tx).cerrar(ctx, 'ext-1');

    expect(cerrado.estado).toBe('CONCILIADO');
  });

  it('rechaza cerrar con una línea suelta sin explicar', async () => {
    const { tx, actualizaciones } = txFalso({
      lineas: [
        { valor: '500000', tipo: 'CREDITO' },
        { valor: '200000', tipo: 'DEBITO', suelta: true },
      ],
      saldoLibro: '1500000',
      pendientes: [],
    });

    await expect(servicio(tx).cerrar(ctx, 'ext-1')).rejects.toThrow(
      /1 línea del extracto sin cruzar ni explicar/,
    );
    expect(actualizaciones).toHaveLength(0);
  });

  it('cierra con un error del banco anotado: el libro no se ajusta por él', async () => {
    // El banco cobró 200.000 que no son nuestros; se reclama.
    const { tx } = txFalso({
      lineas: [
        { valor: '500000', tipo: 'CREDITO' },
        {
          valor: '200000',
          tipo: 'DEBITO',
          suelta: true,
          nota: 'Cobro duplicado, reclamado',
        },
      ],
      saldoLibro: '1500000',
      pendientes: [],
    });

    const cerrado = await servicio(tx).cerrar(ctx, 'ext-1');

    expect(cerrado.estado).toBe('CONCILIADO');
  });

  it('rechaza si el extracto ya está conciliado', async () => {
    const { tx } = txFalso({
      extracto: { ...extractoAbiertoFila, estado: 'CONCILIADO' },
      lineas: [],
      saldoLibro: '1000000',
      pendientes: [],
    });

    await expect(servicio(tx).cerrar(ctx, 'ext-1')).rejects.toThrow(
      /ya está conciliado/,
    );
  });
});
