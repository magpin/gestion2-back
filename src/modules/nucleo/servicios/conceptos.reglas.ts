/**
 * Conceptos de ingreso y egreso: lo que la persona elige en vez de una cuenta.
 *
 * Reglas puras. Lo que toca la base está en `conceptos.service.ts`.
 * Plan: `docs/planes/plan-integracion-menu-nuevo.md`, Fase 2.
 */

export type TipoConcepto = 'INGRESO' | 'COSTO' | 'GASTO' | 'NO_GASTO';
export type TipoFlujo = 'OPERACION' | 'INVERSION' | 'FINANCIACION';

export const TIPOS_CONCEPTO: TipoConcepto[] = [
  'INGRESO',
  'COSTO',
  'GASTO',
  'NO_GASTO',
];
export const TIPOS_FLUJO: TipoFlujo[] = [
  'OPERACION',
  'INVERSION',
  'FINANCIACION',
];

/**
 * A qué clases del PUC puede ir cada tipo. Es lo que impide un «gasto» que en
 * realidad mueve una cuenta de balance, o un «no gasto» que toca el resultado.
 */
const CLASES: Record<TipoConcepto, string[]> = {
  INGRESO: ['4'],
  GASTO: ['5'],
  COSTO: ['6', '7'],
  NO_GASTO: ['1', '2', '3'],
};

const NOMBRE_TIPO: Record<TipoConcepto, string> = {
  INGRESO: 'ingreso',
  GASTO: 'gasto',
  COSTO: 'costo',
  NO_GASTO: '«no gasto»',
};

/**
 * Por qué una cuenta no le sirve a un concepto, o `null` si sirve. La cuenta
 * tiene que recibir asientos (auxiliar) y ser de la clase del tipo.
 */
export function problemaDeCuenta(
  tipo: TipoConcepto,
  cuenta: { codigo: string; esAuxiliar: boolean },
): string | null {
  if (!cuenta.esAuxiliar) {
    return `La cuenta ${cuenta.codigo} agrupa: el concepto va a uno de sus auxiliares.`;
  }
  if (!CLASES[tipo].includes(cuenta.codigo[0])) {
    return `Un concepto de ${NOMBRE_TIPO[tipo]} va a una cuenta de clase ${CLASES[tipo].join(' o ')}; la ${cuenta.codigo} es de clase ${cuenta.codigo[0]}.`;
  }
  return null;
}

/**
 * Si toca el estado de resultados. Un «no gasto» mueve plata sin ser ingreso
 * ni gasto: el abono a capital, el pago del IVA, el anticipo.
 */
export function afectaResultado(tipo: TipoConcepto): boolean {
  return tipo !== 'NO_GASTO';
}

/**
 * Operacional o no, leído de la cuenta y no guardado aparte: 41, 51, 52 y 61
 * son de la operación; 42 y 53, no. Así no puede contradecir a la cuenta.
 * `null` para lo que no va al resultado.
 */
export function esOperacional(codigoCuenta: string): boolean | null {
  const grupo = codigoCuenta.slice(0, 2);
  if (['41', '51', '52', '61', '62', '71', '72', '73', '74'].includes(grupo))
    return true;
  if (['42', '53', '54'].includes(grupo)) return false;
  return null;
}

/** El código de un concepto propio: `PROPIO-` y el nombre en mayúsculas sin tildes. */
export function codigoPropio(nombre: string, existentes: Set<string>): string {
  const base =
    'PROPIO-' +
    nombre
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
  let codigo = base.length > 'PROPIO-'.length ? base : 'PROPIO-CONCEPTO';
  for (let n = 2; existentes.has(codigo); n++) {
    codigo = `${base.slice(0, 36)}-${n}`;
  }
  return codigo;
}

export interface ConceptoInicial {
  codigo: string;
  tipo: TipoConcepto;
  grupo: string;
  nombre: string;
  /** El auxiliar del Decreto 2650 al que va. Si la empresa no lo tiene, se crea. */
  cuenta: string;
  /** Nombre con que se crea la cuenta, si hay que crearla. */
  nombreCuenta: string;
  /** La cuenta que se crea pide tercero: lo que se le debe a alguien o alguien debe. */
  exigeTercero?: boolean;
  tipoFlujo?: TipoFlujo;
  automatico?: boolean;
  pistas?: string[];
}

/**
 * El catálogo con que arranca cada empresa comercial.
 *
 * Corregido por Claude contra el Decreto 2650 el 28-09-2026 (decisión D12 del
 * plan): se usa ya, **pendiente de ratificar Yeris**. Cada código se verificó
 * contra `cuenta_puc`; los que el decreto deja libres (`250505`, `510568`,
 * `422595`) cuelgan de su cuenta de cuatro dígitos.
 *
 * Fuera a propósito:
 *   · Sobrantes y faltantes: los resuelven solos el arqueo de caja y el ajuste
 *     de inventario (`caja.reglas.ts`, cuentas automáticas de inventario).
 *   · El pago de retención en la fuente: 2365 se abre por concepto, y la
 *     declaración 350 se paga desde su reporte, no eligiendo un concepto.
 *   · Costos: el de la mercancía lo calcula el kardex al vender.
 */
export const CONCEPTOS_INICIALES: ConceptoInicial[] = [
  // ── Ingresos ─────────────────────────────────────────────────────────────
  {
    codigo: 'ING-SERVICIOS',
    tipo: 'INGRESO',
    grupo: 'Servicios',
    nombre: 'Servicios de taller y soporte',
    cuenta: '415595',
    nombreCuenta: 'Actividades conexas',
    pistas: ['servicio', 'reparación', 'soporte', 'taller', 'mantenimiento'],
  },
  {
    codigo: 'ING-ARRIENDOS',
    tipo: 'INGRESO',
    grupo: 'Otros ingresos',
    nombre: 'Arrendamientos recibidos',
    cuenta: '422010',
    nombreCuenta: 'Arrendamientos - construcciones y edificios',
    pistas: ['arriendo', 'arrendamiento', 'canon'],
  },
  {
    codigo: 'ING-COMISIONES',
    tipo: 'INGRESO',
    grupo: 'Otros ingresos',
    nombre: 'Comisiones recibidas',
    cuenta: '422595',
    nombreCuenta: 'Otras comisiones',
    pistas: ['comisión'],
  },
  {
    codigo: 'ING-INTERESES',
    tipo: 'INGRESO',
    grupo: 'Rendimientos e intereses',
    nombre: 'Intereses y rendimientos financieros',
    cuenta: '421005',
    nombreCuenta: 'Intereses',
    pistas: ['intereses', 'rendimientos'],
  },
  {
    codigo: 'ING-DESCUENTO-PP',
    tipo: 'INGRESO',
    grupo: 'Rendimientos e intereses',
    nombre: 'Descuentos por pronto pago obtenidos',
    cuenta: '421040',
    nombreCuenta: 'Descuentos comerciales condicionados',
    automatico: true,
  },
  {
    codigo: 'ING-RECUPERACIONES',
    tipo: 'INGRESO',
    grupo: 'Recuperaciones',
    nombre: 'Recuperaciones e indemnizaciones',
    cuenta: '425050',
    nombreCuenta: 'Reintegro de otros costos y gastos',
    pistas: ['indemnización', 'reintegro', 'recuperación'],
  },
  {
    codigo: 'ING-APROVECHAMIENTOS',
    tipo: 'INGRESO',
    grupo: 'Recuperaciones',
    nombre: 'Aprovechamientos',
    cuenta: '429505',
    nombreCuenta: 'Aprovechamientos',
    pistas: ['aprovechamiento', 'chatarra', 'desecho'],
  },

  // ── Gastos de personal ───────────────────────────────────────────────────
  {
    codigo: 'GTO-SUELDOS',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Sueldos',
    cuenta: '510506',
    nombreCuenta: 'Sueldos',
    pistas: ['sueldo', 'salario', 'nómina'],
  },
  {
    codigo: 'GTO-HORAS-EXTRAS',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Horas extras y recargos',
    cuenta: '510515',
    nombreCuenta: 'Horas extras y recargos',
    pistas: ['horas extras', 'recargo'],
  },
  {
    codigo: 'GTO-AUX-TRANSPORTE',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Auxilio de transporte',
    cuenta: '510527',
    nombreCuenta: 'Auxilio de transporte',
    pistas: ['auxilio de transporte'],
  },
  {
    codigo: 'GTO-CESANTIAS',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Cesantías',
    cuenta: '510530',
    nombreCuenta: 'Cesantías',
    pistas: ['cesantías'],
  },
  {
    codigo: 'GTO-INT-CESANTIAS',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Intereses sobre cesantías',
    cuenta: '510533',
    nombreCuenta: 'Intereses sobre cesantías',
    pistas: ['intereses de cesantías'],
  },
  {
    codigo: 'GTO-PRIMA',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Prima de servicios',
    cuenta: '510536',
    nombreCuenta: 'Prima de servicios',
    pistas: ['prima'],
  },
  {
    codigo: 'GTO-VACACIONES',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Vacaciones',
    cuenta: '510539',
    nombreCuenta: 'Vacaciones',
    pistas: ['vacaciones'],
  },
  {
    codigo: 'GTO-DOTACION',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Dotación y suministro a trabajadores',
    cuenta: '510551',
    nombreCuenta: 'Dotación y suministro a trabajadores',
    pistas: ['dotación', 'uniforme', 'overol'],
  },
  {
    codigo: 'GTO-PENSION',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Aportes a pensión',
    cuenta: '510569',
    nombreCuenta: 'Aportes a fondos de pensiones',
    pistas: ['pensión', 'colpensiones', 'porvenir', 'protección'],
  },
  {
    codigo: 'GTO-SALUD',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Aportes a salud',
    cuenta: '510570',
    nombreCuenta: 'Aportes a entidades promotoras de salud EPS',
    pistas: ['eps', 'salud'],
  },
  {
    codigo: 'GTO-ARL',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Aportes a riesgos laborales (ARL)',
    cuenta: '510568',
    nombreCuenta: 'Aportes a administradoras de riesgos laborales ARL',
    pistas: ['arl', 'riesgos laborales'],
  },
  {
    codigo: 'GTO-CAJA-COMPENSACION',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Aportes a caja de compensación',
    cuenta: '510572',
    nombreCuenta: 'Aportes cajas de compensación familiar',
    pistas: [
      'caja de compensación',
      'comfama',
      'comfenalco',
      'cafam',
      'compensar',
    ],
  },
  {
    codigo: 'GTO-ICBF',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Aportes al ICBF',
    cuenta: '510575',
    nombreCuenta: 'Aportes I.C.B.F.',
    pistas: ['icbf'],
  },
  {
    codigo: 'GTO-SENA',
    tipo: 'GASTO',
    grupo: 'Personal',
    nombre: 'Aportes al SENA',
    cuenta: '510578',
    nombreCuenta: 'SENA',
    pistas: ['sena'],
  },

  // ── Honorarios ───────────────────────────────────────────────────────────
  {
    codigo: 'GTO-REVISORIA',
    tipo: 'GASTO',
    grupo: 'Honorarios',
    nombre: 'Revisoría fiscal',
    cuenta: '511010',
    nombreCuenta: 'Revisoría fiscal',
    pistas: ['revisor fiscal', 'revisoría'],
  },
  {
    codigo: 'GTO-HON-CONTABLES',
    tipo: 'GASTO',
    grupo: 'Honorarios',
    nombre: 'Honorarios contables y financieros',
    cuenta: '511030',
    nombreCuenta: 'Asesoría financiera',
    pistas: ['contador', 'contabilidad', 'asesoría financiera'],
  },
  {
    codigo: 'GTO-HON-JURIDICOS',
    tipo: 'GASTO',
    grupo: 'Honorarios',
    nombre: 'Asesoría jurídica',
    cuenta: '511025',
    nombreCuenta: 'Asesoría jurídica',
    pistas: ['abogado', 'jurídica', 'legal'],
  },
  {
    codigo: 'GTO-HON-TECNICOS',
    tipo: 'GASTO',
    grupo: 'Honorarios',
    nombre: 'Asesoría técnica',
    cuenta: '511035',
    nombreCuenta: 'Asesoría técnica',
    pistas: ['asesoría técnica', 'consultoría'],
  },
  {
    codigo: 'GTO-HON-OTROS',
    tipo: 'GASTO',
    grupo: 'Honorarios',
    nombre: 'Otros honorarios',
    cuenta: '511095',
    nombreCuenta: 'Otros honorarios',
    pistas: ['honorarios'],
  },

  // ── Impuestos que son gasto ──────────────────────────────────────────────
  {
    codigo: 'GTO-ICA',
    tipo: 'GASTO',
    grupo: 'Impuestos que son gasto',
    nombre: 'Industria y comercio (ICA)',
    cuenta: '511505',
    nombreCuenta: 'Industria y comercio',
    pistas: ['ica', 'industria y comercio'],
  },
  {
    codigo: 'GTO-PREDIAL',
    tipo: 'GASTO',
    grupo: 'Impuestos que son gasto',
    nombre: 'Predial',
    cuenta: '511515',
    nombreCuenta: 'A la propiedad raíz',
    pistas: ['predial'],
  },
  {
    codigo: 'GTO-VEHICULOS',
    tipo: 'GASTO',
    grupo: 'Impuestos que son gasto',
    nombre: 'Impuesto de vehículos',
    cuenta: '511540',
    nombreCuenta: 'De vehículos',
    pistas: ['impuesto vehicular', 'rodamiento'],
  },
  // D8: el 4×1000 es un impuesto, gasto operacional de administración.
  {
    codigo: 'GTO-GMF',
    tipo: 'GASTO',
    grupo: 'Impuestos que son gasto',
    nombre: 'GMF 4 × 1000',
    cuenta: '511595',
    nombreCuenta: 'Otros impuestos',
    automatico: true,
    pistas: ['4x1000', 'gmf', 'gravamen'],
  },

  // ── Arriendos y servicios ────────────────────────────────────────────────
  {
    codigo: 'GTO-ARRIENDO',
    tipo: 'GASTO',
    grupo: 'Arriendos y servicios',
    nombre: 'Arriendo del local',
    cuenta: '512010',
    nombreCuenta: 'Arrendamientos - construcciones y edificaciones',
    pistas: ['arriendo', 'canon', 'arrendamiento'],
  },
  {
    codigo: 'GTO-ACUEDUCTO',
    tipo: 'GASTO',
    grupo: 'Arriendos y servicios',
    nombre: 'Acueducto y alcantarillado',
    cuenta: '513525',
    nombreCuenta: 'Acueducto y alcantarillado',
    pistas: ['acueducto', 'agua', 'alcantarillado'],
  },
  {
    codigo: 'GTO-ENERGIA',
    tipo: 'GASTO',
    grupo: 'Arriendos y servicios',
    nombre: 'Energía eléctrica',
    cuenta: '513530',
    nombreCuenta: 'Energía eléctrica',
    pistas: ['energía', 'luz', 'epm', 'celsia', 'enel'],
  },
  {
    codigo: 'GTO-TELEFONO',
    tipo: 'GASTO',
    grupo: 'Arriendos y servicios',
    nombre: 'Teléfono e internet',
    cuenta: '513535',
    nombreCuenta: 'Teléfono',
    pistas: ['teléfono', 'internet', 'celular', 'claro', 'tigo', 'movistar'],
  },
  {
    codigo: 'GTO-CORREO',
    tipo: 'GASTO',
    grupo: 'Arriendos y servicios',
    nombre: 'Correo y mensajería',
    cuenta: '513540',
    nombreCuenta: 'Correo, portes y telegramas',
    pistas: [
      'correo',
      'mensajería',
      'servientrega',
      'envía',
      'interrapidísimo',
    ],
  },
  {
    codigo: 'GTO-SEGUROS',
    tipo: 'GASTO',
    grupo: 'Arriendos y servicios',
    nombre: 'Seguros',
    cuenta: '513095',
    nombreCuenta: 'Otros seguros',
    pistas: ['póliza', 'seguro'],
  },

  // ── Mantenimiento ────────────────────────────────────────────────────────
  {
    codigo: 'GTO-MANT-LOCAL',
    tipo: 'GASTO',
    grupo: 'Mantenimiento',
    nombre: 'Mantenimiento del local',
    cuenta: '514510',
    nombreCuenta: 'Mantenimiento - construcciones y edificaciones',
    pistas: ['pintura', 'plomería', 'reparación locativa'],
  },
  {
    codigo: 'GTO-MANT-EQUIPOS',
    tipo: 'GASTO',
    grupo: 'Mantenimiento',
    nombre: 'Mantenimiento de equipos de oficina',
    cuenta: '514520',
    nombreCuenta: 'Mantenimiento - equipo de oficina',
    pistas: ['mantenimiento equipo'],
  },
  {
    codigo: 'GTO-MANT-COMPUTO',
    tipo: 'GASTO',
    grupo: 'Mantenimiento',
    nombre: 'Mantenimiento de cómputo y comunicaciones',
    cuenta: '514525',
    nombreCuenta: 'Mantenimiento - equipo de computación y comunicación',
    pistas: ['computador', 'impresora', 'software'],
  },
  {
    codigo: 'GTO-MANT-VEHICULOS',
    tipo: 'GASTO',
    grupo: 'Mantenimiento',
    nombre: 'Mantenimiento de vehículos',
    cuenta: '514540',
    nombreCuenta: 'Mantenimiento - flota y equipo de transporte',
    pistas: ['taller', 'llantas', 'aceite'],
  },

  // ── Transporte, viajes y diversos ────────────────────────────────────────
  {
    codigo: 'GTO-FLETES',
    tipo: 'GASTO',
    grupo: 'Transporte, papelería y aseo',
    nombre: 'Transporte, fletes y acarreos',
    cuenta: '513550',
    nombreCuenta: 'Transporte, fletes y acarreos',
    pistas: ['flete', 'transporte', 'acarreo', 'domicilio'],
  },
  {
    codigo: 'GTO-VIAJES',
    tipo: 'GASTO',
    grupo: 'Transporte, papelería y aseo',
    nombre: 'Gastos de viaje',
    cuenta: '515595',
    nombreCuenta: 'Otros gastos de viaje',
    pistas: ['viaje', 'pasaje', 'hotel', 'viáticos'],
  },
  {
    codigo: 'GTO-PAPELERIA',
    tipo: 'GASTO',
    grupo: 'Transporte, papelería y aseo',
    nombre: 'Útiles, papelería y fotocopias',
    cuenta: '519530',
    nombreCuenta: 'Útiles, papelería y fotocopias',
    pistas: ['papelería', 'fotocopias', 'útiles'],
  },
  {
    codigo: 'GTO-ASEO',
    tipo: 'GASTO',
    grupo: 'Transporte, papelería y aseo',
    nombre: 'Aseo y cafetería',
    cuenta: '519525',
    nombreCuenta: 'Elementos de aseo y cafetería',
    pistas: ['aseo', 'cafetería', 'café'],
  },
  {
    codigo: 'GTO-DIVERSOS',
    tipo: 'GASTO',
    grupo: 'Transporte, papelería y aseo',
    nombre: 'Otros gastos diversos',
    cuenta: '519595',
    nombreCuenta: 'Otros gastos diversos',
  },
  {
    codigo: 'GTO-PUBLICIDAD',
    tipo: 'GASTO',
    grupo: 'Ventas',
    nombre: 'Publicidad y propaganda',
    cuenta: '523560',
    nombreCuenta: 'Propaganda y publicidad',
    pistas: ['publicidad', 'pauta', 'volantes', 'redes'],
  },

  // ── Financieros ──────────────────────────────────────────────────────────
  {
    codigo: 'GTO-GASTOS-BANCARIOS',
    tipo: 'GASTO',
    grupo: 'Financieros',
    nombre: 'Gastos bancarios',
    cuenta: '530505',
    nombreCuenta: 'Gastos bancarios',
    pistas: ['cuota de manejo', 'chequera'],
  },
  {
    codigo: 'GTO-COMISIONES',
    tipo: 'GASTO',
    grupo: 'Financieros',
    nombre: 'Comisiones bancarias y de datáfono',
    cuenta: '530515',
    nombreCuenta: 'Comisiones',
    pistas: ['comisión', 'datáfono', 'pasarela'],
  },
  {
    codigo: 'GTO-INTERESES',
    tipo: 'GASTO',
    grupo: 'Financieros',
    nombre: 'Intereses de créditos',
    cuenta: '530520',
    nombreCuenta: 'Intereses',
    pistas: ['intereses'],
  },
  {
    codigo: 'GTO-DESCUENTO-PP',
    tipo: 'GASTO',
    grupo: 'Financieros',
    nombre: 'Descuentos por pronto pago concedidos',
    cuenta: '530535',
    nombreCuenta: 'Descuentos comerciales condicionados',
    automatico: true,
  },

  // ── No gasto: mueven plata, no el resultado ─────────────────────────────
  {
    codigo: 'NG-CREDITO-ABONO',
    tipo: 'NO_GASTO',
    grupo: 'Créditos',
    nombre: 'Abono a capital de créditos',
    cuenta: '210510',
    nombreCuenta: 'Pagarés', // voseo-ok: sustantivo
    exigeTercero: true,
    tipoFlujo: 'FINANCIACION',
    pistas: ['cuota', 'crédito', 'abono a capital', 'préstamo'],
  },
  {
    codigo: 'NG-CREDITO-RECIBIDO',
    tipo: 'NO_GASTO',
    grupo: 'Créditos',
    nombre: 'Préstamo recibido',
    cuenta: '210510',
    nombreCuenta: 'Pagarés', // voseo-ok: sustantivo
    exigeTercero: true,
    tipoFlujo: 'FINANCIACION',
    pistas: ['desembolso', 'préstamo'],
  },
  {
    codigo: 'NG-PAGO-IVA',
    tipo: 'NO_GASTO',
    grupo: 'Impuestos por pagar',
    nombre: 'Pago de IVA',
    cuenta: '240805',
    nombreCuenta: 'IVA por pagar',
    // PC15: se paga desde Impuestos, contra su declaración; no a mano.
    automatico: true,
    pistas: ['iva', 'formulario 300'],
  },
  {
    codigo: 'NG-PAGO-ICA',
    tipo: 'NO_GASTO',
    grupo: 'Impuestos por pagar',
    nombre: 'Pago de industria y comercio',
    cuenta: '241205',
    nombreCuenta: 'Industria y comercio - vigencia fiscal corriente',
    // PC15: se paga desde Impuestos, contra su declaración; no a mano.
    automatico: true,
    pistas: ['ica', 'industria y comercio'],
  },
  {
    codigo: 'NG-PAGO-NOMINA',
    tipo: 'NO_GASTO',
    grupo: 'Nómina por pagar',
    nombre: 'Pago de nómina',
    cuenta: '250505',
    nombreCuenta: 'Salarios por pagar',
    exigeTercero: true,
    pistas: ['nómina', 'pago de sueldos'],
  },
  {
    codigo: 'NG-PAGO-SEG-SOCIAL',
    tipo: 'NO_GASTO',
    grupo: 'Nómina por pagar',
    nombre: 'Pago de seguridad social',
    cuenta: '237005',
    nombreCuenta: 'Aportes a seguridad social',
    exigeTercero: true,
    pistas: ['pila', 'seguridad social'],
  },
  {
    codigo: 'NG-PAGO-PARAFISCALES',
    tipo: 'NO_GASTO',
    grupo: 'Nómina por pagar',
    nombre: 'Pago de parafiscales',
    cuenta: '237010',
    nombreCuenta: 'Aportes al I.C.B.F., SENA y cajas de compensación',
    exigeTercero: true,
    pistas: ['parafiscales'],
  },
  {
    codigo: 'NG-DIVIDENDOS',
    tipo: 'NO_GASTO',
    grupo: 'Socios',
    nombre: 'Pago de dividendos',
    cuenta: '236005',
    nombreCuenta: 'Dividendos',
    exigeTercero: true,
    tipoFlujo: 'FINANCIACION',
    pistas: ['dividendos', 'utilidades a socios'],
  },
  // PC16: en una S.A.S. no hay «retiro de socios» (E11); la plata que un
  // accionista se lleva sin ser dividendo es un préstamo que se le cobra.
  {
    codigo: 'NG-PRESTAMO-SOCIO',
    tipo: 'NO_GASTO',
    grupo: 'Socios',
    nombre: 'Préstamo a socio',
    cuenta: '132510',
    nombreCuenta: 'A accionistas',
    exigeTercero: true,
    tipoFlujo: 'INVERSION',
    pistas: ['préstamo a socio', 'préstamo a accionista', 'retiro de socio'],
  },
  // D11a: anticipos en 133005 y 280505.
  {
    codigo: 'NG-ANTICIPO-PROVEEDOR',
    tipo: 'NO_GASTO',
    grupo: 'Anticipos',
    nombre: 'Anticipo a proveedor',
    cuenta: '133005',
    nombreCuenta: 'Anticipos a proveedores',
    exigeTercero: true,
    automatico: true,
  },
  {
    codigo: 'NG-ANTICIPO-CLIENTE',
    tipo: 'NO_GASTO',
    grupo: 'Anticipos',
    nombre: 'Anticipo de cliente',
    cuenta: '280505',
    nombreCuenta: 'Anticipos y avances recibidos de clientes',
    exigeTercero: true,
    automatico: true,
  },
];
