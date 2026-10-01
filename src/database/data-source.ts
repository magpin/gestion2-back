import 'reflect-metadata';
import { join } from 'node:path';
import { config as cargarEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import '../common/db/tipos-pg';

cargarEnv();

/**
 * Fuente unica de configuracion de la base. La leen la CLI de TypeORM
 * (`yarn migration:run`, `migration:show`, `migration:revert`) y, mas adelante,
 * el modulo de Nest.
 *
 * `synchronize` esta en false a proposito y se queda asi: todo cambio de esquema
 * pasa por una migracion revisable.
 *
 * Las migraciones corren con el usuario duenio de la base (postgres), que es
 * quien puede crear extensiones y roles. La API en cambio se conecta como
 * `gestion_app`, que esta sujeto a RLS y no tiene privilegio DELETE.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'db_gestion5',
  // Mismo criterio que la API (`env.ts`): los proveedores administrados exigen
  // TLS y se reconocen por el host.
  ssl:
    process.env.DB_SSL === 'true' ||
    (process.env.DB_SSL === undefined &&
      /neon\.tech|amazonaws\.com|supabase\.co|azure\.com/.test(
        process.env.DB_HOST ?? '',
      ))
      ? { rejectUnauthorized: false }
      : false,
  schema: 'public',
  synchronize: false,
  logging: ['error', 'migration', 'schema'],
  entities: [],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsTableName: 'migraciones',
});
