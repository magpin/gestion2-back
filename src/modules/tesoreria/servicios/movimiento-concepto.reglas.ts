/**
 * Movimientos por concepto: reglas puras.
 *
 * Plan: `docs/planes/plan-integracion-menu-nuevo.md`, Fases 3 y 4.
 */

export type Direccion = 'ENTRADA' | 'SALIDA';
export type TipoConcepto = 'INGRESO' | 'COSTO' | 'GASTO' | 'NO_GASTO';

/**
 * Si un concepto de este tipo puede ir en esa dirección. Lo que entra es un
 * ingreso o un «no gasto» (un préstamo recibido, un anticipo de cliente); lo
 * que sale, un gasto, un costo o un «no gasto» (el abono a capital, el pago
 * del IVA, un anticipo a proveedor).
 */
export function problemaDeDireccion(
  tipo: TipoConcepto,
  direccion: Direccion,
): string | null {
  if (direccion === 'ENTRADA' && (tipo === 'GASTO' || tipo === 'COSTO')) {
    return 'En un gasto no entra dinero: elija un concepto de ingreso o de «no gasto».';
  }
  if (direccion === 'SALIDA' && tipo === 'INGRESO') {
    return 'En un ingreso no sale dinero: elija un concepto de gasto o de «no gasto».';
  }
  return null;
}

/**
 * Si un gasto se puede pagar sin factura ni documento soporte.
 *
 * Solo lo que por su naturaleza no lleva uno ni retención: los gastos
 * financieros (53) —el banco es autorretenedor— y los impuestos que son gasto
 * (5115). Todo lo demás —arriendos, honorarios, servicios, fletes— se paga a
 * alguien que factura o a quien hay que hacerle documento soporte, con su
 * retención: eso va por Compras. Los «no gasto» siempre pueden ir sin factura.
 */
export function admiteSinFactura(
  tipo: TipoConcepto,
  codigoCuenta: string,
): boolean {
  if (tipo === 'NO_GASTO' || tipo === 'INGRESO') return true;
  return codigoCuenta.startsWith('53') || codigoCuenta.startsWith('5115');
}

/**
 * El 4×1000 de una salida de banco: cuatro por cada mil, al peso (art. 872
 * ET). Una cuenta marcada como exenta no paga.
 */
export function gmfDe(valor: number, exenta: boolean): number {
  if (exenta || valor <= 0) return 0;
  return Math.round((valor * 4) / 1000);
}

/**
 * Cuánto de `total` es el 4×1000 cuando el impuesto sale de ese mismo valor
 * —lo asume quien recibe—: se transfiere `total - gmf` y el 4×1000 de esa
 * transferencia es `gmf`, al peso.
 */
export function gmfIncluido(total: number, exenta: boolean): number {
  if (exenta || total <= 0) return 0;
  const transferido = Math.round((total * 1000) / 1004);
  return Math.round((total - transferido) * 100) / 100;
}

/**
 * Lo que sale de la caja o del banco: lo que va al concepto menos lo que se
 * retiene. Tiene que quedar algo: una retención igual al anticipo no mueve
 * plata y no es un movimiento.
 */
export function valorMovido(
  valorConcepto: number,
  retenciones: readonly { valor: number }[],
): { ok: true; valor: number } | { ok: false; motivo: string } {
  const centavos =
    Math.round(valorConcepto * 100) -
    retenciones.reduce((t, r) => t + Math.round(r.valor * 100), 0);
  if (centavos <= 0) {
    return {
      ok: false,
      motivo: 'La retención se lleva todo el valor: no queda nada que pagar.',
    };
  }
  return { ok: true, valor: centavos / 100 };
}
