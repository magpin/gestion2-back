import type { FotoParametros, TarifaLey } from '../servicios/parametros.reglas';
import { rigeEn } from '../servicios/parametros.reglas';
import {
  aplicarConvenio,
  calcularRenta,
  type ConceptoRenta,
  type ContextoRenta,
  type PerfilBeneficiario,
  type RenglonRenta,
} from './renta.reglas';

// Especificación §14, con la foto fija de la ley sembrada en 0074.

const UVT_2026 = 52374;

const CONCEPTOS: ConceptoRenta[] = [
  {
    id: 'C',
    codigo: 'COMPRAS_GENERALES',
    nombre: 'Compras generales',
    usaAcumuladoAnual: false,
    umbralAcumuladoUvt: null,
  },
  {
    id: 'S',
    codigo: 'SERVICIOS_GENERALES',
    nombre: 'Servicios generales',
    usaAcumuladoAnual: false,
    umbralAcumuladoUvt: null,
  },
  {
    id: 'H',
    codigo: 'HONORARIOS',
    nombre: 'Honorarios',
    usaAcumuladoAnual: true,
    umbralAcumuladoUvt: 3300,
  },
];

let n = 0;
const t = (x: Partial<TarifaLey>): TarifaLey => ({
  id: `t${++n}`,
  conceptoId: 'C',
  tipoPersona: null,
  declarante: null,
  baseUvt: 0,
  tarifa: 0,
  vigenciaDesde: '2026-07-01',
  vigenciaHasta: null,
  norma: 'Decreto 572/2025',
  ...x,
});

const cuatroVigencias = (
  conceptoId: string,
  tarifa: number,
  alta: number,
  baja: number,
): TarifaLey[] => [
  t({
    conceptoId,
    tarifa,
    baseUvt: alta,
    vigenciaDesde: '2016-10-11',
    vigenciaHasta: '2025-05-31',
    norma: 'DUR 1625/2016',
  }),
  t({
    conceptoId,
    tarifa,
    baseUvt: baja,
    vigenciaDesde: '2025-06-01',
    vigenciaHasta: '2026-05-07',
    norma: 'Decreto 572/2025',
  }),
  t({
    conceptoId,
    tarifa,
    baseUvt: alta,
    vigenciaDesde: '2026-05-08',
    vigenciaHasta: '2026-06-30',
    norma: 'Suspensión provisional CE',
  }),
  t({
    conceptoId,
    tarifa,
    baseUvt: baja,
    vigenciaDesde: '2026-07-01',
    norma: 'Decreto 572/2025 restablecido',
  }),
];

const LEY: TarifaLey[] = [
  ...cuatroVigencias('C', 0.025, 27, 10).map((x) => ({
    ...x,
    declarante: true,
  })),
  ...cuatroVigencias('C', 0.035, 27, 10).map((x) => ({
    ...x,
    declarante: false,
  })),
  ...cuatroVigencias('S', 0.04, 4, 2).map((x) => ({ ...x, declarante: true })),
  ...cuatroVigencias('S', 0.06, 4, 2).map((x) => ({ ...x, declarante: false })),
  t({ conceptoId: 'H', tipoPersona: 'JURIDICA', tarifa: 0.11 }),
  t({
    conceptoId: 'H',
    tipoPersona: 'NATURAL',
    declarante: true,
    tarifa: 0.11,
  }),
  t({
    conceptoId: 'H',
    tipoPersona: 'NATURAL',
    declarante: false,
    tarifa: 0.1,
  }),
];

const foto = (fecha: string): FotoParametros => ({
  fecha,
  uvt: UVT_2026,
  tarifas: LEY.filter((x) => rigeEn(x, fecha)),
});

const PJ_DECLARANTE: PerfilBeneficiario = {
  tipoPersona: 'JURIDICA',
  regimenRenta: 'ORDINARIO',
  declaranteRenta: true,
  esAutorretenedorRenta: false,
  esGranContribuyente: false,
  esZomac: false,
  zomacTamano: null,
  desde: '2020-01-01',
};

const FACTORES: Record<string, number> = {
  MICRO: 0.5,
  PEQUENA: 0.5,
  MEDIANA: 0.75,
  GRANDE: 0.75,
};

const ctx = (
  x: Partial<ContextoRenta> & { fecha?: string } = {},
): ContextoRenta => {
  const fecha = x.fecha ?? '2026-09-25';
  return {
    fecha,
    empresaEsAgente: true,
    beneficiario: PJ_DECLARANTE,
    zomacEnFactura: false,
    foto: foto(fecha),
    conceptos: new Map(CONCEPTOS.map((c) => [c.id, c])),
    factorZomac: (tamano) => FACTORES[tamano] ?? null,
    acumulado: () => 0,
    ...x,
  };
};

const r = (concepto: string, subtotal: number, orden = 1): RenglonRenta => ({
  orden,
  subtotal,
  descuento: 0,
  conceptoCodigo: concepto,
  origen: 'PRODUCTO',
});

const valores = (res: ReturnType<typeof calcularRenta>) =>
  res.retenciones.map((x) => [x.concepto.codigo, x.valor]);

describe('Motor de renta — especificación §14', () => {
  it('T01 — compra $600.000 a PJ declarante el 2026-09-25 → 2,5 % = $15.000', () => {
    const res = calcularRenta([r('COMPRAS_GENERALES', 600_000)], ctx());
    expect(res.decision).toBe('CALCULADA');
    expect(valores(res)).toEqual([['COMPRAS_GENERALES', 15_000]]);
  });

  it('T02 — compra $500.000 (bajo 10 UVT) → sin retención', () => {
    const res = calcularRenta([r('COMPRAS_GENERALES', 500_000)], ctx());
    expect(res.decision).toBe('BAJO_BASE');
    expect(res.sinRetener[0].explicacion.texto).toMatch(/no llega a 10 UVT/);
  });

  it('T03 — la MISMA compra el 2026-06-15 → sin retención (rige la suspensión: 27 UVT)', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ fecha: '2026-06-15' }),
    );
    expect(res.decision).toBe('BAJO_BASE');
    expect(res.sinRetener[0].explicacion.cuantia_minima?.uvt).toBe(27);
  });

  it('T04 — servicio $150.000 a PN no declarante → 6 % = $9.000', () => {
    const res = calcularRenta(
      [r('SERVICIOS_GENERALES', 150_000)],
      ctx({
        beneficiario: {
          ...PJ_DECLARANTE,
          tipoPersona: 'NATURAL',
          declaranteRenta: false,
        },
      }),
    );
    expect(valores(res)).toEqual([['SERVICIOS_GENERALES', 9_000]]);
  });

  it('T05 — servicio $150.000 el 2026-05-20 → sin retención (base 4 UVT)', () => {
    const res = calcularRenta(
      [r('SERVICIOS_GENERALES', 150_000)],
      ctx({ fecha: '2026-05-20' }),
    );
    expect(res.decision).toBe('BAJO_BASE');
  });

  it('T07 — proveedor autorretenedor → sin retefuente', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ beneficiario: { ...PJ_DECLARANTE, esAutorretenedorRenta: true } }),
    );
    expect(res.decision).toBe('NO_SUJETO');
    expect(res.motivo).toMatch(/autorretenedor/);
  });

  it('T08 — gran contribuyente NO autorretenedor → sí hay retefuente', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ beneficiario: { ...PJ_DECLARANTE, esGranContribuyente: true } }),
    );
    expect(valores(res)).toEqual([['COMPRAS_GENERALES', 15_000]]);
  });

  it('T09 — ZOMAC micro 2026 en compras → 1,25 %', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 1_000_000)],
      ctx({
        zomacEnFactura: true,
        beneficiario: { ...PJ_DECLARANTE, esZomac: true, zomacTamano: 'MICRO' },
      }),
    );
    expect(res.retenciones[0].tarifaEfectiva).toBeCloseTo(0.0125);
    expect(res.retenciones[0].valor).toBe(12_500);
  });

  it('T10 — ZOMAC mediana 2026 en compras → 1,875 %', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 1_000_000)],
      ctx({
        zomacEnFactura: true,
        beneficiario: {
          ...PJ_DECLARANTE,
          esZomac: true,
          zomacTamano: 'MEDIANA',
        },
      }),
    );
    expect(res.retenciones[0].valor).toBe(18_750);
  });

  it('T11 — ZOMAC sin categoría en la factura → tarifa plena 2,5 %, y lo dice', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 1_000_000)],
      ctx({
        zomacEnFactura: false,
        beneficiario: { ...PJ_DECLARANTE, esZomac: true, zomacTamano: 'MICRO' },
      }),
    );
    expect(res.retenciones[0].valor).toBe(25_000);
    expect(res.retenciones[0].explicacion.zomac).toMatch(/tarifa plena/);
  });

  it('T12 — honorarios PN no declarante: acumulado 3.290 UVT + factura que cruza → 11 %', () => {
    const pn = {
      ...PJ_DECLARANTE,
      tipoPersona: 'NATURAL' as const,
      declaranteRenta: false,
    };
    const bajo = calcularRenta(
      [r('HONORARIOS', 1_000_000)],
      ctx({ beneficiario: pn }),
    );
    expect(bajo.retenciones[0].tarifaNominal).toBe(0.1);

    const cruza = calcularRenta(
      [r('HONORARIOS', 1_000_000)],
      ctx({ beneficiario: pn, acumulado: () => 3290 * UVT_2026 }),
    );
    expect(cruza.retenciones[0].tarifaNominal).toBe(0.11);
    expect(cruza.retenciones[0].explicacion.acumulado?.supera).toBe(true);
  });

  it('T15 — factura mixta: compras $600.000 + servicios $150.000 → dos retenciones', () => {
    const res = calcularRenta(
      [
        r('COMPRAS_GENERALES', 600_000, 1),
        r('SERVICIOS_GENERALES', 150_000, 2),
      ],
      ctx(),
    );
    expect(valores(res)).toEqual([
      ['COMPRAS_GENERALES', 15_000],
      ['SERVICIOS_GENERALES', 6_000],
    ]);
  });

  it('T18 — honorarios $100.000 (base 0 UVT) → sí retiene 11 %', () => {
    const res = calcularRenta([r('HONORARIOS', 100_000)], ctx());
    expect(valores(res)).toEqual([['HONORARIOS', 11_000]]);
  });

  it('T20 — los mismos insumos dan exactamente el mismo resultado', () => {
    const a = calcularRenta([r('COMPRAS_GENERALES', 600_000)], ctx());
    const b = calcularRenta([r('COMPRAS_GENERALES', 600_000)], ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('T21 — proveedor sin perfil → REVISION, no cálculo en cero', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ beneficiario: null }),
    );
    expect(res.decision).toBe('REVISION');
    expect(res.retenciones).toEqual([]);
  });
});

describe('Motor de renta — guardas y bordes', () => {
  it('la empresa no es agente → no retiene, y lo dice con la norma', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ empresaEsAgente: false }),
    );
    expect(res.decision).toBe('NO_SUJETO');
    expect(res.motivo).toMatch(/art\. 368/);
  });

  it('proveedor del SIMPLE → no retiene (art. 911)', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ beneficiario: { ...PJ_DECLARANTE, regimenRenta: 'SIMPLE' } }),
    );
    expect(res.motivo).toMatch(/911/);
  });

  it('varios renglones del mismo concepto se suman antes de comparar con el mínimo', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 300_000, 1), r('COMPRAS_GENERALES', 300_000, 2)],
      ctx(),
    );
    expect(res.retenciones[0].base).toBe(600_000);
    expect(res.retenciones[0].renglones).toEqual([1, 2]);
  });

  it('un concepto sin tarifa a la fecha → revisión, nunca cero', () => {
    const res = calcularRenta(
      [r('HONORARIOS', 100_000)],
      ctx({ fecha: '2026-03-01' }),
    );
    expect(res.decision).toBe('REVISION');
  });

  it('la explicación trae guardas, base, mínimo, tarifa y norma', () => {
    const e = calcularRenta([r('COMPRAS_GENERALES', 600_000)], ctx())
      .retenciones[0].explicacion;
    expect(e.guardas.map((g) => g.regla)).toEqual([
      'pagador_es_agente',
      'beneficiario_simple',
      'beneficiario_no_contribuyente',
      'beneficiario_autorretenedor',
    ]);
    expect(e.tarifa?.norma).toMatch(/572/);
    expect(e.texto).toBe(
      'Retención en la fuente · Compras generales 2,5 % sobre $600.000 = $15.000.',
    );
  });
});

describe('Motor de renta — pago con tarjeta (caso borde 6)', () => {
  it('pagada con tarjeta → la retención la practica la entidad, no la empresa', () => {
    const res = calcularRenta(
      [r('COMPRAS_GENERALES', 600_000)],
      ctx({ pagadaConTarjeta: true }),
    );
    expect(res.decision).toBe('NO_SUJETO');
    expect(res.motivo).toMatch(/tarjeta/);
  });
});

describe('honorarios de persona natural por la tabla del art. 383 (Fase 8, §8.14)', () => {
  const TABLA = [
    { desdeUvt: 0, hastaUvt: 95, tarifaMarginal: 0, uvtAdicionales: 0 },
    { desdeUvt: 95, hastaUvt: 150, tarifaMarginal: 0.19, uvtAdicionales: 0 },
    { desdeUvt: 150, hastaUvt: 360, tarifaMarginal: 0.28, uvtAdicionales: 10 },
    { desdeUvt: 360, hastaUvt: 640, tarifaMarginal: 0.33, uvtAdicionales: 69 },
    { desdeUvt: 640, hastaUvt: 945, tarifaMarginal: 0.35, uvtAdicionales: 162 },
    {
      desdeUvt: 945,
      hastaUvt: 2300,
      tarifaMarginal: 0.37,
      uvtAdicionales: 268,
    },
    {
      desdeUvt: 2300,
      hastaUvt: null,
      tarifaMarginal: 0.39,
      uvtAdicionales: 770,
    },
  ].map((f) => ({ ...f, norma: 'ET art. 383' }));
  const LEY_383 = {
    RENTA_EXENTA_TRABAJO_PORCENTAJE: 0.25,
    RENTA_EXENTA_TRABAJO_TOPE_UVT_ANUAL: 790,
    DEPURACION_TOPE_PORCENTAJE: 0.4,
    DEPURACION_TOPE_UVT_ANUAL: 1340,
  };
  const conTabla = CONCEPTOS.map((c) =>
    c.codigo === 'HONORARIOS' ? { ...c, usaTabla383: true } : c,
  );
  const pn: PerfilBeneficiario = {
    ...PJ_DECLARANTE,
    tipoPersona: 'NATURAL',
    declaranteRenta: false,
  };
  const ctx383 = (x: Partial<ContextoRenta> = {}) =>
    ctx({
      foto: { ...foto('2026-09-25'), tabla383: TABLA, ley: LEY_383 },
      conceptos: new Map(conTabla.map((c) => [c.id, c])),
      beneficiario: pn,
      ...x,
    });

  it('$10.000.000 sin aportes: 25 % exento, lo demás por la tabla', () => {
    const res = calcularRenta([r('HONORARIOS', 10_000_000)], ctx383());
    // (7.500.000 − 95 UVT) × 19 % = 479.649
    expect(res.retenciones[0].valor).toBeCloseTo(479_649, -1);
    expect(res.retenciones[0].explicacion.tabla_383?.renta_exenta).toBe(
      2_500_000,
    );
    expect(res.retenciones[0].explicacion.texto).toMatch(/art\. 383/);
  });

  it('los aportes de la planilla bajan la base', () => {
    const res = calcularRenta(
      [r('HONORARIOS', 10_000_000)],
      ctx383({ aportesSeguridadSocial: 1_140_000 }),
    );
    // (8.860.000 − 25 % − 95 UVT) × 19 % = 317.199
    expect(res.retenciones[0].valor).toBeCloseTo(317_199, -1);
  });

  it('un pago que después de la depuración no llega a 95 UVT no retiene', () => {
    const res = calcularRenta([r('HONORARIOS', 5_000_000)], ctx383());
    expect(res.decision).toBe('BAJO_BASE');
    expect(res.sinRetener[0].explicacion.texto).toMatch(/95 UVT/);
  });

  it('con dos o más trabajadores sigue con la tarifa del art. 392', () => {
    const res = calcularRenta(
      [r('HONORARIOS', 1_000_000)],
      ctx383({ beneficiario: { ...pn, contratoDosOMasTrabajadores: true } }),
    );
    expect(res.retenciones[0].tarifaNominal).toBe(0.1);
  });

  it('a una persona jurídica no se le aplica la tabla', () => {
    const res = calcularRenta(
      [r('HONORARIOS', 1_000_000)],
      ctx383({ beneficiario: PJ_DECLARANTE }),
    );
    expect(res.retenciones[0].tarifaNominal).toBe(0.11);
  });
});

describe('temporales, aseo y vigilancia sobre el AIU (Fase 8, §8.13, R-D3)', () => {
  const aseo: ConceptoRenta = {
    id: 'A',
    codigo: 'SERV_VIGILANCIA_ASEO',
    nombre: 'Servicios de vigilancia y aseo',
    usaAcumuladoAnual: false,
    umbralAcumuladoUvt: null,
    baseEsAiu: true,
  };
  const fotoAseo: FotoParametros = {
    ...foto('2026-09-25'),
    tarifas: [
      ...foto('2026-09-25').tarifas,
      t({
        conceptoId: 'A',
        tarifa: 0.02,
        baseUvt: 2,
        vigenciaDesde: '2026-07-01',
      }),
    ],
  };
  const ctxAseo = () =>
    ctx({
      foto: fotoAseo,
      conceptos: new Map([...CONCEPTOS, aseo].map((c) => [c.id, c])),
    });
  const renglon = (aiu?: number): RenglonRenta => ({
    ...r('SERV_VIGILANCIA_ASEO', 10_000_000),
    aiu,
  });

  it('con el AIU de la factura: 2 % sobre el AIU', () => {
    const res = calcularRenta([renglon(1_200_000)], ctxAseo());
    expect(res.retenciones[0].valor).toBe(24_000);
    expect(res.retenciones[0].base).toBe(1_200_000);
    expect(res.retenciones[0].explicacion.texto).toMatch(/de AIU/);
  });

  it('un AIU menor al 10 % del contrato se lleva al 10 %', () => {
    const res = calcularRenta([renglon(500_000)], ctxAseo());
    expect(res.retenciones[0].valor).toBe(20_000);
  });

  it('sin el AIU escrito, sobre el total y lo avisa', () => {
    const res = calcularRenta([renglon()], ctxAseo());
    expect(res.retenciones[0].valor).toBe(200_000);
    expect(res.retenciones[0].explicacion.texto).toMatch(/Sin el AIU/);
  });
});

describe('aplicarConvenio (Fase 8, §8.15)', () => {
  const base = calcularRenta([r('HONORARIOS', 1_000_000)], ctx())
    .retenciones[0];
  const espana = {
    pais: 'ES',
    paisNombre: 'España',
    tipoRenta: 'REGALIAS' as const,
    tarifa: 0.1,
    ley: 'Ley 1082 de 2006',
  };

  it('baja a la tarifa del convenio y lo explica', () => {
    const c = aplicarConvenio(base, espana);
    expect(c.valor).toBe(100_000);
    expect(c.explicacion.convenio?.tarifa_nacional).toBe(0.11);
    expect(c.explicacion.texto).toMatch(/convenio con España/);
  });

  it('un convenio no sube la retención', () => {
    expect(aplicarConvenio(base, { ...espana, tarifa: 0.15 })).toBe(base);
  });
});
