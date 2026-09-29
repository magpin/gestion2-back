/**
 * Qué concepto de retención lleva un renglón de compra, **sin IA** (plan motor
 * de retenciones, Fase 1, §1.5; especificación §6).
 *
 * Cinco fuentes, de más a menos confiable. Las dos primeras son «La vi
 * clara» y se aprueban con la factura; las otras dos son «La deduje» y una
 * persona las acepta o las cambia **antes de registrar** (lo exige el backend).
 * Si dos fuentes deducidas no coinciden, o ninguna dice nada, «Te pregunto».
 *
 * | # | Fuente | Certeza |
 * |---|---|---|
 * | 1 | Lo que una persona ya confirmó (`retencion_mapeo_concepto`) | CLARA |
 * | 2 | Producto del catálogo → compras generales | CLARA |
 * | 3 | CIIU del proveedor | DEDUCIDA |
 * | 4 | La retención que sugiere el concepto del gasto (PC23), o si no las palabras del renglón y la cuenta | DEDUCIDA |
 * | 5 | La IA, con la lista cerrada, si ninguna otra dijo nada (Fase 5) | DEDUCIDA |
 *
 * La IA no se llama desde aquí: llega ya contestada (`contexto.ia`), guardada
 * por proveedor y renglón. Para cuando llegue el XML de la DIAN,
 * el UNSPSC entra entre la 2 y la 3 (`FuenteConcepto`, §1.9).
 */

export type OrigenClasificacion =
  'CONFIRMADO' | 'PRODUCTO' | 'CIIU' | 'CONCEPTO' | 'PALABRAS' | 'IA';
export type Certeza = 'CLARA' | 'DEDUCIDA' | 'PREGUNTA';

export interface RenglonAClasificar {
  orden: number;
  productoId: string | null;
  /** Qué dice el renglón: el detalle del gasto o el nombre del producto. */
  texto: string | null;
  /** La cuenta contra la que se debita (gastos): dice mucho del concepto. */
  cuentaCodigo: string | null;
  /**
   * La retención que sugiere el concepto del gasto (PC23): una sugerencia, no
   * una orden. Pesa más que las palabras —alguien la eligió para ese
   * concepto— pero es una deducción: se acepta o se cambia antes de registrar.
   */
  sugerida?: { concepto: string; nombreConcepto: string } | null;
}

export interface Aprendido {
  productoId: string | null;
  llaveRenglon: string | null;
  /** `true` si lo aprendido es de este proveedor; `false` si vale para todos. */
  deEsteProveedor: boolean;
  conceptoCodigo: string;
}

export interface Clasificacion {
  orden: number;
  concepto: string | null;
  origen: OrigenClasificacion | null;
  certeza: Certeza;
  /** Una frase, para la pantalla y para la explicación guardada. */
  razon: string;
  /** Cuando pregunta porque dos fuentes no coinciden: las dos opciones. */
  opciones?: string[];
  /** Lo que la IA también ve posible, para «Cambiar». */
  alternativas?: string[];
}

/** Lo que la IA ya propuso para un renglón (`retencion_clasificacion_ia`). */
export interface PropuestaIa {
  concepto: string;
  razon: string;
  alternativas: string[];
}

/** «Arriendo Local #3 — Sept.» → «arriendo local sept». Sin tildes ni números. */
export function llaveDe(texto: string | null): string | null {
  if (texto === null) return null;
  const llave = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return llave.length < 3 ? null : llave;
}

// ---------------------------------------------------------------------------
// Fuente 3 — CIIU del proveedor (especificación §6.3)
// ---------------------------------------------------------------------------

const CIIU: Array<{
  prueba: (c: string) => boolean;
  concepto: string;
  que: string;
}> = [
  {
    prueba: (c) => c === '4923',
    concepto: 'TRANSPORTE_CARGA',
    que: 'transporte de carga',
  },
  {
    prueba: (c) => c === '4921' || c === '4922',
    concepto: 'TRANSPORTE_PASAJEROS_TER',
    que: 'transporte de pasajeros',
  },
  {
    prueba: (c) => /^55/.test(c) || /^56/.test(c),
    concepto: 'HOTELES_RESTAURANTES',
    que: 'hoteles o restaurantes',
  },
  {
    prueba: (c) => c === '8010' || /^812/.test(c),
    concepto: 'SERV_VIGILANCIA_ASEO',
    que: 'vigilancia o aseo',
  },
  {
    prueba: (c) => /^86/.test(c),
    concepto: 'SERV_SALUD_IPS',
    que: 'servicios de salud',
  },
  {
    prueba: (c) => /^78/.test(c),
    concepto: 'SERV_TEMPORALES',
    que: 'servicios temporales',
  },
  {
    prueba: (c) => /^4[123]/.test(c),
    concepto: 'CONSTRUCCION',
    que: 'construcción',
  },
  {
    prueba: (c) => c === '6910' || c === '6920',
    concepto: 'HONORARIOS',
    que: 'servicios jurídicos o contables',
  },
  {
    prueba: (c) => /^4[5-7]/.test(c),
    concepto: 'COMPRAS_GENERALES',
    que: 'comercio',
  },
];

// ---------------------------------------------------------------------------
// Fuente 4 — palabras del renglón y cuenta de gasto
// ---------------------------------------------------------------------------

/**
 * En orden: los casos engañosos primero (especificación §6.3). «Productos de
 * aseo» son compras, no servicio de aseo; un letrero es una compra, no
 * publicidad; el café trillado no es café pergamino.
 */
const PALABRAS: Array<{ re: RegExp; concepto: string; que: string }> = [
  {
    re: /\b(productos?|elementos?|implementos?|insumos?) de aseo\b/,
    concepto: 'COMPRAS_GENERALES',
    que: 'productos de aseo (una compra, no el servicio de aseo)',
  },
  {
    re: /\bcafe (trillado|tostado|molido)\b/,
    concepto: 'COMPRAS_GENERALES',
    que: 'café procesado (una compra)',
  },
  {
    re: /\b(aviso|letrero|valla)s?\b/,
    concepto: 'COMPRAS_GENERALES',
    que: 'un aviso o letrero (se compra el bien)',
  },
  {
    re: /\bcafe (pergamino|cereza)\b/,
    concepto: 'CAFE_PERGAMINO',
    que: 'café pergamino o cereza',
  },
  {
    re: /\b(arriendo|arrendamiento|canon|alquiler)\b.*\b(equipo|maquina|maquinaria|vehiculo|computador|andamio|herramienta)s?\b/,
    concepto: 'ARREND_MUEBLES',
    que: 'arriendo de un bien mueble',
  },
  {
    re: /\b(arriendo|arrendamiento|canon|alquiler)\b/,
    concepto: 'ARREND_INMUEBLES',
    que: 'arriendo',
  },
  {
    re: /\b(honorarios?|asesoria|consultoria|auditoria|interventoria|revisoria|abogad|contador|sg sst)/,
    concepto: 'HONORARIOS',
    que: 'un servicio profesional',
  },
  { re: /\bcomision(es)?\b/, concepto: 'COMISIONES', que: 'una comisión' },
  {
    re: /\b(flete|fletes|acarreo|acarreos|transporte de (carga|mercancia))\b/,
    concepto: 'TRANSPORTE_CARGA',
    que: 'transporte de carga',
  },
  {
    re: /\b(tiquete|pasaje)s? aereos?\b|\bvuelo\b/,
    concepto: 'TRANSPORTE_PASAJEROS_AER',
    que: 'transporte aéreo',
  },
  {
    re: /\b(taxi|pasajes?|tiquetes?)\b/,
    concepto: 'TRANSPORTE_PASAJEROS_TER',
    que: 'transporte de pasajeros',
  },
  {
    re: /\b(vigilancia|seguridad privada|servicio de aseo|aseo y limpieza)\b/,
    concepto: 'SERV_VIGILANCIA_ASEO',
    que: 'vigilancia o aseo',
  },
  {
    re: /\b(hotel|hospedaje|alojamiento|restaurante|almuerzos?|alimentacion)\b/,
    concepto: 'HOTELES_RESTAURANTES',
    que: 'hotel o restaurante',
  },
  {
    re: /\blicencias?\b|\bsuscripcion\b.*\bsoftware\b/,
    concepto: 'SOFTWARE_LICENCIAS',
    que: 'licencia de software',
  },
  {
    re: /\b(gasolina|acpm|diesel|combustibles?)\b/,
    concepto: 'COMBUSTIBLES',
    que: 'combustible',
  },
  {
    re: /\b(intereses|rendimientos)\b/,
    concepto: 'RENDIMIENTOS_FIN',
    que: 'intereses',
  },
  {
    re: /\b(temporales|personal en mision)\b/,
    concepto: 'SERV_TEMPORALES',
    que: 'servicios temporales',
  },
  {
    re: /\b(obra civil|construccion|urbanizacion)\b/,
    concepto: 'CONSTRUCCION',
    que: 'construcción',
  },
  {
    re: /\b(mantenimiento|reparacion|instalacion|servicio|soporte|capacitacion)\b/,
    concepto: 'SERVICIOS_GENERALES',
    que: 'un servicio',
  },
];

/** La cuenta de gasto (Decreto 2650) dice mucho: 5120 es arrendamientos. */
const CUENTAS: Array<{ prefijo: string; concepto: string; que: string }> = [
  {
    prefijo: '512005',
    concepto: 'ARREND_INMUEBLES',
    que: 'la cuenta es de arriendo de terrenos',
  },
  {
    prefijo: '512010',
    concepto: 'ARREND_INMUEBLES',
    que: 'la cuenta es de arriendo de construcciones',
  },
  {
    prefijo: '5120',
    concepto: 'ARREND_MUEBLES',
    que: 'la cuenta es de arriendo de equipos',
  },
  {
    prefijo: '5110',
    concepto: 'HONORARIOS',
    que: 'la cuenta es de honorarios',
  },
  {
    prefijo: '513505',
    concepto: 'SERV_VIGILANCIA_ASEO',
    que: 'la cuenta es de aseo y vigilancia',
  },
  {
    prefijo: '513510',
    concepto: 'SERV_TEMPORALES',
    que: 'la cuenta es de temporales',
  },
  {
    prefijo: '513550',
    concepto: 'TRANSPORTE_CARGA',
    que: 'la cuenta es de transporte y fletes',
  },
  {
    prefijo: '5135',
    concepto: 'SERVICIOS_GENERALES',
    que: 'la cuenta es de servicios',
  },
  {
    prefijo: '5145',
    concepto: 'SERVICIOS_GENERALES',
    que: 'la cuenta es de mantenimiento',
  },
  {
    prefijo: '5150',
    concepto: 'SERVICIOS_GENERALES',
    que: 'la cuenta es de adecuación e instalación',
  },
  {
    prefijo: '519525',
    concepto: 'COMPRAS_GENERALES',
    que: 'la cuenta es de elementos de aseo',
  },
  {
    prefijo: '519530',
    concepto: 'COMPRAS_GENERALES',
    que: 'la cuenta es de útiles y papelería',
  },
  { prefijo: '14', concepto: 'COMPRAS_GENERALES', que: 'es inventario' },
  { prefijo: '15', concepto: 'COMPRAS_GENERALES', que: 'es un activo fijo' },
];

function porPalabras(
  texto: string | null,
): { concepto: string; que: string } | null {
  const llave = llaveDe(texto);
  if (llave === null) return null;
  const hit = PALABRAS.find((p) => p.re.test(llave));
  return hit === undefined
    ? null
    : { concepto: hit.concepto, que: `dice «${texto?.trim()}»: ${hit.que}` };
}

function porCuenta(
  codigo: string | null,
): { concepto: string; que: string } | null {
  if (codigo === null) return null;
  const hit = CUENTAS.find((c) => codigo.startsWith(c.prefijo));
  return hit === undefined ? null : { concepto: hit.concepto, que: hit.que };
}

function porCiiu(
  ciiu: string | null,
): { concepto: string; que: string } | null {
  if (ciiu === null) return null;
  const hit = CIIU.find((c) => c.prueba(ciiu));
  return hit === undefined
    ? null
    : {
        concepto: hit.concepto,
        que: `el proveedor es de ${hit.que} (CIIU ${ciiu})`,
      };
}

/**
 * Clasifica un renglón. `nombreDe` da el nombre legible del concepto para la
 * razón («Compras generales»).
 */
export function clasificar(
  r: RenglonAClasificar,
  contexto: {
    aprendidos: Aprendido[];
    ciiuProveedor: string | null;
    nombreProveedor: string;
    nombreDe: (codigo: string) => string;
    /** La propuesta de la IA para la llave del renglón, si ya la hay. */
    ia?: (llave: string) => PropuestaIa | null;
  },
): Clasificacion {
  const llave = llaveDe(r.texto);

  // 1. Lo que una persona ya confirmó: primero lo de este proveedor, después
  //    lo que vale para todos; por producto antes que por texto.
  const candidatos = contexto.aprendidos
    .filter(
      (a) =>
        (r.productoId !== null && a.productoId === r.productoId) ||
        (llave !== null && a.llaveRenglon === llave),
    )
    .sort(
      (a, b) =>
        Number(b.deEsteProveedor) - Number(a.deEsteProveedor) ||
        Number(b.productoId !== null) - Number(a.productoId !== null),
    );
  const aprendido = candidatos[0];
  if (aprendido !== undefined) {
    const nombre = contexto.nombreDe(aprendido.conceptoCodigo);
    return {
      orden: r.orden,
      concepto: aprendido.conceptoCodigo,
      origen: 'CONFIRMADO',
      certeza: 'CLARA',
      razon: aprendido.deEsteProveedor
        ? `A ${contexto.nombreProveedor}, por esto, ya me dijiste ${nombre}.`
        : `Por esto ya me dijiste ${nombre}.`,
    };
  }

  // 2. Un producto del catálogo es un bien: compras generales.
  if (r.productoId !== null) {
    return {
      orden: r.orden,
      concepto: 'COMPRAS_GENERALES',
      origen: 'PRODUCTO',
      certeza: 'CLARA',
      razon: 'Es un producto del inventario: compras generales.',
    };
  }

  // 3 y 4. Deducciones. Si no coinciden, se pregunta con las dos a la vista.
  const ciiu = porCiiu(contexto.ciiuProveedor);
  const delConcepto = r.sugerida
    ? {
        concepto: r.sugerida.concepto,
        que: `el concepto «${r.sugerida.nombreConcepto}» la sugiere`,
      }
    : null;
  const palabras =
    delConcepto ?? porPalabras(r.texto) ?? porCuenta(r.cuentaCodigo);

  if (
    ciiu !== null &&
    palabras !== null &&
    ciiu.concepto !== palabras.concepto
  ) {
    return {
      orden: r.orden,
      concepto: null,
      origen: null,
      certeza: 'PREGUNTA',
      razon: `No coinciden: ${ciiu.que}, pero ${palabras.que}. ¿Cuál es?`,
      opciones: [ciiu.concepto, palabras.concepto],
    };
  }
  if (ciiu !== null) {
    return {
      orden: r.orden,
      concepto: ciiu.concepto,
      origen: 'CIIU',
      certeza: 'DEDUCIDA',
      razon: `La deduje: ${ciiu.que}. ¿Es ${contexto.nombreDe(ciiu.concepto)}?`,
    };
  }
  if (palabras !== null) {
    return {
      orden: r.orden,
      concepto: palabras.concepto,
      origen: palabras === delConcepto ? 'CONCEPTO' : 'PALABRAS',
      certeza: 'DEDUCIDA',
      razon: `La deduje: ${palabras.que}. ¿Es ${contexto.nombreDe(palabras.concepto)}?`,
    };
  }

  // 5. La IA: solo cuando ninguna fuente dijo nada, y nunca se aplica sola.
  const ia =
    r.productoId === null && llave !== null
      ? (contexto.ia?.(llave) ?? null)
      : null;
  if (ia !== null) {
    return {
      orden: r.orden,
      concepto: ia.concepto,
      origen: 'IA',
      certeza: 'DEDUCIDA',
      razon: `La deduje (IA): ${ia.razon} ¿Es ${contexto.nombreDe(ia.concepto)}?`,
      alternativas: ia.alternativas,
    };
  }

  return {
    orden: r.orden,
    concepto: null,
    origen: null,
    certeza: 'PREGUNTA',
    razon: 'No sé qué concepto de retención es. ¿Me decís cuál?',
  };
}
