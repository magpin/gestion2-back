import type { TipoMovimientoManual } from './banco-movimiento.service';

export type Medio = 'CAJA' | 'BANCO';

/** Un extremo del traslado: de dónde sale o a dónde llega. */
export interface Extremo {
  medio: Medio;
  id: string;
  /** Solo en banco: el nombre del banco, para saber si es el mismo. */
  banco?: string;
}

/**
 * Cómo se llama el movimiento en el libro del banco según hacia dónde va la
 * plata y de dónde viene: el efectivo que llega es una consignación, lo que
 * sale para la caja es un retiro, y entre cuentas es una transferencia.
 */
export function tipoEnBanco(
  lado: 'SALIDA' | 'ENTRADA',
  otro: Medio,
): TipoMovimientoManual {
  if (lado === 'SALIDA')
    return otro === 'CAJA' ? 'RETIRO' : 'TRANSFERENCIA_SALIENTE';
  return otro === 'CAJA' ? 'CONSIGNACION' : 'TRANSFERENCIA_ENTRANTE';
}

const mismoBanco = (a?: string, b?: string) =>
  a !== undefined &&
  b !== undefined &&
  a.trim().toLocaleLowerCase('es') === b.trim().toLocaleLowerCase('es');

/**
 * Si el traslado causa 4×1000, antes de mirar si la cuenta es exenta (eso lo
 * decide `gmfDe`). Solo lo que sale de un banco; y no el traslado entre
 * cuentas del mismo titular en el mismo banco (art. 879 num. 14 ET).
 */
export function causaGmf(origen: Extremo, destino: Extremo): boolean {
  if (origen.medio !== 'BANCO') return false;
  return !(
    destino.medio === 'BANCO' && mismoBanco(origen.banco, destino.banco)
  );
}

/** Qué impide el traslado, o `null`. */
export function problemaDeTraslado(
  origen: Extremo,
  destino: Extremo,
): string | null {
  if (origen.medio === destino.medio && origen.id === destino.id) {
    return 'El origen y el destino son el mismo: el traslado no movería nada.';
  }
  return null;
}

/** Cómo se le dice al traslado si nadie escribe el detalle. */
export function nombreDelTraslado(origen: Medio, destino: Medio): string {
  if (origen === 'CAJA')
    return destino === 'BANCO'
      ? 'Consignación del efectivo'
      : 'Traslado entre cajas';
  return destino === 'CAJA'
    ? 'Retiro para la caja'
    : 'Transferencia entre cuentas propias';
}

/** «TR-000012». */
export function numeroTraslado(n: number): string {
  return `TR-${String(n).padStart(6, '0')}`;
}
