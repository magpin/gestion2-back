import {
  acumuladoIcaAntes,
  calcularIca,
  municipioDeCausacion,
  periodoDe,
  type ContextoIca,
  type ParametroIca,
  type RenglonIca,
} from './ica.reglas';

const UVT = 52374;
const MEDELLIN = '05001';
const PEREIRA = '66001';

const MEDELLIN_2026: ParametroIca = {
  municipio: MEDELLIN,
  anio: 2026,
  baseMinimaUvtCompras: 15,
  baseMinimaUvtServicios: 15,
  tarifaGeneralPorMil: 2,
  usaTarifaPorActividad: false,
  acumulaEnPeriodo: true,
  periodicidad: 'BIMESTRAL',
  acuerdo: 'Acuerdo 093 de 2023',
};

const ctx = (x: Partial<ContextoIca> = {}): ContextoIca => ({
  fecha: '2026-09-25',
  uvt: UVT,
  beneficiarioSimple: false,
  perfilPagador: 'ORDINARIO',
  perfilBeneficiario: 'ORDINARIO',
  agenteEn: new Set([MEDELLIN]),
  nombreMunicipio: (c) =>
    ({ [MEDELLIN]: 'Medellín', [PEREIRA]: 'Pereira' })[c] ?? c,
  parametro: (m) => (m === MEDELLIN ? MEDELLIN_2026 : null),
  perfilProveedor: () => null,
  tarifaActividad: () => null,
  matriz: () => [],
  acumulado: () => 0,
  ...x,
});

const r = (
  subtotal: number,
  municipio: string | null = MEDELLIN,
  orden = 1,
): RenglonIca => ({
  orden,
  subtotal,
  esBien: true,
  municipio,
});

describe('ReteICA — especificación §14', () => {
  it('Medellín: compra de $1.000.000 (sobre 15 UVT) → 2 por mil = $2.000', () => {
    const res = calcularIca([r(1_000_000)], ctx());
    expect(res.retenciones.map((x) => [x.municipio, x.valor])).toEqual([
      [MEDELLIN, 2_000],
    ]);
  });

  it('T16 — Medellín: $700.000 bajo 15 UVT, pero con $900.000 acumulados del bimestre → retiene', () => {
    expect(calcularIca([r(700_000)], ctx()).retenciones).toEqual([]);
    const res = calcularIca([r(700_000)], ctx({ acumulado: () => 900_000 }));
    expect(res.retenciones[0].valor).toBe(1_400);
    expect(res.retenciones[0].explicacion.acumulado?.con_este).toBe(1_600_000);
  });

  it('T17 — un bien de un proveedor industrial se causa en su sede fabril, no en la de quien compra', () => {
    expect(
      municipioDeCausacion({
        municipioRenglon: null,
        esBien: true,
        ciiuProveedor: '1089',
        municipioProveedor: PEREIRA,
        municipioCompra: MEDELLIN,
      }),
    ).toBe(PEREIRA);
    // Un servicio del mismo proveedor, donde se presta.
    expect(
      municipioDeCausacion({
        municipioRenglon: null,
        esBien: false,
        ciiuProveedor: '1089',
        municipioProveedor: PEREIRA,
        municipioCompra: MEDELLIN,
      }),
    ).toBe(MEDELLIN);
  });
});

describe('ReteICA — varios municipios y bordes', () => {
  it('caso 9: una factura en dos municipios, cada renglón en el suyo', () => {
    const res = calcularIca(
      [r(1_000_000, MEDELLIN, 1), r(1_000_000, PEREIRA, 2)],
      ctx({ agenteEn: new Set([MEDELLIN, PEREIRA]) }),
    );
    expect(res.retenciones.map((x) => x.municipio)).toEqual([MEDELLIN]);
    // Pereira sin parámetros: no se calcula en cero, se avisa.
    expect(res.avisos[0]).toMatch(
      /No tengo los parámetros de ReteICA de Pereira/,
    );
  });

  it('donde la empresa no es agente, no retiene', () => {
    const res = calcularIca([r(1_000_000, PEREIRA)], ctx());
    expect(res.decision).toBe('NO_SUJETO');
  });

  it('la empresa no es agente en ningún municipio → no', () => {
    expect(
      calcularIca([r(1_000_000)], ctx({ agenteEn: new Set() })).decision,
    ).toBe('NO_SUJETO');
  });

  it('proveedor del SIMPLE → no (el ICA va integrado)', () => {
    expect(
      calcularIca([r(1_000_000)], ctx({ beneficiarioSimple: true })).motivo,
    ).toMatch(/SIMPLE/);
  });

  it('proveedor autorretenedor de ICA o no contribuyente allí → no', () => {
    const autor = calcularIca(
      [r(1_000_000)],
      ctx({
        perfilProveedor: () => ({
          regimen: 'COMUN',
          esAutorretenedor: true,
          codigoActividad: null,
        }),
      }),
    );
    expect(autor.sinRetener[0].texto).toMatch(/autorretenedor/);
    const noContrib = calcularIca(
      [r(1_000_000)],
      ctx({
        perfilProveedor: () => ({
          regimen: 'NO_CONTRIBUYENTE',
          esAutorretenedor: false,
          codigoActividad: null,
        }),
      }),
    );
    expect(noContrib.retenciones).toEqual([]);
  });

  it('la matriz municipal manda: no se le retiene a un gran contribuyente, salvo la entidad pública', () => {
    const matriz = () => [
      {
        perfilPagador: 'ORDINARIO',
        perfilBeneficiario: 'GRAN_CONTRIBUYENTE_DIAN',
        retiene: false,
        fundamento: 'Acuerdo X',
      },
      {
        perfilPagador: 'ENTIDAD_PUBLICA',
        perfilBeneficiario: 'GRAN_CONTRIBUYENTE_DIAN',
        retiene: true,
        fundamento: 'Acuerdo X',
      },
    ];
    expect(
      calcularIca(
        [r(1_000_000)],
        ctx({ matriz, perfilBeneficiario: 'GRAN_CONTRIBUYENTE_DIAN' }),
      ).retenciones,
    ).toEqual([]);
    expect(
      calcularIca(
        [r(1_000_000)],
        ctx({
          matriz,
          perfilPagador: 'ENTIDAD_PUBLICA',
          perfilBeneficiario: 'GRAN_CONTRIBUYENTE_DIAN',
        }),
      ).retenciones,
    ).toHaveLength(1);
  });

  it('con tarifa por actividad: la del proveedor; sin ella, la general', () => {
    const porActividad = { ...MEDELLIN_2026, usaTarifaPorActividad: true };
    const res = calcularIca(
      [r(1_000_000)],
      ctx({
        parametro: () => porActividad,
        perfilProveedor: () => ({
          regimen: 'COMUN',
          esAutorretenedor: false,
          codigoActividad: '4711',
        }),
        tarifaActividad: (_m, a) => (a === '4711' ? 7 : null),
      }),
    );
    expect(res.retenciones[0]).toMatchObject({ tarifaPorMil: 7, valor: 7_000 });
    expect(
      calcularIca([r(1_000_000)], ctx({ parametro: () => porActividad }))
        .retenciones[0].tarifaPorMil,
    ).toBe(2);
  });

  it('lo que no se retuvo también se acumula en el período', () => {
    const res = calcularIca([r(300_000)], ctx());
    expect(res.acumular).toEqual([
      { municipio: MEDELLIN, base: 300_000, retenido: 0 },
    ]);
  });

  it('el período sale de la periodicidad del municipio', () => {
    expect(periodoDe('2026-09-25', 'BIMESTRAL')).toBe(5);
    expect(periodoDe('2026-09-25', 'MENSUAL')).toBe(9);
    expect(periodoDe('2026-09-25', 'ANUAL')).toBe(1);
  });
});

describe('Recálculo de ReteICA en un municipio que acumula — bug 3', () => {
  // Una compra de $500.000 en Medellín, sola en el bimestre: no llega a 15 UVT
  // ($785.610) y no retiene. Al confirmarla, su aporte entra al acumulado.
  const compra = [r(500_000)];
  const acumuladoHoy = new Map([[MEDELLIN, 500_000]]);

  it('así estaba: el recálculo leía el acumulado de hoy, que ya trae la compra, y retenía', () => {
    const res = calcularIca(
      compra,
      ctx({ acumulado: (m) => acumuladoHoy.get(m) ?? 0 }),
    );
    expect(res.retenciones.map((x) => x.valor)).toEqual([1_000]);
    expect(res.retenciones[0].explicacion.acumulado?.con_este).toBe(1_000_000);
  });

  it('con el acumulado de antes de la compra, recalcular da lo mismo que al confirmar', () => {
    const alConfirmar = calcularIca(compra, ctx());
    const alRecalcular = calcularIca(
      compra,
      ctx({
        acumulado: (m) => acumuladoIcaAntes({ [MEDELLIN]: 0 }, acumuladoHoy, m),
      }),
    );
    expect(alConfirmar.retenciones).toEqual([]);
    expect(alRecalcular.retenciones).toEqual([]);
    expect(alRecalcular.acumular).toEqual(alConfirmar.acumular);
  });

  it('acumuladoIcaAntes: lo guardado manda; sin dato de ese municipio, el de hoy', () => {
    expect(
      acumuladoIcaAntes({ [MEDELLIN]: 300_000 }, acumuladoHoy, MEDELLIN),
    ).toBe(300_000);
    expect(acumuladoIcaAntes({}, acumuladoHoy, MEDELLIN)).toBe(500_000);
    expect(acumuladoIcaAntes(undefined, acumuladoHoy, MEDELLIN)).toBe(500_000);
    expect(acumuladoIcaAntes(undefined, acumuladoHoy, PEREIRA)).toBe(0);
  });
});
