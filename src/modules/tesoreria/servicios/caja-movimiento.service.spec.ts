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
