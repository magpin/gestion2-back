import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { CajaMovimientoService } from './caja-movimiento.service';
import type { CargaInicialCajaDto } from '../dto/caja-movimiento.dto';

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

/** `TxService` falso: abre "transacción" ejecutando `fn` con el `tx` dado. */
function servicioCon(tx: Tx) {
  return new CajaMovimientoService({
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as never);
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
