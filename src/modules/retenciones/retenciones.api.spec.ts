import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { RetencionesApi } from './retenciones.api';
import type { FotoParametros, TarifaLey } from './servicios/parametros.reglas';
import type { ParametrosService } from './servicios/parametros.service';
import type {
  ConceptoRetencion,
  RetencionService,
} from './servicios/retencion.service';

const ctx = { empresaId: 'e', usuarioId: 'u' } as CtxEmpresa;

const concepto = (x: Partial<ConceptoRetencion>): ConceptoRetencion => ({
  id: 'c1',
  anio: null,
  tipo: 'RENTA',
  codigo: 'COMPRAS_GENERALES',
  nombre: 'Compras generales',
  cuenta_id: 'pasivo',
  cuenta_activo_id: 'activo',
  activo: true,
  cuenta_codigo: '236540',
  cuenta_activo_codigo: '135515',
  concepto_nacional_id: 'N-COMPRAS',
  ...x,
});

const ley = (x: Partial<TarifaLey>): TarifaLey => ({
  id: 't',
  conceptoId: 'N-COMPRAS',
  tipoPersona: null,
  declarante: true,
  baseUvt: 10,
  tarifa: 0.025,
  vigenciaDesde: '2026-07-01',
  vigenciaHasta: null,
  norma: 'Decreto 572/2025',
  ...x,
});

function armar(
  c: ConceptoRetencion,
  tarifas: TarifaLey[],
  uvt: number | null = 52374,
) {
  const retenciones = {
    porId: jest.fn().mockResolvedValue(c),
    uvtDe: jest.fn().mockResolvedValue(uvt),
  } as unknown as RetencionService;
  const parametros = {
    fotoEn: jest.fn((_: CtxEmpresa, fecha: string): Promise<FotoParametros> =>
      Promise.resolve({
        fecha,
        uvt,
        tarifas,
      }),
    ),
  } as unknown as ParametrosService;
  return new RetencionesApi(
    retenciones,
    parametros,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // RecalculoService: no lo usa esta prueba.
    {} as never, // PerfilTerceroService: tampoco.
    {} as never, // AnticipoRetencionService: tampoco.
  );
}

const base = { conceptoId: 'c1', fecha: '2026-09-25', declaranteRenta: true };

describe('RetencionesApi.calcular — con la tarifa de la ley', () => {
  it('un concepto enlazado usa la tarifa de la ley a la fecha', async () => {
    const api = armar(concepto({}), [ley({})]);
    const r = await api.calcular(ctx, { ...base, base: 1_000_000 });
    expect(r).toMatchObject({
      tarifa: 2.5,
      valor: 25_000,
      cuentaId: 'pasivo',
      norma: 'Decreto 572/2025',
    });
  });

  it('debajo de la base mínima de la ley no se retiene', async () => {
    const api = armar(concepto({}), [ley({})]);
    // 10 UVT × 52.374 = 523.740
    expect(await api.calcular(ctx, { ...base, base: 500_000 })).toBeNull();
  });

  it('sin tarifa de la ley a la fecha, no calcula en cero: avisa', async () => {
    const api = armar(concepto({}), []);
    await expect(
      api.calcular(ctx, { ...base, base: 1_000_000 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('sin UVT del año, avisa', async () => {
    const api = armar(concepto({}), [ley({})], null);
    await expect(
      api.calcular(ctx, { ...base, base: 1_000_000 }),
    ).rejects.toThrow(/UVT/);
  });

  it('lo que nos retienen va al anticipo, no al pasivo', async () => {
    const api = armar(concepto({}), [ley({})]);
    const r = await api.calcular(ctx, {
      ...base,
      base: 1_000_000,
      lado: 'NOS_RETIENEN',
    });
    expect(r?.cuentaId).toBe('activo');
  });

  it('sin cuenta de pasivo (no es agente de ese impuesto) no se puede retener', async () => {
    const api = armar(concepto({ cuenta_id: null }), [ley({})]);
    await expect(
      api.calcular(ctx, { ...base, base: 1_000_000 }),
    ).rejects.toThrow(/agente/);
  });

  it('ReteIVA: el mínimo se mide sobre el subtotal y la tarifa va sobre el IVA', async () => {
    const api = armar(
      concepto({ tipo: 'IVA', concepto_nacional_id: 'N-IVA' }),
      [ley({ conceptoId: 'N-IVA', declarante: null, tarifa: 0.15 })],
    );
    const r = await api.calcular(ctx, {
      ...base,
      base: 1_000_000,
      ivaDocumento: 190_000,
    });
    expect(r).toMatchObject({ base: 190_000, valor: 28_500 });
  });
});

describe('RetencionesApi.calcular — fila cargada a mano (Fase 7)', () => {
  it('sin concepto de la ley ya no tiene tarifa: avisa', async () => {
    const vieja = concepto({ concepto_nacional_id: null, anio: 2026 });
    await expect(
      armar(vieja, []).calcular(ctx, { ...base, base: 100_000 }),
    ).rejects.toThrow(/tarifa de ley/);
  });
});
