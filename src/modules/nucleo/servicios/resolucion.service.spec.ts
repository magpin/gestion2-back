import { ConflictException, BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { ResolucionService } from './resolucion.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['DIRECTOR'],
};

/** Transacción falsa: devuelve la resolución pedida y registra el UPDATE. */
function txFalso(resolucion: Record<string, unknown> | undefined) {
  const consultas: string[] = [];
  const tx = {
    query: jest.fn(async (sql: string) => {
      consultas.push(sql);
      if (sql.includes('FOR UPDATE')) {
        return resolucion === undefined ? [] : [resolucion];
      }
      if (sql.includes('consecutivo_actual + 1')) {
        return [
          {
            consecutivo_actual: String(
              Number(resolucion?.consecutivo_actual) + 1,
            ),
          },
        ];
      }
      return [];
    }),
  } as unknown as Tx;
  return { tx, consultas };
}

const base = {
  id: 'r-1',
  prefijo: 'SETP',
  rango_hasta: '1000',
  consecutivo_actual: '990',
  numero_resolucion: '18764000001',
  fecha_vigencia_desde: '2026-01-01',
  fecha_vigencia_hasta: '2026-12-31',
};

describe('ResolucionService.tomarConsecutivo', () => {
  const servicio = new ResolucionService(
    {} as never,
    { cifrarOpcional: () => null } as never,
  );

  it('avanza el consecutivo y arma el numero con el prefijo', async () => {
    const { tx } = txFalso(base);
    const numero = await servicio.tomarConsecutivo(
      ctx,
      'FACTURA_VENTA',
      tx,
      '2026-06-15',
    );

    expect(numero.consecutivo).toBe(991);
    expect(numero.numero).toBe('SETP991');
    expect(numero.numeroResolucion).toBe('18764000001');
  });

  it('bloquea la fila de la resolucion antes de avanzar', async () => {
    // Sin FOR UPDATE, dos facturas simultaneas se llevan el mismo numero.
    const { tx, consultas } = txFalso(base);
    await servicio.tomarConsecutivo(ctx, 'FACTURA_VENTA', tx, '2026-06-15');
    expect(consultas[0]).toContain('FOR UPDATE');
  });

  it('rechaza emitir si no hay resolucion activa', async () => {
    const { tx } = txFalso(undefined);
    await expect(
      servicio.tomarConsecutivo(ctx, 'NOTA_CREDITO', tx, '2026-06-15'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza emitir fuera de la vigencia', async () => {
    const { tx } = txFalso(base);
    await expect(
      servicio.tomarConsecutivo(ctx, 'FACTURA_VENTA', tx, '2027-01-05'),
    ).rejects.toThrow(ConflictException);
  });

  it('rechaza emitir antes de que la resolucion empiece a regir', async () => {
    const { tx } = txFalso(base);
    await expect(
      servicio.tomarConsecutivo(ctx, 'FACTURA_VENTA', tx, '2025-12-31'),
    ).rejects.toThrow(ConflictException);
  });

  it('rechaza emitir con el rango agotado', async () => {
    // Llegar a rango_hasta significa que la DIAN tiene que autorizar otro rango.
    const { tx } = txFalso({ ...base, consecutivo_actual: '1000' });
    await expect(
      servicio.tomarConsecutivo(ctx, 'FACTURA_VENTA', tx, '2026-06-15'),
    ).rejects.toThrow(/agoto su rango/);
  });

  it('emite el ultimo numero del rango', async () => {
    const { tx } = txFalso({ ...base, consecutivo_actual: '999' });
    const numero = await servicio.tomarConsecutivo(
      ctx,
      'FACTURA_VENTA',
      tx,
      '2026-06-15',
    );
    expect(numero.consecutivo).toBe(1000);
  });

  it('funciona sin prefijo', async () => {
    const { tx } = txFalso({ ...base, prefijo: null });
    const numero = await servicio.tomarConsecutivo(
      ctx,
      'FACTURA_VENTA',
      tx,
      '2026-06-15',
    );
    expect(numero.numero).toBe('991');
  });
});
