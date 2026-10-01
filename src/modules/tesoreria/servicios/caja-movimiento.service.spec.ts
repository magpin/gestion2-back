import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { CajaMovimientoService } from './caja-movimiento.service';
import type {
  CargaInicialCajaDto,
  EgresoCajaDto,
  IngresoCajaDto,
} from '../dto/caja-movimiento.dto';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CAJA'],
};

const DTO: CargaInicialCajaDto = {
  fecha: '2026-09-10',
  valor: 100_000,
  concepto: 'Fondo con el que abre la caja',
};

const DTO_MOVIMIENTO: IngresoCajaDto | EgresoCajaDto = {
  fecha: '2026-09-10',
  valor: 30_000,
  concepto: 'Venta de contado sin factura',
  contraCuentaId: 'cta-contra',
};

/**
 * Transacción falsa: responde según qué tabla consulta la query. `saldo`
 * `undefined` simula una caja sin movimientos todavía.
 */
function txFalso(saldo: { saldo_valor: string } | undefined) {
  const insertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM caja WHERE')) {
        return [{ id: 'c-1', cuenta_id: 'cta-1' }];
      }
      if (sql.startsWith('SELECT saldo_valor')) {
        return saldo === undefined ? [] : [saldo];
      }
      if (sql.startsWith('INSERT INTO caja_movimiento')) {
        insertadas.push(params ?? []);
        const [
          id,
          ,
          caja_id,
          fecha,
          tipo,
          valor,
          concepto,
          origen_tipo,
          origen_id,
          tercero_id,
          saldo_valor,
          asiento_id,
        ] = params as unknown[];
        // Postgres devuelve `numeric` como texto — el mock lo imita.
        return [
          {
            id,
            caja_id,
            fecha,
            tipo,
            valor: String(valor),
            concepto,
            origen_tipo,
            origen_id,
            tercero_id,
            saldo_valor: String(saldo_valor),
            asiento_id,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, insertadas };
}

/**
 * `TxService` falso: abre "transacción" ejecutando `fn` con el `tx` dado.
 * `ContabilidadApi` no interviene en `registrarSaldoInicial` — no genera
 * asiento, mismo motivo que `ENTRADA_INICIAL` del kardex — pero
 * `registrarIngreso`/`registrarEgreso` sí la necesitan, de ahí el segundo
 * parámetro.
 */
function servicioCon(
  tx: Tx,
  contabilidad: ConstructorParameters<
    typeof CajaMovimientoService
  >[1] = {} as never,
) {
  return new CajaMovimientoService(
    {
      enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
    } as never,
    contabilidad,
  );
}

/**
 * `ContabilidadApi` falsa: responde con un tipo de comprobante ya sembrado
 * (o `null`, para simular que la empresa no lo sembró) y un asiento fijo.
 */
function contabilidadFalso(
  opciones: { comprobante?: { id: string } | null } = {},
) {
  const { comprobante = { id: 'comp-1' } } = opciones;
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-1', numero: 'CI-000001' }),
  );
  const fake = {
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve(comprobante)),
    asentar,
  } as unknown as ConstructorParameters<typeof CajaMovimientoService>[1];
  return { fake, asentar };
}

describe('CajaMovimientoService.registrarSaldoInicial', () => {
  it('inserta el saldo inicial sin asiento, con el saldo corrido igual al valor', async () => {
    const { tx, insertadas } = txFalso(undefined);

    const movimiento = await servicioCon(tx).registrarSaldoInicial(
      ctx,
      'c-1',
      DTO,
    );

    expect(movimiento.tipo).toBe('SALDO_INICIAL');
    expect(movimiento.asiento_id).toBeNull();
    expect(movimiento.saldo_valor).toBe('100000');
    expect(insertadas).toHaveLength(1);
  });

  it('rechaza sin insertar si la caja ya tiene movimientos', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });

    await expect(
      servicioCon(tx).registrarSaldoInicial(ctx, 'c-1', DTO),
    ).rejects.toThrow(BadRequestException);
    expect(insertadas).toHaveLength(0);
  });

  it('rechaza si la caja no existe o está inactiva', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM caja WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(
      servicioCon(tx).registrarSaldoInicial(ctx, 'inexistente', DTO),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CajaMovimientoService.registrarIngreso', () => {
  it('asienta contra CI y suma el valor al saldo corrido', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    const movimiento = await servicioCon(tx, contabilidad).registrarIngreso(
      ctx,
      'c-1',
      DTO_MOVIMIENTO,
    );

    expect(movimiento.tipo).toBe('INGRESO');
    expect(movimiento.asiento_id).toBe('asiento-1');
    expect(movimiento.saldo_valor).toBe('80000');
    expect(insertadas).toHaveLength(1);

    expect(asentar).toHaveBeenCalledTimes(1);
    const [, dtoAsiento, origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
      { origenTipo: string; origenId: string },
    ];
    expect(origen.origenTipo).toBe('MOVIMIENTO_CAJA');
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-1', debito: 30_000, credito: 0 },
      { cuentaId: 'cta-contra', debito: 0, credito: 30_000 },
    ]);
  });

  it('siempre pasa, aunque la caja arranque en 0', async () => {
    const { tx, insertadas } = txFalso(undefined);
    const { fake: contabilidad } = contabilidadFalso();

    const movimiento = await servicioCon(tx, contabilidad).registrarIngreso(
      ctx,
      'c-1',
      DTO_MOVIMIENTO,
    );

    expect(movimiento.saldo_valor).toBe('30000');
    expect(insertadas).toHaveLength(1);
  });

  it('rechaza sin asentar ni insertar si la empresa no sembró el comprobante CI', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });
    const { fake: contabilidad, asentar } = contabilidadFalso({
      comprobante: null,
    });

    await expect(
      servicioCon(tx, contabilidad).registrarIngreso(
        ctx,
        'c-1',
        DTO_MOVIMIENTO,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });
});

describe('CajaMovimientoService.registrarEgreso', () => {
  it('asienta contra CE y resta el valor del saldo corrido', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    const movimiento = await servicioCon(tx, contabilidad).registrarEgreso(
      ctx,
      'c-1',
      DTO_MOVIMIENTO,
    );

    expect(movimiento.tipo).toBe('EGRESO');
    expect(movimiento.saldo_valor).toBe('20000');
    expect(insertadas).toHaveLength(1);

    const [, dtoAsiento, origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
      { origenTipo: string; origenId: string },
    ];
    expect(origen.origenTipo).toBe('MOVIMIENTO_CAJA');
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-1', debito: 0, credito: 30_000 },
      { cuentaId: 'cta-contra', debito: 30_000, credito: 0 },
    ]);
  });

  it('rechaza sin asentar ni insertar si deja la caja en negativo', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '10000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    await expect(
      servicioCon(tx, contabilidad).registrarEgreso(ctx, 'c-1', DTO_MOVIMIENTO),
    ).rejects.toThrow(BadRequestException);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });

  it('rechaza sin asentar ni insertar si la empresa no sembró el comprobante CE', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });
    const { fake: contabilidad, asentar } = contabilidadFalso({
      comprobante: null,
    });

    await expect(
      servicioCon(tx, contabilidad).registrarEgreso(ctx, 'c-1', DTO_MOVIMIENTO),
    ).rejects.toThrow(BadRequestException);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });
});

describe('CajaMovimientoService.registrarMovimientoDocumento', () => {
  const COBRO = {
    tipo: 'INGRESO' as const,
    fecha: '2026-09-12',
    valor: 50_000,
    concepto: 'Cobro de factura FV-001',
    contraCuentaId: 'cta-clientes',
    documentoTipo: 'FACTURA_VENTA' as const,
    documentoId: 'factura-1',
    terceroId: 'ter-1',
  };

  it('un cobro deja origen_tipo/origen_id/tercero_id con el documento, no NULL', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    const movimiento = await servicioCon(
      tx,
      contabilidad,
    ).registrarMovimientoDocumento(ctx, 'c-1', COBRO);

    expect(movimiento.tipo).toBe('INGRESO');
    expect(movimiento.origen_tipo).toBe('FACTURA_VENTA');
    expect(movimiento.origen_id).toBe('factura-1');
    expect(movimiento.tercero_id).toBe('ter-1');
    expect(insertadas).toHaveLength(1);

    const [, , origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { origenTipo: string; origenId: string },
    ];
    // El asiento sigue enlazado por MOVIMIENTO_CAJA + el id del movimiento,
    // no por el documento — esa es otra columna (origen_tipo del movimiento).
    expect(origen.origenTipo).toBe('MOVIMIENTO_CAJA');
  });

  it('un pago (EGRESO) rechaza en negativo, igual que un egreso manual', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '10000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    await expect(
      servicioCon(tx, contabilidad).registrarMovimientoDocumento(ctx, 'c-1', {
        ...COBRO,
        tipo: 'EGRESO',
        documentoTipo: 'COMPRA',
        contraCuentaId: 'cta-proveedores',
        valor: 50_000,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });
});

describe('CajaMovimientoService.reversar', () => {
  const MOTIVO = { fecha: '2026-09-16', motivo: 'Se cargó dos veces' };

  const egresoManual = {
    id: 'mov-1',
    caja_id: 'c-1',
    fecha: '2026-09-15',
    tipo: 'EGRESO',
    valor: '30000',
    concepto: 'Papelería',
    origen_tipo: null,
    origen_id: null,
    tercero_id: null,
    saldo_valor: '70000',
    asiento_id: 'asiento-original',
    reversa_de: null,
    motivo_reversa: null,
    reversado_por: null,
    es_ajuste_arqueo: false,
  };

  /** Transacción falsa para la reversa: la caja, el original y el saldo. */
  function txReversa(
    original: Record<string, unknown> | undefined,
    saldo = '70000',
  ) {
    const insertadas: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM caja WHERE')) {
          return [{ id: 'c-1', cuenta_id: 'cta-caja' }];
        }
        if (
          sql.includes('FROM caja_movimiento WHERE id = $1 AND caja_id = $2')
        ) {
          return original === undefined ? [] : [original];
        }
        if (sql.startsWith('SELECT saldo_valor')) {
          return [{ saldo_valor: saldo }];
        }
        if (sql.startsWith('INSERT INTO caja_movimiento')) {
          insertadas.push(params ?? []);
          const p = params as unknown[];
          return [
            {
              id: p[0],
              tipo: p[4],
              valor: String(p[5]),
              concepto: p[6],
              saldo_valor: String(p[10]),
              asiento_id: p[11],
              reversa_de: p[13],
              motivo_reversa: p[14],
            },
          ];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, insertadas };
  }

  function contabilidadReversa(
    lineas: unknown[] | null = [
      { cuentaId: 'cta-caja', debito: 30000, credito: 0 },
      { cuentaId: 'cta-gasto', debito: 0, credito: 30000 },
    ],
  ) {
    const asentar = jest.fn(() =>
      Promise.resolve({ id: 'asiento-reversa', numero: 'CI-000009' }),
    );
    const tipoComprobantePorCodigo = jest.fn(() =>
      Promise.resolve({ id: 'comp-ci' }),
    );
    const fake = {
      lineasInvertidasDe: jest.fn(() => Promise.resolve(lineas)),
      tipoComprobantePorCodigo,
      asentar,
    } as unknown as ConstructorParameters<typeof CajaMovimientoService>[1];
    return { fake, asentar, tipoComprobantePorCodigo };
  }

  it('un egreso se reversa con un ingreso por el mismo valor, el asiento invertido y el motivo', async () => {
    const { tx, insertadas } = txReversa(egresoManual);
    const { fake, asentar, tipoComprobantePorCodigo } = contabilidadReversa();

    const reversa = await servicioCon(tx, fake).reversar(
      ctx,
      'c-1',
      'mov-1',
      MOTIVO,
    );

    expect(reversa.tipo).toBe('INGRESO');
    expect(reversa.valor).toBe('30000');
    expect(reversa.saldo_valor).toBe('100000');
    expect(reversa.reversa_de).toBe('mov-1');
    expect(reversa.motivo_reversa).toBe('Se cargó dos veces');
    expect(reversa.concepto).toBe('Reversa de: Papelería');
    expect(tipoComprobantePorCodigo).toHaveBeenCalledWith(ctx, 'CI', tx);

    const [, dtoAsiento, origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      { fecha: string; glosa: string; lineas: unknown[] },
      { origenTipo: string; origenId: string },
    ];
    expect(dtoAsiento.fecha).toBe('2026-09-16');
    expect(dtoAsiento.glosa).toContain('Se cargó dos veces');
    expect(dtoAsiento.lineas).toHaveLength(2);
    expect(origen).toEqual({
      origenTipo: 'MOVIMIENTO_CAJA',
      origenId: insertadas[0][0],
    });
  });

  it('un ingreso no se reversa si el dinero ya no está en la caja', async () => {
    const { tx, insertadas } = txReversa(
      { ...egresoManual, tipo: 'INGRESO', valor: '50000' },
      '20000',
    );
    const { fake, asentar } = contabilidadReversa();

    await expect(
      servicioCon(tx, fake).reversar(ctx, 'c-1', 'mov-1', MOTIVO),
    ).rejects.toThrow(/Solo hay 20000 en caja/);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });

  it.each([
    [
      { origen_tipo: 'FACTURA_VENTA', origen_id: 'f-1' },
      /devolviendo el cobro/,
    ],
    [{ origen_tipo: 'COMPRA', origen_id: 'co-1' }, /devolución del pago/],
    [{ es_ajuste_arqueo: true }, /otro arqueo/],
    [{ reversa_de: 'mov-0' }, /ya es una reversa/],
    [{ reversado_por: 'mov-2' }, /ya se reversó/],
    [
      { tipo: 'SALDO_INICIAL', asiento_id: null },
      /saldo inicial no se reversa/,
    ],
  ])('rechaza sin asentar: %o', async (cambio, mensaje) => {
    const { tx, insertadas } = txReversa({ ...egresoManual, ...cambio });
    const { fake, asentar } = contabilidadReversa();

    await expect(
      servicioCon(tx, fake).reversar(ctx, 'c-1', 'mov-1', MOTIVO),
    ).rejects.toThrow(mensaje);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });

  it('rechaza si el movimiento no es de esta caja', async () => {
    const { tx } = txReversa(undefined);

    await expect(
      servicioCon(tx, contabilidadReversa().fake).reversar(
        ctx,
        'c-1',
        'mov-x',
        MOTIVO,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza si el asiento del original está anulado', async () => {
    const { tx } = txReversa(egresoManual);

    await expect(
      servicioCon(tx, contabilidadReversa(null).fake).reversar(
        ctx,
        'c-1',
        'mov-1',
        MOTIVO,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
