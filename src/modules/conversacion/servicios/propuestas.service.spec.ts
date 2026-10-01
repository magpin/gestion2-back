import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa, RolCodigo } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { ComprasApi } from '../../compras/compras.api';
import type { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import type { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type { VentasApi } from '../../ventas/ventas.api';
import { PropuestasService } from './propuestas.service';

const CAJA_ID = '11111111-1111-4111-8111-111111111111';

const ctx = (roles: RolCodigo[] = ['CAJA']): CtxEmpresa => ({
  tenantId: 't-1',
  usuarioId: 'u-caja',
  empresaId: 'e-1',
  roles,
});

const COBRO = {
  factura: 'SETT-5',
  fecha: '2026-09-21',
  pagos: [{ medio: 'CAJA', id: CAJA_ID, valor: 1000 }],
};

interface Fila {
  id: string;
  usuario_id: string;
  accion: 'COBRO' | 'PAGO';
  documento_id: string;
  cuerpo: unknown;
  vista_previa: unknown;
  estado: string;
  vence_en: string;
  vencida: boolean;
  error: string | null;
  cuerpo_confirmado: unknown;
}

/**
 * Una base de mentira para las propuestas: guarda filas, las devuelve
 * bloqueadas y aplica los UPDATE. Cada transacción se registra, para ver qué
 * quedó y qué se deshizo.
 */
function preparar(e: { vencida?: boolean } = {}) {
  const filas: Fila[] = [];
  const query = jest.fn((sql: string, p: unknown[] = []) => {
    if (sql.includes('INSERT INTO asistente_propuesta')) {
      const f: Fila = {
        id: `p-${filas.length + 1}`,
        usuario_id: p[1] as string,
        accion: p[3] as 'COBRO',
        documento_id: p[4] as string,
        cuerpo: JSON.parse(p[5] as string),
        vista_previa: JSON.parse(p[6] as string),
        estado: 'PENDIENTE',
        vence_en: '2026-09-22T10:00:00Z',
        vencida: e.vencida ?? false,
        // El motivo de una apartada (paso 8) se guarda al insertar.
        error: (p[7] as string | null | undefined) ?? null,
        cuerpo_confirmado: null,
      };
      filas.push(f);
      return Promise.resolve([f]);
    }
    const f = filas.find((x) => x.id === p[0]);
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve(f && f.usuario_id === p[1] ? [f] : []);
    }
    if (sql.includes("SET estado = 'CONFIRMADA'") && f) {
      // Por una regla: (id, activador, regla, cuerpo, resultado); a mano:
      // (id, quien, cuerpo, resultado).
      const porRegla = sql.includes('confirmada_por_regla = $3');
      Object.assign(f, {
        estado: 'CONFIRMADA',
        resuelta_por: p[1] as string,
        automatica: porRegla,
        cuerpo_confirmado: JSON.parse(
          (porRegla ? p[3] : p[2]) as string,
        ) as unknown,
      });
      return Promise.resolve([f]);
    }
    if (
      sql.trimStart().startsWith('SELECT') &&
      sql.includes('WHERE id = $1 AND usuario_id = $2') &&
      f
    ) {
      return Promise.resolve([f]);
    }
    if (sql.includes("SET estado = 'DESCARTADA'") && f) {
      f.estado = 'DESCARTADA';
      return Promise.resolve([f]);
    }
    if (sql.includes("SET estado = 'VENCIDA'") && f) {
      f.estado = 'VENCIDA';
      return Promise.resolve([]);
    }
    if (sql.includes('SET error') && f) {
      f.error = p[2] as string;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  const t = { query } as unknown as Tx;
  const tx = {
    enContexto: (_c: unknown, fn: (t: Tx) => Promise<unknown>) => fn(t),
  } as unknown as TxService;

  const cobrarEnTx = jest.fn(() =>
    Promise.resolve({ id: 'f-5', pendiente: '0' }),
  );
  const simularCobro = jest.fn(() =>
    Promise.resolve({
      documento: { pendiente: '3943450.00' },
      asientos: [{ numero: 'RC-1', glosa: 'Cobro', lineas: [] }],
    }),
  );
  const facturaPorNumero = jest.fn((_c: unknown, numero: string) =>
    Promise.resolve(
      numero === 'SETT-5'
        ? {
            id: 'f-5',
            numero: 'SETT-5',
            cliente: 'CORONA',
            pendiente: '3944450.00',
          }
        : null,
    ),
  );
  const comprasPorNumero = jest.fn(() => Promise.resolve([]));
  const ventas = {
    cobrarEnTx,
    simularCobro,
    facturaPorNumero,
  } as unknown as VentasApi;
  const compras = { comprasPorNumero } as unknown as ComprasApi;
  const tesoreria = {
    saldos: () =>
      Promise.resolve([
        {
          id: CAJA_ID,
          medio: 'CAJA',
          nombre: 'Caja principal',
          saldo: '0',
          ultimoMovimiento: null,
        },
      ]),
  } as unknown as TesoreriaApi;

  // Marcar los asientos con su propuesta es cosa de contabilidad; acá solo
  // importa que se llame dentro de la transacción del cobro.
  const marcarPropuesta = jest.fn(() => Promise.resolve(1));
  const contabilidad = { marcarPropuesta } as unknown as ContabilidadApi;

  const servicio = new PropuestasService(
    tx,
    ventas,
    compras,
    tesoreria,
    contabilidad,
  );
  return {
    servicio,
    filas,
    cobrarEnTx,
    simularCobro,
    comprasPorNumero,
    t,
  };
}

/** Propone y guarda una, como lo hace un turno. */
async function unaGuardada(p: ReturnType<typeof preparar>, quien = ctx()) {
  const { nueva } = await p.servicio.preparar(quien, 'COBRO', COBRO);
  const [guardada] = await p.servicio.guardar(quien, 'turno-1', [nueva!], p.t);
  return guardada;
}

describe('PropuestasService — proponer', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('verifica en seco y arma la vista previa con el nombre de la caja', async () => {
    const p = preparar();
    const r = await p.servicio.preparar(ctx(), 'COBRO', COBRO);
    expect(p.simularCobro).toHaveBeenCalledWith(ctx(), 'f-5', {
      fecha: '2026-09-21',
      pagos: [{ medio: 'CAJA', cajaId: CAJA_ID, valor: 1000 }],
    });
    expect(r.nueva?.vistaPrevia).toMatchObject({
      documento: {
        numero: 'SETT-5',
        pendienteAntes: '3944450.00',
        pendienteDespues: '3943450.00',
      },
      medios: [{ medio: 'CAJA', nombre: 'Caja principal', valor: 1000 }],
    });
    expect(r.texto).toMatch(/No está registrada/);
  });

  it('un rol que no cobra no propone, aunque el modelo lo pida', async () => {
    const p = preparar();
    const r = await p.servicio.preparar(ctx(['VENTAS']), 'COBRO', COBRO);
    expect(r.nueva).toBeUndefined();
    expect(r.texto).toMatch(/^No se pudo proponer: .*rol/);
    expect(p.simularCobro).not.toHaveBeenCalled();
  });

  it('una factura que no existe se dice, sin simular', async () => {
    const p = preparar();
    const r = await p.servicio.preparar(ctx(), 'COBRO', {
      ...COBRO,
      factura: 'SETT-99',
    });
    expect(r.texto).toMatch(/SETT-99/);
    expect(p.simularCobro).not.toHaveBeenCalled();
  });

  it('un cuerpo que el DTO del endpoint rechaza no llega a simularse', async () => {
    const p = preparar();
    const r = await p.servicio.preparar(ctx(), 'COBRO', {
      ...COBRO,
      pagos: [],
    });
    expect(r.texto).toMatch(/al menos un medio/);
    expect(p.simularCobro).not.toHaveBeenCalled();
  });

  it('si el cobro en seco no pasaría, el motivo llega al modelo', async () => {
    const p = preparar();
    p.simularCobro.mockRejectedValueOnce(
      new BadRequestException('El cobro supera lo que queda por cobrar.'),
    );
    const r = await p.servicio.preparar(ctx(), 'COBRO', COBRO);
    expect(r.nueva).toBeUndefined();
    expect(r.texto).toBe(
      'No se pudo proponer: El cobro supera lo que queda por cobrar.',
    );
  });

  it('un pago con un número que dos proveedores repiten pide cuál', async () => {
    const p = preparar();
    p.comprasPorNumero.mockResolvedValueOnce([
      { id: 'c-1', numero: 'FE-1', proveedor: 'MPS', pendiente: '1' },
      { id: 'c-2', numero: 'FE-1', proveedor: 'CQV', pendiente: '1' },
    ] as never);
    const r = await p.servicio.preparar(ctx(), 'PAGO', {
      compra: 'FE-1',
      pagos: [{ medio: 'CAJA', id: CAJA_ID, valor: 1 }],
    });
    expect(r.texto).toMatch(/2 compras .*MPS, CQV.*proveedor/);
  });
});

describe('PropuestasService — confirmar y descartar', () => {
  it('confirmar cobra con el código del endpoint y marca la propuesta en la misma transacción', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    const r = await p.servicio.confirmar(ctx(), guardada.id);
    expect(p.cobrarEnTx).toHaveBeenCalledWith(
      ctx(),
      'f-5',
      guardada.cuerpo,
      p.t,
    );
    expect(r.estado).toBe('CONFIRMADA');
    expect(p.filas[0].cuerpo_confirmado).toEqual(guardada.cuerpo);
  });

  it('con corrección se registra lo corregido, y queda guardado para saber que se corrigió', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    const correccion = {
      fecha: '2026-09-21',
      pagos: [{ medio: 'CAJA' as const, cajaId: CAJA_ID, valor: 800 }],
    };
    await p.servicio.confirmar(ctx(), guardada.id, correccion);
    expect(p.cobrarEnTx).toHaveBeenCalledWith(ctx(), 'f-5', correccion, p.t);
    expect(p.filas[0].cuerpo_confirmado).toEqual(correccion);
  });

  it('dos veces no: la segunda es un 409 y no vuelve a cobrar', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    await p.servicio.confirmar(ctx(), guardada.id);
    await expect(
      p.servicio.confirmar(ctx(), guardada.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(p.cobrarEnTx).toHaveBeenCalledTimes(1);
  });

  it('solo la confirma quien la pidió: la de otra persona no existe para mí', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    const otro = { ...ctx(), usuarioId: 'u-otro' };
    await expect(
      p.servicio.confirmar(otro, guardada.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('si ya no tengo el rol, no se confirma', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    await expect(
      p.servicio.confirmar({ ...ctx(['VENTAS']) }, guardada.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(p.cobrarEnTx).not.toHaveBeenCalled();
  });

  it('si el cobro falla al confirmar, sigue pendiente y guarda por qué', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    p.cobrarEnTx.mockRejectedValueOnce(
      new BadRequestException('La factura ya no tiene saldo.'),
    );
    await expect(
      p.servicio.confirmar(ctx(), guardada.id),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(p.filas[0]).toMatchObject({
      estado: 'PENDIENTE',
      error: 'La factura ya no tiene saldo.',
    });
  });

  it('vencida: no se confirma y queda marcada VENCIDA', async () => {
    const p = preparar({ vencida: true });
    const guardada = await unaGuardada(p);
    expect(guardada.estado).toBe('VENCIDA');
    await expect(p.servicio.confirmar(ctx(), guardada.id)).rejects.toThrow(
      /venció/,
    );
    expect(p.cobrarEnTx).not.toHaveBeenCalled();
    expect(p.filas[0].estado).toBe('VENCIDA');
  });

  it('descartar la cierra sin registrar nada', async () => {
    const p = preparar();
    const guardada = await unaGuardada(p);
    const r = await p.servicio.descartar(ctx(), guardada.id);
    expect(r.estado).toBe('DESCARTADA');
    expect(p.cobrarEnTx).not.toHaveBeenCalled();
    await expect(
      p.servicio.confirmar(ctx(), guardada.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
