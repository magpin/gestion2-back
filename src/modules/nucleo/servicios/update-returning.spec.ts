import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { CtxEmpresa, CtxPlataforma } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { SistemaService } from '../../plataforma/servicios/sistema.service';
import { EmpresaLegalService } from './empresa-legal.service';
import { PlanCuentasService } from './plan-cuentas.service';

/**
 * Plan motor de retenciones, Fase 8 (§8.1). TypeORM devuelve un `UPDATE …
 * RETURNING` como `[filas, cantidad]`: leerlo como si fueran las filas dejaba
 * pasar «no existe» (el arreglo nunca es `undefined` ni tiene largo 0) y
 * devolvía el arreglo entero en vez de la fila. Cada caso con los dos lados:
 * no encontró nada, y encontró la fila.
 */

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['DIRECTOR'],
};

/** Un `Tx` que responde al UPDATE como TypeORM: `[filas, cantidad]`. */
function txUpdate(filasUpdate: unknown[], antes: unknown[] = []): Tx {
  return {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.trimStart().startsWith('UPDATE')
          ? [filasUpdate, filasUpdate.length]
          : antes,
      ),
    ),
  } as unknown as Tx;
}

const txService = (tx: Tx) =>
  ({
    enContexto: (_: unknown, fn: (t: Tx) => Promise<unknown>) => fn(tx),
  }) as unknown as TxService;

describe('UPDATE … RETURNING se lee con filas()', () => {
  it('PlanCuentasService.editar: no existe → 404; existe → la fila', async () => {
    await expect(
      new PlanCuentasService(txService(txUpdate([]))).editar(ctx, 'c-1', {}),
    ).rejects.toThrow(NotFoundException);
    await expect(
      new PlanCuentasService(txService(txUpdate([{ id: 'c-1' }]))).editar(
        ctx,
        'c-1',
        {},
      ),
    ).resolves.toEqual({ id: 'c-1' });
  });

  it('PlanCuentasService.desactivar: una cuenta que no existe → 404', async () => {
    await expect(
      new PlanCuentasService(txService(txUpdate([], [{ n: '0' }]))).desactivar(
        ctx,
        'c-1',
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      new PlanCuentasService(
        txService(txUpdate([{ id: 'c-1' }], [{ n: '0' }])),
      ).desactivar(ctx, 'c-1'),
    ).resolves.toBeUndefined();
  });

  it('PlanCuentasService.editarCentro y desactivarCentro', async () => {
    await expect(
      new PlanCuentasService(txService(txUpdate([]))).editarCentro(
        ctx,
        'cc-1',
        {},
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      new PlanCuentasService(
        txService(txUpdate([{ id: 'cc-1' }])),
      ).editarCentro(ctx, 'cc-1', {}),
    ).resolves.toEqual({ id: 'cc-1' });
    await expect(
      new PlanCuentasService(txService(txUpdate([]))).desactivarCentro(
        ctx,
        'cc-1',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('EmpresaLegalService.editarConfiguracionContable', async () => {
    await expect(
      new EmpresaLegalService(
        txService(txUpdate([])),
      ).editarConfiguracionContable(ctx, {}),
    ).rejects.toThrow(NotFoundException);
    await expect(
      new EmpresaLegalService(
        txService(txUpdate([{ grupo_niif: 'GRUPO_2' }])),
      ).editarConfiguracionContable(ctx, {}),
    ).resolves.toEqual({ grupo_niif: 'GRUPO_2' });
  });

  it('SistemaService.retirar: un anuncio ya retirado → 404', async () => {
    const admin: CtxPlataforma = { adminId: 'a-1', email: 'a@b.co' };
    const conProvision = (tx: Tx) =>
      new SistemaService(
        {
          transaction: (fn: (t: Tx) => Promise<unknown>) => fn(tx),
        } as unknown as DataSource,
        {} as DataSource,
        {} as TxService,
        {} as never,
      );
    await expect(
      conProvision(txUpdate([])).retirar(admin, 'an-1'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      conProvision(txUpdate([{ titulo: 'Mantenimiento' }])).retirar(
        admin,
        'an-1',
      ),
    ).resolves.toEqual({ ok: true });
  });
});
