import { elegirCliente } from './cruce.reglas';
import {
  avisoDePrecio,
  comprobarPedido,
  validarPedido,
  type PedidoLeido,
} from './pedido-venta.reglas';

const pedido = (cambios: Partial<PedidoLeido> = {}): PedidoLeido => ({
  cliente: { nombre: 'ALMACENES CORONA S.A.S', nit: '860000123' },
  numero: 'OC-77',
  fecha: '2026-09-22',
  renglones: [
    {
      codigo: 'P001',
      descripcion: 'TECLADO',
      cantidad: 2,
      valorUnitario: 50_000,
    },
    {
      codigo: 'P002',
      descripcion: 'MOUSE',
      cantidad: 3,
      valorUnitario: 20_000,
    },
  ],
  subtotalImpreso: 160_000,
  ...cambios,
});

describe('comprobarPedido — lo único que se puede comprobar son las cantidades', () => {
  it('los renglones suman el subtotal impreso', () => {
    const [c] = comprobarPedido(pedido());
    expect(c).toMatchObject({ cuadra: true, calculado: 160_000 });
  });

  // Un renglón saltado o una cantidad mal leída se nota acá.
  it('si una cantidad está mal leída, no cuadra', () => {
    const mal = pedido();
    mal.renglones[1] = { ...mal.renglones[1], cantidad: 30 };
    expect(comprobarPedido(mal)[0].cuadra).toBe(false);
  });

  it('sin subtotal impreso no hay comprobación, y no una que «cuadra»', () => {
    expect(comprobarPedido(pedido({ subtotalImpreso: 0 }))).toEqual([]);
  });

  it('si un renglón no trae precio, tampoco', () => {
    const sinPrecio = pedido();
    sinPrecio.renglones[0] = { ...sinPrecio.renglones[0], valorUnitario: null };
    expect(comprobarPedido(sinPrecio)).toEqual([]);
  });
});

describe('avisoDePrecio — se factura a la lista, siempre', () => {
  it('distinto: lo dice, y dice a cuánto se factura', () => {
    expect(avisoDePrecio(45_000, 50_000)).toBe(
      'El pedido dice $ 45.000 y la lista, $ 50.000. Se factura a $ 50.000.',
    );
  });

  it('igual al peso: nada', () => {
    expect(avisoDePrecio(50_000.4, 50_000)).toBeNull();
  });

  it('el pedido sin precio: nada que comparar', () => {
    expect(avisoDePrecio(null, 50_000)).toBeNull();
  });
});

describe('validarPedido — lo que devuelve el modelo es un dato de afuera', () => {
  it('toma lo que sirve y recorta lo que no', () => {
    const p = validarPedido({
      cliente: { nombre: '  Almacenes   Corona ', nit: '860.000.123-4' },
      numero: 'OC-77',
      fecha: '22/09/2026',
      renglones: [
        {
          codigo: null,
          descripcion: 'TECLADO',
          cantidad: 2,
          valorUnitario: null,
        },
        { descripcion: 'SUBTOTAL', cantidad: 0, valorUnitario: 10 },
      ],
      subtotalImpreso: 0,
    });
    expect(p?.cliente).toEqual({
      nombre: 'Almacenes Corona',
      nit: '8600001234',
    });
    // Una fecha que no está en aaaa-mm-dd no se adivina: la factura es de hoy.
    expect(p?.fecha).toBeNull();
    // Un renglón sin cantidad es un rótulo, no un renglón.
    expect(p?.renglones).toEqual([
      {
        codigo: null,
        descripcion: 'TECLADO',
        cantidad: 2,
        valorUnitario: null,
      },
    ]);
  });

  it('sin cliente no es un pedido', () => {
    expect(validarPedido({ renglones: [] })).toBeNull();
  });
});

describe('elegirCliente — por NIT, y que sea cliente', () => {
  const tercero = (esCliente: boolean) => ({
    id: 't1',
    numeroDocumento: '860000123',
    nombre: 'ALMACENES CORONA S.A.S',
    esCliente,
  });

  it('por NIT, aunque venga con el dígito de verificación pegado', () => {
    const c = elegirCliente({ nombre: 'Corona', nit: '8600001234' }, [
      tercero(true),
    ]);
    expect(c.encontrado?.id).toBe('t1');
    expect(c.forma).toBe('NIT');
  });

  it('sin NIT no se elige por nombre', () => {
    const c = elegirCliente({ nombre: 'ALMACENES CORONA S.A.S', nit: null }, [
      tercero(true),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('¿Quién es el cliente?');
  });

  // La venta lo rechazaría: se dice antes.
  it('un tercero que no está marcado como cliente', () => {
    const c = elegirCliente({ nombre: 'Corona', nit: '860000123' }, [
      tercero(false),
    ]);
    expect(c.encontrado).toBeNull();
    expect(c.motivo).toContain('no figura como cliente');
  });

  it('un NIT que no está', () => {
    const c = elegirCliente({ nombre: 'Corona', nit: '999' }, []);
    expect(c.motivo).toContain('crearlo como cliente');
  });
});
