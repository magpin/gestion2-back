/**
 * El promedio ponderado, en memoria. Sin base de datos.
 *
 * Es la regla que `secuencia-modulos.md` marca como el riesgo del módulo:
 * "recalcular el costo con cada entrada y no al cierre". Se prueba acá,
 * aislada, antes de que un servicio la use contra Postgres — los `CHECK` de
 * `0025` (`saldo_cantidad >= 0`, `valor_total = round(cantidad * costo, 2)`)
 * ya sostienen la aritmética en la base, pero disparan al COMMIT y con un
 * error genérico. Acá se anticipa, para poder señalar qué falta con un
 * mensaje que se entienda.
 *
 * No reemplaza al `CHECK`: lo anticipa. Si esto y la base discrepan, la base
 * tiene razón.
 */

/** Lo que hay de un producto ahora mismo: la última fila de su kardex, o cero. */
export interface SaldoKardex {
  cantidad: number;
  costoPromedio: number;
}

/** Una entrada siempre se puede registrar: no hay cantidad que "no quepa". */
export interface ResultadoEntrada {
  saldo: SaldoKardex;
  valorMovimiento: number;
}

/** Una salida sí se puede rechazar: dejaría la existencia negativa. */
export type ResultadoSalida =
  | { ok: true; saldo: SaldoKardex; valorMovimiento: number }
  | { ok: false; motivo: string };

/**
 * Redondea al número de decimales que la empresa configuró
 * (`decimales_cantidad`/`decimales_valor`). Nunca se compara ni se guarda el
 * valor flotante crudo: `0.1 + 0.2 !== 0.3`, y un kardex que arrastre ese
 * error se nota en la fila mil, no en la primera.
 */
export function redondear(valor: number, decimales: number): number {
  const factor = 10 ** decimales;
  return Math.round(valor * factor) / factor;
}

/**
 * El dinero de un movimiento (`valor_total`/`saldo_valor`) siempre son pesos
 * con centavos — `numeric(18,2)`, igual que `asiento.total_debito` — sin
 * importar cuántos decimales configure la empresa para el costo unitario.
 * `decimales_valor` de `empresa_configuracion_contable` redondea el COSTO
 * (útil para artículos que cuestan fracciones de peso por unidad, ej. al por
 * mayor), no el total en pesos: son dos precisiones distintas a propósito.
 */
const DECIMALES_DINERO = 2;

/**
 * Una entrada. El costo promedio se recalcula AHORA:
 *
 *   nueva_cantidad = cantidad_actual + cantidad_entrada
 *   nuevo_costo    = (cantidad_actual × costo_actual + cantidad_entrada × costo_entrada) / nueva_cantidad
 *
 * Sobre saldo cero, el resultado es exactamente el costo de la entrada — no
 * hay nada previo que promediar.
 */
export function calcularEntrada(
  actual: SaldoKardex,
  cantidadEntrada: number,
  costoUnitarioEntrada: number,
  decimalesCantidad: number,
  decimalesCosto: number,
): ResultadoEntrada {
  const nuevaCantidad = redondear(
    actual.cantidad + cantidadEntrada,
    decimalesCantidad,
  );
  const valorAcumuladoActual = actual.cantidad * actual.costoPromedio;
  const valorEntrada = cantidadEntrada * costoUnitarioEntrada;
  const nuevoCostoPromedio = redondear(
    (valorAcumuladoActual + valorEntrada) / nuevaCantidad,
    decimalesCosto,
  );

  return {
    saldo: { cantidad: nuevaCantidad, costoPromedio: nuevoCostoPromedio },
    valorMovimiento: redondear(valorEntrada, DECIMALES_DINERO),
  };
}

/**
 * Una salida. El costo promedio NO cambia — una salida consume, no valora—.
 * Se rechaza si deja el saldo negativo: la existencia no se puede vaciar más
 * de lo que tiene.
 */
export function calcularSalida(
  actual: SaldoKardex,
  cantidadSalida: number,
  decimalesCantidad: number,
): ResultadoSalida {
  const nuevaCantidad = redondear(
    actual.cantidad - cantidadSalida,
    decimalesCantidad,
  );

  if (nuevaCantidad < 0) {
    return {
      ok: false,
      motivo: `Solo hay ${actual.cantidad} en existencia; no se puede sacar ${cantidadSalida}.`,
    };
  }

  return {
    ok: true,
    saldo: { cantidad: nuevaCantidad, costoPromedio: actual.costoPromedio },
    valorMovimiento: redondear(
      cantidadSalida * actual.costoPromedio,
      DECIMALES_DINERO,
    ),
  };
}
