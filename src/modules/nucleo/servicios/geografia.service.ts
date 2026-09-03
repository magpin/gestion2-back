import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Catálogo DANE. Es compartido entre todos los tenants y no lleva RLS, así que
 * se consulta directo sin abrir transacción ni fijar contexto.
 *
 * La DIAN exige el código de municipio en la factura electrónica y la tarifa de
 * ICA depende del municipio, por eso el catálogo vive en `nucleo` y no en un
 * módulo posterior.
 */
@Injectable()
export class GeografiaService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async departamentos(): Promise<Array<{ codigo: string; nombre: string }>> {
    return this.ds.query(
      'SELECT codigo, nombre FROM departamento ORDER BY nombre',
    );
  }

  async municipios(
    departamento?: string,
    q?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const condiciones: string[] = [];
    const params: unknown[] = [];

    if (departamento !== undefined && departamento !== '') {
      params.push(departamento);
      condiciones.push(`m.departamento_codigo = $${params.length}`);
    }
    if (q !== undefined && q.trim() !== '') {
      params.push(`%${q.trim()}%`);
      condiciones.push(
        `fn_normalizar(m.nombre) LIKE fn_normalizar($${params.length})`,
      );
    }

    const where =
      condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;
    return this.ds.query(
      `SELECT m.codigo, m.nombre, m.departamento_codigo, d.nombre AS departamento_nombre
         FROM municipio m
         JOIN departamento d ON d.codigo = m.departamento_codigo
         ${where}
        ORDER BY d.nombre, m.nombre
        LIMIT 300`,
      params,
    );
  }
}
