import {
  calcularEgresoBanco,
  calcularIngresoBanco,
  calcularSaldoBancoEsperado,
  calcularSaldoExtracto,
  emparejarPorFechaValor,
  verificarConciliacion,
} from './banco.reglas';

describe('calcularIngresoBanco / calcularEgresoBanco', () => {
  it('un ingreso suma al saldo', () => {
    expect(calcularIngresoBanco(100000, 50000)).toBe(150000);
  });

  it('un egreso resta, y NO rechaza aunque deje la cuenta en negativo', () => {
    // A diferencia de caja: una cuenta bancaria puede tener sobregiro.
    expect(calcularEgresoBanco(100000, 150000)).toBe(-50000);
  });
});

describe('calcularSaldoExtracto', () => {
  it('CREDITO suma, DEBITO resta, partiendo del saldo inicial', () => {
    const saldo = calcularSaldoExtracto(1_000_000, [
      { valor: 500_000, tipo: 'CREDITO' },
      { valor: 200_000, tipo: 'DEBITO' },
    ]);
    expect(saldo).toBe(1_300_000);
  });

  it('sin líneas, el saldo final es el inicial', () => {
    expect(calcularSaldoExtracto(1_000_000, [])).toBe(1_000_000);
  });
});

describe('calcularSaldoBancoEsperado', () => {
  it('una salida pendiente se suma de vuelta: el banco todavía no la cobra', () => {
    // El cheque ya salió del libro (saldoLibro=1150000), pero el banco
    // todavía no lo procesa: su saldo sigue más alto por esos 150000.
    const saldo = calcularSaldoBancoEsperado(1_150_000, [
      { valor: 150_000, direccion: 'SALIDA' },
    ]);
    expect(saldo).toBe(1_300_000);
  });

  it('una entrada pendiente se resta: el banco todavía no la acredita', () => {
    const saldo = calcularSaldoBancoEsperado(1_300_000, [
      { valor: 100_000, direccion: 'ENTRADA' },
    ]);
    expect(saldo).toBe(1_200_000);
  });

  it('sin pendientes, el saldo esperado es el del libro tal cual', () => {
    expect(calcularSaldoBancoEsperado(1_300_000, [])).toBe(1_300_000);
  });
});

describe('verificarConciliacion', () => {
  it('concilia exacto cuando las dos cuentas cuadran', () => {
    const resultado = verificarConciliacion({
      saldoInicialBanco: 1_000_000,
      saldoFinalBanco: 1_300_000,
      lineas: [
        { valor: 500_000, tipo: 'CREDITO' },
        { valor: 200_000, tipo: 'DEBITO' },
      ],
      saldoLibro: 1_300_000,
      pendientes: [],
    });

    expect(resultado).toEqual({ ok: true });
  });

  it('rechaza si las líneas del extracto no cuadran con su propio saldo final', () => {
    const resultado = verificarConciliacion({
      saldoInicialBanco: 1_000_000,
      // Dice 1_400_000, pero las líneas solo dan 1_300_000.
      saldoFinalBanco: 1_400_000,
      lineas: [
        { valor: 500_000, tipo: 'CREDITO' },
        { valor: 200_000, tipo: 'DEBITO' },
      ],
      saldoLibro: 1_300_000,
      pendientes: [],
    });

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.motivo).toMatch(/no cuadra con sus propias líneas/);
    }
  });

  it('rechaza por un cheque no cobrado que no se marcó como pendiente', () => {
    // El libro ya restó el cheque (saldoLibro=1_150_000), pero al cerrar
    // se olvidaron de incluirlo en `pendientes` — el ajuste no compensa
    // esos 150_000 y la conciliación no cuadra.
    const resultado = verificarConciliacion({
      saldoInicialBanco: 1_000_000,
      saldoFinalBanco: 1_300_000,
      lineas: [
        { valor: 500_000, tipo: 'CREDITO' },
        { valor: 200_000, tipo: 'DEBITO' },
      ],
      saldoLibro: 1_150_000,
      pendientes: [],
    });

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.motivo).toMatch(/movimientos sin conciliar/);
    }
  });

  it('rechaza por una cuota de manejo que el banco cobró y el libro no registró', () => {
    // El extracto ya incluye la cuota (sus propias líneas cuadran), pero
    // nadie creó el banco_movimiento correspondiente: el saldo del libro
    // sigue de más, y ningún pendiente lo explica.
    const resultado = verificarConciliacion({
      saldoInicialBanco: 1_000_000,
      saldoFinalBanco: 990_000,
      lineas: [{ valor: 10_000, tipo: 'DEBITO' }],
      saldoLibro: 1_000_000,
      pendientes: [],
    });

    expect(resultado.ok).toBe(false);
    if (!resultado.ok) {
      expect(resultado.motivo).toMatch(/movimientos sin conciliar/);
    }
  });
});

describe('emparejarPorFechaValor', () => {
  it('aparea una línea con un movimiento cuando fecha y valor coinciden exacto', () => {
    const resultado = emparejarPorFechaValor(
      [{ id: 'linea-1', fecha: '2026-09-01', valor: 100_000 }],
      [{ id: 'mov-1', fecha: '2026-09-01', valor: 100_000 }],
    );

    expect(resultado.pares).toEqual([
      { lineaId: 'linea-1', movimientoId: 'mov-1' },
    ]);
    expect(resultado.lineasSinAparear).toEqual([]);
    expect(resultado.movimientosSinAparear).toEqual([]);
  });

  it('dos movimientos iguales contra la misma línea: no aparea ninguno (caso ambiguo)', () => {
    const resultado = emparejarPorFechaValor(
      [{ id: 'linea-1', fecha: '2026-09-01', valor: 100_000 }],
      [
        { id: 'mov-1', fecha: '2026-09-01', valor: 100_000 },
        { id: 'mov-2', fecha: '2026-09-01', valor: 100_000 },
      ],
    );

    expect(resultado.pares).toEqual([]);
    expect(resultado.lineasSinAparear).toEqual(['linea-1']);
    expect(resultado.movimientosSinAparear).toEqual(['mov-1', 'mov-2']);
  });

  it('deja sin aparear lo que no coincide en fecha o valor', () => {
    const resultado = emparejarPorFechaValor(
      [{ id: 'linea-1', fecha: '2026-09-01', valor: 100_000 }],
      [{ id: 'mov-1', fecha: '2026-09-02', valor: 100_000 }],
    );

    expect(resultado.pares).toEqual([]);
    expect(resultado.lineasSinAparear).toEqual(['linea-1']);
    expect(resultado.movimientosSinAparear).toEqual(['mov-1']);
  });

  it('aparea varios pares distintos en una sola pasada', () => {
    const resultado = emparejarPorFechaValor(
      [
        { id: 'linea-1', fecha: '2026-09-01', valor: 100_000 },
        { id: 'linea-2', fecha: '2026-09-02', valor: 50_000 },
      ],
      [
        { id: 'mov-1', fecha: '2026-09-01', valor: 100_000 },
        { id: 'mov-2', fecha: '2026-09-02', valor: 50_000 },
      ],
    );

    expect(resultado.pares).toHaveLength(2);
    expect(resultado.lineasSinAparear).toEqual([]);
    expect(resultado.movimientosSinAparear).toEqual([]);
  });
});
