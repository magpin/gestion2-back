import type { DefinicionConcepto } from '../../../common/contabilidad/cuentas-automaticas';

/**
 * Las cuentas que inventario usa solo: las de un producto nuevo y las de un
 * ajuste de existencias. Ver `common/contabilidad/cuentas-automaticas.ts`.
 */
export type ConceptoInventario =
  | 'INVENTARIO'
  | 'INGRESO'
  | 'COSTO_VENTA'
  | 'SOBRANTE'
  | 'FALTANTE_ASUMIDO'
  | 'FALTANTE_COBRABLE';

export type TratamientoFaltante = 'EMPRESA' | 'RESPONSABLE';

export const CONCEPTOS_INVENTARIO: Record<
  ConceptoInventario,
  DefinicionConcepto
> = {
  INVENTARIO: {
    familia: '1435',
    codigoCrear: '143501',
    nombreCuenta: 'Mercancías no fabricadas por la empresa',
    etiqueta: 'Inventario de mercancías',
    explicacion:
      'Lo que se compra para revender, mientras está en bodega. Cuenta por defecto de un producto nuevo.',
    columna: 'cuenta_inventario_id',
  },
  // La subcuenta de 4135 la eligió la empresa en el plan según su actividad
  // (413548 ferretería, por ejemplo). Si no eligió ninguna, la genérica.
  INGRESO: {
    familia: '4135',
    codigoCrear: '413595',
    nombreCuenta: 'Venta de otros productos',
    etiqueta: 'Ingreso por venta',
    explicacion:
      'Lo que se factura al vender un producto. Cuenta por defecto de un producto nuevo.',
    columna: 'cuenta_ingreso_id',
  },
  COSTO_VENTA: {
    familia: '6135',
    codigoCrear: '613595',
    nombreCuenta: 'Venta de otros productos',
    etiqueta: 'Costo de venta',
    explicacion:
      'Lo que costó la mercancía que se vendió. Cuenta por defecto de un producto nuevo.',
    columna: 'cuenta_costo_venta_id',
  },
  SOBRANTE: {
    familia: '429505',
    codigoCrear: '429505',
    nombreCuenta: 'Sobrantes de inventario',
    etiqueta: 'Sobrante de inventario',
    explicacion:
      'Unidades de más al contar la bodega: un ingreso que no se había registrado.',
    columna: 'cuenta_sobrante_id',
  },
  FALTANTE_ASUMIDO: {
    familia: '529595',
    codigoCrear: '529595',
    nombreCuenta: 'Faltantes de inventario',
    etiqueta: 'Faltante de inventario asumido por la empresa',
    explicacion: 'Merma, daño o pérdida que la empresa asume como gasto.',
    columna: 'cuenta_faltante_asumido_id',
  },
  FALTANTE_COBRABLE: {
    familia: '136530',
    codigoCrear: '136530',
    nombreCuenta: 'Faltantes por cobrar',
    etiqueta: 'Faltante de inventario cobrable al responsable',
    explicacion:
      'Mercancía que falta y paga quien respondía por ella: queda como cuenta por cobrar a esa persona.',
    exigeTercero: true,
    columna: 'cuenta_faltante_cobrable_id',
  },
};

export const ORDEN_CONCEPTOS_INVENTARIO: ConceptoInventario[] = [
  'INVENTARIO',
  'INGRESO',
  'COSTO_VENTA',
  'SOBRANTE',
  'FALTANTE_ASUMIDO',
  'FALTANTE_COBRABLE',
];

/** Qué concepto lleva un faltante: lo decide quien lo registra, no el sistema. */
export function conceptoDelFaltante(
  tratamiento: TratamientoFaltante | undefined,
): { ok: true; concepto: ConceptoInventario } | { ok: false; motivo: string } {
  if (tratamiento === undefined) {
    return {
      ok: false,
      motivo:
        'Indica si el faltante lo asume la empresa o lo paga el responsable.',
    };
  }
  return {
    ok: true,
    concepto:
      tratamiento === 'RESPONSABLE' ? 'FALTANTE_COBRABLE' : 'FALTANTE_ASUMIDO',
  };
}

/** El nombre de la subcuenta 95 del decreto en cada cuenta de ingresos y costos. */
function nombreSubcuenta95(familia: string): string {
  const resto = familia.slice(2);
  if (resto === '35') return 'Venta de otros productos';
  if (resto === '20') return 'Productos de otras industrias manufactureras';
  return 'Actividades conexas';
}

/**
 * Las cuentas de inventario de una empresa según su actividad: el ingreso y
 * el costo de un producto nuevo van a la cuenta de su actividad (4135 un
 * comercio, 4155 una empresa de servicios), con la subcuenta 95 del decreto
 * como la que se crea si falta. Sin actividad conocida, las de comercio.
 */
export function conceptosInventarioPara(
  familiaIngreso: string | null,
): Record<ConceptoInventario, DefinicionConcepto> {
  if (familiaIngreso === null || familiaIngreso === '4135') {
    return CONCEPTOS_INVENTARIO;
  }
  const familiaCosto = `61${familiaIngreso.slice(2)}`;
  return {
    ...CONCEPTOS_INVENTARIO,
    INGRESO: {
      ...CONCEPTOS_INVENTARIO.INGRESO,
      familia: familiaIngreso,
      codigoCrear: `${familiaIngreso}95`,
      nombreCuenta: nombreSubcuenta95(familiaIngreso),
    },
    COSTO_VENTA: {
      ...CONCEPTOS_INVENTARIO.COSTO_VENTA,
      familia: familiaCosto,
      codigoCrear: `${familiaCosto}95`,
      nombreCuenta: nombreSubcuenta95(familiaCosto),
    },
  };
}
