/**
 * Qué recuerda María de una factura a la siguiente, y cuándo lo recordado
 * vale. Sin red y sin base de datos.
 *
 * La regla de fondo: **aprende de personas, nunca de sí misma.** Solo se
 * guarda lo que alguien contestó al registrar una compra. Lo que el cruce
 * encontró solo —por código, por nombre, «era el único que se parecía»— no se
 * guarda nunca: si fue un error, se grabaría y se confirmaría solo cada mes.
 *
 * Y guarda el destino, nunca el monto: la cantidad y el precio salen del papel
 * de cada factura.
 */

import { comparable, esCuentaDeGasto, type FormaDeCruce } from './cruce.reglas';

const MESES = new Set([
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'SETIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
]);

/**
 * El texto con que se recuerda un renglón, o `null` si no queda nada con qué
 * reconocerlo.
 *
 * **En un producto, el texto entero.** Ahí los números son el producto:
 * «TORNILLO 1/2» y «TORNILLO 3/8» son dos cosas, y juntarlos mandaría uno al
 * kardex del otro.
 *
 * **En un gasto, sin meses ni palabras con dígitos.** Una cuenta de cobro de
 * arriendo dice «OCTUBRE 2026» este mes y «NOVIEMBRE 2026» el que viene: con el
 * texto exacto, la memoria no serviría justo para lo que se hizo.
 */
export function llaveDelRenglon(renglon: {
  clase: 'PRODUCTO' | 'GASTO';
  descripcion: string;
}): string | null {
  const texto = comparable(renglon.descripcion);
  if (renglon.clase === 'PRODUCTO') {
    return texto === '' ? null : texto;
  }

  const quedan = texto
    .split(' ')
    .filter((palabra) => !/\d/.test(palabra))
    .filter((palabra) => !MESES.has(palabra.replace(/[^A-Z]/g, '')))
    // Lo que queda sin una sola letra —un guion, una barra— no dice nada.
    .filter((palabra) => /[A-Z]/.test(palabra));

  return quedan.length === 0 ? null : quedan.join(' ');
}

/** Cómo está hoy aquello que se recordó. */
export type DestinoRecordado =
  | { clase: 'PRODUCTO'; existe: boolean; activo: boolean }
  | {
      clase: 'GASTO';
      existe: boolean;
      activa: boolean;
      esAuxiliar: boolean;
      codigo: string;
    };

/**
 * Por qué lo recordado ya no sirve, o `null` si sirve.
 *
 * Cuando no sirve, el renglón **vuelve a preguntar** sin error: la respuesta
 * era buena cuando se dio y el catálogo cambió después. Lo que no se hace es
 * registrar contra un producto inactivo porque alguien lo dijo hace seis meses.
 */
export function porQueNoSirve(destino: DestinoRecordado): string | null {
  if (!destino.existe) return 'ya no existe';
  if (destino.clase === 'PRODUCTO') {
    return destino.activo ? null : 'el producto está inactivo';
  }
  if (!destino.activa) return `la cuenta ${destino.codigo} está inactiva`;
  if (!destino.esAuxiliar) {
    return `la cuenta ${destino.codigo} ya no recibe movimientos`;
  }
  if (!esCuentaDeGasto(destino.codigo)) {
    return `la cuenta ${destino.codigo} no es de gasto`;
  }
  return null;
}

/** Lo que se hace con cada renglón al registrar la compra. */
export type Aprendizaje =
  | {
      /** Una persona lo contestó: se guarda, o reemplaza lo que había. */
      tipo: 'RESPUESTA';
      clase: 'PRODUCTO' | 'GASTO';
      texto: string;
      ejemplo: string;
      productoId?: string;
      cuentaId?: string;
    }
  | {
      /** Venía recordado y nadie lo cambió: se usó una vez más. */
      tipo: 'USO';
      clase: 'PRODUCTO' | 'GASTO';
      texto: string;
    };

/**
 * De los renglones de una factura que se está registrando, qué se aprende.
 *
 * Solo dos casos, y todo lo demás se ignora:
 *
 * - **Lo que contestó una persona.** También si cambió algo que el cruce había
 *   resuelto: es su respuesta, y la última respuesta de una persona es la que
 *   manda.
 * - **Lo que venía recordado y se dejó igual**, que solo suma un uso.
 */
export function queAprender(
  renglones: Array<{
    orden: number;
    leido: { clase: 'PRODUCTO' | 'GASTO'; descripcion: string };
    forma?: FormaDeCruce;
  }>,
  respuestas: Array<{ orden: number; productoId?: string; cuentaId?: string }>,
): Aprendizaje[] {
  const aMano = new Map(respuestas.map((r) => [r.orden, r]));
  const salida: Aprendizaje[] = [];

  for (const renglon of renglones) {
    const texto = llaveDelRenglon(renglon.leido);
    if (texto === null) continue;

    const respuesta = aMano.get(renglon.orden);
    if (respuesta !== undefined) {
      // Una respuesta con los dos o con ninguno no llega hasta acá: el
      // registro la rechaza antes. Igual no se guarda algo que no se entiende.
      if (
        (respuesta.productoId === undefined) ===
        (respuesta.cuentaId === undefined)
      ) {
        continue;
      }
      salida.push({
        tipo: 'RESPUESTA',
        clase: renglon.leido.clase,
        texto,
        ejemplo: renglon.leido.descripcion,
        ...(respuesta.productoId !== undefined && {
          productoId: respuesta.productoId,
        }),
        ...(respuesta.cuentaId !== undefined && {
          cuentaId: respuesta.cuentaId,
        }),
      });
      continue;
    }

    if (renglon.forma === 'APRENDIDO') {
      salida.push({ tipo: 'USO', clase: renglon.leido.clase, texto });
    }
  }

  // Dos renglones con el mismo texto en la misma factura son una sola llave.
  // Una respuesta le gana a un uso —es lo que alguien acaba de decir—, y entre
  // dos respuestas gana la última.
  const porLlave = new Map<string, Aprendizaje>();
  for (const a of salida) {
    const llave = `${a.clase}|${a.texto}`;
    if (a.tipo === 'RESPUESTA' || porLlave.get(llave)?.tipo !== 'RESPUESTA') {
      porLlave.set(llave, a);
    }
  }
  return [...porLlave.values()];
}
