import {
  comprobar,
  cuadra,
  validarFactura,
  type FacturaCompraLeida,
} from './factura-compra.reglas';

/** Una factura mínima que cuadra: un renglón de 100.000 al 19 %. */
const factura = (cambios: Partial<FacturaCompraLeida> = {}): FacturaCompraLeida => ({
  proveedor: { nombre: 'JALTECH SOLUCIONES S.A.S.', nit: '900378652' },
  numero: '215183',
  prefijo: null,
  fecha: '2026-07-28',
  renglones: [
    {
      codigo: 'P001',
      descripcion: 'TECLADO INALAMBRICO',
      clase: 'PRODUCTO',
      cuentaPuc: null,
      cantidad: 2,
      valorUnitario: 50_000,
      ivaTarifa: 19,
      total: 100_000,
    },
  ],
  impreso: { subtotal: 100_000, iva: 19_000, retencion: 0, total: 119_000 },
  ...cambios,
});

describe('comprobar — el código suma, el modelo transcribe', () => {
  it('una factura bien leída cuadra en las tres', () => {
    expect(cuadra(comprobar(factura()))).toBe(true);
  });

  // El caso que de verdad importa: es exactamente lo que pasa cuando el modelo
  // se salta un renglón de una factura de sesenta.
  it('un renglón que falta se ve en el subtotal', () => {
    const c = comprobar(
      factura({ impreso: { subtotal: 150_000, iva: 28_500, retencion: 0, total: 178_500 } }),
    );
    expect(cuadra(c)).toBe(false);
    expect(c[0]).toMatchObject({ cuadra: false, calculado: 100_000, impreso: 150_000 });
  });

  it('una cifra mal leída en un renglón se ve aunque el subtotal impreso sea el bueno', () => {
    const f = factura();
    f.renglones[0].total = 10_000;
    expect(cuadra(comprobar(f))).toBe(false);
  });

  // Los centavos de cada renglón no cierran solos: 1.131.573 al 19 % da
  // 214.998,87 y el papel imprime 214.999.
  it('tolera un peso de diferencia por el redondeo de cada renglón', () => {
    const f = factura({
      renglones: [
        {
          codigo: null,
          descripcion: 'VARIOS',
          clase: 'PRODUCTO',
          cuentaPuc: null,
          cantidad: 1,
          valorUnitario: 1_131_573,
          ivaTarifa: 19,
          total: 1_131_573,
        },
      ],
      impreso: { subtotal: 1_131_573, iva: 214_999, retencion: 0, total: 1_346_572 },
    });
    expect(cuadra(comprobar(f))).toBe(true);
  });

  it('descuenta la retención del total', () => {
    const f = factura({
      impreso: { subtotal: 100_000, iva: 19_000, retencion: 2_500, total: 116_500 },
    });
    expect(cuadra(comprobar(f))).toBe(true);
  });

  // Dar por bueno lo que no se pudo verificar es lo contrario de para qué
  // existe esto: sin total impreso no hay comprobación, y eso no es un sí.
  it('un total que el documento no imprime NO cuadra', () => {
    const f = factura({
      renglones: [],
      impreso: { subtotal: 0, iva: 0, retencion: 0, total: 0 },
    });
    expect(cuadra(comprobar(f))).toBe(false);
  });

  // Un arriendo sin IVA imprime un cero legítimo. Tratarlo como dato faltante
  // dejaba toda factura exenta en «no cuadra» para siempre.
  it('una factura sin IVA cuadra entera: el cero del IVA es un dato', () => {
    const f = factura({
      renglones: [
        {
          codigo: null,
          descripcion: 'ARRENDAMIENTO LOCAL COMERCIAL',
          clase: 'GASTO',
          cuentaPuc: null,
          cantidad: 1,
          valorUnitario: 1_500_000,
          ivaTarifa: 0,
          total: 1_500_000,
        },
      ],
      impreso: { subtotal: 1_500_000, iva: 0, retencion: 0, total: 1_500_000 },
    });
    expect(cuadra(comprobar(f))).toBe(true);
  });

  // Y la distinción al revés: un subtotal en cero sí es «el documento no lo
  // dice», porque toda factura trae subtotal y total.
  it('un subtotal en cero sigue contando como que falta', () => {
    const f = factura({
      impreso: { subtotal: 0, iva: 19_000, retencion: 0, total: 119_000 },
    });
    expect(comprobar(f)[0].cuadra).toBe(false);
  });
});

describe('validarFactura — lo que llega del modelo es dato de afuera', () => {
  it('acepta una factura bien formada', () => {
    const v = validarFactura(factura());
    expect(v?.proveedor.nit).toBe('900378652');
    expect(v?.renglones).toHaveLength(1);
  });

  it('rechaza lo que no es una factura', () => {
    expect(validarFactura(null)).toBeNull();
    expect(validarFactura('una factura')).toBeNull();
    expect(validarFactura({ proveedor: { nombre: 'X' } })).toBeNull();
  });

  it('exige la fecha en aaaa-mm-dd', () => {
    expect(validarFactura(factura({ fecha: '28/07/2026' }))).toBeNull();
  });

  it('le quita al NIT el dígito de verificación y los puntos', () => {
    const v = validarFactura(
      factura({ proveedor: { nombre: 'X S.A.S.', nit: '900.378.652-1' } }),
    );
    // Se conserva lo que haya: quitar el último dígito a ciegas rompería un NIT
    // que ya venía sin él. Quien cruza busca por prefijo.
    expect(v?.proveedor.nit).toBe('9003786521');
  });

  it('recorta la descripción a lo que admite la columna', () => {
    const f = factura();
    f.renglones[0].descripcion = 'A'.repeat(500);
    expect(validarFactura(f)?.renglones[0].descripcion).toHaveLength(200);
  });

  // Un rótulo o un subtotal intermedio que el modelo copió como si fuera un
  // renglón: sin cantidad no es un renglón.
  it('tira los renglones sin cantidad', () => {
    const f = factura();
    f.renglones[0].cantidad = 0;
    expect(validarFactura(f)?.renglones).toHaveLength(0);
  });

  it('una tarifa que no es colombiana se trata como sin IVA', () => {
    const f = factura();
    f.renglones[0].ivaTarifa = 21;
    expect(validarFactura(f)?.renglones[0].ivaTarifa).toBe(0);
  });

  it('un número que no es número vale cero y no contamina las sumas', () => {
    const f = factura();
    (f.renglones[0] as { total: unknown }).total = 'ciento';
    expect(validarFactura(f)?.renglones[0].total).toBe(0);
  });

  it('el número de la factura puede faltar, y eso no invalida la lectura', () => {
    expect(validarFactura(factura({ numero: null }))?.numero).toBeNull();
  });
});
