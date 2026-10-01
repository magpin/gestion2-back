import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { TipoRetencion } from '../dto/retencion.dto';

export interface ConceptoRetencion {
  id: string;
  anio: number | null;
  tipo: TipoRetencion;
  codigo: string;
  nombre: string;
  /** Lo que la empresa retiene (pasivo). NULL si no es agente de ese impuesto (0076). */
  cuenta_id: string | null;
  /** Lo que a la empresa le retienen (anticipo, 1355xx). */
  cuenta_activo_id: string | null;
  activo: boolean;
  /** Los códigos de las cuentas, para que la pantalla no tenga que ir a buscarlos. */
  cuenta_codigo: string | null;
  cuenta_activo_codigo: string | null;
  /**
   * El concepto de la ley al que corresponde (0075): la tarifa sale de la ley
   * a la fecha del documento. Una fila vieja sin equivalente no tiene tarifa.
   */
  concepto_nacional_id: string | null;
}

export interface TarifaVigencia {
  tipoPersona: 'NATURAL' | 'JURIDICA' | null;
  declarante: boolean | null;
  baseUvt: number;
  /** Fracción: 0.025 es 2,5 %. */
  tarifa: number;
  vigenciaDesde: string;
  vigenciaHasta: string | null;
  norma: string;
  observacion: string | null;
  validadoPor: string;
  validadoEn: string;
}

export interface ConceptoLey {
  id: string;
  codigo: string;
  nombre: string;
  impuesto: TipoRetencion;
  base_es_iva: boolean;
  tarifas: TarifaVigencia[];
}

const CAMPOS = `id, anio, tipo, codigo, nombre,
                cuenta_id, cuenta_activo_id, activo, concepto_nacional_id,
                (SELECT c.codigo FROM empresa_cuenta c WHERE c.id = retencion_concepto.cuenta_id) AS cuenta_codigo,
                (SELECT c.codigo FROM empresa_cuenta c WHERE c.id = retencion_concepto.cuenta_activo_id) AS cuenta_activo_codigo`;

/**
 * Los conceptos de retención de la empresa: cada concepto de la ley enlazado a
 * sus cuentas. **Solo se leen.** Los enlaces los crea la base (0076) cuando
 * existe la cuenta, y las tarifas y la UVT son de la ley: las carga la
 * plataforma con su norma y quién las validó (plan motor de retenciones, Fase 0).
 */
@Injectable()
export class RetencionService {
  constructor(private readonly tx: TxService) {}

  // --- UVT --------------------------------------------------------------

  async listarUvt(
    ctx: CtxEmpresa,
  ): Promise<Array<{ anio: number; valor: string }>> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<{ anio: number; valor: string }>(
        await t.query('SELECT anio, valor FROM uvt ORDER BY anio DESC'),
      ),
    );
  }

  /**
   * La UVT del año de una fecha. Del año del **documento**, no del actual: una
   * factura de 2025 se explica con la UVT de 2025.
   */
  async uvtDe(ctx: CtxEmpresa, fecha: string, tx?: Tx): Promise<number | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const anio = Number(fecha.slice(0, 4));
        const encontrada = fila<{ valor: string }>(
          await t.query('SELECT valor FROM uvt WHERE anio = $1', [anio]),
        );
        return encontrada === undefined ? null : Number(encontrada.valor);
      },
      tx,
    );
  }

  // --- La ley -----------------------------------------------------------

  /**
   * Los conceptos de la ley con todas sus vigencias. Son de todos (sin RLS) y
   * pocos: la pantalla arma la línea de tiempo y marca la que rige hoy.
   */
  async ley(ctx: CtxEmpresa): Promise<ConceptoLey[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<ConceptoLey>(
        await t.query(
          `SELECT n.id, n.codigo, n.nombre, n.impuesto, n.base_es_iva,
                  coalesce(json_agg(json_build_object(
                    'tipoPersona', r.tipo_persona,
                    'declarante', r.declarante,
                    'baseUvt', r.base_uvt,
                    'tarifa', r.tarifa,
                    'vigenciaDesde', r.vigencia_desde,
                    'vigenciaHasta', r.vigencia_hasta,
                    'norma', r.norma,
                    'observacion', r.observacion,
                    'validadoPor', r.validado_por,
                    'validadoEn', r.validado_en)
                    ORDER BY r.vigencia_desde DESC, r.tipo_persona NULLS FIRST, r.declarante DESC NULLS FIRST)
                    FILTER (WHERE r.id IS NOT NULL), '[]') AS tarifas
             FROM retencion_concepto_nacional n
             LEFT JOIN retencion_tarifa r ON r.concepto_id = n.id
            WHERE n.activo
            GROUP BY n.id
            ORDER BY n.impuesto DESC, n.prioridad, n.nombre`,
        ),
      ),
    );
  }

  // --- Conceptos --------------------------------------------------------

  async listar(ctx: CtxEmpresa, anio?: number): Promise<ConceptoRetencion[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<ConceptoRetencion>(
        await t.query(
          `SELECT ${CAMPOS} FROM retencion_concepto
            ${anio === undefined ? '' : 'WHERE anio = $1 OR anio IS NULL'}
            ORDER BY anio DESC NULLS FIRST, tipo, codigo`,
          anio === undefined ? [] : [anio],
        ),
      ),
    );
  }

  async porId(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<ConceptoRetencion | null> {
    return this.tx.enContexto(
      ctx,
      async (t) =>
        fila<ConceptoRetencion>(
          await t.query(
            `SELECT ${CAMPOS} FROM retencion_concepto WHERE id = $1`,
            [id],
          ),
        ) ?? null,
      tx,
    );
  }
}
