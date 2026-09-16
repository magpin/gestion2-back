import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ENTORNO, leerEntorno, type Entorno } from '../../config/env';
import { TxService } from './tx.service';

/**
 * Conexión de aprovisionamiento: `gestion_provision`, con BYPASSRLS.
 *
 * Existe porque el alta de un tenant ocurre antes de que haya tenant en sesión,
 * y RLS taparía la fila que se está creando. Es la única conexión que puede
 * saltarse el aislamiento, y solo la toca el alta de tenants.
 *
 * Si no está configurada en el entorno, el proveedor entrega `null` y el
 * endpoint responde 503 con un mensaje claro en vez de fallar de forma rara.
 */
export const DATA_SOURCE_PROVISION = Symbol('DATA_SOURCE_PROVISION');

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ENTORNO],
      useFactory: (env: Entorno) => ({
        type: 'postgres' as const,
        host: env.db.host,
        port: env.db.puerto,
        username: env.db.usuario,
        password: env.db.password,
        database: env.db.nombre,
        // `rejectUnauthorized: false` porque los proveedores administrados
        // rotan sus certificados intermedios y no publican una CA estable que
        // valga la pena fijar acá. El tráfico va cifrado igual; lo que no se
        // verifica es la identidad del servidor, que en una red privada o con
        // un host fijo es un riesgo distinto del de viajar en claro.
        ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
        // Sin entidades a proposito: el esquema vive en las migraciones SQL y los
        // repositorios consultan con SQL. Una segunda definicion del esquema en
        // decoradores terminaria separandose de la primera.
        entities: [],
        synchronize: false,
        migrationsRun: false,
        logging: env.nodeEnv === 'development' ? ['error', 'warn'] : ['error'],
      }),
    }),
  ],
  providers: [
    {
      provide: ENTORNO,
      useFactory: leerEntorno,
    },
    TxService,
    {
      provide: DATA_SOURCE_PROVISION,
      inject: [ENTORNO],
      useFactory: async (env: Entorno): Promise<DataSource | null> => {
        if (env.dbProvision === undefined) {
          return null;
        }
        const ds = new DataSource({
          type: 'postgres',
          host: env.db.host,
          port: env.db.puerto,
          username: env.dbProvision.usuario,
          password: env.dbProvision.password,
          database: env.db.nombre,
          entities: [],
          synchronize: false,
        });
        await ds.initialize();
        return ds;
      },
    },
  ],
  exports: [ENTORNO, TxService, DATA_SOURCE_PROVISION, TypeOrmModule],
})
export class DbModule {}
