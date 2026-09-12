/**
 * El saldo corrido de una cuenta bancaria y la conciliación contra el
 * extracto. Sin base de datos.
 *
 * Los `CHECK` de `0035_bancos.sql` ya sostienen la aritmética de cada fila
 * (`valor > 0`, `fecha_hasta >= fecha_desde`, `ck_extracto_cierre`), pero
 * disparan al COMMIT con un error genérico. Acá se anticipa, para poder
 * señalar qué falta con un mensaje que se entienda — mismo principio que
 * `caja.reglas.ts`, de donde se reusa `redondear`.
 *
 * No reemplaza al `CHECK`: lo anticipa. Si esto y la base discrepan, la
 * base tiene razón.
 */

import { redondear } from './caja.reglas';

/**
 * A diferencia de `caja.reglas.calcularEgreso`, acá NO hay rechazo por
 * negativo: una cuenta bancaria puede tener sobregiro, un cajón de
 * efectivo no — ver `0035_bancos.sql`, `banco_movimiento.saldo_valor` sin
 * `CHECK (>= 0)`.
 */
export function calcularIngresoBanco(
  saldoActual: number,
  valor: number,
): number {
  return redondear(saldoActual + valor);
}

export function calcularEgresoBanco(
  saldoActual: number,
  valor: number,
): number {
  return redondear(saldoActual - valor);
}

/** Una línea de extracto, lo mínimo que hace falta para sumarla. */
export interface LineaExtractoEntrada {
  valor: number;
  tipo: 'DEBITO' | 'CREDITO';
}

/**
 * El saldo final que arrojan las líneas del extracto, partiendo del
 * saldo inicial que dice el banco. `CREDITO` suma, `DEBITO` resta — es
 * la perspectiva del banco sobre la cuenta del cliente, no la nuestra.
 */
export function calcularSaldoExtracto(
  saldoInicial: number,
  lineas: readonly LineaExtractoEntrada[],
): number {
  const suma = lineas.reduce(
    (t, l) => t + (l.tipo === 'CREDITO' ? l.valor : -l.valor),
    saldoInicial,
  );
  return redondear(suma);
}

/**
 * Un movimiento del libro que todavía no se explicó contra el extracto
 * (no está `conciliado`). `direccion` es la que ya decidió el servicio
 * según el `tipo` del movimiento — acá no se vuelve a preguntar cuáles
 * tipos son entrada o salida.
 */
export interface MovimientoPendienteEntrada {
  valor: number;
  direccion: 'ENTRADA' | 'SALIDA';
}

/**
 * El saldo que el banco DEBERÍA mostrar, partiendo del saldo del libro y
 * ajustando por lo que todavía no le llegó — la fórmula clásica de
 * conciliación bancaria. Una salida pendiente (un cheque girado, una
 * transferencia que el banco no ha procesado) ya se restó en el libro
 * pero el banco todavía no la cobra, así que SU saldo sigue más alto que
 * el nuestro por ese valor — se suma de vuelta. Una entrada pendiente
 * (una consignación en tránsito) es al revés — se resta.
 */
export function calcularSaldoBancoEsperado(
  saldoLibro: number,
  pendientes: readonly MovimientoPendienteEntrada[],
): number {
  const ajuste = pendientes.reduce(
    (t, p) => t + (p.direccion === 'SALIDA' ? p.valor : -p.valor),
    0,
  );
  return redondear(saldoLibro + ajuste);
}

export type ResultadoConciliacion =
  { ok: true } | { ok: false; motivo: string };

/**
 * Si un extracto puede cerrar como `CONCILIADO`. Dos cuentas tienen que
 * cuadrar, no una sola:
 *
 *   1. El extracto consigo mismo — sus líneas tienen que sumar al saldo
 *      final que dice el banco, partiendo del inicial.
 *   2. El libro contra el extracto — el saldo corrido de
 *      `banco_movimiento`, ajustado por lo que todavía está pendiente de
 *      conciliar, tiene que dar el mismo saldo final.
 *
 * "Conciliado" exige cuadrar las dos, no solo marcar un estado.
 */
export function verificarConciliacion(datos: {
  saldoInicialBanco: number;
  saldoFinalBanco: number;
  lineas: readonly LineaExtractoEntrada[];
  saldoLibro: number;
  pendientes: readonly MovimientoPendienteEntrada[];
}): ResultadoConciliacion {
  const saldoFinalBanco = redondear(datos.saldoFinalBanco);

  const saldoExtractoCalculado = calcularSaldoExtracto(
    datos.saldoInicialBanco,
    datos.lineas,
  );
  if (saldoExtractoCalculado !== saldoFinalBanco) {
    return {
      ok: false,
      motivo:
        `El saldo final del extracto (${saldoFinalBanco}) no cuadra con sus ` +
        `propias líneas: saldo inicial ${redondear(datos.saldoInicialBanco)} ` +
        `más lo digitado da ${saldoExtractoCalculado}.`,
    };
  }

  const saldoBancoEsperado = calcularSaldoBancoEsperado(
    datos.saldoLibro,
    datos.pendientes,
  );
  if (saldoBancoEsperado !== saldoFinalBanco) {
    return {
      ok: false,
      motivo:
        `El saldo del libro (${redondear(datos.saldoLibro)}) ajustado por ` +
        `las partidas pendientes da ${saldoBancoEsperado}, no los ` +
        `${saldoFinalBanco} que dice el extracto. Revisa los movimientos sin conciliar.`,
    };
  }

  return { ok: true };
}

/** Lo mínimo de una línea o un movimiento para poder aparearlos entre sí. */
export interface ElementoParaAparear {
  id: string;
  fecha: string;
  valor: number;
}

export interface ResultadoEmparejamiento {
  pares: Array<{ lineaId: string; movimientoId: string }>;
  lineasSinAparear: string[];
  movimientosSinAparear: string[];
}

/**
 * Aparea automáticamente por `(fecha, valor)` exacto.
 *
 * Un caso ambiguo —dos movimientos que calzan igual contra la misma
 * línea, o dos líneas contra el mismo movimiento— se deja SIN tocar de
 * los dos lados: emparejar cualquiera de los dos al azar sería inventar
 * un dato que nadie confirmó. Queda para `conciliarManual`.
 */
export function emparejarPorFechaValor(
  lineas: readonly ElementoParaAparear[],
  movimientos: readonly ElementoParaAparear[],
): ResultadoEmparejamiento {
  const clave = (fecha: string, valor: number) =>
    `${fecha}|${redondear(valor)}`;

  const agrupar = (elementos: readonly ElementoParaAparear[]) => {
    const porClave = new Map<string, ElementoParaAparear[]>();
    for (const e of elementos) {
      const k = clave(e.fecha, e.valor);
      const lista = porClave.get(k);
      if (lista) lista.push(e);
      else porClave.set(k, [e]);
    }
    return porClave;
  };

  const lineasPorClave = agrupar(lineas);
  const movimientosPorClave = agrupar(movimientos);

  const pares: Array<{ lineaId: string; movimientoId: string }> = [];
  const lineasApareadas = new Set<string>();
  const movimientosApareados = new Set<string>();

  for (const [k, lineasDeEstaClave] of lineasPorClave) {
    const movimientosDeEstaClave = movimientosPorClave.get(k) ?? [];
    // Ambiguo si de cualquiera de los dos lados hay más de uno para la
    // misma clave: no hay forma de saber cuál con cuál sin adivinar.
    if (lineasDeEstaClave.length === 1 && movimientosDeEstaClave.length === 1) {
      pares.push({
        lineaId: lineasDeEstaClave[0].id,
        movimientoId: movimientosDeEstaClave[0].id,
      });
      lineasApareadas.add(lineasDeEstaClave[0].id);
      movimientosApareados.add(movimientosDeEstaClave[0].id);
    }
  }

  return {
    pares,
    lineasSinAparear: lineas
      .filter((l) => !lineasApareadas.has(l.id))
      .map((l) => l.id),
    movimientosSinAparear: movimientos
      .filter((m) => !movimientosApareados.has(m.id))
      .map((m) => m.id),
  };
}
