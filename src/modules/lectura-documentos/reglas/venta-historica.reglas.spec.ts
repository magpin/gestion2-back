import {
  comprobarVentaHistorica,
  validarVentasHistoricas,
  type VentaHistoricaLeida,
} from './venta-historica.reglas';

/** La FEV 13898 del escaneo de prueba: dos renglones, IVA del 19 %. */
const FEV_13898 = {
  numero: 'FEV 13898',
  fecha: '2026-09-24',
  cliente: {
    nombre: 'SOCIEDAD ANTIOQUENA DE TRANSPORTES URBANOS',
    nit: '890.905.123-4',
  },
  formaPago: 'CREDITO',
  renglones: [
    {
      codigo: 'SERV01',
      descripcion: 'MANTENIMIENTO FISICO IMPRESORA',
      cantidad: 1,
      valorUnitario: 100000,
      ivaTarifa: 19,
    },
    {
      codigo: 'TON-KY',
      descripcion: 'TONER LASER KYOCERA',
      cantidad: 2,
      valorUnitario: 235882.35,
      ivaTarifa: 19,
    },
  ],
  impreso: { subtotal: 571764.7, iva: 108635.29, total: 680399.99 },
};

describe('validarVentasHistoricas', () => {
  it('devuelve cada factura, con el NIT en dígitos y sin el de verificación aparte', () => {
    const [f] = validarVentasHistoricas({ facturas: [FEV_13898] })!;
    expect(f.numero).toBe('FEV 13898');
    expect(f.cliente.nit).toBe('8909051234');
    expect(f.formaPago).toBe('CREDITO');
    expect(f.renglones).toHaveLength(2);
  });

  it('una hoja ilegible no tumba las demás: se deja afuera la que no se parece a una factura', () => {
    const facturas = validarVentasHistoricas({
      facturas: [
        FEV_13898,
        { ...FEV_13898, numero: '' },
        { ...FEV_13898, fecha: '24/09/2026' },
        { ...FEV_13898, renglones: [] },
      ],
    })!;
    expect(facturas.map((f) => f.numero)).toEqual(['FEV 13898']);
  });

  it('una forma de pago que no es contado ni crédito queda en null: la decide una persona', () => {
    const [f] = validarVentasHistoricas({
      facturas: [{ ...FEV_13898, formaPago: 'TARJETA' }],
    })!;
    expect(f.formaPago).toBeNull();
  });

  it('le quita al número los rótulos «No.», «N°» y «#»: con ellos no se entiende', () => {
    const numeros = validarVentasHistoricas({
      facturas: [
        { ...FEV_13898, numero: 'FEV NO. 13892' },
        { ...FEV_13898, numero: 'FEV No.13893' },
        { ...FEV_13898, numero: 'N° 11385' },
        { ...FEV_13898, numero: '# 456' },
        { ...FEV_13898, numero: 'FE-0123' },
      ],
    })!.map((f) => f.numero);
    expect(numeros).toEqual([
      'FEV 13892',
      'FEV 13893',
      '11385',
      '456',
      'FE-0123',
    ]);
  });

  it('sin lista de facturas no hay lectura', () => {
    expect(validarVentasHistoricas({})).toBeNull();
    expect(validarVentasHistoricas('facturas')).toBeNull();
  });

  it('descarta el renglón sin cantidad, y conserva el resto', () => {
    const [f] = validarVentasHistoricas({
      facturas: [
        {
          ...FEV_13898,
          renglones: [
            FEV_13898.renglones[0],
            { ...FEV_13898.renglones[1], cantidad: 0 },
          ],
        },
      ],
    })!;
    expect(f.renglones).toHaveLength(1);
  });
});

describe('comprobarVentaHistorica', () => {
  const leida = (): VentaHistoricaLeida =>
    validarVentasHistoricas({ facturas: [FEV_13898] })![0];

  it('cuadra cuando los renglones dan lo impreso, con un peso de tolerancia', () => {
    expect(comprobarVentaHistorica(leida()).every((c) => c.cuadra)).toBe(true);
  });

  it('una cantidad mal leída no cuadra, y dice cuánto da y cuánto dice el papel', () => {
    const f = leida();
    f.renglones[1].cantidad = 3;
    const [subtotal] = comprobarVentaHistorica(f);
    expect(subtotal.cuadra).toBe(false);
    expect(subtotal.calculado).toBe(807647.05);
    expect(subtotal.impreso).toBe(571764.7);
  });

  it('una venta exenta con IVA impreso en cero cuadra', () => {
    const f = leida();
    f.renglones = [{ ...f.renglones[0], ivaTarifa: 0 }];
    f.impreso = { subtotal: 100000, iva: 0, total: 100000 };
    expect(comprobarVentaHistorica(f).every((c) => c.cuadra)).toBe(true);
  });

  it('sin total impreso no se da por buena', () => {
    const f = leida();
    f.impreso = { ...f.impreso, total: 0 };
    expect(comprobarVentaHistorica(f).every((c) => c.cuadra)).toBe(false);
  });
});
