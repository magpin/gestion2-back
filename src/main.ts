import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as cargarEnv } from 'dotenv';

import { TxService } from './common/db/tx.service';
import { ENTORNO, type Entorno } from './config/env';
import { AppModule } from './app.module';

cargarEnv();

async function arrancar(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = app.get<Entorno>(ENTORNO);

  app.setGlobalPrefix(env.prefijoApi);

  app.useGlobalPipes(
    new ValidationPipe({
      // Descarta cualquier campo que el DTO no declare. Sin esto, un cliente
      // podria mandar `activo: true` en un PATCH y colarlo a la consulta.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({ origin: true, credentials: true });

  // Avisa fuerte si la API quedo conectada con un rol que se salta RLS.
  await app.get(TxService).verificarAislamiento();

  await app.listen(env.puerto);
  new Logger('Arranque').log(
    `API escuchando en http://localhost:${env.puerto}/${env.prefijoApi} (${env.nodeEnv})`,
  );
}

void arrancar();
