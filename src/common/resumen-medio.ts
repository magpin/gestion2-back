/**
 * El resumen del mes por medio: cuánto entró o salió por cada caja y cada
 * cuenta de banco (Fase 5 de las pantallas complementarias). Lo usan Cobros
 * (recibos) y Pagos (egresos), cada uno con su consulta.
 */

/** «2026-09». */
export const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MedioDelMes {
  medio: 'CAJA' | 'BANCO';
  /** La caja o la cuenta bancaria. */
  id: string;
  /** «Caja principal», «Bancolombia». */
  nombre: string;
  /** «Efectivo», «Ahorros ···4521». */
  detalle: string;
  total: number;
  cantidad: number;
}

export interface ResumenDelMes {
  mes: string;
  total: number;
  cantidad: number;
  anulados: number;
  porMedio: MedioDelMes[];
}

/**
 * Las columnas `nombre` y `detalle` de un medio, dadas las columnas de la
 * caja y de la cuenta bancaria de la fila.
 */
export function sqlNombreMedio(
  caja: string,
  cuenta: string,
  prefijo = '',
): string {
  return `COALESCE((SELECT k.nombre FROM caja k WHERE k.id = ${caja}),
                   (SELECT b.banco FROM cuenta_bancaria b WHERE b.id = ${cuenta})) AS ${prefijo}nombre,
          COALESCE((SELECT 'Efectivo' FROM caja k WHERE k.id = ${caja}),
                   (SELECT initcap(lower(b.tipo_cuenta)) || ' ···' || right(b.numero_cuenta, 4)
                      FROM cuenta_bancaria b WHERE b.id = ${cuenta})) AS ${prefijo}detalle`;
}

/** Del resultado agrupado por medio al resumen: los medios con más plata primero. */
export function armarResumen(
  mes: string,
  filas: Array<{
    medio: 'CAJA' | 'BANCO';
    id: string;
    nombre: string | null;
    detalle: string | null;
    total: string | number | null;
    cantidad: string | number;
    anulados: string | number;
  }>,
): ResumenDelMes {
  const porMedio = filas
    .filter((f) => Number(f.cantidad) > 0)
    .map((f) => ({
      medio: f.medio,
      id: f.id,
      nombre: f.nombre ?? '',
      detalle: f.detalle ?? '',
      total: Math.round(Number(f.total ?? 0) * 100) / 100,
      cantidad: Number(f.cantidad),
    }))
    .sort((a, b) => b.total - a.total);
  return {
    mes,
    total: Math.round(porMedio.reduce((t, m) => t + m.total, 0) * 100) / 100,
    cantidad: porMedio.reduce((t, m) => t + m.cantidad, 0),
    anulados: filas.reduce((t, f) => t + Number(f.anulados), 0),
    porMedio,
  };
}
