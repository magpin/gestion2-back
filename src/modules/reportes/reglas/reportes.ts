import type { RolCodigo } from '../../../common/ctx';
import type { Orientacion } from '../servicios/plantilla.service';

/**
 * Qué reportes puede sacar una empresa. Sin red y sin base de datos.
 *
 * Es lo que la pantalla lee para dibujar sus tarjetas y lo que el controlador
 * mira para decidir quién puede correr cuál. **Una sola lista**: si la pantalla
 * tuviera la suya, el día que se agregue un reporte alguien va a actualizar una
 * de las dos.
 *
 * No se confunde con el catálogo de `catalogo.ts`. Ese dice **qué se puede
 * reportar** —los seis orígenes y sus columnas— y es la mitad del armador que
 * viene después. Este dice **qué reportes hay hechos**.
 */

/** Qué hay que elegir antes de correrlo. No todos piden lo mismo. */
export type Parametro = 'RANGO' | 'CORTE';

export type ClaveReporte =
  | 'VENTAS_POR_CLIENTE'
  | 'ANTIGUEDAD_CARTERA'
  | 'RETENCIONES_350'
  | 'RETEICA'
  | 'CERTIFICADOS_RETENCION';

/**
 * Las áreas, en el orden en que se muestran.
 *
 * Están las seis aunque cuatro no tengan reportes todavía: esconderlas haría
 * creer que el producto no reporta compras ni inventario. Que se vean vacías
 * dice la verdad, y dice hacia dónde va.
 */
export const AREAS = [
  'VENTAS',
  'CARTERA',
  'COMPRAS',
  'INVENTARIO',
  'TESORERIA',
  'CONTABILIDAD',
] as const;

export type Area = (typeof AREAS)[number];

export const ETIQUETA_AREA: Record<Area, string> = {
  VENTAS: 'Ventas',
  CARTERA: 'Cartera',
  COMPRAS: 'Compras',
  INVENTARIO: 'Inventario',
  TESORERIA: 'Tesorería',
  CONTABILIDAD: 'Contabilidad',
};

export interface Reporte {
  clave: ClaveReporte;
  area: Area;
  etiqueta: string;
  /** La pregunta que contesta, en las palabras de quien la haría. */
  pregunta: string;
  /** Qué trae la hoja. Lo que la tarjeta muestra sin que haya que abrirla. */
  trae: string;
  parametro: Parametro;
  /**
   * Quién puede correrlo. **Se mira al correr, no al listarlo**: la lista ya
   * viene filtrada, pero un `GET` directo con la URL tiene que rebotar igual.
   */
  roles: readonly RolCodigo[];
  formato: { orientacion: Orientacion; paginas: string; firmas: boolean };
}

export const REPORTES: Readonly<Record<ClaveReporte, Reporte>> = {
  VENTAS_POR_CLIENTE: {
    clave: 'VENTAS_POR_CLIENTE',
    area: 'VENTAS',
    etiqueta: 'Ventas del mes por cliente',
    pregunta: 'Qué vendí, a quién y cuánto me deben',
    trae: 'Resumen con gráficas, y el detalle factura por factura',
    parametro: 'RANGO',
    roles: ['DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA'],
    formato: { orientacion: 'VERTICAL', paginas: '2 páginas', firmas: true },
  },
  ANTIGUEDAD_CARTERA: {
    clave: 'ANTIGUEDAD_CARTERA',
    area: 'CARTERA',
    etiqueta: 'Antigüedad de saldos de cartera',
    pregunta: 'Quién me debe, cuánto y desde cuándo',
    trae: 'El saldo repartido en cinco rangos de vencimiento, y por cliente',
    parametro: 'CORTE',
    roles: ['DIRECTOR', 'CONTADOR', 'VENTAS', 'CAJA', 'CONSULTA'],
    formato: { orientacion: 'HORIZONTAL', paginas: '1 página', firmas: false },
  },
  // Los de retenciones (plan motor de retenciones, Fase 6): solo quien
  // responde por las declaraciones.
  RETENCIONES_350: {
    clave: 'RETENCIONES_350',
    area: 'CONTABILIDAD',
    etiqueta: 'Formulario 350 — retenciones del mes',
    pregunta: 'Cuánto retuve este mes y qué va en cada renglón',
    trae: 'Los renglones al múltiplo de mil, y el cuadre con el libro',
    parametro: 'RANGO',
    roles: ['DIRECTOR', 'CONTADOR'],
    formato: { orientacion: 'HORIZONTAL', paginas: '2 páginas', firmas: true },
  },
  RETEICA: {
    clave: 'RETEICA',
    area: 'CONTABILIDAD',
    etiqueta: 'ReteICA por municipio',
    pregunta: 'Cuánto retuve de ICA en cada municipio',
    trae: 'Lo retenido por municipio y tercero, con su periodicidad',
    parametro: 'RANGO',
    roles: ['DIRECTOR', 'CONTADOR'],
    formato: { orientacion: 'VERTICAL', paginas: '1 página', firmas: true },
  },
  CERTIFICADOS_RETENCION: {
    clave: 'CERTIFICADOS_RETENCION',
    area: 'CONTABILIDAD',
    etiqueta: 'Certificados de retención',
    pregunta: 'Qué le retuve a cada proveedor',
    trae: 'Un certificado por tercero: renta por concepto, IVA e ICA',
    parametro: 'RANGO',
    roles: ['DIRECTOR', 'CONTADOR'],
    formato: {
      orientacion: 'VERTICAL',
      paginas: '1 por tercero',
      firmas: false,
    },
  },
};

/** Los que puede correr quien pregunta. Lo que no puede ver, no se le ofrece. */
export function reportesPara(roles: readonly RolCodigo[]): Reporte[] {
  return Object.values(REPORTES).filter((r) =>
    r.roles.some((rol) => roles.includes(rol)),
  );
}

export function puedeCorrer(
  clave: ClaveReporte,
  roles: readonly RolCodigo[],
): boolean {
  return REPORTES[clave].roles.some((rol) => roles.includes(rol));
}
