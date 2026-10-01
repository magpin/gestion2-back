import { BadRequestException } from '@nestjs/common';

/**
 * «No existe o está inactiva la cuenta de cartera (130505)», con el código
 * aparte (`cuentaCodigo`): la pantalla lo usa para ofrecer «Ir al plan de
 * cuentas» ya filtrado en esa cuenta, en vez de dejar a la persona buscándola.
 */
export function cuentaInactiva(
  descripcion: string,
  codigo: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: `No existe o está inactiva la cuenta de ${descripcion} (${codigo}). Actívela en Plan de cuentas.`,
    cuentaCodigo: codigo,
  });
}
