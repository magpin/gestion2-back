import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import type { Ctx } from '../ctx';

/**
 * El `EntityManager` de una transacción abierta. Es lo que un módulo le pasa a
 * otro para que se enganche a la misma transacción en vez de abrir la suya.
 */
export type Tx = EntityManager;

/**
 * Abre transacciones con el contexto de RLS puesto.
 *
 * Toda lectura y toda escritura pasan por acá. La razón es que las políticas de
 * seguridad de fila se apoyan en `app.tenant_id` / `app.empresa_id`, y esas
 * variables son locales a la transacción: fuera de una, valen NULL y las tablas
 * no devuelven nada.
 *
 * Se usa `set_config(..., true)` y no `SET LOCAL` porque `SET LOCAL` no acepta
 * parámetros, y concatenar el id del tenant dentro del SQL es exactamente la
 * clase de cosa que termina en inyección.
 */
@Injectable()
export class TxService {
  private readonly log = new Logger(TxService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Corre `fn` dentro de una transacción con el contexto del `ctx` aplicado.
   * Si ya viene un `tx`, se engancha a esa transacción y no abre otra: quien es
   * dueño de la tabla cabecera es quien abre la transacción.
   */
  async enContexto<T>(
    ctx: Ctx,
    fn: (tx: Tx) => Promise<T>,
    tx?: Tx,
  ): Promise<T> {
    if (tx !== undefined) {
      return fn(tx);
    }

    return this.ds.transaction(async (manager) => {
      await this.fijarContexto(manager, ctx);
      return fn(manager);
    });
  }

  /**
   * Corre `fn` con el contexto puesto y **deshace todo al final**, salga bien
   * o mal. Devuelve lo que `fn` devolvió.
   *
   * Es la verificación en seco del paso 7 de `asistente-conversacion.md`: el
   * asistente propone un cobro, y para saber si pasaría y qué asiento haría
   * se corre el mismo código del cobro de verdad, que valida y asienta, y se
   * deshace. Así la verificación no es una copia de las reglas que puede
   * quedar desfasada: son las reglas.
   *
   * Es seguro con la numeración: los consecutivos de los comprobantes salen
   * de un `UPDATE` que el rollback deshace. Las secuencias de Postgres
   * (`*_secuencia_seq`, 0036) sí avanzan, pero solo ordenan los saldos y un
   * hueco no se ve.
   */
  async simular<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.fijarContexto(qr.manager, ctx);
      return await fn(qr.manager);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  }

  /**
   * Transacción sin tenant: solo para el login, que ocurre antes de saber quién
   * es. Lo único que puede hacer es llamar a `fn_usuario_para_login`, que es
   * `SECURITY DEFINER` y devuelve nada más lo que el login necesita.
   */
  async sinContexto<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.ds.transaction((manager) => fn(manager));
  }

  /**
   * Fija la empresa dentro de una transaccion ya abierta.
   *
   * Hace falta al crear una empresa: sus tablas hijas —configuracion contable,
   * sedes— tienen politicas que exigen `app.empresa_id`, y cuando se estan
   * creando ese contexto todavia no existe. Sin esto, insertar la configuracion
   * contable de la empresa recien creada lo rechaza su propia politica.
   */
  async fijarEmpresa(tx: Tx, empresaId: string): Promise<void> {
    await tx.query('SELECT set_config($1, $2, true)', [
      'app.empresa_id',
      empresaId,
    ]);
  }

  private async fijarContexto(manager: EntityManager, ctx: Ctx): Promise<void> {
    await manager.query('SELECT set_config($1, $2, true)', [
      'app.tenant_id',
      ctx.tenantId,
    ]);
    await manager.query('SELECT set_config($1, $2, true)', [
      'app.empresa_id',
      ctx.empresaId ?? '',
    ]);
  }

  /**
   * Avisa al arrancar si la API se conectó con un rol que se salta RLS. Un
   * superusuario ignora las políticas incluso con FORCE activo, así que el
   * aislamiento entre clientes quedaría solo en manos del código.
   */
  async verificarAislamiento(): Promise<void> {
    const [fila] = await this.ds.query(
      'SELECT current_user AS usuario, usesuper AS superusuario, userepl AS replicacion, rolbypassrls AS bypassrls ' +
        'FROM pg_user JOIN pg_roles ON pg_roles.rolname = pg_user.usename ' +
        'WHERE usename = current_user',
    );

    if (fila === undefined) {
      return;
    }

    if (fila.superusuario || fila.bypassrls) {
      this.log.error(
        `La API esta conectada como "${fila.usuario}", que se salta Row Level Security. ` +
          'El aislamiento entre empresas NO esta activo. Configurar DB_APP_USERNAME=gestion_app.',
      );
    } else {
      this.log.log(
        `Conectado como "${fila.usuario}" — Row Level Security activo.`,
      );
    }
  }
}
