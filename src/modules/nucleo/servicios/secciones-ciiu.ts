/**
 * A qué parte del PUC le sirve a una empresa, deducido de a qué se dedica.
 *
 * Dos fuentes, y **suman**: las actividades CIIU que declaró en el RUT y los
 * sectores que marcó a mano. Una cuenta es pertinente si la señala cualquiera de
 * las dos. Nunca se cruzan: la intersección escondería cuentas que el RUT
 * respalda porque alguien no marcó una casilla, y en contabilidad no encontrar
 * la cuenta correcta termina en asentar en la equivocada.
 *
 * Nada de esto oculta: marca. La UI pliega lo no pertinente y deja el catálogo
 * completo a un clic. Si la inferencia se equivoca, el costo es un clic.
 *
 * Función pura, sin base de datos, igual que `estado-configuracion.reglas`.
 */

/** Las 21 secciones de la CIIU Rev. 4 A.C. */
export type Seccion = string;

/**
 * Sección CIIU -> cuenta de ingresos operacionales.
 *
 * No es un criterio propio: las cuentas del grupo 41 del Decreto 2650 SON las
 * secciones de la CIIU ("4135 COMERCIO AL POR MAYOR Y AL POR MENOR", "4160
 * ENSEÑANZA"). El decreto se escribió sobre la revisión 3, que tenía menos
 * secciones que la 4 A.C. vigente, así que varias secciones de hoy caen en la
 * misma cuenta. El grupo 61 (costo de ventas) usa los mismos dos últimos dígitos.
 */
export const INGRESO_POR_SECCION: Record<string, string> = {
  A: '4105', // agricultura, ganadería, caza y silvicultura
  B: '4115', // explotación de minas y canteras
  C: '4120', // industrias manufactureras
  D: '4125', // suministro de electricidad, gas y agua
  E: '4125', // distribución de agua y saneamiento
  F: '4130', // construcción
  G: '4135', // comercio al por mayor y al por menor
  H: '4145', // transporte, almacenamiento y comunicaciones
  I: '4140', // hoteles y restaurantes
  J: '4145', // información y comunicaciones
  K: '4150', // actividad financiera
  L: '4155', // actividades inmobiliarias y de alquiler
  M: '4155', // profesionales, científicas y técnicas
  N: '4155', // servicios administrativos y de apoyo
  O: '4170', // administración pública
  P: '4160', // enseñanza
  Q: '4165', // servicios sociales y de salud
  R: '4170', // artísticas y de entretenimiento
  S: '4170', // otras actividades de servicios
  T: '4170', // hogares en calidad de empleadores
  U: '4170', // organizaciones extraterritoriales
};

/** La pesca comparte sección con la agricultura pero el decreto le da cuenta propia. */
const INGRESO_PESCA = '4110';

/**
 * Qué secciones cubre cada sector marcado a mano.
 *
 * Es más grueso que la CIIU a propósito: el sector es la red de seguridad para
 * cuando el RUT está incompleto, no un segundo lugar donde declarar lo mismo.
 */
export const SECCIONES_POR_SECTOR: Record<string, Seccion[]> = {
  COMERCIO: ['G'],
  MANUFACTURA: ['C'],
  SERVICIOS: [
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
  ],
};

/**
 * Secciones cuyo trabajo se acumula como costo de producción antes de venderse.
 *
 * Agricultura, minería, manufactura, servicios públicos y construcción. NO es lo
 * mismo que "fábrica": el grupo 74 del decreto es "contratos de servicios" y lo
 * usa cualquiera que costee por contrato. Por eso la clase 7 solo se pliega.
 */
const SECCIONES_DE_PRODUCCION = new Set(['A', 'B', 'C', 'D', 'E', 'F']);

/**
 * Cuentas de inventario que solo tienen sentido para cierto tipo de operación.
 *
 * Deducido del nombre que les puso el decreto, no del código: "MATERIAS PRIMAS"
 * es de quien transforma y "MERCANCIAS NO FABRICADAS POR LA EMPRESA" es de quien
 * revende. Es inferencia, no norma, y por eso también solo pliega. Lo que no
 * está en esta lista —repuestos, envases, inventarios en tránsito, provisiones—
 * le sirve a cualquiera.
 */
const INVENTARIO_POR_SECCION: Record<string, Seccion[]> = {
  '1405': ['C'], // materias primas
  '1410': ['C'], // productos en proceso
  '1430': ['C'], // productos terminados
  '1415': ['F'], // obras de construcción en curso
  '1417': ['F'], // obras de urbanismo
  '1420': ['F'], // contratos en ejecución
  '1425': ['A'], // cultivos en desarrollo
  '1428': ['A'], // plantaciones agrícolas
  '1445': ['A'], // semovientes
  '1435': ['G'], // mercancías no fabricadas por la empresa
  '1440': ['G', 'L'], // bienes raíces para la venta
  '1450': ['G', 'L'], // terrenos
};

export interface Pertinencia {
  pertinente: boolean;
  /** Por qué no lo es. Va a la UI tal cual; vacío cuando sí lo es. */
  motivo?: string;
}

/**
 * Las secciones que le sirven a la empresa: las de sus actividades más las de
 * sus sectores marcados.
 */
export function seccionesPertinentes(
  seccionesDeActividades: Array<string | null>,
  sectoresMarcados: string[],
): Set<Seccion> {
  const secciones = new Set<Seccion>();
  for (const s of seccionesDeActividades) {
    if (s !== null && s !== '') secciones.add(s);
  }
  for (const sector of sectoresMarcados) {
    for (const s of SECCIONES_POR_SECTOR[sector] ?? []) secciones.add(s);
  }
  return secciones;
}

/** Las cuentas de ingreso y de costo que corresponden a esas secciones. */
function cuentasDeActividad(secciones: Set<Seccion>): Set<string> {
  const cuentas = new Set<string>();
  for (const s of secciones) {
    const ingreso = INGRESO_POR_SECCION[s];
    if (ingreso !== undefined) {
      cuentas.add(ingreso);
      cuentas.add(`61${ingreso.slice(2)}`);
    }
    if (s === 'A') {
      cuentas.add(INGRESO_PESCA);
      cuentas.add(`61${INGRESO_PESCA.slice(2)}`);
    }
  }
  return cuentas;
}

/**
 * Si una cuenta del catálogo le sirve a esta empresa.
 *
 * Sin secciones —empresa nueva, sin actividad ni sectores— todo es pertinente:
 * no hay con qué filtrar, y mostrar de menos sería peor que mostrar de más.
 */
export function evaluarPertinencia(
  codigo: string,
  secciones: Set<Seccion>,
): Pertinencia {
  if (secciones.size === 0) return { pertinente: true };

  const cuenta = codigo.slice(0, 4);

  // Ingresos y costos operacionales. Filtro fuerte: el mapa lo trae el decreto.
  // 4175 (devoluciones) queda fuera porque le sirve a cualquiera que venda.
  const esOperacional =
    (codigo.startsWith('41') || codigo.startsWith('61')) &&
    codigo.length >= 4 &&
    cuenta !== '4175';

  if (esOperacional && !cuentasDeActividad(secciones).has(cuenta)) {
    // El motivo no nombra la actividad de la empresa: se repetiría en cada fila
    // y con quince secciones marcadas el mensaje se vuelve ilegible. Las
    // actividades viajan una sola vez, arriba de la lista.
    return { pertinente: false, motivo: 'Es de otra actividad económica.' };
  }

  // Costos de producción. Inferencia débil: el grupo 74 es "contratos de
  // servicios" y no solo lo usa una fábrica.
  const produce = [...secciones].some((s) => SECCIONES_DE_PRODUCCION.has(s));
  if (codigo.startsWith('7') && !produce) {
    return {
      pertinente: false,
      motivo:
        'Es para acumular costo de producción, y ninguna de tus actividades lo hace.',
    };
  }

  // Inventarios. Inferencia a partir del nombre de la cuenta, no de la norma.
  const seccionesInventario = INVENTARIO_POR_SECCION[cuenta];
  if (
    codigo.startsWith('14') &&
    seccionesInventario !== undefined &&
    !seccionesInventario.some((s) => secciones.has(s))
  ) {
    return {
      pertinente: false,
      motivo: 'Es un inventario de otro tipo de operación.',
    };
  }

  return { pertinente: true };
}

/**
 * La cuenta de ingresos (41xx) de una actividad, por su sección y división.
 * La pesca (división 03) tiene cuenta propia aunque comparta sección con la
 * agricultura. `undefined` si la sección no se conoce.
 */
export function cuentaIngresoDeActividad(
  seccion: string | null,
  division: string | null,
): string | undefined {
  if (division === '03') return INGRESO_PESCA;
  return seccion === null ? undefined : INGRESO_POR_SECCION[seccion];
}
