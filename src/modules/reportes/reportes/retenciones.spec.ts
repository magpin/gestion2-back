import {
  alMil,
  armar350,
  armarCertificados,
  armarReteIca,
  cuadrar,
  esPeriodoDe,
  renglonDe,
  type Renglon350,
  type RetencionLeida,
} from './retenciones';

const renglon = (
  codigo: string,
  seccion: Renglon350['seccion'],
  orden: number,
  conceptos: string[],
  porTipoPersona = false,
): Renglon350 => ({
  codigo,
  seccion,
  orden,
  nombre: codigo,
  porTipoPersona,
  conceptos,
  casillas: porTipoPersona ? [1, 2, 3, 4] : [null, 5],
});

const RENGLONES: Renglon350[] = [
  renglon('HONORARIOS', 'RENTA', 10, ['HONORARIOS'], true),
  renglon('COMPRAS', 'RENTA', 60, ['COMPRAS_GENERALES'], true),
  renglon('AUTO_EXONERADOS', 'AUTORRETENCION', 120, [
    'AUTORRETENCION_ESPECIAL',
  ]),
  renglon('AUTO_VENTAS', 'AUTORRETENCION', 130, ['COMPRAS_GENERALES']),
  renglon('RENTA_MENOS', 'RENTA_MENOS', 140, []),
  renglon('IVA_RESPONSABLES', 'IVA', 150, ['RETEIVA_COMPRAS']),
  renglon('IVA_MENOS', 'IVA_MENOS', 170, []),
];

let n = 0;
const fila = (p: Partial<RetencionLeida>): RetencionLeida => {
  n += 1;
  return {
    id: `r-${n}`,
    anulaA: null,
    fecha: '2026-09-10',
    documentoId: `d-${n}`,
    documentoTipo: 'COMPRA',
    documento: `FV-${n}`,
    terceroId: 't-1',
    tercero: 'Proveedor Uno SAS',
    terceroDocumento: '900123456-7',
    tipoPersona: 'JURIDICA',
    impuesto: 'RENTA',
    concepto: 'COMPRAS_GENERALES',
    conceptoNombre: 'Compras generales',
    municipio: null,
    municipioNombre: null,
    base: '1000000.00',
    tarifa: '0.025000',
    valor: '25000.00',
    esAutorretencion: false,
    ...p,
  };
};

const SIN_LIBRO = { documentos: [], sueltos: [] };

describe('alMil (art. 577 ET)', () => {
  it('redondea al múltiplo de mil más cercano, en centavos', () => {
    expect(alMil(123_449_900)).toBe(123_400_000); // 1.234.499 → 1.234.000
    expect(alMil(123_450_000)).toBe(123_500_000); // 1.234.500 → 1.235.000
    expect(alMil(0)).toBe(0);
  });
});

describe('renglonDe', () => {
  it('lleva cada fila a su renglón', () => {
    expect(renglonDe(fila({ concepto: 'HONORARIOS' }), RENGLONES)?.codigo).toBe(
      'HONORARIOS',
    );
    expect(renglonDe(fila({}), RENGLONES)?.codigo).toBe('COMPRAS');
    expect(
      renglonDe(
        fila({ impuesto: 'IVA', concepto: 'RETEIVA_COMPRAS' }),
        RENGLONES,
      )?.codigo,
    ).toBe('IVA_RESPONSABLES');
  });

  it('una autorretención de compras va en autorretenciones, no en compras', () => {
    expect(renglonDe(fila({ esAutorretencion: true }), RENGLONES)?.codigo).toBe(
      'AUTO_VENTAS',
    );
    expect(
      renglonDe(
        fila({ esAutorretencion: true, concepto: 'AUTORRETENCION_ESPECIAL' }),
        RENGLONES,
      )?.codigo,
    ).toBe('AUTO_EXONERADOS');
  });

  it('una reversa va en «menos» de su impuesto', () => {
    expect(renglonDe(fila({ valor: '-10000.00' }), RENGLONES)?.codigo).toBe(
      'RENTA_MENOS',
    );
    expect(
      renglonDe(
        fila({ impuesto: 'IVA', concepto: 'RETEIVA_COMPRAS', valor: '-5.00' }),
        RENGLONES,
      )?.codigo,
    ).toBe('IVA_MENOS');
  });

  it('el ICA no va en el 350, y un concepto sin renglón devuelve null', () => {
    expect(
      renglonDe(fila({ impuesto: 'ICA', concepto: 'RETEICA' }), RENGLONES),
    ).toBeNull();
    expect(
      renglonDe(fila({ concepto: 'LOTERIAS_RIFAS' }), RENGLONES),
    ).toBeNull();
  });
});

describe('armar350', () => {
  it('separa jurídicas de naturales, redondea cada renglón y resta las reversas', () => {
    const f = armar350(
      '2026-09',
      [
        fila({ base: '1000000.00', valor: '25000.00' }),
        fila({ base: '400000.00', valor: '10000.00' }),
        fila({
          tipoPersona: 'NATURAL',
          concepto: 'HONORARIOS',
          base: '2000000.00',
          valor: '220400.00',
        }),
        fila({
          impuesto: 'IVA',
          concepto: 'RETEIVA_COMPRAS',
          base: '190000.00',
          valor: '28500.00',
        }),
        fila({ valor: '-10000.00', base: '-400000.00' }),
        fila({ impuesto: 'ICA', concepto: 'RETEICA', valor: '9660.00' }),
      ],
      RENGLONES,
      SIN_LIBRO,
    );
    const todos = f.secciones.flatMap((s) => s.renglones);
    const compras = todos.find((r) => r.codigo === 'COMPRAS');
    expect(compras?.pj?.valor).toBe('$ 35.000');
    expect(compras?.pj?.baseMil).toBe(140_000_000);
    expect(compras?.pn?.valorMil).toBe(0);
    // 220.400 al mil = 220.000.
    expect(todos.find((r) => r.codigo === 'HONORARIOS')?.pn?.valorMil).toBe(
      22_000_000,
    );
    expect(todos.find((r) => r.codigo === 'RENTA_MENOS')?.unico?.valor).toBe(
      '$ 10.000',
    );
    // 35.000 + 220.000 − 10.000 = 245.000; IVA 28.500 → 29.000 (al mil).
    expect(f.totales.renta).toBe('$ 245.000');
    expect(f.totales.iva).toBe('$ 29.000');
    expect(f.totales.total).toBe('$ 274.000');
    expect(f.totales.exacto).toBe('$ 273.900');
    // El ICA no es fila del 350.
    expect(f.filas).toBe(5);
    expect(todos.find((r) => r.codigo === 'HONORARIOS')?.casillas).toBe(
      'PJ 1 / 2 · PN 3 / 4',
    );
    expect(todos.find((r) => r.codigo === 'RENTA_MENOS')?.casillas).toBe('5');
  });

  it('la reversa de algo del mismo mes resta en su renglón, no en «Menos»', () => {
    const venta = fila({
      id: 'v-1',
      esAutorretencion: true,
      concepto: 'AUTORRETENCION_ESPECIAL',
      base: '10000000.00',
      valor: '80000.00',
    });
    const anulada = fila({
      id: 'v-2',
      anulaA: 'v-1',
      esAutorretencion: true,
      concepto: 'AUTORRETENCION_ESPECIAL',
      base: '-10000000.00',
      valor: '-80000.00',
    });
    // Y una nota de un mes anterior, anulada este mes: vuelve a su renglón
    // «Menos» en negativo, porque lo que corrige es esa nota.
    const nota = fila({
      id: 'n-1',
      anulaA: 'agosto',
      valor: '-10000.00',
      base: '-400000.00',
    });
    const vuelve = fila({
      id: 'n-2',
      anulaA: 'n-1',
      valor: '10000.00',
      base: '400000.00',
    });
    const f = armar350(
      '2026-09',
      [venta, anulada, nota, vuelve],
      RENGLONES,
      SIN_LIBRO,
    );
    const todos = f.secciones.flatMap((s) => s.renglones);
    const auto = todos.find((r) => r.codigo === 'AUTO_EXONERADOS');
    expect(auto?.unico?.valor).toBe('$ 0');
    expect(todos.find((r) => r.codigo === 'RENTA_MENOS')?.unico?.valor).toBe(
      '$ 0',
    );
    expect(f.totales.total).toBe('$ 0');
    expect(
      f.secciones.find((s) => s.titulo === 'Autorretenciones')?.porTipoPersona,
    ).toBe(false);
  });

  it('una fila sin renglón sale aparte y no suma', () => {
    const f = armar350(
      '2026-09',
      [fila({ concepto: 'LOTERIAS_RIFAS', conceptoNombre: 'Loterías' })],
      RENGLONES,
      SIN_LIBRO,
    );
    expect(f.sinRenglon).toHaveLength(1);
    expect(f.totales.total).toBe('$ 0');
  });
});

describe('cuadrar', () => {
  it('cuadra cuando el motor y el libro dicen lo mismo por documento', () => {
    const c = cuadrar([fila({ documentoId: 'c-1' })], {
      documentos: [
        {
          documentoId: 'c-1',
          documento: 'FV-1',
          anulado: false,
          origen: 'COMPRA',
          neto: '25000.00',
        },
      ],
      sueltos: [],
    });
    expect(c.cuadra).toBe(true);
    expect(c.documentos).toHaveLength(0);
  });

  it('explica la compra de antes del motor y la anulación', () => {
    const c = cuadrar(
      [
        fila({ documentoId: 'nueva', valor: '25000.00' }),
        fila({ documentoId: 'anulada', documento: 'FV-9', valor: '-15000.00' }),
      ],
      {
        documentos: [
          {
            documentoId: 'nueva',
            documento: 'FV-1',
            anulado: false,
            origen: 'COMPRA',
            neto: '25000.00',
          },
          {
            documentoId: 'vieja',
            documento: 'FV-0',
            anulado: false,
            origen: 'COMPRA',
            neto: '8000.00',
          },
        ],
        sueltos: [
          {
            numero: 'CD-1',
            fecha: '2026-09-30',
            glosa: 'Ajuste',
            neto: '100.00',
          },
        ],
      },
    );
    expect(c.cuadra).toBe(false);
    expect(c.diferencia).toBe('$ -23.000');
    expect(c.documentos.find((d) => d.documento === 'FV-0')?.razon).toMatch(
      /antes del motor/,
    );
    expect(c.documentos.find((d) => d.documento === 'FV-9')?.razon).toMatch(
      /Anulado/,
    );
    expect(c.sueltos).toHaveLength(1);
  });
});

describe('esPeriodoDe', () => {
  it('reconoce los períodos del municipio', () => {
    expect(esPeriodoDe('2026-01-01', '2026-02-28', 'BIMESTRAL')).toBe(true);
    expect(esPeriodoDe('2026-02-01', '2026-03-31', 'BIMESTRAL')).toBe(false);
    expect(esPeriodoDe('2026-09-01', '2026-09-30', 'MENSUAL')).toBe(true);
    expect(esPeriodoDe('2026-09-01', '2026-09-29', 'MENSUAL')).toBe(false);
    expect(esPeriodoDe('2026-07-01', '2026-09-30', 'TRIMESTRAL')).toBe(true);
    expect(esPeriodoDe('2026-01-01', '2026-12-31', 'ANUAL')).toBe(true);
  });
});

describe('armarReteIca', () => {
  const ica = (p: Partial<RetencionLeida>) =>
    fila({
      impuesto: 'ICA',
      concepto: 'RETEICA',
      municipio: '11001',
      municipioNombre: 'Bogotá',
      tarifa: '0.009660',
      base: '1000000.00',
      valor: '9660.00',
      ...p,
    });

  it('agrupa por municipio y tercero, neto de reversas, y avisa si el rango no es su período', () => {
    const r = armarReteIca(
      [
        ica({}),
        ica({ base: '-500000.00', valor: '-4830.00' }),
        ica({
          municipio: '05001',
          municipioNombre: 'Medellín',
          valor: '5000.00',
          tarifa: '0.005000',
        }),
      ],
      new Map([
        ['11001', 'BIMESTRAL'],
        ['05001', 'MENSUAL'],
      ]),
      { desde: '2026-09-01', hasta: '2026-09-30' },
    );
    expect(r.municipios.map((m) => m.nombre)).toEqual(['Medellín', 'Bogotá']);
    const bogota = r.municipios[1];
    expect(bogota.retenido).toBe('$ 4.830');
    expect(bogota.terceros[0].tarifas).toBe('9,66 ‰');
    expect(bogota.aviso).toMatch(/bimestral/);
    expect(r.municipios[0].aviso).toBeNull();
    expect(r.total).toBe('$ 9.830');
  });
});

describe('armarReteIca: la autorretención de la empresa (§8.9)', () => {
  it('va en su propia línea, no como retenido a un cliente', () => {
    const r = armarReteIca(
      [
        fila({
          impuesto: 'ICA',
          concepto: 'RETEICA',
          municipio: '11001',
          municipioNombre: 'Bogotá',
          terceroId: 'cliente-1',
          tercero: 'Cliente SAS',
          esAutorretencion: true,
          tarifa: '0.006900',
          base: '1000000.00',
          valor: '6900.00',
        }),
      ],
      new Map(),
      { desde: '2026-09-01', hasta: '2026-09-30' },
    );
    expect(r.municipios[0].terceros[0].tercero).toMatch(/Autorretención/);
  });
});

describe('armarCertificados', () => {
  it('uno por tercero, neto, sin autorretenciones y sin los que quedaron en cero', () => {
    const c = armarCertificados([
      fila({
        terceroId: 'a',
        tercero: 'Beta SAS',
        base: '1000000.00',
        valor: '25000.00',
      }),
      fila({
        terceroId: 'a',
        tercero: 'Beta SAS',
        base: '-400000.00',
        valor: '-10000.00',
      }),
      fila({
        terceroId: 'a',
        tercero: 'Beta SAS',
        impuesto: 'IVA',
        concepto: 'RETEIVA_COMPRAS',
        base: '190000.00',
        valor: '28500.00',
      }),
      fila({ terceroId: 'b', tercero: 'Alfa SAS', valor: '25000.00' }),
      fila({
        terceroId: 'b',
        tercero: 'Alfa SAS',
        valor: '-25000.00',
        base: '-1000000.00',
      }),
      fila({
        terceroId: 'c',
        tercero: 'Cliente',
        esAutorretencion: true,
        valor: '8000.00',
      }),
    ]);
    expect(c.certificados).toHaveLength(1);
    const beta = c.certificados[0];
    expect(beta.renta[0].retenido).toBe('$ 15.000');
    expect(beta.renta[0].base).toBe('$ 600.000');
    expect(beta.renta[0].tarifas).toBe('2,5 %');
    expect(beta.iva?.retenido).toBe('$ 28.500');
    expect(beta.totalRetenido).toBe('$ 43.500');
    expect(c.total).toBe('$ 43.500');
  });
});

describe('renglonDe: pagos al exterior con convenio (§8.15)', () => {
  it('van al renglón de países con convenio', () => {
    const conConvenio = renglon(
      'EXTERIOR_CON_CONVENIO',
      'RENTA_EXTERIOR',
      130,
      [],
      true,
    );
    const sinConvenio = renglon(
      'EXTERIOR_SIN_CONVENIO',
      'RENTA_EXTERIOR',
      120,
      ['EXT_GENERAL'],
      true,
    );
    const f = fila({ concepto: 'EXT_GENERAL' });
    expect(renglonDe(f, [sinConvenio, conConvenio])?.codigo).toBe(
      'EXTERIOR_SIN_CONVENIO',
    );
    expect(
      renglonDe({ ...f, conConvenio: true }, [sinConvenio, conConvenio])
        ?.codigo,
    ).toBe('EXTERIOR_CON_CONVENIO');
  });
});
