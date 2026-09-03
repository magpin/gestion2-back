import type { TipoRegimen } from '../../../common/ctx';

/**
 * Casilla 53 del RUT -> la condición tributaria en el vocabulario del software.
 *
 * Son la misma verdad escrita dos veces. El RUT la escribe con los códigos de la
 * DIAN, porque es el documento y así hay que poder mostrarlo si lo piden. El
 * motor de impuestos la necesita con nombre propio —`RESPONSABLE_IVA`— porque un
 * número no dice nada al leer el código que liquida una factura.
 *
 * Por eso una sola se captura: se carga el RUT, y la condición se deriva. Pedir
 * las dos a mano era pedir dos veces el mismo dato y dejar abierta la puerta a
 * que se contradigan, que es peor que no tener ninguna.
 *
 * Los códigos que no están acá no es que se ignoren: es que no cambian nada del
 * motor. El 42 (obligado a llevar contabilidad) o el 52 (facturador electrónico)
 * no deciden si una venta lleva IVA ni si hay que retener.
 */
export const CONDICION_POR_RESPONSABILIDAD_RUT: Record<number, TipoRegimen> = {
  5: 'REGIMEN_ORDINARIO',
  7: 'AGENTE_RETENEDOR_RENTA',
  // 9 es la retención de IVA propiamente; 23 es la calidad de agente retenedor
  // en ventas. Las dos terminan en la misma condición para el motor.
  9: 'AGENTE_RETENEDOR_IVA',
  13: 'GRAN_CONTRIBUYENTE',
  15: 'AUTORRETENEDOR_RENTA',
  23: 'AGENTE_RETENEDOR_IVA',
  33: 'RESPONSABLE_INC',
  47: 'REGIMEN_SIMPLE',
  48: 'RESPONSABLE_IVA',
  49: 'NO_RESPONSABLE_IVA',
  53: 'NO_RESPONSABLE_IVA',
  59: 'AUTORRETENEDOR_RENTA',
};

/**
 * El ICA no está en esta tabla a propósito: es municipal y el RUT no lo trae. La
 * calidad de agente retenedor de ICA sale del acuerdo del municipio, y en el
 * software se declara aparte.
 */

/**
 * Condiciones que no pueden estar vigentes al mismo tiempo.
 *
 * Una empresa cobra IVA o no lo cobra; declara por el ordinario o por el simple.
 * No hay estado intermedio y no hay forma de facturar bien con las dos abiertas:
 * el motor tendría que elegir una, y elegir por su cuenta un hecho tributario es
 * exactamente lo que no debe hacer.
 *
 * El índice único de la base garantiza una sola fila vigente POR TIPO, no que
 * dos tipos contrarios no coexistan. Eso lo sostiene esto.
 */
export const CONDICION_OPUESTA: Partial<Record<TipoRegimen, TipoRegimen>> = {
  RESPONSABLE_IVA: 'NO_RESPONSABLE_IVA',
  NO_RESPONSABLE_IVA: 'RESPONSABLE_IVA',
  REGIMEN_SIMPLE: 'REGIMEN_ORDINARIO',
  REGIMEN_ORDINARIO: 'REGIMEN_SIMPLE',
};

/** La condición que le corresponde a un código, o null si ese código no mueve nada. */
export function condicionDe(codigo: number): TipoRegimen | null {
  return CONDICION_POR_RESPONSABILIDAD_RUT[codigo] ?? null;
}

/**
 * Los códigos del RUT que sostienen una condición dada.
 *
 * Hace falta al cerrar: si se quita el 9 pero sigue vigente el 23, la empresa
 * sigue siendo agente de retención de IVA y su condición no se puede cerrar.
 */
export function codigosQueSostienen(condicion: TipoRegimen): number[] {
  return Object.entries(CONDICION_POR_RESPONSABILIDAD_RUT)
    .filter(([, c]) => c === condicion)
    .map(([codigo]) => Number(codigo));
}
