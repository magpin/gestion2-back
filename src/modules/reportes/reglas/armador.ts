/**
 * El armador: de una definición a una consulta. Puro, sin base.
 *
 * Una **definición** es lo que el contador arma en la pantalla y lo que se
 * guarda: un origen, columnas, fechas, filtros, agrupación y orden. Todo son
 * **claves del catálogo**, nunca SQL. Este archivo hace dos cosas con ella:
 *
 * 1. **La valida** contra el catálogo. Una clave que no está, un filtro con una
 *    forma que la columna no admite, un tercer nivel de agrupación: se rechaza
 *    con un mensaje que dice qué sobra, antes de tocar la base.
 * 2. **La traduce a SQL** con parámetros. El único texto que se interpola es el
 *    del catálogo —`desde`, `fecha`, `donde` y el `sql` de cada columna—; todo
 *    lo que viene del cliente —fechas, valores de lista, montos— va como
 *    parámetro `$n`. Es la razón por la que armar reportes no es inyección de
 *    SQL con otro nombre.
 */
import type { Atajo } from './rango';
import {
  columnaDe,
  ORIGENES,
  sumaColumna,
  type ClaveOrigen,
  type Columna,
} from './catalogo';

/** Lo más que se trae para mostrar. Más que eso es trabajo para el Excel. */
export const LIMITE_FILAS = 5000;
/** La vista previa del armador: una muestra, no el resultado. */
export const LIMITE_MUESTRA = 50;
/** El Excel del armador: más filas que la pantalla, pero con techo. */
export const LIMITE_EXCEL = 50_000;
/** Cuánto puede tardar una corrida antes de que la base la corte. */
export const TIEMPO_MAXIMO = '20s';

const MAX_COLUMNAS = 20;
const MAX_VALORES_LISTA = 200;
const MAX_FILTROS = 20;

export type Fechas = { atajo: Atajo } | { desde: string; hasta: string };

export type Filtro =
  | { columna: string; forma: 'LISTA'; valores: string[] }
  | {
      columna: string;
      forma: 'RANGO';
      minimo?: number | null;
      maximo?: number | null;
    }
  | { columna: string; forma: 'SI_NO'; valor: boolean };

export interface Definicion {
  origen: ClaveOrigen;
  columnas: string[];
  fechas: Fechas;
  filtros: Filtro[];
  /** Hasta dos niveles. Tres ya es un tabulado, y eso es Excel. */
  agrupar: string[];
  orden?: { columna: string; direccion: 'ASC' | 'DESC' } | null;
}

export class DefinicionInvalida extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Valida una definición que llegó de afuera —el cuerpo de una petición o una
 * fila de `reporte_guardado`— y devuelve una limpia.
 *
 * Normaliza lo que es obvio: las columnas de agrupación se agregan a las
 * elegidas si faltaban, y las repetidas se quitan. Lo que no es obvio se
 * rechaza con un mensaje.
 */
export function validar(
  entrada: unknown,
  atajosValidos: readonly string[],
): Definicion {
  if (!esObjeto(entrada))
    throw new DefinicionInvalida('La definición del reporte no se entiende.');
  const origen = entrada.origen as ClaveOrigen;
  if (typeof origen !== 'string' || !(origen in ORIGENES)) {
    throw new DefinicionInvalida('Ese origen no existe.');
  }

  const columna = (clave: unknown, para: string): Columna => {
    const c = typeof clave === 'string' ? columnaDe(origen, clave) : undefined;
    if (!c) {
      throw new DefinicionInvalida(
        `«${String(clave)}» no es una columna de ${ORIGENES[origen].etiqueta.toLowerCase()} (${para}).`,
      );
    }
    return c;
  };

  // ── Agrupación ──
  const agrupar = Array.isArray(entrada.agrupar) ? entrada.agrupar : [];
  if (agrupar.length > 2) {
    throw new DefinicionInvalida(
      'Se agrupa hasta en dos niveles. Tres ya es un tabulado: para eso está el Excel.',
    );
  }
  for (const g of agrupar) {
    if (!columna(g, 'agrupación').agrupable) {
      throw new DefinicionInvalida(
        `No se puede agrupar por «${columna(g, 'agrupación').etiqueta}».`,
      );
    }
  }
  if (new Set(agrupar).size !== agrupar.length) {
    throw new DefinicionInvalida(
      'Los dos niveles de agrupación son la misma columna.',
    );
  }

  // ── Columnas ──
  if (!Array.isArray(entrada.columnas) || entrada.columnas.length === 0) {
    throw new DefinicionInvalida('Elige al menos una columna.');
  }
  const columnas = [
    ...new Set([
      ...(agrupar as string[]),
      ...(entrada.columnas as unknown[]).map(String),
    ]),
  ];
  if (columnas.length > MAX_COLUMNAS) {
    throw new DefinicionInvalida(
      `Son ${columnas.length} columnas; el máximo es ${MAX_COLUMNAS}.`,
    );
  }
  for (const c of columnas) columna(c, 'columnas');

  // ── Fechas ──
  let fechas: Fechas;
  const f = entrada.fechas;
  if (esObjeto(f) && typeof f.atajo === 'string') {
    if (!atajosValidos.includes(f.atajo))
      throw new DefinicionInvalida('Ese atajo de fechas no existe.');
    fechas = { atajo: f.atajo as Atajo };
  } else if (
    esObjeto(f) &&
    typeof f.desde === 'string' &&
    typeof f.hasta === 'string'
  ) {
    if (
      !ISO.test(f.desde) ||
      !ISO.test(f.hasta) ||
      Number.isNaN(Date.parse(f.desde)) ||
      Number.isNaN(Date.parse(f.hasta))
    ) {
      throw new DefinicionInvalida('Las fechas van como aaaa-mm-dd.');
    }
    if (f.desde > f.hasta)
      throw new DefinicionInvalida('«Desde» tiene que ser antes que «hasta».');
    fechas = { desde: f.desde, hasta: f.hasta };
  } else {
    throw new DefinicionInvalida(
      'Falta el rango de fechas: todo reporte lo tiene.',
    );
  }

  // ── Filtros ──
  const crudos = Array.isArray(entrada.filtros) ? entrada.filtros : [];
  if (crudos.length > MAX_FILTROS)
    throw new DefinicionInvalida('Son demasiados filtros.');
  const filtros: Filtro[] = crudos.map((crudo: unknown) => {
    if (!esObjeto(crudo))
      throw new DefinicionInvalida('Un filtro no se entiende.');
    const c = columna(crudo.columna, 'filtros');
    if (c.filtro === undefined || c.filtro !== crudo.forma) {
      throw new DefinicionInvalida(`«${c.etiqueta}» no se filtra así.`);
    }
    if (crudo.forma === 'LISTA') {
      const valores = Array.isArray(crudo.valores)
        ? crudo.valores.map(String)
        : [];
      if (valores.length === 0)
        throw new DefinicionInvalida(
          `El filtro de «${c.etiqueta}» no tiene valores.`,
        );
      if (valores.length > MAX_VALORES_LISTA) {
        throw new DefinicionInvalida(
          `El filtro de «${c.etiqueta}» tiene más de ${MAX_VALORES_LISTA} valores.`,
        );
      }
      if (c.valores && valores.some((v) => !c.valores!.includes(v))) {
        throw new DefinicionInvalida(`«${c.etiqueta}» no tiene ese valor.`);
      }
      return { columna: c.clave, forma: 'LISTA', valores };
    }
    if (crudo.forma === 'RANGO') {
      const numero = (v: unknown): number | null => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n))
          throw new DefinicionInvalida(
            `El filtro de «${c.etiqueta}» lleva un número que no es número.`,
          );
        return n;
      };
      const minimo = numero(crudo.minimo);
      const maximo = numero(crudo.maximo);
      if (minimo === null && maximo === null) {
        throw new DefinicionInvalida(
          `El filtro de «${c.etiqueta}» no tiene ni mínimo ni máximo.`,
        );
      }
      if (minimo !== null && maximo !== null && minimo > maximo) {
        throw new DefinicionInvalida(
          `En «${c.etiqueta}», el mínimo es mayor que el máximo.`,
        );
      }
      return { columna: c.clave, forma: 'RANGO', minimo, maximo };
    }
    if (typeof crudo.valor !== 'boolean') {
      throw new DefinicionInvalida(
        `El filtro de «${c.etiqueta}» es de sí o no.`,
      );
    }
    return { columna: c.clave, forma: 'SI_NO', valor: crudo.valor };
  });

  // ── Orden ──
  let orden: Definicion['orden'] = null;
  if (esObjeto(entrada.orden)) {
    const c = columna(entrada.orden.columna, 'orden');
    const direccion = entrada.orden.direccion === 'DESC' ? 'DESC' : 'ASC';
    orden = { columna: c.clave, direccion };
  }

  return {
    origen,
    columnas,
    fechas,
    filtros,
    agrupar: agrupar as string[],
    orden,
  };
}

export interface Consulta {
  sql: string;
  parametros: unknown[];
}

/** Cómo sale cada tipo: texto listo para leer, sin depender de cómo el driver pase números o fechas. */
function salida(c: Columna): string {
  switch (c.tipo) {
    case 'FECHA':
      return `TO_CHAR(${c.sql}, 'YYYY-MM-DD')`;
    case 'DINERO':
    case 'CANTIDAD':
      return `(${c.sql})::numeric::text`;
    default:
      return `(${c.sql})::text`;
  }
}

/** El `FROM … WHERE …` que comparten las filas y los totales. */
function desdeYDonde(
  def: Definicion,
  rango: { desde: string; hasta: string },
): Consulta {
  const origen = ORIGENES[def.origen];
  const parametros: unknown[] = [rango.desde, rango.hasta];
  const condiciones = [`${origen.fecha} BETWEEN $1::date AND $2::date`];
  if (origen.donde) condiciones.push(`(${origen.donde})`);

  for (const filtro of def.filtros) {
    const c = columnaDe(def.origen, filtro.columna)!;
    if (filtro.forma === 'LISTA') {
      parametros.push(filtro.valores);
      condiciones.push(`(${c.sql})::text = ANY($${parametros.length}::text[])`);
    } else if (filtro.forma === 'RANGO') {
      if (filtro.minimo !== null && filtro.minimo !== undefined) {
        parametros.push(filtro.minimo);
        condiciones.push(`(${c.sql}) >= $${parametros.length}::numeric`);
      }
      if (filtro.maximo !== null && filtro.maximo !== undefined) {
        parametros.push(filtro.maximo);
        condiciones.push(`(${c.sql}) <= $${parametros.length}::numeric`);
      }
    } else {
      // Las columnas de sí o no del catálogo devuelven «Sí» o «No».
      parametros.push(filtro.valor ? 'Sí' : 'No');
      condiciones.push(`(${c.sql}) = $${parametros.length}`);
    }
  }

  return {
    sql: `FROM ${origen.desde}\n WHERE ${condiciones.join('\n   AND ')}`,
    parametros,
  };
}

/**
 * Las filas, en el orden de las columnas elegidas: `c0`, `c1`…
 *
 * Primero por los grupos —para que las filas de un mismo grupo queden juntas—
 * y después por el orden elegido. Se pide **una de más** que el límite: si
 * llega, hay más filas de las que se muestran y la pantalla lo dice.
 */
export function consultaFilas(
  def: Definicion,
  rango: { desde: string; hasta: string },
  limite: number,
): Consulta {
  const base = desdeYDonde(def, rango);
  const cols = def.columnas.map((k) => columnaDe(def.origen, k)!);
  const seleccion = cols.map((c, i) => `${salida(c)} AS "c${i}"`).join(', ');

  const orden: string[] = def.agrupar.map(
    (g) => `${columnaDe(def.origen, g)!.sql} ASC NULLS LAST`,
  );
  if (def.orden) {
    orden.push(
      `${columnaDe(def.origen, def.orden.columna)!.sql} ${def.orden.direccion} NULLS LAST`,
    );
  }
  // Un desempate estable: sin él, dos corridas iguales pueden devolver las
  // filas en otro orden, y la vista previa «salta» sin que nada haya cambiado.
  orden.push(ORIGENES[def.origen].fecha);

  return {
    sql: `SELECT ${seleccion}\n  ${base.sql}\n ORDER BY ${orden.join(', ')}\n LIMIT ${Math.floor(limite) + 1}`,
    parametros: base.parametros,
  };
}

/**
 * Los totales y los subtotales **de todas las filas**, no solo de las que se
 * muestran: con cinco mil de cincuenta mil en pantalla, un subtotal sumado en
 * el navegador mentiría.
 *
 * Una sola consulta con `GROUPING SETS`: el total general, el de cada grupo de
 * primer nivel y el de cada grupo de segundo nivel. `nivel` dice cuál es cuál.
 */
export function consultaTotales(
  def: Definicion,
  rango: { desde: string; hasta: string },
): Consulta {
  const base = desdeYDonde(def, rango);
  const sumas = def.columnas
    .map((k) => columnaDe(def.origen, k)!)
    .map((c, i) =>
      sumaColumna(c) ? `SUM(${c.sql})::numeric::text AS "s${i}"` : null,
    )
    .filter((s): s is string => s !== null);

  const grupos = def.agrupar.map((g) => columnaDe(def.origen, g)!);
  const claves = grupos.map((g, i) => `${salida(g)} AS "g${i}"`);
  const seleccion = ['COUNT(*)::int AS filas', ...claves, ...sumas];

  if (grupos.length === 0) {
    return {
      sql: `SELECT ${seleccion.join(', ')}\n  ${base.sql}`,
      parametros: base.parametros,
    };
  }

  const expr = grupos.map((g) => salida(g));
  const conjuntos =
    grupos.length === 1
      ? `(), (${expr[0]})`
      : `(), (${expr[0]}), (${expr[0]}, ${expr[1]})`;
  // `GROUPING(x)` vale 1 cuando x no participa del conjunto: con eso se sabe
  // si la fila es el total, un grupo de primer nivel o uno de segundo.
  const nivel =
    grupos.length === 1
      ? `(1 - GROUPING(${expr[0]}))`
      : `(1 - GROUPING(${expr[0]})) + (1 - GROUPING(${expr[1]}))`;

  return {
    sql: `SELECT (${nivel})::int AS nivel, ${seleccion.join(', ')}\n  ${base.sql}\n GROUP BY GROUPING SETS (${conjuntos})`,
    parametros: base.parametros,
  };
}
