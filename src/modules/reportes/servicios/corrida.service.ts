import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';

export type ClaveCorrida =
  'VENTAS_POR_CLIENTE' | 'ANTIGUEDAD_CARTERA' | 'GUARDADO';
export type FormatoCorrida = 'HTML' | 'PDF' | 'XLSX';

/**
 * Quién sacó qué reporte, y cuándo. Escribe `reporte_corrida` (0049).
 *
 * Lo pide la pantalla para decir en cada tarjeta «la última vez que se
 * corrió», pero se guarda sobre todo por el rastro: en un sistema contable,
 * poder decir quién sacó la cartera de un cliente y en qué fecha es parte del
 * expediente. Mostrar datos también deja huella.
 */
@Injectable()
export class CorridaService {
  private readonly log = new Logger(CorridaService.name);

  constructor(private readonly tx: TxService) {}

  /**
   * Anota una corrida.
   *
   * **Si anotarla falla, el reporte sale igual.** El rastro importa, pero no
   * más que la hoja que alguien está esperando: un contador que no puede sacar
   * la cartera porque la tabla de corridas tuvo un problema es un contador sin
   * cartera. Se registra en el log, que es el rastro del rastro.
   */
  async registrar(
    ctx: CtxEmpresa,
    reporte: ClaveCorrida,
    parametros: Record<string, unknown>,
    formato: FormatoCorrida,
    guardadoId?: string,
  ): Promise<void> {
    try {
      await this.tx.enContexto(ctx, (t) =>
        t.query(
          `INSERT INTO reporte_corrida
             (empresa_id, reporte, guardado_id, parametros, formato, corrido_por)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            ctx.empresaId,
            reporte,
            guardadoId ?? null,
            JSON.stringify(parametros),
            formato,
            ctx.usuarioId,
          ],
        ),
      );
    } catch (error: unknown) {
      const motivo = error instanceof Error ? error.message : String(error);
      this.log.error(`No se pudo anotar la corrida de ${reporte}: ${motivo}`);
    }
  }

  /**
   * La última vez que se corrió cada reporte en esta empresa, por cualquiera.
   *
   * Por cualquiera y no por quien pregunta: la tarjeta dice «se corrió ayer»,
   * y lo útil es saber que alguien ya lo sacó, no solo si fui yo.
   */
  async ultimas(ctx: CtxEmpresa): Promise<Map<string, string>> {
    return this.tx.enContexto(ctx, async (t) => {
      const crudas = filas<{ clave: string; cuando: string }>(
        await t.query<Array<Record<string, unknown>>>(
          `SELECT DISTINCT ON (COALESCE(guardado_id::text, reporte))
                  COALESCE(guardado_id::text, reporte) AS clave,
                  corrido_en AS cuando
             FROM reporte_corrida
            ORDER BY COALESCE(guardado_id::text, reporte), corrido_en DESC`,
        ),
      );
      return new Map(
        crudas.map((c) => [c.clave, new Date(c.cuando).toISOString()]),
      );
    });
  }
}
