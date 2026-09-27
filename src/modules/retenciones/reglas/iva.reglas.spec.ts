import type { FotoParametros, TarifaLey } from '../servicios/parametros.reglas';
import {
  calcularIva,
  esBien,
  type BeneficiarioIva,
  type ConceptoIva,
  type ContextoIva,
  type RenglonIva,
} from './iva.reglas';

const UVT = 52374;

const CONCEPTOS: ConceptoIva[] = [
  {
    id: 'IC',
    codigo: 'RETEIVA_COMPRAS',
    nombre: 'Retención de IVA en compras',
  },
  {
    id: 'IS',
    codigo: 'RETEIVA_SERVICIOS',
    nombre: 'Retención de IVA en servicios',
  },
  {
    id: 'IX',
    codigo: 'RETEIVA_EXTERIOR',
    nombre: 'Retención de IVA en servicios del exterior',
  },
];

const t = (conceptoId: string, baseUvt: number, tarifa: number): TarifaLey => ({
  id: `t-${conceptoId}`,
  conceptoId,
  tipoPersona: null,
  declarante: null,
  baseUvt,
  tarifa,
  vigenciaDesde: '2026-07-01',
  vigenciaHasta: null,
  norma: 'ET art. 437-1',
});

const foto: FotoParametros = {
  fecha: '2026-09-25',
  uvt: UVT,
  tarifas: [t('IC', 10, 0.15), t('IS', 2, 0.15), t('IX', 0, 1)],
};

const RESPONSABLE: BeneficiarioIva = {
  esResponsableIva: true,
  esAgenteRetIva: false,
  agenteIvaNumeral: null,
  esExterior: false,
};

const ctx = (x: Partial<ContextoIva> = {}): ContextoIva => ({
  fecha: '2026-09-25',
  empresaEsAgenteIva: true,
  empresaNumeral: null,
  beneficiario: RESPONSABLE,
  pagadaConTarjeta: false,
  tarifaIvaGeneral: 0.19,
  foto,
  conceptos: CONCEPTOS,
  ...x,
});

const bien = (subtotal: number, orden = 1): RenglonIva => ({
  orden,
  subtotal,
  iva: Math.round(subtotal * 0.19),
  esBien: true,
});
const servicio = (
  subtotal: number,
  orden = 1,
  iva = Math.round(subtotal * 0.19),
): RenglonIva => ({
  orden,
  subtotal,
  iva,
  esBien: false,
});

describe('ReteIVA — especificación §14', () => {
  it('compra de bienes $1.000.000 a un responsable → 15 % del IVA ($190.000) = $28.500', () => {
    const r = calcularIva([bien(1_000_000)], ctx());
    expect(r.decision).toBe('CALCULADA');
    expect(
      r.retenciones.map((x) => [x.concepto.codigo, x.base, x.valor]),
    ).toEqual([['RETEIVA_COMPRAS', 190_000, 28_500]]);
  });

  it('T06 — proveedor del SIMPLE que factura IVA: CON ReteIVA (renta no lo mira acá)', () => {
    // El SIMPLE no es una guarda de IVA: los tres impuestos son independientes.
    const r = calcularIva([bien(1_000_000)], ctx());
    expect(r.retenciones).toHaveLength(1);
  });

  it('T13 — entre agentes de IVA de los numerales 1, 2 o 5 → sin retención', () => {
    const r = calcularIva(
      [bien(1_000_000)],
      ctx({
        empresaNumeral: 1,
        beneficiario: {
          ...RESPONSABLE,
          esAgenteRetIva: true,
          agenteIvaNumeral: 1,
        },
      }),
    );
    expect(r.decision).toBe('NO_SUJETO');
    expect(r.motivo).toMatch(/par\. 1 art\. 437-2/);
  });

  it('con un agente del numeral 9 (compras al SIMPLE) sí se retiene', () => {
    const r = calcularIva(
      [bien(1_000_000)],
      ctx({
        empresaNumeral: 1,
        beneficiario: {
          ...RESPONSABLE,
          esAgenteRetIva: true,
          agenteIvaNumeral: 9,
        },
      }),
    );
    expect(r.decision).toBe('CALCULADA');
  });

  it('T14 — servicio del exterior → la empresa asume el IVA y lo retiene al 100 %', () => {
    const r = calcularIva(
      [servicio(1_000_000, 1, 0)],
      ctx({
        beneficiario: {
          ...RESPONSABLE,
          esResponsableIva: false,
          esExterior: true,
        },
      }),
    );
    expect(r.retenciones[0]).toMatchObject({
      base: 190_000,
      valor: 190_000,
      asumida: true,
    });
    expect(r.retenciones[0].concepto.codigo).toBe('RETEIVA_EXTERIOR');
  });
});

describe('ReteIVA — guardas y bordes', () => {
  it('la empresa no es agente de IVA → no', () => {
    expect(
      calcularIva([bien(1_000_000)], ctx({ empresaEsAgenteIva: false }))
        .decision,
    ).toBe('NO_SUJETO');
  });

  it('el proveedor no es responsable de IVA → no', () => {
    const r = calcularIva(
      [bien(1_000_000)],
      ctx({ beneficiario: { ...RESPONSABLE, esResponsableIva: false } }),
    );
    expect(r.motivo).toMatch(/no es responsable de IVA/);
  });

  it('la factura sin IVA → no', () => {
    expect(calcularIva([{ ...bien(1_000_000), iva: 0 }], ctx()).motivo).toMatch(
      /no trae IVA/,
    );
  });

  it('pagada con tarjeta → retiene la entidad de la tarjeta, no la empresa', () => {
    expect(
      calcularIva([bien(1_000_000)], ctx({ pagadaConTarjeta: true })).motivo,
    ).toMatch(/tarjeta/);
  });

  it('el mínimo se mide sobre el subtotal: bienes $500.000 no llegan a 10 UVT', () => {
    const r = calcularIva([bien(500_000)], ctx());
    expect(r.decision).toBe('BAJO_BASE');
  });

  it('servicios $150.000 sí llegan a 2 UVT: 15 % de $28.500 = $4.275', () => {
    const r = calcularIva([servicio(150_000)], ctx());
    expect(r.retenciones[0]).toMatchObject({ base: 28_500, valor: 4_275 });
  });

  it('factura mixta: bienes y servicios, cada uno con su mínimo', () => {
    const r = calcularIva([bien(1_000_000, 1), servicio(150_000, 2)], ctx());
    expect(r.retenciones.map((x) => x.concepto.codigo)).toEqual([
      'RETEIVA_COMPRAS',
      'RETEIVA_SERVICIOS',
    ]);
  });

  it('un renglón sin concepto todavía no entra al cálculo', () => {
    const r = calcularIva([{ ...bien(1_000_000), esBien: null }], ctx());
    expect(r.retenciones).toEqual([]);
  });

  it('bien o servicio sale del producto o del concepto de renta', () => {
    expect(esBien('p1', null)).toBe(true);
    expect(esBien(null, 'COMBUSTIBLES')).toBe(true);
    expect(esBien(null, 'HONORARIOS')).toBe(false);
    expect(esBien(null, null)).toBeNull();
  });
});
