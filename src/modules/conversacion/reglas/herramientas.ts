import type { RolCodigo } from '../../../common/ctx';
import type { Resultado } from '../../reportes/servicios/armador.service';
import {
  ORIGENES,
  origenesPara,
  type ClaveOrigen,
  type Origen,
} from '../../reportes/reglas/catalogo';

/**
 * Las herramientas con las que el asistente consulta los datos de la empresa
 * (paso 6 de `docs/planes/asistente-conversacion.md`). Puro: sin red y sin
 * base.
 *
 * **No hay una puerta nueva.** Cada herramienta es un origen del armador de
 * reportes (`reportes/reglas/catalogo.ts`) y corre por `ArmadorService.correr`,
 * igual que la pantalla de Reportes:
 *
 * - **El modelo solo ve los orígenes que el rol de quien pregunta puede
 *   correr** (`origenesPara`). Si igual pidiera otro, el servicio lo rechaza:
 *   `correr` vuelve a mirar los roles.
 * - **El modelo no escribe SQL.** Manda claves de columnas, como la pantalla, y
 *   la definición pasa por `validar` del armador antes de tocar la base.
 */

/** Las filas que ve el modelo por consulta. Para más, que agrupe o pida el total. */
export const FILAS_PARA_MODELO = 50;

/** Las consultas por turno. Si no le alcanza, lo dice en vez de seguir gastando. */
export const CONSULTAS_POR_TURNO = 4;

/** Los valores parecidos que devuelve `buscar_valores`. */
const COINCIDENCIAS = 20;

/** Desde cuándo, si el modelo no dice: la cartera y los saldos son de siempre. */
export const DESDE_SIEMPRE = '2000-01-01';

const PREFIJO = 'consultar_';

/** Lo que el SDK espera de una herramienta. Sin importar el SDK acá: es un objeto. */
export interface Herramienta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const enumDe = (claves: readonly string[]) => ({
  type: 'string',
  enum: [...claves],
});

function describirOrigen(o: Origen): string {
  const columnas = o.columnas
    .map((c) => {
      const extras = [
        c.tipo.toLowerCase(),
        c.filtro === 'LISTA'
          ? c.valores
            ? `filtra por lista: ${c.valores.join(', ')}`
            : 'filtra por lista (valores exactos: usá buscar_valores)'
          : c.filtro === 'RANGO'
            ? 'filtra por mínimo/máximo'
            : c.filtro === 'SI_NO'
              ? 'filtra por sí/no'
              : null,
        c.agrupable ? 'agrupa' : null,
      ].filter((e) => e !== null);
      return `- ${c.clave}: ${c.etiqueta} (${extras.join('; ')})`;
    })
    .join('\n');
  return `${o.pregunta}. Consulta el reporte de ${o.etiqueta.toLowerCase()} de la empresa, con los permisos de quien pregunta.

Las fechas filtran por ${o.fecha.split('.').pop()}. Sin fechas, va desde siempre hasta hoy.
Devuelve hasta ${FILAS_PARA_MODELO} filas y el total de todas: para sumar, agrupá o usá el total, no sumes filas a mano.

Columnas:
${columnas}`;
}

/** Una herramienta por origen que el rol puede correr, más la de buscar valores. */
export function herramientasPara(roles: readonly RolCodigo[]): Herramienta[] {
  const origenes = origenesPara(roles);
  if (origenes.length === 0) return [];

  const porOrigen = origenes.map((o): Herramienta => {
    const claves = o.columnas.map((c) => c.clave);
    const filtrables = o.columnas.filter((c) => c.filtro).map((c) => c.clave);
    const agrupables = o.columnas
      .filter((c) => c.agrupable)
      .map((c) => c.clave);
    return {
      name: `${PREFIJO}${o.clave.toLowerCase()}`,
      description: describirOrigen(o),
      input_schema: {
        type: 'object',
        properties: {
          columnas: { type: 'array', items: enumDe(claves), minItems: 1 },
          desde: { type: 'string', description: 'aaaa-mm-dd. Opcional.' },
          hasta: { type: 'string', description: 'aaaa-mm-dd. Opcional: hoy.' },
          filtros: {
            type: 'array',
            description: 'Se cumplen todos a la vez.',
            items: {
              type: 'object',
              properties: {
                columna: enumDe(filtrables),
                valores: { type: 'array', items: { type: 'string' } },
                minimo: { type: 'number' },
                maximo: { type: 'number' },
                valor: { type: 'boolean' },
              },
              required: ['columna'],
            },
          },
          agrupar: { type: 'array', items: enumDe(agrupables), maxItems: 2 },
          orden: {
            type: 'object',
            properties: {
              columna: enumDe(claves),
              direccion: { type: 'string', enum: ['ASC', 'DESC'] },
            },
            required: ['columna'],
          },
        },
        required: ['columnas'],
      },
    };
  });

  const listas = origenes.flatMap((o) =>
    o.columnas
      .filter((c) => c.filtro === 'LISTA' && c.catalogo !== undefined)
      .map((c) => `${o.clave}.${c.clave}`),
  );
  const buscar: Herramienta = {
    name: 'buscar_valores',
    description: `Los valores exactos de una columna de lista, como están escritos en los datos de la empresa. Usala antes de filtrar por un cliente, un proveedor, una cuenta o una categoría: el filtro compara el texto exacto, y «Papelería Central» puede estar escrito «PAPELERIA CENTRAL S.A.S.». Busca sin tildes ni mayúsculas y devuelve hasta ${COINCIDENCIAS}.`,
    input_schema: {
      type: 'object',
      properties: {
        columna: enumDe(listas),
        contiene: {
          type: 'string',
          description: 'Parte del nombre. Vacío trae los primeros.',
        },
      },
      required: ['columna'],
    },
  };

  return [...porOrigen, buscar];
}

/** De qué origen es una herramienta, o `undefined` si no es de consultar. */
export function origenDeHerramienta(nombre: string): ClaveOrigen | undefined {
  if (!nombre.startsWith(PREFIJO)) return undefined;
  const clave = nombre.slice(PREFIJO.length).toUpperCase();
  return clave in ORIGENES ? (clave as ClaveOrigen) : undefined;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lo que pidió el modelo, como la definición que manda la pantalla del
 * armador. **No valida**: eso lo hace `validar` del armador, el mismo de
 * siempre. Acá solo se completa lo que el modelo no tiene por qué saber: la
 * forma de cada filtro sale del catálogo, y sin fechas va desde siempre.
 */
export function definicionDesde(
  origen: ClaveOrigen,
  entrada: unknown,
  hoy: string,
): Record<string, unknown> {
  const e = esObjeto(entrada) ? entrada : {};
  const forma = (clave: unknown) =>
    ORIGENES[origen].columnas.find((c) => c.clave === clave)?.filtro;
  const filtros = Array.isArray(e.filtros)
    ? e.filtros.filter(esObjeto).map((f) => ({ ...f, forma: forma(f.columna) }))
    : [];
  return {
    origen,
    columnas: Array.isArray(e.columnas) ? e.columnas : [],
    fechas: {
      desde: typeof e.desde === 'string' ? e.desde : DESDE_SIEMPRE,
      hasta: typeof e.hasta === 'string' ? e.hasta : hoy,
    },
    filtros,
    agrupar: Array.isArray(e.agrupar) ? e.agrupar : [],
    orden: esObjeto(e.orden) ? e.orden : null,
  };
}

/**
 * El resultado, como lo lee el modelo: etiquetas en vez de claves, las filas
 * que entran y el total de todas. Cifras en texto, como las devuelve la base:
 * convertirlas a número perdería centavos.
 */
export function resultadoParaModelo(r: Resultado): string {
  const filas = r.filas.slice(0, FILAS_PARA_MODELO);
  const total =
    r.total === null
      ? null
      : Object.fromEntries(
          Object.entries(r.total.sumas).map(([i, v]) => [
            r.columnas[Number(i)].etiqueta,
            v,
          ]),
        );
  return JSON.stringify({
    rango: `${r.rango.desde} a ${r.rango.hasta}`,
    columnas: r.columnas.map((c) => c.etiqueta),
    filas,
    totalFilas: r.totalFilas,
    ...(r.totalFilas > filas.length
      ? {
          aviso: `Se muestran ${filas.length} de ${r.totalFilas} filas; el total es de todas.`,
        }
      : {}),
    total,
    subtotales: r.subtotales.slice(0, FILAS_PARA_MODELO).map((s) => ({
      grupo: s.grupo,
      filas: s.filas,
      sumas: Object.fromEntries(
        Object.entries(s.sumas).map(([i, v]) => [
          r.columnas[Number(i)].etiqueta,
          v,
        ]),
      ),
    })),
  });
}

/** Sin tildes ni mayúsculas, para buscar «papeleria» y encontrar «PAPELERÍA». */
export const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Los valores que contienen el texto buscado, hasta el tope. */
export function coincidencias(
  valores: readonly string[],
  contiene: string,
): string[] {
  const buscado = normalizar(contiene);
  return valores
    .filter((v) => buscado === '' || normalizar(v).includes(buscado))
    .slice(0, COINCIDENCIAS);
}
