import { BadRequestException } from '@nestjs/common';

import type { Tx } from '../../../common/db/tx.service';

/**
 * Validaciones contra los catálogos normativos, hechas dentro de la transacción.
 *
 * Las claves foráneas ya impiden guardar un código inválido, pero el error que
 * levanta Postgres nombra la restricción, no el problema. Acá se revisa antes
 * para poder decir qué se escribió mal y cuáles son los valores válidos, que es
 * lo que un formulario necesita mostrar.
 */

export async function exigirTipoDocumento(
  t: Tx,
  codigo: string,
): Promise<void> {
  const filas = await t.query<Array<{ codigo: string }>>(
    'SELECT codigo FROM tipo_documento_identidad WHERE codigo = $1 AND vigente',
    [codigo],
  );
  if (filas.length > 0) return;

  const validos = await t.query<Array<{ codigo: string }>>(
    'SELECT codigo FROM tipo_documento_identidad WHERE vigente ORDER BY codigo',
  );
  throw new BadRequestException(
    `El tipo de documento "${codigo}" no existe. Validos: ${validos.map((f) => f.codigo).join(', ')}.`,
  );
}

export async function exigirResponsabilidadFe(
  t: Tx,
  codigo: string,
): Promise<void> {
  const filas = await t.query<Array<{ codigo: string }>>(
    'SELECT codigo FROM responsabilidad_fiscal_fe WHERE codigo = $1',
    [codigo],
  );
  if (filas.length > 0) return;

  const validos = await t.query<Array<{ codigo: string }>>(
    'SELECT codigo FROM responsabilidad_fiscal_fe ORDER BY codigo',
  );
  throw new BadRequestException(
    `La responsabilidad fiscal "${codigo}" no esta en el anexo tecnico de la DIAN. Validas: ${validos.map((f) => f.codigo).join(', ')}.`,
  );
}

/**
 * Devuelve el nombre oficial de la clase CIIU. La descripción se congela dentro
 * de `empresa_actividad_economica`: el catálogo cambia de versión y el RUT
 * histórico no.
 */
export async function nombreCiiuOficial(
  t: Tx,
  codigo: string,
): Promise<string> {
  const [fila] = await t.query<Array<{ nombre: string }>>(
    'SELECT nombre FROM ciiu_clase WHERE codigo = $1',
    [codigo],
  );
  if (fila === undefined) {
    throw new BadRequestException(
      `La actividad CIIU "${codigo}" no existe en el catalogo DANE. Buscala en /catalogos/ciiu.`,
    );
  }
  return fila.nombre;
}

export async function exigirFormaAsociativa(
  t: Tx,
  codigo: string,
): Promise<void> {
  const filas = await t.query<Array<{ codigo: string }>>(
    'SELECT codigo FROM forma_asociativa WHERE codigo = $1',
    [codigo],
  );
  if (filas.length === 0) {
    throw new BadRequestException(
      `La forma asociativa "${codigo}" no existe. Consultala en /catalogos/formas-asociativas.`,
    );
  }
}
