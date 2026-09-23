import {
  choqueConResolucion,
  partirNumero,
  problemasDeFactura,
  repetidosEnElArchivo,
  type FacturaHistoricaEntrada,
} from './historico.reglas';

describe('partirNumero — el número de la DIAN, como se imprimió', () => {
  it.each([
    ['FE-0123', { prefijo: 'FE', consecutivo: 123 }],
    ['fe 123', { prefijo: 'FE', consecutivo: 123 }],
    ['SETT13', { prefijo: 'SETT', consecutivo: 13 }],
    ['FE1-123', { prefijo: 'FE1', consecutivo: 123 }],
    ['000456', { prefijo: null, consecutivo: 456 }],
  ])('%s', (numero, esperado) => {
    expect(partirNumero(numero)).toEqual(esperado);
  });

  it('sin consecutivo al final no hay número', () => {
    expect(partirNumero('FACTURA')).toBeNull();
    expect(partirNumero('FE-0')).toBeNull();
  });

  it('un prefijo con símbolos no es de una resolución', () => {
    expect(partirNumero('F/E 12')).toBeNull();
  });
});

describe('choqueConResolucion — un número que el sistema todavía va a usar', () => {
  const resolucion = {
    prefijo: 'SETT',
    rangoDesde: 1,
    rangoHasta: 5000,
    consecutivoActual: 14,
  };

  it('adelante del consecutivo de la resolución vigente: choca, y dice qué hacer', () => {
    const r = choqueConResolucion({ prefijo: 'SETT', consecutivo: 20 }, [
      resolucion,
    ]);
    expect(r).toContain('el sistema todavía no llegó a él (va en el 14)');
    expect(r).toContain('adelantar el consecutivo');
  });

  it('uno que el sistema ya pasó: no choca con la resolución', () => {
    // Si además está en la base, lo agarra la comprobación de números usados.
    expect(
      choqueConResolucion({ prefijo: 'SETT', consecutivo: 10 }, [resolucion]),
    ).toBeNull();
  });

  it('otro prefijo, u otro rango: no tiene nada que ver', () => {
    expect(
      choqueConResolucion({ prefijo: 'FV', consecutivo: 20 }, [resolucion]),
    ).toBeNull();
    expect(
      choqueConResolucion({ prefijo: 'SETT', consecutivo: 9000 }, [resolucion]),
    ).toBeNull();
  });
});

describe('problemasDeFactura', () => {
  const factura = (
    cambios: Partial<FacturaHistoricaEntrada> = {},
  ): FacturaHistoricaEntrada => ({
    numero: 'FV-100',
    fecha: '2026-06-15',
    clienteNit: '900746054',
    lineas: [
      {
        codigoProducto: '11111500',
        cantidad: 2,
        precioUnitario: 20_000,
        ivaTarifa: 19,
      },
    ],
    ...cambios,
  });

  it('una factura bien: nada', () => {
    expect(
      problemasDeFactura(factura({ pagado: 47_600 }), '2026-09-23'),
    ).toEqual([]);
  });

  it('fecha futura', () => {
    expect(
      problemasDeFactura(factura({ fecha: '2026-10-01' }), '2026-09-23')[0],
    ).toContain('futura');
  });

  it('tarifa de IVA que no es colombiana', () => {
    const [p] = problemasDeFactura(
      factura({
        lineas: [
          {
            codigoProducto: 'X',
            cantidad: 1,
            precioUnitario: 10,
            ivaTarifa: 16,
          },
        ],
      }),
      '2026-09-23',
    );
    expect(p).toContain('0, 5 o 19, no 16');
  });

  // 2 × 20.000 + 19 % = 47.600: no se pudo haber pagado más.
  it('pagado más de lo que vale', () => {
    expect(
      problemasDeFactura(factura({ pagado: 50_000 }), '2026-09-23')[0],
    ).toContain('la factura vale 47600');
  });
});

describe('repetidosEnElArchivo', () => {
  it('el mismo número escrito de dos formas', () => {
    const base = { fecha: '2026-06-15', clienteNit: '1', lineas: [] };
    expect(
      repetidosEnElArchivo([
        { ...base, numero: 'FV-0100' },
        { ...base, numero: 'fv100' },
        { ...base, numero: 'FV-101' },
      ]),
    ).toEqual(['FV-100']);
  });
});
