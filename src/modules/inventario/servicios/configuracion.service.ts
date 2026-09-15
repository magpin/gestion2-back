import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';

export interface InventarioConfiguracion {
  empresa_id: string;
  cuenta_ajuste_id: string | null;
  /**
   * Si la empresa acepta facturar sin existencia. `false` por defecto: el
   * kardex —por trigger, ver `0037`— rechaza la salida. Con `true`, quien
   * factura todavía tiene que confirmarlo documento por documento.
   */
  permite_existencia_negativa: boolean;
}

/**
 * Contra qué cuenta se asienta un ajuste de existencias. Una fila por
 * empresa, elegida una sola vez por quien tiene criterio contable
 * (`CONTADOR`/`DIRECTOR`) — ver el porqué en `0025_producto_inventario.sql`.
 */
@Injectable()
export class ConfiguracionService {
  constructor(private readonly tx: TxService) {}

  /** `cuenta_ajuste_id` viene `null` si nadie la ha fijado todavía. */
  async obtener(ctx: CtxEmpresa, tx?: Tx): Promise<InventarioConfiguracion> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const encontrada = fila<InventarioConfiguracion>(
          await t.query(
            `SELECT empresa_id, cuenta_ajuste_id, permite_existencia_negativa
               FROM inventario_configuracion WHERE empresa_id = $1`,
            [ctx.empresaId],
          ),
        );
        return (
          encontrada ?? {
            empresa_id: ctx.empresaId,
            cuenta_ajuste_id: null,
            permite_existencia_negativa: false,
          }
        );
      },
      tx,
    );
  }

  /**
   * `UPSERT`: la primera vez inserta, después actualiza. Si `cuentaAjusteId`
   * no existe o es de otra empresa, la FK compuesta lo rechaza.
   */
  async fijarCuentaAjuste(
    ctx: CtxEmpresa,
    cuentaAjusteId: string,
  ): Promise<InventarioConfiguracion> {
    return this.tx.enContexto(ctx, async (t) => {
      const guardada = fila<InventarioConfiguracion>(
        await t.query(
          `INSERT INTO inventario_configuracion (empresa_id, cuenta_ajuste_id)
           VALUES ($1, $2)
           ON CONFLICT (empresa_id) DO UPDATE SET cuenta_ajuste_id = EXCLUDED.cuenta_ajuste_id
           RETURNING empresa_id, cuenta_ajuste_id, permite_existencia_negativa`,
          [ctx.empresaId, cuentaAjusteId],
        ),
      );
      if (guardada === undefined) {
        throw new BadRequestException('No se pudo guardar la configuracion.');
      }
      return guardada;
    });
  }

  /**
   * Habilita o apaga el descubierto para toda la empresa.
   *
   * Es una decisión de quien responde por el inventario, tomada una vez y no
   * documento por documento: con esto apagado, la confirmación de quien
   * factura no alcanza y el kardex rechaza la salida igual.
   */
  async fijarExistenciaNegativa(
    ctx: CtxEmpresa,
    permite: boolean,
  ): Promise<InventarioConfiguracion> {
    return this.tx.enContexto(ctx, async (t) => {
      const guardada = fila<InventarioConfiguracion>(
        await t.query(
          `INSERT INTO inventario_configuracion (empresa_id, permite_existencia_negativa)
           VALUES ($1, $2)
           ON CONFLICT (empresa_id) DO UPDATE
             SET permite_existencia_negativa = EXCLUDED.permite_existencia_negativa
           RETURNING empresa_id, cuenta_ajuste_id, permite_existencia_negativa`,
          [ctx.empresaId, permite],
        ),
      );
      if (guardada === undefined) {
        throw new BadRequestException('No se pudo guardar la configuracion.');
      }
      return guardada;
    });
  }
}
