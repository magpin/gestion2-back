import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import type { CrearReglaExtractoDto } from '../dto/extracto.dto';
import { ExtractoReglaService } from './extracto-regla.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CONTADOR'],
};

const DTO: CrearReglaExtractoDto = {
  nombre: '4×1000',
  palabras: [' GMF ', 'GMF', '4X1000'],
  tipoLinea: 'DEBITO',
  contraCuentaId: 'cta-gasto',
  concepto: 'Gravamen a los movimientos financieros',
};

const CUENTA_BUENA = {
  activa: true,
  es_auxiliar: true,
  exige_tercero: false,
  exige_centro_costo: false,
  exige_base_gravable: false,
};

function servicioCon(cuenta: Partial<typeof CUENTA_BUENA> | undefined) {
  const query = jest.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM empresa_cuenta')) {
      return Promise.resolve(
        cuenta === undefined ? [] : [{ ...CUENTA_BUENA, ...cuenta }],
      );
    }
    if (sql.startsWith('INSERT INTO extracto_regla')) {
      return Promise.resolve([{ id: 'r-1', palabras: params?.[3] }]);
    }
    throw new Error(`Query inesperada en el test: ${sql}`);
  });
  const servicio = new ExtractoReglaService({
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) =>
      fn({ query } as unknown as Tx),
  } as never);
  return { servicio, query };
}

describe('ExtractoReglaService.crear', () => {
  it('crea la regla con las palabras limpias y sin repetir', async () => {
    const { servicio } = servicioCon({});
    const creada = await servicio.crear(ctx, DTO);
    expect(creada.palabras).toEqual(['GMF', '4X1000']);
  });

  it.each([
    ['exige_tercero', 'tercero'],
    ['exige_centro_costo', 'centro de costo'],
    ['exige_base_gravable', 'base gravable'],
  ])(
    'rechaza sin crear una cuenta con %s: la regla registra sin él',
    async (campo, nombre) => {
      const { servicio, query } = servicioCon({ [campo]: true });
      const intento = servicio.crear(ctx, DTO);
      await expect(intento).rejects.toBeInstanceOf(BadRequestException);
      await expect(intento).rejects.toThrow(nombre);
      expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(
        false,
      );
    },
  );

  it('rechaza una cuenta que agrupa', async () => {
    const { servicio } = servicioCon({ es_auxiliar: false });
    await expect(servicio.crear(ctx, DTO)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rechaza una cuenta que no existe', async () => {
    const { servicio } = servicioCon(undefined);
    await expect(servicio.crear(ctx, DTO)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
