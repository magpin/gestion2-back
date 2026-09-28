import type { Tx, TxService } from '../../../common/db/tx.service';
import { TerceroService } from './tercero.service';

jest.mock('../../../common/fecha', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../common/fecha'),
  hoyEnColombia: () => '2026-09-28',
}));

interface Version {
  id: string;
  desde: string;
  hasta: string | null;
  regimen_simple: boolean;
}

/** La historia del perfil de un tercero; anota cada escritura. */
function escenario(versiones: Version[]) {
  const escrituras: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    // eslint-disable-next-line @typescript-eslint/require-await -- imita la firma de Tx.query
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('ORDER BY vigencia_desde')) {
        return versiones.map((v) => ({
          ...v,
          responsable_iva: true,
          es_agente_retenedor: false,
          es_autorretenedor: false,
          es_gran_contribuyente: false,
        }));
      }
      escrituras.push({ sql, params });
      return [];
    }),
  } as unknown as Tx;
  const servicio = new TerceroService({} as TxService);
  const desdeFicha = (regimenSimple: boolean) =>
    servicio['perfilDesdeFicha'](tx, 'te-1', { regimenSimple });
  return { desdeFicha, escrituras };
}

const insercion = (e: Array<{ sql: string; params: unknown[] }>) =>
  e.find((x) => x.sql.includes('INSERT INTO tercero_perfil_tributario'));

describe('TerceroService — la ficha y el perfil con fecha futura (bug #7)', () => {
  it('con una versión futura, cierra la de hoy y la nueva dura hasta el día antes de la futura', async () => {
    const { desdeFicha, escrituras } = escenario([
      {
        id: 'v1',
        desde: '2026-01-01',
        hasta: '2026-10-14',
        regimen_simple: false,
      },
      { id: 'v2', desde: '2026-10-15', hasta: null, regimen_simple: false },
    ]);

    await desdeFicha(true);

    // La futura no se toca; antes se cerraba ayer y rompía ck_perfil_vigencia.
    expect(escrituras.some((e) => e.params[0] === 'v2')).toBe(false);
    const cierre = escrituras.find((e) => e.sql.includes('SET vigencia_hasta'));
    expect(cierre?.params).toEqual(['v1', '2026-09-28']);
    const nueva = insercion(escrituras);
    expect(nueva?.sql).toContain("$7::date, $8::date - 1, 'MANUAL'");
    expect(nueva?.params).toEqual([
      'v1',
      true,
      true,
      false,
      false,
      false,
      '2026-09-28',
      '2026-10-15',
    ]);
  });

  it('si solo hay una versión futura, la nueva va de hoy al día antes de ella', async () => {
    const { desdeFicha, escrituras } = escenario([
      { id: 'v2', desde: '2026-10-15', hasta: null, regimen_simple: false },
    ]);

    await desdeFicha(true);

    expect(escrituras.some((e) => e.sql.includes('UPDATE'))).toBe(false);
    expect(insercion(escrituras)?.params.slice(-2)).toEqual([
      '2026-09-28',
      '2026-10-15',
    ]);
  });

  it('sin futura, cierra la vigente ayer y abre una sin fin, como antes', async () => {
    const { desdeFicha, escrituras } = escenario([
      { id: 'v1', desde: '2026-01-01', hasta: null, regimen_simple: false },
    ]);

    await desdeFicha(true);

    expect(
      escrituras.find((e) => e.sql.includes('SET vigencia_hasta'))?.params,
    ).toEqual(['v1', '2026-09-28']);
    expect(insercion(escrituras)?.params.slice(-2)).toEqual([
      '2026-09-28',
      null,
    ]);
  });

  it('la de hoy se corrige en el sitio', async () => {
    const { desdeFicha, escrituras } = escenario([
      { id: 'v1', desde: '2026-09-28', hasta: null, regimen_simple: false },
    ]);

    await desdeFicha(true);

    expect(escrituras).toHaveLength(1);
    expect(escrituras[0].sql).toContain('SET regimen_renta');
    expect(escrituras[0].params[0]).toBe('v1');
  });

  it('sin cambios no escribe nada', async () => {
    const { desdeFicha, escrituras } = escenario([
      {
        id: 'v1',
        desde: '2026-01-01',
        hasta: '2026-10-14',
        regimen_simple: true,
      },
      { id: 'v2', desde: '2026-10-15', hasta: null, regimen_simple: false },
    ]);

    await desdeFicha(true);

    expect(escrituras).toHaveLength(0);
  });
});
