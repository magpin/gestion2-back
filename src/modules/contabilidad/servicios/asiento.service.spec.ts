import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { CrearAsientoDto } from '../dto/asiento.dto';
import { AsientoService } from './asiento.service';
import type { ComprobanteService } from './comprobante.service';
import type { PeriodoService } from './periodo.service';

/**
 * El centro de costo de las líneas al registrar (plan de centros de costo,
 * fases 1, 2 y 8): el del documento, el de por defecto en los automáticos,
 * los repartos y lo que se rechaza con un mensaje que se entiende.
 */

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CONTADOR'],
};

interface Escenario {
  /** Las cuentas que exigen centro. */
  exigen?: string[];
  porDefecto?: string | null;
  /** Los centros que existen; `agrupa` = tiene hijos. */
  centros?: Record<
    string,
    { codigo: string; nombre: string; agrupa?: boolean }
  >;
  repartos?: Record<string, Array<{ centro: string; porcentaje: number }>>;
}

function servicioCon(e: Escenario) {
  const insertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM centro_costo_reparto_linea')) {
        const ids = params[0] as string[];
        return Promise.resolve(
          ids.flatMap((id) =>
            (e.repartos?.[id] ?? []).map((p) => ({
              reparto_id: id,
              centro_costo_id: p.centro,
              porcentaje: String(p.porcentaje),
            })),
          ),
        );
      }
      if (sql.includes('AND exige_centro_costo')) {
        const ids = params[0] as string[];
        return Promise.resolve(
          ids.filter((id) => e.exigen?.includes(id)).map((id) => ({ id })),
        );
      }
      if (sql.includes('es_por_defecto AND activo')) {
        return Promise.resolve(e.porDefecto ? [{ id: e.porDefecto }] : []);
      }
      if (sql.includes('AS agrupa')) {
        const ids = params[0] as string[];
        return Promise.resolve(
          ids
            .filter((id) => e.centros?.[id] !== undefined)
            .map((id) => ({
              id,
              codigo: e.centros![id].codigo,
              nombre: e.centros![id].nombre,
              agrupa: e.centros![id].agrupa ?? false,
            })),
        );
      }
      if (
        sql.includes('INSERT INTO asiento\n') ||
        sql.includes('INSERT INTO asiento ')
      ) {
        return Promise.resolve([{ id: 'asiento-1' }]);
      }
      if (sql.includes('INSERT INTO asiento_linea')) {
        insertadas.push(params);
        return Promise.resolve([]);
      }
      throw new Error(`Consulta inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  const servicio = new AsientoService(
    {
      enContexto: (_: unknown, fn: (t: Tx) => Promise<unknown>) => fn(tx),
    } as unknown as TxService,
    {
      periodoParaAsentar: jest.fn(() =>
        Promise.resolve({
          periodo: { id: 'p-1' },
          fecha: '2026-10-01',
          movida: false,
        }),
      ),
    } as unknown as PeriodoService,
    {
      exigirDigitable: jest.fn(() => Promise.resolve()),
      siguienteNumero: jest.fn(() => Promise.resolve('CD-1')),
    } as unknown as ComprobanteService,
  );
  /** La cuenta y el centro de cada línea insertada, con su débito y crédito. */
  const lineas = () =>
    insertadas.map((p) => ({
      cuenta: p[3],
      centro: p[5],
      debito: p[8],
      credito: p[9],
    }));
  return { servicio, lineas };
}

const asiento = (
  lineas: CrearAsientoDto['lineas'],
  extra: Partial<CrearAsientoDto> = {},
): CrearAsientoDto => ({
  comprobanteTipoId: 'cd',
  fecha: '2026-10-01',
  glosa: 'Prueba de centros',
  lineas,
  ...extra,
});

const AUTOMATICO = { origenTipo: 'COMPRA', origenId: 'c-1' } as const;

describe('AsientoService.crear — centros de costo', () => {
  it('la línea que exige centro toma el del documento', async () => {
    const { servicio, lineas } = servicioCon({
      exigen: ['gasto'],
      centros: { norte: { codigo: 'N', nombre: 'Norte' } },
    });
    await servicio.crear(
      ctx,
      asiento(
        [
          { cuentaId: 'gasto', debito: 100, credito: 0 },
          { cuentaId: 'proveedores', debito: 0, credito: 100 },
        ],
        { centroCostoId: 'norte' },
      ),
      AUTOMATICO,
    );
    expect(lineas()).toEqual([
      { cuenta: 'gasto', centro: 'norte', debito: 100, credito: 0 },
      { cuenta: 'proveedores', centro: null, debito: 0, credito: 100 },
    ]);
  });

  it('un automático sin centro va al de por defecto', async () => {
    const { servicio, lineas } = servicioCon({
      exigen: ['gasto'],
      porDefecto: 'adm',
      centros: { adm: { codigo: 'ADM', nombre: 'Administración' } },
    });
    await servicio.crear(
      ctx,
      asiento([
        { cuentaId: 'gasto', debito: 100, credito: 0 },
        { cuentaId: 'banco', debito: 0, credito: 100 },
      ]),
      AUTOMATICO,
    );
    expect(lineas()[0].centro).toBe('adm');
  });

  it('el asiento manual sin centro no se completa: lo elige quien digita', async () => {
    const { servicio, lineas } = servicioCon({
      exigen: ['gasto'],
      porDefecto: 'adm',
    });
    await servicio.crear(
      ctx,
      asiento([
        { cuentaId: 'gasto', debito: 100, credito: 0 },
        { cuentaId: 'banco', debito: 0, credito: 100 },
      ]),
    );
    // Sin centro: el trigger de la base dirá que la cuenta lo exige.
    expect(lineas()[0].centro).toBeNull();
  });

  it('rechaza un centro que agrupa otros, con su nombre', async () => {
    const { servicio } = servicioCon({
      centros: { norte: { codigo: 'N', nombre: 'Norte', agrupa: true } },
    });
    await expect(
      servicio.crear(
        ctx,
        asiento([
          {
            cuentaId: 'gasto',
            debito: 100,
            credito: 0,
            centroCostoId: 'norte',
          },
          { cuentaId: 'banco', debito: 0, credito: 100 },
        ]),
      ),
    ).rejects.toThrow('El centro de costo N (Norte) agrupa otros');
  });

  it('rechaza un centro que no es de la empresa', async () => {
    const { servicio } = servicioCon({ centros: {} });
    await expect(
      servicio.crear(
        ctx,
        asiento([
          {
            cuentaId: 'gasto',
            debito: 100,
            credito: 0,
            centroCostoId: 'ajeno',
          },
          { cuentaId: 'banco', debito: 0, credito: 100 },
        ]),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('el reparto parte la línea en una por centro y el asiento sigue cuadrando', async () => {
    const { servicio, lineas } = servicioCon({
      centros: {
        norte: { codigo: 'N', nombre: 'Norte' },
        sur: { codigo: 'S', nombre: 'Sur' },
      },
      repartos: {
        arriendo: [
          { centro: 'norte', porcentaje: 60 },
          { centro: 'sur', porcentaje: 40 },
        ],
      },
    });
    await servicio.crear(
      ctx,
      asiento([
        {
          cuentaId: 'gasto',
          debito: 2_000_000,
          credito: 0,
          repartoId: 'arriendo',
        },
        { cuentaId: 'proveedores', debito: 0, credito: 2_000_000 },
      ]),
      AUTOMATICO,
    );
    expect(lineas()).toEqual([
      { cuenta: 'gasto', centro: 'norte', debito: 1_200_000, credito: 0 },
      { cuenta: 'gasto', centro: 'sur', debito: 800_000, credito: 0 },
      { cuenta: 'proveedores', centro: null, debito: 0, credito: 2_000_000 },
    ]);
  });

  it('un reparto inactivo o que no existe se rechaza', async () => {
    const { servicio } = servicioCon({ repartos: {} });
    await expect(
      servicio.crear(
        ctx,
        asiento([
          { cuentaId: 'gasto', debito: 100, credito: 0, repartoId: 'viejo' },
          { cuentaId: 'banco', debito: 0, credito: 100 },
        ]),
      ),
    ).rejects.toThrow(/reparto/);
  });
});
