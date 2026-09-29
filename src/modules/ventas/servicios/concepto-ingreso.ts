import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import type { NucleoApi } from '../../nucleo/nucleo.api';

/**
 * La cuenta de una línea de servicio u otro ingreso (Fase 8): la del concepto,
 * que tiene que ser de INGRESO, estar activo, no ser automático y tener una
 * cuenta del grupo 4. La usan la factura y la nota débito.
 */
export async function cuentaDeIngreso(
  nucleo: NucleoApi,
  ctx: CtxEmpresa,
  conceptoId: string,
  t: Tx,
): Promise<{ conceptoId: string; cuentaId: string }> {
  const concepto = await nucleo.concepto(ctx, conceptoId, t);
  if (!concepto.activo || concepto.automatico || concepto.tipo !== 'INGRESO') {
    throw new BadRequestException(
      `«${concepto.nombre}» no sirve para una línea de venta: elegí un concepto de ingreso.`,
    );
  }
  if (concepto.cuenta === null || !concepto.cuenta.codigo.startsWith('4')) {
    throw new BadRequestException(
      `«${concepto.nombre}» no tiene una cuenta de ingreso. Elegila en Contabilidad → Conceptos.`,
    );
  }
  return { conceptoId: concepto.id, cuentaId: concepto.cuenta.id };
}
