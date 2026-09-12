import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';

export interface CajaConfiguracion {
  empresa_id: string;
  cuenta_diferencia_id: string | null;
}

/**
 * Contra qué cuenta se ajusta un faltante o sobrante de arqueo. Una fila
 * por empresa, elegida una sola vez por quien tiene criterio contable
 * (`CONTADOR`/`DIRECTOR`) — mismo patrón que `ConfiguracionService` de
 * inventario, mismo motivo: sin ella, `CajaArqueoService.cerrar` rechaza
 * cerrar un arqueo con diferencia.
 */
@Injectable()
export class CajaConfiguracionService {
  constructor(private readonly tx: TxService) {}

  /** `cuenta_diferencia_id` viene `null` si nadie la ha fijado todavía. */
  async obtener(ctx: CtxEmpresa, tx?: Tx): Promise<CajaConfiguracion> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const encontrada = fila<CajaConfiguracion>(
          await t.query(
            'SELECT empresa_id, cuenta_diferencia_id FROM caja_configuracion WHERE empresa_id = $1',
            [ctx.empresaId],
          ),
        );
        return (
          encontrada ?? {
            empresa_id: ctx.empresaId,
            cuenta_diferencia_id: null,
          }
        );
      },
      tx,
    );
  }

  /**
   * `UPSERT`: la primera vez inserta, después actualiza. Si
   * `cuentaDiferenciaId` no existe o es de otra empresa, la FK compuesta
   * (`fk_caja_config_cuenta`) lo rechaza.
   */
  async fijarCuentaDiferencia(
    ctx: CtxEmpresa,
    cuentaDiferenciaId: string,
  ): Promise<CajaConfiguracion> {
    return this.tx.enContexto(ctx, async (t) => {
      const guardada = fila<CajaConfiguracion>(
        await t.query(
          `INSERT INTO caja_configuracion (empresa_id, cuenta_diferencia_id)
           VALUES ($1, $2)
           ON CONFLICT (empresa_id) DO UPDATE SET cuenta_diferencia_id = EXCLUDED.cuenta_diferencia_id
           RETURNING empresa_id, cuenta_diferencia_id`,
          [ctx.empresaId, cuentaDiferenciaId],
        ),
      );
      if (guardada === undefined) {
        throw new BadRequestException('No se pudo guardar la configuracion.');
      }
      return guardada;
    });
  }
}
