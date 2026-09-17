import {
  armarCorte,
  calcularEgresoBanco,
  calcularIngresoBanco,
  calcularSaldoBancoEsperado,
  calcularSaldoExtracto,
  describirCruce,
  proponerCruces,
  reconocerPorReglas,
  tokensReferencia,
  verificarConciliacion,
  verificarGrupo,
  type LineaParaCruzar,
  type MovimientoParaCruzar,
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

function linea(
  id: string,
  fecha: string,
  valor: number,
  tipo: 'DEBITO' | 'CREDITO' = 'CREDITO',
  texto = 'TRANSFERENCIA',
): LineaParaCruzar {
  return { id, fecha, valor, tipo, texto };
}

function movimiento(
  id: string,
  fecha: string,
  valor: number,
  direccion: 'ENTRADA' | 'SALIDA' = 'ENTRADA',
  referencias: string[] = [],
): MovimientoParaCruzar {
  return { id, fecha, valor, direccion, referencias };
}

describe('tokensReferencia', () => {
  it('saca los números de 4 dígitos o más, sin ceros a la izquierda', () => {
    expect(tokensReferencia('CHQ 0004512 OF 15 NIT 900123456-7')).toEqual([
      '4512',
      '900123456',
    ]);
  });

  it('un número corto no sirve para cruzar', () => {
    expect(tokensReferencia('PAGO 123 0012')).toEqual([]);
  });
});

describe('proponerCruces', () => {
  it('propone el par con el mismo valor y la misma fecha', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-01', 100_000)],
      [movimiento('m1', '2026-09-01', 100_000)],
    );

    expect(r.propuestas).toEqual([
      {
        lineaId: 'l1',
        movimientoId: 'm1',
        criterio: 'MISMA_FECHA',
        dias: 0,
        referencia: null,
      },
    ]);
    expect(r.lineasSueltas).toEqual([]);
    expect(r.movimientosSueltos).toEqual([]);
  });

  it('nunca cruza un débito del banco con una entrada del libro', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-01', 100_000, 'DEBITO')],
      [movimiento('m1', '2026-09-01', 100_000, 'ENTRADA')],
    );

    expect(r.propuestas).toEqual([]);
    expect(r.lineasSueltas).toEqual(['l1']);
    expect(r.movimientosSueltos).toEqual(['m1']);
  });

  it('un centavo de diferencia no se propone', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-01', 100_000.01)],
      [movimiento('m1', '2026-09-01', 100_000)],
    );

    expect(r.propuestas).toEqual([]);
  });

  it('dos movimientos igual de buenos: no escoge, deja la línea ambigua', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-01', 100_000)],
      [
        movimiento('m1', '2026-09-01', 100_000),
        movimiento('m2', '2026-09-01', 100_000),
      ],
    );

    expect(r.propuestas).toEqual([]);
    expect(r.ambiguas).toEqual([{ lineaId: 'l1', candidatos: ['m1', 'm2'] }]);
    expect(r.lineasSueltas).toEqual([]);
  });

  it('la referencia desempata dos movimientos del mismo valor y día', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-01', 100_000, 'CREDITO', 'TRANSF 900123456')],
      [
        movimiento('m1', '2026-09-01', 100_000, 'ENTRADA', ['800111222']),
        movimiento('m2', '2026-09-01', 100_000, 'ENTRADA', ['900123456']),
      ],
    );

    expect(r.propuestas).toHaveLength(1);
    expect(r.propuestas[0]).toMatchObject({
      movimientoId: 'm2',
      criterio: 'REFERENCIA',
      referencia: '900123456',
    });
    expect(r.movimientosSueltos).toEqual(['m1']);
  });

  it('el cheque que se cobra el mes siguiente cruza por su número', () => {
    const r = proponerCruces(
      [linea('l1', '2026-10-06', 500_000, 'DEBITO', 'PAGO CHEQUE 0004512')],
      [movimiento('m1', '2026-09-20', 500_000, 'SALIDA', ['4512'])],
    );

    expect(r.propuestas).toEqual([
      {
        lineaId: 'l1',
        movimientoId: 'm1',
        criterio: 'REFERENCIA',
        dias: 16,
        referencia: '4512',
      },
    ]);
  });

  it('sin referencia, 16 días es demasiado lejos', () => {
    const r = proponerCruces(
      [linea('l1', '2026-10-06', 500_000, 'DEBITO')],
      [movimiento('m1', '2026-09-20', 500_000, 'SALIDA')],
    );

    expect(r.propuestas).toEqual([]);
    expect(r.lineasSueltas).toEqual(['l1']);
  });

  it('el NIT con el dígito de verificación pegado cruza si el libro lo trae igual', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-03', 80_000, 'CREDITO', 'ABONO NIT9001234567')],
      [
        movimiento('m1', '2026-08-30', 80_000, 'ENTRADA', [
          '900123456',
          '9001234567',
        ]),
      ],
    );

    expect(r.propuestas[0]).toMatchObject({ criterio: 'REFERENCIA' });
  });

  it('fecha cercana: el banco lo registra 3 días después (fin de semana)', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-07', 250_000)],
      [movimiento('m1', '2026-09-04', 250_000)],
    );

    expect(r.propuestas).toEqual([
      {
        lineaId: 'l1',
        movimientoId: 'm1',
        criterio: 'FECHA_CERCANA',
        dias: 3,
        referencia: null,
      },
    ]);
  });

  it('entre dos cercanos gana el más cercano, si es el único a esa distancia', () => {
    const r = proponerCruces(
      [linea('l1', '2026-09-07', 250_000)],
      [
        movimiento('m1', '2026-09-04', 250_000),
        movimiento('m2', '2026-09-06', 250_000),
      ],
    );

    expect(r.propuestas).toHaveLength(1);
    expect(r.propuestas[0].movimientoId).toBe('m2');
  });

  it('un par propuesto desempata a otro en la vuelta siguiente', () => {
    // m1 es igual de bueno para l1 y l2 por fecha, pero l2 tiene la referencia
    // de m2... y l1 solo puede ir con m1 cuando m2 ya tiene dueño.
    const r = proponerCruces(
      [
        linea('l1', '2026-09-01', 100_000),
        linea('l2', '2026-09-01', 100_000, 'CREDITO', 'REF 77889'),
      ],
      [
        movimiento('m1', '2026-09-01', 100_000),
        movimiento('m2', '2026-09-01', 100_000, 'ENTRADA', ['77889']),
      ],
    );

    expect(r.propuestas.map((p) => [p.lineaId, p.movimientoId]).sort()).toEqual(
      [
        ['l1', 'm1'],
        ['l2', 'm2'],
      ],
    );
    expect(r.ambiguas).toEqual([]);
  });
});

describe('describirCruce', () => {
  it('dice el motivo en palabras', () => {
    expect(
      describirCruce({
        lineaId: 'l',
        movimientoId: 'm',
        criterio: 'REFERENCIA',
        dias: 16,
        referencia: '4512',
      }),
    ).toBe('Mismo valor y la referencia 4512, 16 días después');
    expect(
      describirCruce({
        lineaId: 'l',
        movimientoId: 'm',
        criterio: 'FECHA_CERCANA',
        dias: -1,
        referencia: null,
      }),
    ).toBe('Mismo valor, 1 día antes');
  });
});

describe('verificarGrupo', () => {
  it('uno contra uno con el mismo valor cuadra', () => {
    expect(
      verificarGrupo(
        [{ valor: 100_000, tipo: 'CREDITO' }],
        [{ valor: 100_000, direccion: 'ENTRADA' }],
      ),
    ).toEqual({ cuadra: true, diferencia: 0 });
  });

  it('el banco junta tres consignaciones en un renglón', () => {
    expect(
      verificarGrupo(
        [{ valor: 350_000, tipo: 'CREDITO' }],
        [
          { valor: 100_000, direccion: 'ENTRADA' },
          { valor: 200_000, direccion: 'ENTRADA' },
          { valor: 50_000, direccion: 'ENTRADA' },
        ],
      ).cuadra,
    ).toBe(true);
  });

  it('el abono llega con la comisión descontada', () => {
    expect(
      verificarGrupo(
        [{ valor: 995_000, tipo: 'CREDITO' }],
        [
          { valor: 1_000_000, direccion: 'ENTRADA' },
          { valor: 5_000, direccion: 'SALIDA' },
        ],
      ).cuadra,
    ).toBe(true);
  });

  it('el cheque cobrado por más: dice cuánto falta y hacia dónde', () => {
    expect(
      verificarGrupo(
        [{ valor: 510_000, tipo: 'DEBITO' }],
        [{ valor: 500_000, direccion: 'SALIDA' }],
      ),
    ).toEqual({ cuadra: false, diferencia: -10_000 });
  });

  it('no se deja engañar por la coma flotante', () => {
    expect(
      verificarGrupo(
        [{ valor: 0.3, tipo: 'CREDITO' }],
        [
          { valor: 0.1, direccion: 'ENTRADA' },
          { valor: 0.2, direccion: 'ENTRADA' },
        ],
      ).cuadra,
    ).toBe(true);
  });
});

describe('reconocerPorReglas', () => {
  const reglas = [
    {
      id: 'gmf',
      palabras: ['GMF', '4x1000', 'gravamen'],
      tipoLinea: 'DEBITO' as const,
    },
    {
      id: 'manejo',
      palabras: ['cuota de manejo'],
      tipoLinea: 'DEBITO' as const,
    },
  ];

  it('reconoce por palabra completa, sin mayúsculas ni tildes', () => {
    const r = reconocerPorReglas(
      [
        { id: 'l1', tipo: 'DEBITO', descripcion: 'IMPTO GOBIERNO 4X1000' },
        { id: 'l2', tipo: 'DEBITO', descripcion: 'Gravámen mov. financieros' },
        { id: 'l3', tipo: 'DEBITO', descripcion: 'CUOTA DE MANEJO TARJ' },
        { id: 'l4', tipo: 'DEBITO', descripcion: 'PAGMF PROVEEDOR' },
      ],
      reglas,
    );

    expect(r.get('gmf')).toEqual(['l1', 'l2']);
    expect(r.get('manejo')).toEqual(['l3']);
  });

  it('un crédito no cae en una regla de débitos', () => {
    const r = reconocerPorReglas(
      [{ id: 'l1', tipo: 'CREDITO', descripcion: 'REVERSO GMF' }],
      reglas,
    );

    expect(r.size).toBe(0);
  });
});

describe('verificarConciliacion con lo que se le reclama al banco', () => {
  it('una línea por reclamar explica la diferencia sin tocar el libro', () => {
    // El banco cobró dos veces una comisión de 20.000; el libro tiene una.
    const resultado = verificarConciliacion({
      saldoInicialBanco: 1_000_000,
      saldoFinalBanco: 960_000,
      lineas: [
        { valor: 20_000, tipo: 'DEBITO' },
        { valor: 20_000, tipo: 'DEBITO' },
      ],
      saldoLibro: 980_000,
      pendientes: [],
      porReclamar: [{ valor: 20_000, tipo: 'DEBITO' }],
    });

    expect(resultado).toEqual({ ok: true });
  });
});

describe('armarCorte', () => {
  it('saldo final = anterior + entradas - salidas, sin diferencia si nadie leyó el banco', () => {
    expect(armarCorte(1_000_000, 250_000.1, 100_000.2)).toEqual({
      saldoAnterior: 1_000_000,
      entradas: 250_000.1,
      salidas: 100_000.2,
      saldoFinal: 1_149_999.9,
      saldoBanco: null,
      diferencia: null,
    });
  });

  it('con el saldo del banco, la diferencia es banco menos libro', () => {
    const corte = armarCorte(500_000, 0, 20_000, 476_000);
    expect(corte.saldoFinal).toBe(480_000);
    // El 4×1000 que el banco ya cobró y el libro todavía no.
    expect(corte.diferencia).toBe(-4_000);
  });

  it('admite sobregiro', () => {
    expect(armarCorte(10_000, 0, 50_000).saldoFinal).toBe(-40_000);
  });
});
