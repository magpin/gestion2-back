import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Carpeta donde viven los archivos `.sql` con el DDL.
 *
 * El DDL tiene una sola copia: los `.sql` de `backend/db/migrations`. Las clases
 * de migracion son el envoltorio que TypeORM necesita para llevar la cuenta de
 * lo aplicado, no una segunda version del esquema. Duplicar el DDL en TypeScript
 * garantiza que tarde o temprano las dos copias se separen.
 *
 * La ruta resuelve igual desde `src/` (ts-node) que desde `dist/` (compilado):
 * en los dos casos dos niveles arriba es la raiz del backend.
 */
const CARPETA_SQL = join(__dirname, '..', '..', 'db', 'migrations');

/** Lee un archivo de DDL por nombre, sin extension. */
export function leerSql(nombre: string): string {
  return readFileSync(join(CARPETA_SQL, `${nombre}.sql`), 'utf8');
}
