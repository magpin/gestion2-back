/**
 * Una línea del asiento de un movimiento que no es la de la caja o el banco.
 *
 * Un cobro o un pago de factura tiene una sola (Clientes o Proveedores). Un
 * movimiento por concepto puede tener más: el anticipo a un proveedor con
 * retención debita el anticipo por el bruto y acredita la retención, y la
 * caja solo pone el neto. El asiento cuadra igual; lo sostiene la base.
 */
export interface Contrapartida {
  cuentaId: string;
  debito: number;
  credito: number;
  terceroId?: string;
  conceptoId?: string;
  baseGravable?: number;
  detalle?: string;
  /** Dónde se gastó o se ganó: solo en las cuentas de resultado (4 a 7). */
  centroCostoId?: string;
  /** O repartido entre varios centros por porcentajes (fase 8). */
  repartoId?: string;
}
