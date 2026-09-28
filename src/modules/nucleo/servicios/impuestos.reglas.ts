/**
 * El paso «Impuestos» de la configuración, en lenguaje de persona (plan motor
 * de retenciones, Fase 0, §0.7.3).
 *
 * Por debajo sigue siendo la casilla 53 del RUT: cada pregunta abre o cierra un
 * código, y la condición tributaria se deriva de ahí como siempre
 * (`responsabilidades-rut.ts`). Lo que cambia es la pregunta: el dueño de una
 * pyme no sabe qué es «O-15», pero sí sabe si le descuenta retención a sus
 * proveedores.
 *
 * Separado del acceso a datos, como `estado-configuracion.reglas`: es la parte
 * que hay que poder probar sin levantar una base.
 */

export type ClavePregunta =
  | 'IVA'
  | 'SIMPLE'
  | 'GRAN_CONTRIBUYENTE'
  | 'AGENTE_RETENCION'
  | 'AUTORRETENEDOR';

export interface Pregunta {
  clave: ClavePregunta;
  pregunta: string;
  ayuda: string;
  /** El código de la casilla 53 que significa «sí». */
  codigoSi: number;
  /**
   * El que significa «no», cuando el RUT lo escribe (IVA: 49). Si no hay, el
   * «no» es la ausencia del código.
   */
  codigoNo?: number;
  /** La condición que deja vigente el «sí». */
  condicion: string;
}

export const PREGUNTAS: Pregunta[] = [
  {
    clave: 'IVA',
    pregunta: '¿Tu empresa cobra IVA en lo que vende?',
    ayuda: 'Si tus facturas llevan IVA, es sí.',
    codigoSi: 48,
    codigoNo: 49,
    condicion: 'RESPONSABLE_IVA',
  },
  {
    clave: 'SIMPLE',
    pregunta: '¿Está en el Régimen Simple de Tributación?',
    ayuda: 'Si pagás impuestos con el formulario del SIMPLE, es sí.',
    codigoSi: 47,
    condicion: 'REGIMEN_SIMPLE',
  },
  {
    clave: 'GRAN_CONTRIBUYENTE',
    pregunta: '¿La DIAN la calificó como gran contribuyente?',
    ayuda: 'Te llega una resolución de la DIAN que lo dice.',
    codigoSi: 13,
    condicion: 'GRAN_CONTRIBUYENTE',
  },
  {
    clave: 'AGENTE_RETENCION',
    pregunta: '¿Es agente de retención en la fuente?',
    ayuda:
      'Si le descontás retención a tus proveedores cuando les pagás, es sí.',
    codigoSi: 7,
    condicion: 'AGENTE_RETENEDOR_RENTA',
  },
  {
    clave: 'AUTORRETENEDOR',
    pregunta: '¿Es autorretenedora?',
    ayuda: 'Si vos misma te practicás la retención en tus ventas.',
    codigoSi: 15,
    condicion: 'AUTORRETENEDOR_RENTA',
  },
];

export const preguntaDe = (clave: ClavePregunta): Pregunta => {
  const p = PREGUNTAS.find((x) => x.clave === clave);
  if (p === undefined) throw new Error(`Pregunta desconocida: ${clave}`);
  return p;
};

/**
 * La respuesta a una pregunta, leída de las condiciones vigentes.
 *
 * `null` = nadie contestó. Los «no» sin código en la casilla 53 son la
 * ausencia de un código: los distingue el «No» que contestó la persona
 * (`dijoNo`, 0101) o la confirmación del paso. Sin lo primero, el botón «No»
 * quedaba sin marcar hasta «Todo correcto» (bug #18 de la revisión del 27-09).
 */
export function respuestaDe(
  p: Pregunta,
  vigentes: string[],
  confirmado: boolean,
  dijoNo: readonly string[] = [],
): boolean | null {
  if (vigentes.includes(p.condicion)) return true;
  if (p.clave === 'IVA') {
    return vigentes.includes('NO_RESPONSABLE_IVA') ? false : null;
  }
  return confirmado || dijoNo.includes(p.clave) ? false : null;
}

/**
 * Ser agente de retención de IVA no se pregunta: se deduce (art. 437-2 E.T.).
 * El gran contribuyente lo es por el numeral 1. Quien lo sea por otra razón
 * (entidad pública, designado por resolución) lo tiene en el RUT, código 09 o
 * 23, y eso ya queda en sus condiciones.
 */
export function agenteIva(vigentes: string[]): {
  es: boolean;
  porque: string | null;
} {
  if (vigentes.includes('GRAN_CONTRIBUYENTE')) {
    return {
      es: true,
      porque: 'Por ser gran contribuyente (art. 437-2, numeral 1).',
    };
  }
  if (vigentes.includes('AGENTE_RETENEDOR_IVA')) {
    return { es: true, porque: 'Tu RUT lo dice (código 09 o 23).' };
  }
  return { es: false, porque: null };
}

export interface ResumenImpuestos {
  vasARetener: string[];
  teVanARetener: string[];
}

/**
 * «Lo que esto significa para vos»: el resumen que se arma solo con las
 * respuestas. Es la forma de que el dueño entienda lo que acaba de contestar,
 * y de que el contador vea de un vistazo si algo no cuadra.
 */
export function resumir(
  vigentes: string[],
  /** Nombres de los municipios donde es agente retenedor de ICA. */
  agenteIcaEn: string[],
): ResumenImpuestos {
  const tiene = (c: string) => vigentes.includes(c);
  const vasARetener: string[] = [];
  const teVanARetener: string[] = [];

  if (tiene('AGENTE_RETENEDOR_RENTA') || tiene('GRAN_CONTRIBUYENTE')) {
    vasARetener.push(
      'Retención en la fuente a tus proveedores (compras, servicios, honorarios…).',
    );
  }
  if (agenteIva(vigentes).es) {
    vasARetener.push('ReteIVA a los proveedores que te cobran IVA.');
  }
  if (agenteIcaEn.length > 0) {
    vasARetener.push(`ReteICA en ${unir(agenteIcaEn)}.`);
  }
  if (tiene('AUTORRETENEDOR_RENTA')) {
    vasARetener.push('Te autorretenés renta en tus propias ventas.');
  }

  // Quien está en el SIMPLE no es sujeto de retención de renta (art. 911 E.T.);
  // al autorretenedor tampoco le retienen: se retiene él.
  if (tiene('REGIMEN_SIMPLE')) {
    teVanARetener.push(
      'Renta no: en el SIMPLE no te practican retención en la fuente.',
    );
  } else if (tiene('AUTORRETENEDOR_RENTA')) {
    teVanARetener.push(
      'Renta no: como sos autorretenedor, tus clientes no te retienen.',
    );
  } else {
    teVanARetener.push(
      'Retención en la fuente, tus clientes que sean agentes.',
    );
  }
  if (tiene('RESPONSABLE_IVA')) {
    teVanARetener.push('ReteIVA, tus clientes que sean agentes de IVA.');
  }
  teVanARetener.push('ReteICA, tus clientes que sean agentes en su municipio.');

  return { vasARetener, teVanARetener };
}

function unir(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}
