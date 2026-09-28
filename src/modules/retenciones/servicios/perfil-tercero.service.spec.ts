import { ConflictException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { CambioPerfil } from '../reglas/propuesta-perfil.reglas';
import { PerfilTerceroService } from './perfil-tercero.service';

jest.mock('../../../common/fecha', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../common/fecha'),
  hoyEnColombia: () => '2026-09-28',
}));

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['DIRECTOR'],
};

interface Version {
  id: string;
  desde: string;
  hasta: string | null;
  regimen_renta: 'ORDINARIO' | 'SIMPLE';
  aprobado: boolean;
}

const aSimple: CambioPerfil[] = [
  {
    campo: 'regimenRenta',
    antes: 'ORDINARIO',
    propuesto: 'SIMPLE',
    texto: 'La factura dice régimen simple.',
  },
];

/**
 * Una base de mentiras con la historia del perfil de un tercero: contesta las
 * lecturas de `aprobarPropuesta` y anota cada escritura.
 */
function escenario(versiones: Version[], propuestaDesde: string) {
  const escrituras: Array<{ sql: string; params: unknown[] }> = [];
  const fila = (v: Version) => ({
    id: v.id,
    desde: v.desde,
    hasta: v.hasta,
    regimen_renta: v.regimen_renta,
    es_responsable_iva: true,
    es_gran_contribuyente: false,
    es_autorretenedor_renta: false,
    ciiu_principal: null,
    declarante_renta: true,
    es_agente_ret_iva: false,
    es_zomac: false,
    zomac_tamano: null,
    contrato_dos_o_mas_trabajadores: false,
  });
  const vigente = versiones.find((v) => v.hasta === null)!;
  const automatica =
    !vigente.aprobado && versiones.every((v) => v.hasta === null);

  const tx = {
    // eslint-disable-next-line @typescript-eslint/require-await -- imita la firma de Tx.query
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM tercero_perfil_propuesta WHERE id = $1')) {
        return [
          {
            tercero_id: 'te-1',
            desde: propuestaDesde,
            cambios: aSimple,
            estado: 'PENDIENTE',
          },
        ];
      }
      if (sql.includes('SELECT tipo_persona FROM tercero')) {
        return [{ tipo_persona: 'JURIDICA' }];
      }
      if (sql.includes('AS automatica')) {
        return [{ ...fila(vigente), automatica }];
      }
      if (sql.includes('ORDER BY vigencia_desde')) {
        return versiones.map(fila);
      }
      escrituras.push({ sql, params });
      return [];
    }),
  } as unknown as Tx;
  const txService = {
    enContexto: <T>(_c: unknown, fn: (t: Tx) => Promise<T>, t?: Tx) =>
      fn(t ?? tx),
  } as unknown as TxService;
  return { servicio: new PerfilTerceroService(txService), escrituras };
}

const tocaLaVersion = (
  escrituras: Array<{ sql: string; params: unknown[] }>,
  id: string,
) =>
  escrituras.filter(
    (e) =>
      e.sql.includes('UPDATE tercero_perfil_tributario') && e.params[0] === id,
  );

describe('PerfilTerceroService.aprobarPropuesta — bug #5', () => {
  it('una factura anterior a la vigente entra en la historia y no pisa la vigente', async () => {
    const { servicio, escrituras } = escenario(
      [
        {
          id: 'v1',
          desde: '2026-01-01',
          hasta: '2026-06-30',
          regimen_renta: 'ORDINARIO',
          aprobado: false,
        },
        {
          id: 'v2',
          desde: '2026-07-01',
          hasta: null,
          regimen_renta: 'ORDINARIO',
          aprobado: true,
        },
      ],
      '2026-03-15',
    );

    await servicio.aprobarPropuesta(ctx, 'pr-1');

    // La vigente no se toca.
    expect(tocaLaVersion(escrituras, 'v2')).toHaveLength(0);
    // La que regía el 15 de marzo se cierra el día antes.
    const cierre = tocaLaVersion(escrituras, 'v1');
    expect(cierre).toHaveLength(1);
    expect(cierre[0].sql).toContain('SET vigencia_hasta = $2::date - 1');
    expect(cierre[0].params).toEqual(['v1', '2026-03-15']);
    // Y la nueva va del 15 de marzo al día antes de la vigente.
    const insercion = escrituras.find((e) =>
      e.sql.includes('INSERT INTO tercero_perfil_tributario'),
    );
    expect(insercion?.sql).toContain("$7::date, $8::date - 1, 'FACTURA'");
    expect(insercion?.params).toEqual([
      'v1',
      'SIMPLE',
      true,
      false,
      false,
      null,
      '2026-03-15',
      '2026-07-01',
      'u-1',
    ]);
    expect(escrituras.at(-1)?.sql).toContain("SET estado = 'APROBADA'");
  });

  it('si ya hay una versión que empieza ese día, no la reemplaza', async () => {
    const { servicio, escrituras } = escenario(
      [
        {
          id: 'v1',
          desde: '2026-01-01',
          hasta: '2026-06-30',
          regimen_renta: 'ORDINARIO',
          aprobado: false,
        },
        {
          id: 'v2',
          desde: '2026-07-01',
          hasta: null,
          regimen_renta: 'ORDINARIO',
          aprobado: true,
        },
      ],
      '2026-07-01',
    );

    await expect(servicio.aprobarPropuesta(ctx, 'pr-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(escrituras).toHaveLength(0);
  });

  it('si ese día ya regía lo que dice la factura, solo se aprueba', async () => {
    const { servicio, escrituras } = escenario(
      [
        {
          id: 'v1',
          desde: '2026-01-01',
          hasta: '2026-06-30',
          regimen_renta: 'SIMPLE',
          aprobado: true,
        },
        {
          id: 'v2',
          desde: '2026-07-01',
          hasta: null,
          regimen_renta: 'ORDINARIO',
          aprobado: true,
        },
      ],
      '2026-03-15',
    );

    await servicio.aprobarPropuesta(ctx, 'pr-1');

    expect(escrituras).toHaveLength(1);
    expect(escrituras[0].sql).toContain("SET estado = 'APROBADA'");
  });

  it('una factura posterior a la vigente abre la versión nueva desde su fecha, como siempre', async () => {
    const { servicio, escrituras } = escenario(
      [
        {
          id: 'v1',
          desde: '2026-01-01',
          hasta: null,
          regimen_renta: 'ORDINARIO',
          aprobado: true,
        },
      ],
      '2026-09-12',
    );

    await servicio.aprobarPropuesta(ctx, 'pr-1');

    const cierre = tocaLaVersion(escrituras, 'v1');
    expect(cierre).toHaveLength(1);
    expect(cierre[0].sql).toContain('SET vigencia_hasta = $2::date - 1');
    expect(cierre[0].params).toEqual(['v1', '2026-09-12']);
    const insercion = escrituras.find((e) =>
      e.sql.includes('INSERT INTO tercero_perfil_tributario'),
    );
    expect(insercion?.params).toContain('2026-09-12');
    expect(insercion?.params).toContain('SIMPLE');
  });

  it('la versión automática del alta sí se reemplaza, desde la fecha de la factura', async () => {
    const { servicio, escrituras } = escenario(
      [
        {
          id: 'v1',
          desde: '2026-09-20',
          hasta: null,
          regimen_renta: 'ORDINARIO',
          aprobado: false,
        },
      ],
      '2026-09-12',
    );

    await servicio.aprobarPropuesta(ctx, 'pr-1');

    const reemplazo = tocaLaVersion(escrituras, 'v1');
    expect(reemplazo).toHaveLength(1);
    expect(reemplazo[0].sql).toContain('SET vigencia_desde = $14::date');
    expect(reemplazo[0].params[13]).toBe('2026-09-12');
    expect(reemplazo[0].params[2]).toBe('SIMPLE');
  });
});
