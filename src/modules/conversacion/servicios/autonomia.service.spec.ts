import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { CtxEmpresa, RolCodigo } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { NucleoApi } from '../../nucleo/nucleo.api';
import { AutonomiaService } from './autonomia.service';

const ctx = (roles: RolCodigo[] = ['DIRECTOR']): CtxEmpresa => ({
  tenantId: 't-1',
  usuarioId: 'u-director',
  empresaId: 'e-1',
  roles,
});

interface Regla {
  id: string;
  accion: string;
  modo: string;
  limite: string | null;
  activada_por: string;
  creada_en: string;
}

/**
 * Una base de mentira para las reglas: las filas se agregan, y la vigente de
 * cada acción es la última. Los aciertos salen de `confirmadas`.
 */
function preparar(
  e: {
    confirmadas?: number;
    duplicado?: boolean;
    rolesActivador?: RolCodigo[];
  } = {},
) {
  const reglas: Regla[] = [];
  const query = jest.fn((sql: string, p: unknown[] = []) => {
    if (sql.includes('INSERT INTO asistente_regla')) {
      const general = sql.includes("'GENERAL'");
      const v = p as [string, string, string, number | null, string];
      reglas.push({
        id: `r-${reglas.length + 1}`,
        accion: general ? 'GENERAL' : v[1],
        modo: general ? v[1] : v[2],
        limite: general || v[3] === null ? null : String(v[3]),
        activada_por: general ? v[2] : v[4],
        creada_en: `2026-09-21T10:0${reglas.length}:00Z`,
      });
      return Promise.resolve([]);
    }
    if (sql.includes('DISTINCT ON (accion)')) {
      const ultimas = new Map<string, Regla>();
      for (const r of reglas) ultimas.set(r.accion, r);
      return Promise.resolve([...ultimas.values()]);
    }
    if (sql.includes('GROUP BY accion')) {
      return Promise.resolve([
        {
          accion: 'COBRO',
          confirmadas: e.confirmadas ?? 0,
          sin_corregir: e.confirmadas ?? 0,
          automaticas: 0,
        },
      ]);
    }
    if (sql.includes('SELECT EXISTS')) {
      return Promise.resolve([{ hay: e.duplicado ?? false }]);
    }
    return Promise.resolve([]);
  });
  const tx = {
    enContexto: (_c: unknown, fn: (t: Tx) => Promise<unknown>) =>
      fn({ query } as unknown as Tx),
  } as unknown as TxService;
  const rolesVigentesDe = jest.fn(() =>
    Promise.resolve({
      nombre: 'Luisa Pena',
      roles: e.rolesActivador ?? ['DIRECTOR'],
    }),
  );
  const servicio = new AutonomiaService(tx, {
    rolesVigentesDe,
  } as unknown as NucleoApi);
  return { servicio, reglas, rolesVigentesDe };
}

describe('AutonomiaService — las reglas', () => {
  it('todo arranca en solo proponer, y cualquiera lo ve; solo DIRECTOR edita', async () => {
    const { servicio } = preparar();
    const visto = await servicio.estado(ctx(['VENTAS']));
    expect(visto.reglas.map((r) => [r.accion, r.modo])).toEqual([
      ['COBRO', 'SOLO_PROPONER'],
      ['PAGO', 'SOLO_PROPONER'],
    ]);
    expect(visto.puedeEditar).toBe(false);
    expect((await servicio.estado(ctx())).puedeEditar).toBe(true);
  });

  it('solo DIRECTOR cambia una regla o pausa', async () => {
    const { servicio } = preparar({ confirmadas: 50 });
    await expect(
      servicio.cambiarRegla(ctx(['CAJA']), 'COBRO', 'CONFIRMAR_SI_PASA', 1000),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      servicio.pausar(ctx(['CONTADOR']), true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('no se suelta una acción sin historia', async () => {
    const { servicio, reglas } = preparar({ confirmadas: 19 });
    await expect(
      servicio.cambiarRegla(ctx(), 'COBRO', 'CONFIRMAR_SI_PASA', 1000),
    ).rejects.toThrow(/hay 19 cobros .* hacen falta 20/);
    expect(reglas).toHaveLength(0);
  });

  it('con historia se suelta, queda con quién la activó, y la vigente es la última fila', async () => {
    const { servicio, reglas } = preparar({ confirmadas: 20 });
    await servicio.cambiarRegla(ctx(), 'COBRO', 'CONFIRMAR_SI_PASA', 2_000_000);
    const estado = await servicio.cambiarRegla(
      ctx(),
      'COBRO',
      'CONFIRMAR_SI_PASA',
      500_000,
    );
    expect(reglas).toHaveLength(2);
    expect(estado.reglas[0]).toMatchObject({
      modo: 'CONFIRMAR_SI_PASA',
      limite: 500_000,
      activadaPor: 'Luisa Pena',
    });
  });

  it('volver a solo proponer no pide historia ni límite', async () => {
    const { servicio } = preparar({ confirmadas: 0 });
    const estado = await servicio.cambiarRegla(
      ctx(),
      'COBRO',
      'SOLO_PROPONER',
      null,
    );
    expect(estado.reglas[0].modo).toBe('SOLO_PROPONER');
  });

  it('confirmar solo sin límite no se puede', async () => {
    const { servicio } = preparar({ confirmadas: 50 });
    await expect(
      servicio.cambiarRegla(ctx(), 'COBRO', 'CONFIRMAR_SI_PASA', null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AutonomiaService — decidir', () => {
  async function conRegla(e: Parameters<typeof preparar>[0] = {}) {
    const p = preparar({ confirmadas: 20, ...e });
    await p.servicio.cambiarRegla(
      ctx(),
      'COBRO',
      'CONFIRMAR_SI_PASA',
      2_000_000,
    );
    return p;
  }

  it('bajo el límite se confirma sola, mirando los roles de quien activó la regla', async () => {
    const { servicio, rolesVigentesDe } = await conRegla();
    const d = await servicio.decidir(ctx(['CAJA']), 'COBRO', 'f-1', 1000);
    expect(d.confirmar).toBe(true);
    expect(rolesVigentesDe).toHaveBeenLastCalledWith(
      ctx(['CAJA']),
      'u-director',
      'e-1',
    );
  });

  it('pausada, todo espera', async () => {
    const { servicio } = await conRegla();
    await servicio.pausar(ctx(), true);
    expect(await servicio.decidir(ctx(), 'COBRO', 'f-1', 1000)).toEqual({
      confirmar: false,
      motivo: null,
    });
    await servicio.pausar(ctx(), false);
    expect(
      (await servicio.decidir(ctx(), 'COBRO', 'f-1', 1000)).confirmar,
    ).toBe(true);
  });

  it('los pagos no tienen regla: esperan', async () => {
    const { servicio } = await conRegla();
    expect((await servicio.decidir(ctx(), 'PAGO', 'c-1', 1000)).confirmar).toBe(
      false,
    );
  });

  it('si quien activó la regla perdió el rol, espera con el motivo', async () => {
    const { servicio } = await conRegla({ rolesActivador: ['CONSULTA'] });
    const d = await servicio.decidir(ctx(), 'COBRO', 'f-1', 1000);
    expect(!d.confirmar && d.motivo).toMatch(/ya no puede registrar/);
  });

  it('un posible duplicado espera', async () => {
    const { servicio } = await conRegla({ duplicado: true });
    const d = await servicio.decidir(ctx(), 'COBRO', 'f-1', 1000);
    expect(!d.confirmar && d.motivo).toMatch(/duplicado/);
  });
});
