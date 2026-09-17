import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { BancoCorteService } from './banco-corte.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CAJA'],
};

const HOY = hoyEnColombia();

/**
 * Transacción falsa. `sumas` es lo que devolvería la agregación del libro;
 * `corteExistente` simula que el día ya se cortó; `cuenta: false`, que la
 * cuenta no existe o está inactiva.
 */
function txFalso(
  opciones: {
    sumas?: {
      saldo_anterior: string;
      entradas: string;
      salidas: string;
      movimientos: number;
    };
    corteExistente?: boolean;
    cuenta?: boolean;
  } = {},
) {
  const {
    sumas = {
      saldo_anterior: '1000000.00',
      entradas: '300000.00',
      salidas: '120000.00',
      movimientos: 4,
    },
    corteExistente = false,
    cuenta = true,
  } = opciones;
  const inserts: unknown[][] = [];
  const agregaciones: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM cuenta_bancaria WHERE')) {
        return cuenta ? [{ id: 'cb-1' }] : [];
      }
      if (sql.includes('INSERT INTO banco_corte')) {
        inserts.push(params ?? []);
        const p = params as unknown[];
        return [
          {
            id: p[0],
            fecha: p[3],
            saldo_anterior: String(p[4]),
            entradas: String(p[5]),
            salidas: String(p[6]),
            saldo_final: String(p[7]),
            movimientos: p[8],
            saldo_banco: p[9] === null ? null : String(Number(p[9])),
            diferencia: p[10] === null ? null : String(Number(p[10])),
            nota: p[11],
            cambios_posteriores: 0,
          },
        ];
      }
      if (sql.startsWith('SELECT id FROM banco_corte')) {
        return corteExistente ? [{ id: 'corte-viejo' }] : [];
      }
      if (sql.includes('AS saldo_anterior')) {
        agregaciones.push(params ?? []);
        return [sumas];
      }
      // Antes que la de movimientos: el corte trae `cambios_posteriores`, que
      // también lee `banco_movimiento`.
      if (sql.includes('FROM banco_corte')) {
        return [];
      }
      if (sql.includes('FROM banco_movimiento')) {
        return [{ id: 'mov-1' }];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, inserts, agregaciones };
}

function servicioCon(tx: Tx) {
  return new BancoCorteService({
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as never);
}

describe('BancoCorteService.cerrar', () => {
  it('congela anterior, entradas, salidas y final calculados del libro', async () => {
    const { tx, inserts } = txFalso();

    const corte = await servicioCon(tx).cerrar(ctx, 'cb-1', { fecha: HOY });

    expect(inserts).toHaveLength(1);
    expect(corte.saldo_anterior).toBe('1000000');
    expect(corte.entradas).toBe('300000');
    expect(corte.salidas).toBe('120000');
    expect(corte.saldo_final).toBe('1180000');
    expect(corte.movimientos).toBe(4);
    expect(corte.saldo_banco).toBeNull();
    expect(corte.diferencia).toBeNull();
  });

  it('con el saldo leído del banco, guarda la diferencia', async () => {
    const { tx } = txFalso();

    const corte = await servicioCon(tx).cerrar(ctx, 'cb-1', {
      fecha: HOY,
      saldoBanco: 1_175_000,
      nota: '  4x1000 sin registrar  ',
    });

    expect(corte.saldo_banco).toBe('1175000');
    expect(corte.diferencia).toBe('-5000');
    expect(corte.nota).toBe('4x1000 sin registrar');
  });

  it('clasifica por la dirección del libro: el saldo inicial y las entradas suman', async () => {
    const { tx, agregaciones } = txFalso();

    await servicioCon(tx).cerrar(ctx, 'cb-1', { fecha: HOY });

    const [, , tiposQueSuman] = agregaciones[0] as [string, string, string[]];
    expect([...tiposQueSuman].sort()).toEqual(
      [
        'CONSIGNACION',
        'NOTA_CREDITO',
        'SALDO_INICIAL',
        'TRANSFERENCIA_ENTRANTE',
      ].sort(),
    );
  });

  it('rechaza un día ya cortado, sin insertar', async () => {
    const { tx, inserts } = txFalso({ corteExistente: true });

    await expect(
      servicioCon(tx).cerrar(ctx, 'cb-1', { fecha: HOY }),
    ).rejects.toThrow(/ya se cortó/);
    expect(inserts).toHaveLength(0);
  });

  it('rechaza una fecha futura sin tocar la base', async () => {
    const { tx } = txFalso();
    const manana = new Date(`${HOY}T12:00:00Z`);
    manana.setUTCDate(manana.getUTCDate() + 1);

    await expect(
      servicioCon(tx).cerrar(ctx, 'cb-1', {
        fecha: manana.toISOString().slice(0, 10),
      }),
    ).rejects.toThrow(BadRequestException);
    expect((tx.query as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('rechaza si la cuenta no existe o está inactiva', async () => {
    const { tx } = txFalso({ cuenta: false });

    await expect(
      servicioCon(tx).cerrar(ctx, 'cb-1', { fecha: HOY }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('BancoCorteService.previo', () => {
  it('devuelve el día calculado, sus movimientos y ningún corte si no se hizo', async () => {
    const { tx } = txFalso();

    const previo = await servicioCon(tx).previo(ctx, 'cb-1', HOY);

    expect(previo.saldo_final).toBe(1_180_000);
    expect(previo.movimientos).toEqual([{ id: 'mov-1' }]);
    expect(previo.corte).toBeNull();
  });
});
