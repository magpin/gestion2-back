import {
  aplicarSaldo,
  armarNumero,
  lineasConValorNegativo,
  lineasSinUnaPata,
  totalesDe,
  verificarCuadre,
  type LineaCuadrable,
} from './asiento.reglas';

const debe = (valor: number): LineaCuadrable => ({ debito: valor, credito: 0 });
const acredita = (valor: number): LineaCuadrable => ({
  debito: 0,
  credito: valor,
});

describe('verificarCuadre', () => {
  it('cuadra cuando débitos y créditos suman igual', () => {
    const r = verificarCuadre([debe(500_000), acredita(500_000)]);

    expect(r.cuadra).toBe(true);
    expect(r.diferencia).toBe(0);
    expect(r.falta).toBeNull();
  });

  it('cuadra con varias líneas por lado', () => {
    // Una compra con IVA: la cuenta por pagar contra el gasto y su IVA.
    const r = verificarCuadre([
      debe(1_000_000),
      debe(190_000),
      acredita(1_190_000),
    ]);

    expect(r.cuadra).toBe(true);
    expect(r.totalDebito).toBe(1_190_000);
    expect(r.totalCredito).toBe(1_190_000);
  });

  it('dice de qué lado falta cuando el débito es mayor', () => {
    const r = verificarCuadre([debe(500_000), acredita(488_000)]);

    expect(r.cuadra).toBe(false);
    expect(r.diferencia).toBe(12_000);
    expect(r.falta).toBe('CREDITO');
  });

  it('dice de qué lado falta cuando el crédito es mayor', () => {
    const r = verificarCuadre([debe(488_000), acredita(500_000)]);

    expect(r.falta).toBe('DEBITO');
    expect(r.diferencia).toBe(12_000);
  });

  it('la diferencia siempre es positiva', () => {
    expect(verificarCuadre([debe(100), acredita(300)]).diferencia).toBe(200);
    expect(verificarCuadre([debe(300), acredita(100)]).diferencia).toBe(200);
  });

  it('un asiento sin líneas cuadra en cero', () => {
    // No es válido como asiento, pero eso lo rechaza otra regla: acá solo se
    // mide el cuadre, y cero contra cero cuadra.
    expect(verificarCuadre([]).cuadra).toBe(true);
  });

  it('no se descuadra por el error de punto flotante', () => {
    // 0.1 + 0.2 !== 0.3 en punto flotante. Sumando en pesos, este asiento
    // quedaría descuadrado por una diferencia que no existe.
    const r = verificarCuadre([debe(0.1), debe(0.2), acredita(0.3)]);

    expect(r.cuadra).toBe(true);
    expect(r.diferencia).toBe(0);
  });

  it('redondea a centavos, como el numeric(18,2) de la base', () => {
    const r = verificarCuadre([debe(10.005), acredita(10.01)]);

    // 10.005 redondea a 10.01: para la base son el mismo valor.
    expect(r.cuadra).toBe(true);
  });
});

describe('lineasSinUnaPata', () => {
  it('acepta las líneas con exactamente una pata', () => {
    expect(lineasSinUnaPata([debe(100), acredita(100)])).toEqual([]);
  });

  it('señala la línea que lleva las dos patas', () => {
    // Son dos líneas mal escritas: hacen ilegible el mayor de la cuenta.
    const lineas = [debe(100), { debito: 50, credito: 50 }, acredita(100)];

    expect(lineasSinUnaPata(lineas)).toEqual([2]);
  });

  it('señala la línea en cero', () => {
    // No aporta al asiento y ensucia el mayor.
    expect(lineasSinUnaPata([debe(100), { debito: 0, credito: 0 }])).toEqual([
      2,
    ]);
  });

  it('numera los renglones desde 1, como los ve quien digita', () => {
    const lineas = [{ debito: 0, credito: 0 }, debe(100)];

    expect(lineasSinUnaPata(lineas)).toEqual([1]);
  });

  it('señala todas las líneas malas, no solo la primera', () => {
    const lineas = [
      { debito: 0, credito: 0 },
      debe(100),
      { debito: 5, credito: 5 },
    ];

    expect(lineasSinUnaPata(lineas)).toEqual([1, 3]);
  });
});

describe('lineasConValorNegativo', () => {
  it('acepta los valores positivos', () => {
    expect(lineasConValorNegativo([debe(100), acredita(100)])).toEqual([]);
  });

  it('señala el negativo: el signo lo da la columna, no el valor', () => {
    // Un crédito escrito como débito negativo cuadraría la suma y dejaría el
    // mayor de la cuenta ilegible.
    expect(lineasConValorNegativo([debe(-100), acredita(100)])).toEqual([1]);
    expect(lineasConValorNegativo([debe(100), acredita(-100)])).toEqual([2]);
  });
});

describe('armarNumero', () => {
  it('rellena a seis dígitos', () => {
    expect(armarNumero('CD', 145)).toBe('CD-000145');
    expect(armarNumero('CI', 1)).toBe('CI-000001');
  });

  it('el relleno hace que ordene como texto', () => {
    // Sin ceros, 'CD-1000' iría antes que 'CD-999' en cualquier orden alfabético.
    const ordenados = [armarNumero('CD', 1000), armarNumero('CD', 999)].sort();

    expect(ordenados).toEqual(['CD-000999', 'CD-001000']);
  });

  it('no trunca cuando el consecutivo pasa de seis dígitos', () => {
    expect(armarNumero('CD', 1_234_567)).toBe('CD-1234567');
  });
});

describe('aplicarSaldo', () => {
  it('una cuenta de naturaleza débito aumenta por el débito', () => {
    // Caja general: entra plata, sube el saldo.
    expect(aplicarSaldo('DEBITO', 500_000, 0)).toBe(500_000);
    expect(aplicarSaldo('DEBITO', 0, 200_000)).toBe(-200_000);
  });

  it('una cuenta de naturaleza crédito aumenta por el crédito', () => {
    // Proveedores nacionales: se le debe más, sube el saldo.
    expect(aplicarSaldo('CREDITO', 0, 500_000)).toBe(500_000);
    expect(aplicarSaldo('CREDITO', 200_000, 0)).toBe(-200_000);
  });

  it('el saldo se lee sin signo invertido según la clase de cuenta', () => {
    // El mismo movimiento sube las dos: es lo que permite imprimir el balance
    // sin decidir el signo cuenta por cuenta.
    expect(aplicarSaldo('DEBITO', 100, 0)).toBeGreaterThan(0);
    expect(aplicarSaldo('CREDITO', 0, 100)).toBeGreaterThan(0);
  });

  it('no arrastra el error de punto flotante', () => {
    expect(aplicarSaldo('DEBITO', 0.3, 0.1)).toBe(0.2);
  });
});

describe('totalesDe', () => {
  it('deriva los totales de la cabecera desde las líneas', () => {
    // El servicio no los recibe del cliente: aceptarlos permitiría guardar una
    // cabecera que dice una cosa y unas líneas que dicen otra.
    expect(totalesDe([debe(100), debe(50), acredita(150)])).toEqual({
      totalDebito: 150,
      totalCredito: 150,
    });
  });
});
