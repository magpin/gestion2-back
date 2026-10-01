/**
 * Las plantillas del comprobante manual asistido (Fase 9 de
 * docs/planes/plan-pantallas-complementarias.md, pantalla 52).
 *
 * «María arma el asiento» no usa un modelo: reconoce la plantilla por las
 * palabras que se escriben y hace la cuenta con una regla. Lo que devuelve es
 * una propuesta: la persona la revisa y la contabiliza (PC22).
 */

export type Plantilla = 'DEPRECIACION' | 'PRIMA' | 'SEGUROS' | 'INVENTARIO';

export const PLANTILLAS: readonly Plantilla[] = [
  'DEPRECIACION',
  'PRIMA',
  'SEGUROS',
  'INVENTARIO',
];

/** Un renglón propuesto, por código de cuenta: el servicio lo resuelve a la cuenta de la empresa. */
export interface RenglonPropuesto {
  codigo: string;
  detalle: string;
  debito: number;
  credito: number;
}

export interface Propuesta {
  plantilla: Plantilla;
  /** La glosa que se propone para el comprobante. */
  glosa: string;
  renglones: RenglonPropuesto[];
  /** Cómo se hizo la cuenta, en palabras y en números. */
  explicacion: string[];
  /** Solo el conteo de inventario: no es un asiento, es un ajuste de inventario. */
  redirigir?: { a: 'AJUSTE_INVENTARIO'; motivo: string };
}

/** Las clases de activo que se deprecian, con su gasto (5160) y su acumulada (1592). */
export const CLASES_ACTIVO = {
  CONSTRUCCIONES: {
    nombre: 'construcciones y edificaciones',
    gasto: '516005',
    acumulada: '159205',
  },
  MAQUINARIA: {
    nombre: 'maquinaria y equipo',
    gasto: '516010',
    acumulada: '159210',
  },
  OFICINA: {
    nombre: 'equipo de oficina',
    gasto: '516015',
    acumulada: '159215',
  },
  COMPUTO: {
    nombre: 'equipo de cómputo y comunicación',
    gasto: '516020',
    acumulada: '159220',
  },
  FLOTA: {
    nombre: 'flota y equipo de transporte',
    gasto: '516035',
    acumulada: '159235',
  },
} as const;
export type ClaseActivo = keyof typeof CLASES_ACTIVO;

/** Los ramos de seguro, con su gasto (5130). Todos se amortizan desde la 170520. */
export const RAMOS_SEGURO = {
  MANEJO: { nombre: 'manejo', gasto: '513005' },
  CUMPLIMIENTO: { nombre: 'cumplimiento', gasto: '513010' },
  CORRIENTE_DEBIL: { nombre: 'corriente débil', gasto: '513015' },
  VIDA: { nombre: 'vida colectiva', gasto: '513020' },
  INCENDIO: { nombre: 'incendio', gasto: '513025' },
  FLOTA: { nombre: 'flota y equipo de transporte', gasto: '513040' },
  OTROS: { nombre: 'otros', gasto: '513095' },
} as const;
export type RamoSeguro = keyof typeof RAMOS_SEGURO;

/** La provisión de prima: un doceavo del salario, el 8,33 % que se usa en la práctica. */
export const TARIFA_PRIMA = 8.33;

const CUENTA_PRIMA_GASTO = '510536';
const CUENTA_PRIMA_PASIVO = '261020';
const CUENTA_SEGUROS_ANTICIPADOS = '170520';

const pesos = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;
const numero = (n: number) => Math.round(n).toLocaleString('es-CO');

/** Una cuota mensual al peso: lo que no alcanza a un peso se lo lleva la última. */
export function cuotaMensual(valor: number, meses: number): number {
  if (!(valor > 0) || !(meses >= 1) || !Number.isInteger(meses)) {
    throw new Error(
      'El valor tiene que ser mayor que cero y los meses, un entero desde 1.',
    );
  }
  return Math.round(valor / meses);
}

export function depreciacion(datos: {
  clase: ClaseActivo;
  costo: number;
  meses: number;
  /** «septiembre de 2026»: va en la glosa y el detalle. */
  periodo: string;
}): Propuesta {
  const clase = CLASES_ACTIVO[datos.clase];
  const cuota = cuotaMensual(datos.costo, datos.meses);
  return {
    plantilla: 'DEPRECIACION',
    glosa: `Depreciación de ${datos.periodo} · ${clase.nombre}`,
    renglones: [
      {
        codigo: clase.gasto,
        detalle: `${datos.periodo} · ${datos.meses} meses`,
        debito: cuota,
        credito: 0,
      },
      {
        codigo: clase.acumulada,
        detalle: datos.periodo,
        debito: 0,
        credito: cuota,
      },
    ],
    explicacion: [
      `${capitalizar(clase.nombre)} por ${pesos(datos.costo)} a ${datos.meses} meses, en línea recta:`,
      `${numero(datos.costo)} ÷ ${datos.meses} = ${numero(cuota)}`,
    ],
  };
}

export function prima(datos: { salarios: number; periodo: string }): Propuesta {
  if (!(datos.salarios > 0))
    throw new Error('Los salarios del mes tienen que ser mayores que cero.');
  const valor = Math.round((datos.salarios * TARIFA_PRIMA) / 100);
  return {
    plantilla: 'PRIMA',
    glosa: `Provisión de prima de ${datos.periodo}`,
    renglones: [
      {
        codigo: CUENTA_PRIMA_GASTO,
        detalle: datos.periodo,
        debito: valor,
        credito: 0,
      },
      {
        codigo: CUENTA_PRIMA_PASIVO,
        detalle: datos.periodo,
        debito: 0,
        credito: valor,
      },
    ],
    explicacion: [
      `Salarios del mes por ${pesos(datos.salarios)}; la prima es un doceavo (8,33 %):`,
      `${numero(datos.salarios)} × 8,33 % = ${numero(valor)}`,
    ],
  };
}

export function seguros(datos: {
  ramo: RamoSeguro;
  valor: number;
  meses: number;
  periodo: string;
}): Propuesta {
  const ramo = RAMOS_SEGURO[datos.ramo];
  const cuota = cuotaMensual(datos.valor, datos.meses);
  return {
    plantilla: 'SEGUROS',
    glosa: `Amortización de seguros de ${datos.periodo} · ${ramo.nombre}`,
    renglones: [
      {
        codigo: ramo.gasto,
        detalle: `${datos.periodo} · ${datos.meses} meses`,
        debito: cuota,
        credito: 0,
      },
      {
        codigo: CUENTA_SEGUROS_ANTICIPADOS,
        detalle: datos.periodo,
        debito: 0,
        credito: cuota,
      },
    ],
    explicacion: [
      `Póliza de ${ramo.nombre} por ${pesos(datos.valor)}, pagada por ${datos.meses} meses:`,
      `${numero(datos.valor)} ÷ ${datos.meses} = ${numero(cuota)}`,
    ],
  };
}

/** El conteo no se asienta a mano: el ajuste de inventario asienta y mueve el kardex a la vez. */
export function inventario(): Propuesta {
  return {
    plantilla: 'INVENTARIO',
    glosa: 'Ajuste por conteo de inventario',
    renglones: [],
    explicacion: [
      'Un asiento a mano contra el inventario lo descuadra del kardex.',
      'El ajuste de inventario registra la diferencia producto por producto y hace el asiento solo.',
    ],
    redirigir: {
      a: 'AJUSTE_INVENTARIO',
      motivo:
        'Lo contado se registra como ajuste de inventario, no como comprobante manual.',
    },
  };
}

const PALABRAS: Array<[Plantilla, string[]]> = [
  [
    'INVENTARIO',
    ['inventario', 'conteo', 'contamos', 'faltante', 'sobrante', 'kardex'],
  ],
  ['DEPRECIACION', ['deprecia', 'depreciacion', 'desgaste']],
  ['PRIMA', ['prima', 'primas']],
  ['SEGUROS', ['seguro', 'seguros', 'poliza', 'amortiza']],
];

const sinTildes = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Qué plantilla es lo que se escribió, por palabras; `null` si no reconoce ninguna. */
export function reconocerPlantilla(texto: string): Plantilla | null {
  const t = sinTildes(texto);
  for (const [plantilla, palabras] of PALABRAS) {
    if (palabras.some((p) => t.includes(p))) return plantilla;
  }
  return null;
}

/** La clase de activo que sugiere el texto («equipos de cómputo» → COMPUTO). */
export function reconocerClase(texto: string): ClaseActivo | null {
  const t = sinTildes(texto);
  if (/comput|portatil|servidor|impresora|celular/.test(t)) return 'COMPUTO';
  if (/vehicul|camion|moto|carro|flota/.test(t)) return 'FLOTA';
  if (/maquin/.test(t)) return 'MAQUINARIA';
  if (/oficina|mueble|escritorio|silla/.test(t)) return 'OFICINA';
  if (/edific|construc|bodega|local/.test(t)) return 'CONSTRUCCIONES';
  return null;
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
