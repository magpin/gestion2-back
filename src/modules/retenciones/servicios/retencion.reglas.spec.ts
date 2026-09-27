import { calcularRetencion } from './retencion.reglas';

// La UVT es un dato por año que carga un contador; acá se usa un valor
// cualquiera para que la aritmética sea verificable.
const UVT = 50000;

describe('calcularRetencion', () => {
  it('retiene base × tarifa cuando la base llega al mínimo', () => {
    // 27 UVT = 1.350.000. Una compra de 2.000.000 al 2,5%.
    expect(
      calcularRetencion({
        base: 2000000,
        tarifa: 2.5,
        baseMinimaUvt: 27,
        uvt: UVT,
      }),
    ).toEqual({ retiene: true, tarifa: 2.5, valor: 50000 });
  });

  it('no retiene si la base no llega al mínimo, y dice de cuánto era', () => {
    const r = calcularRetencion({
      base: 1000000,
      tarifa: 2.5,
      baseMinimaUvt: 27,
      uvt: UVT,
    });
    expect(r.retiene).toBe(false);
    if (r.retiene) return;
    expect(r.motivo).toContain('27 UVT');
  });

  it('sin base mínima, retiene desde el primer peso', () => {
    // Arrendamiento de muebles: 4% y sin mínimo.
    expect(
      calcularRetencion({
        base: 100000,
        tarifa: 4,
        baseMinimaUvt: 0,
        uvt: UVT,
      }),
    ).toEqual({ retiene: true, tarifa: 4, valor: 4000 });
  });

  it('redondea al peso: la DIAN no recibe centavos', () => {
    const r = calcularRetencion({
      base: 33333,
      tarifa: 2.5,
      baseMinimaUvt: 0,
      uvt: UVT,
    });
    expect(r).toEqual({ retiene: true, tarifa: 2.5, valor: 833 });
  });
});
