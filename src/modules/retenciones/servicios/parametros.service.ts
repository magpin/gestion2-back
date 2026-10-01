import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { FotoParametros, TarifaLey } from './parametros.reglas';

/**
 * La ley a una fecha: UVT y tarifas vigentes. Plan motor de retenciones, Fase 0
 * (§0.6).
 *
 * Las tablas de la ley son de todos (sin RLS) y cambian pocas veces al año,
 * pero se leen en cada documento: por eso la foto se guarda por fecha. La
 * caché se limpia al cargar una vigencia nueva (`olvidar`), y como es por
 * proceso, en el peor caso un cambio tarda lo que tarde en reiniciar la API.
 */
@Injectable()
export class ParametrosService {
  private readonly cache = new Map<string, FotoParametros>();

  constructor(private readonly tx: TxService) {}

  async fotoEn(
    ctx: CtxEmpresa,
    fecha: string,
    tx?: Tx,
  ): Promise<FotoParametros> {
    const dia = fecha.slice(0, 10);
    const guardada = this.cache.get(dia);
    if (guardada !== undefined) return guardada;

    const cargar = async (t: Tx): Promise<FotoParametros> => {
      const [uvt] = filas<{ valor: string }>(
        await t.query('SELECT valor FROM uvt WHERE anio = $1', [
          Number(dia.slice(0, 4)),
        ]),
      );
      const tarifas = filas<{
        id: string;
        concepto_id: string;
        tipo_persona: 'NATURAL' | 'JURIDICA' | null;
        declarante: boolean | null;
        base_uvt: string;
        tarifa: string;
        vigencia_desde: string;
        vigencia_hasta: string | null;
        norma: string;
      }>(
        await t.query(
          `SELECT id, concepto_id, tipo_persona, declarante, base_uvt, tarifa,
                  vigencia_desde::text, vigencia_hasta::text, norma
             FROM retencion_tarifa
            WHERE vigencia_desde <= $1
              AND (vigencia_hasta IS NULL OR vigencia_hasta >= $1)`,
          [dia],
        ),
      );
      const tabla = filas<{
        desde_uvt: string;
        hasta_uvt: string | null;
        tarifa_marginal: string;
        uvt_adicionales: string;
        norma: string;
      }>(
        await t.query(
          `SELECT desde_uvt, hasta_uvt, tarifa_marginal, uvt_adicionales, norma
             FROM retencion_tabla_383
            WHERE vigencia_desde <= $1
              AND (vigencia_hasta IS NULL OR vigencia_hasta >= $1)
            ORDER BY desde_uvt`,
          [dia],
        ),
      );
      const ley = filas<{ clave: string; valor: string }>(
        await t.query(
          `SELECT clave, valor FROM retencion_parametro_ley
            WHERE vigencia_desde <= $1
              AND (vigencia_hasta IS NULL OR vigencia_hasta >= $1)`,
          [dia],
        ),
      );
      return {
        fecha: dia,
        uvt: uvt === undefined ? null : Number(uvt.valor),
        tabla383: tabla.map((f) => ({
          desdeUvt: Number(f.desde_uvt),
          hastaUvt: f.hasta_uvt === null ? null : Number(f.hasta_uvt),
          tarifaMarginal: Number(f.tarifa_marginal),
          uvtAdicionales: Number(f.uvt_adicionales),
          norma: f.norma,
        })),
        ley: Object.fromEntries(ley.map((f) => [f.clave, Number(f.valor)])),
        tarifas: tarifas.map((r): TarifaLey => ({
          id: r.id,
          conceptoId: r.concepto_id,
          tipoPersona: r.tipo_persona,
          declarante: r.declarante,
          baseUvt: Number(r.base_uvt),
          tarifa: Number(r.tarifa),
          vigenciaDesde: r.vigencia_desde,
          vigenciaHasta: r.vigencia_hasta,
          norma: r.norma,
        })),
      };
    };

    const foto =
      tx === undefined
        ? await this.tx.enContexto(ctx, cargar)
        : await cargar(tx);
    this.cache.set(dia, foto);
    return foto;
  }

  /** Se llama al cargar una vigencia nueva de tarifa o de UVT. */
  olvidar(): void {
    this.cache.clear();
  }
}
