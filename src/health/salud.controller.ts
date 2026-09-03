import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Publico } from '../common/auth/decoradores';

@Controller('salud')
export class SaludController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Estado de la conexión y del aislamiento.
   *
   * Informa con qué rol está conectada la API y si ese rol se salta RLS: si la
   * respuesta dice `aislamientoActivo: false`, las políticas de seguridad de fila
   * no están protegiendo nada y hay que revisar `DB_APP_USERNAME`.
   */
  @Publico()
  @Get()
  async estado() {
    try {
      const [fila] = await this.ds.query(
        `SELECT current_user AS usuario,
                r.rolsuper     AS superusuario,
                r.rolbypassrls AS bypassrls,
                (SELECT count(*)::int FROM information_schema.tables
                  WHERE table_schema = 'public') AS tablas
           FROM pg_roles r WHERE r.rolname = current_user`,
      );

      return {
        estado: 'ok',
        base: {
          conectada: true,
          usuario: fila.usuario,
          tablas: fila.tablas,
          aislamientoActivo: !fila.superusuario && !fila.bypassrls,
        },
      };
    } catch (error) {
      return {
        estado: 'degradado',
        base: { conectada: false, detalle: (error as Error).message },
      };
    }
  }
}
