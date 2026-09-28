/**
 * Las columnas `date` salen de la base como texto `AAAA-MM-DD`, no como `Date`.
 *
 * Por defecto node-postgres convierte un `date` en un `Date` a la medianoche
 * **de la zona del servidor**. El servidor corre en UTC, así que el 28 de
 * septiembre viajaba como `2026-09-28T00:00:00.000Z`, y un navegador en
 * Colombia (UTC-5) lo pintaba como el 27. Una fecha sin hora no es un instante:
 * es un día del calendario, y el único formato que no se corre de zona es el
 * texto.
 *
 * Además es lo que el resto del backend ya supone: los tipos de las filas
 * declaran `fecha: string`, las reglas comparan `AAAA-MM-DD` con `<` y
 * `localeCompare`, y muchas consultas ya hacían `fecha::text` para lo mismo.
 *
 * Solo cambia `date` (y su arreglo). `timestamptz` y `timestamp` siguen
 * llegando como `Date`: esos sí son instantes y el navegador debe pasarlos a la
 * hora de Colombia.
 *
 * El parser es global del módulo `pg` —lo comparten todas las conexiones, la de
 * la API, la de aprovisionamiento y la de las migraciones—, y registrarlo dos
 * veces no hace daño.
 */

interface TiposPg {
  setTypeParser(oid: number, parser: (valor: string) => unknown): void;
  getTypeParser(oid: number): (valor: string) => unknown;
}

// `pg` no trae tipos propios y `@types/pg` no está instalado; lo único que se
// usa de él es esto.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { types } = require('pg') as { types: TiposPg };

/** OID de `date` en PostgreSQL. */
export const OID_DATE = 1082;
/** OID de `date[]`. */
export const OID_DATE_ARRAY = 1182;
/** OID de `text[]`: su parser es el que sirve para `date[]` como texto. */
const OID_TEXT_ARRAY = 1009;

export function fechasComoTexto(): void {
  types.setTypeParser(OID_DATE, (valor) => valor);
  types.setTypeParser(OID_DATE_ARRAY, types.getTypeParser(OID_TEXT_ARRAY));
}

fechasComoTexto();
