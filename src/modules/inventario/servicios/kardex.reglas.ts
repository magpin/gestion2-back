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
  | {
      ok: true;
      saldo: SaldoKardex;
      valorMovimiento: number;
      /**
       * Cuántas unidades salieron sin estar. `0` en una salida normal; mayor
       * que cero solo cuando se permitió el descubierto, y es lo que hay que
       * comprar para volver a cero.
       */
      faltante: number;
    }
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
 *
 * Se rechaza si deja el saldo negativo, salvo que `permitirNegativo` diga lo
 * contrario: la empresa puede habilitar el descubierto
 * (`inventario_configuracion.permite_existencia_negativa`) y quien factura
 * confirmarlo documento por documento. Cuando eso pasa, la salida sale igual y
 * `faltante` dice cuántas unidades no estaban — es lo que hay que comprar—.
 *
 * El costo de una salida en descubierto es el último promedio conocido: no hay
 * otro dato, y el servicio se encarga de rechazar el caso en que ni ese
 * existe (un producto que nunca tuvo una entrada).
 */
export function calcularSalida(
  actual: SaldoKardex,
  cantidadSalida: number,
  decimalesCantidad: number,
  permitirNegativo = false,
): ResultadoSalida {
  const nuevaCantidad = redondear(
    actual.cantidad - cantidadSalida,
    decimalesCantidad,
  );

  if (nuevaCantidad < 0 && !permitirNegativo) {
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
    faltante:
      nuevaCantidad < 0 ? redondear(-nuevaCantidad, decimalesCantidad) : 0,
  };
}

/**
 * Deshace una entrada **al costo con que entró**, no al promedio de hoy.
 *
 * Es lo que hace falta al anular una compra. Sacar esas unidades al promedio
 * vigente —como cualquier salida— deja una diferencia con la cuenta del
 * inventario: el asiento anulado se lleva el valor de la factura, y el kardex
 * se llevaba otro. Con la compra FM-101264 fueron $ 125.347,50.
 *
 * Lo que queda es lo que había sin esa entrada: la cantidad menos la que entró,
 * y el valor menos el que entró. El promedio sale de dividir los dos. Si no
 * queda nada, el promedio se conserva: no hay de qué sacarlo, y el próximo
 * costo de una salida en descubierto necesita alguno.
 */
export function calcularReversaDeEntrada(
  actual: SaldoKardex,
  cantidad: number,
  costoUnitarioOriginal: number,
  decimalesCantidad: number,
  decimalesCosto: number,
): ResultadoSalida {
  const nuevaCantidad = redondear(actual.cantidad - cantidad, decimalesCantidad);
  if (nuevaCantidad < 0) {
    return {
      ok: false,
      motivo: `Solo hay ${actual.cantidad} en existencia; no se pueden devolver ${cantidad}: parte ya salió.`,
    };
  }

  const valorMovimiento = redondear(
    cantidad * costoUnitarioOriginal,
    DECIMALES_DINERO,
  );
  const valorRestante = actual.cantidad * actual.costoPromedio - valorMovimiento;
  const costoPromedio =
    nuevaCantidad === 0
      ? actual.costoPromedio
      : // Nunca negativo: si las cuentas previas ya venían corridas, un
        // promedio negativo rompería todo lo que salga después.
        Math.max(0, redondear(valorRestante / nuevaCantidad, decimalesCosto));

  return {
    ok: true,
    saldo: { cantidad: nuevaCantidad, costoPromedio },
    valorMovimiento,
    faltante: 0,
  };
}
