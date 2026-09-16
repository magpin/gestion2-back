import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  CargarUvtDto,
  CrearConceptoDto,
  EditarConceptoDto,
  TipoRetencion,
} from '../dto/retencion.dto';

export interface ConceptoRetencion {
  id: string;
  anio: number;
  tipo: TipoRetencion;
  codigo: string;
  nombre: string;
  tarifa: string;
  tarifa_no_declarante: string | null;
  base_minima_uvt: string;
  cuenta_id: string;
  activo: boolean;
  /** El código de la cuenta, para que la pantalla no tenga que ir a buscarlo. */
  cuenta_codigo: string | null;
}

const CAMPOS = `id, anio, tipo, codigo, nombre, tarifa, tarifa_no_declarante,
                base_minima_uvt, cuenta_id, activo,
                (SELECT c.codigo FROM empresa_cuenta c WHERE c.id = retencion_concepto.cuenta_id) AS cuenta_codigo`;

/**
 * El catálogo de retenciones: qué se retiene, a qué tarifa y desde qué monto.
 *
 * **El sistema no inventa las tarifas.** Cambian todos los años, la de ICA sale
 * del acuerdo de cada municipio, y equivocarse le cuesta plata a alguien: las
 * carga y las valida un contador. Lo que el sistema aporta es que, una vez
 * cargadas, no se olviden ni se calculen mal.
 */
@Injectable()
export class RetencionService {
  constructor(private readonly tx: TxService) {}

  // --- UVT --------------------------------------------------------------

  async listarUvt(ctx: CtxEmpresa): Promise<Array<{ anio: number; valor: string }>> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<{ anio: number; valor: string }>(
        await t.query('SELECT anio, valor FROM uvt ORDER BY anio DESC'),
      ),
    );
  }

  /** Cargar la del año, o corregirla si se cargó mal. */
  async cargarUvt(
    ctx: CtxEmpresa,
    dto: CargarUvtDto,
  ): Promise<{ anio: number; valor: string }> {
    return this.tx.enContexto(ctx, async (t) => {
      const guardada = fila<{ anio: number; valor: string }>(
        await t.query(
          `INSERT INTO uvt (anio, valor) VALUES ($1, $2)
           ON CONFLICT (anio) DO UPDATE SET valor = EXCLUDED.valor
           RETURNING anio, valor`,
          [dto.anio, dto.valor],
        ),
      );
      if (guardada === undefined) {
        throw new BadRequestException('No se pudo guardar la UVT.');
      }
      return guardada;
    });
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

  // --- Conceptos --------------------------------------------------------

  async listar(
    ctx: CtxEmpresa,
    anio?: number,
  ): Promise<ConceptoRetencion[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<ConceptoRetencion>(
        await t.query(
          `SELECT ${CAMPOS} FROM retencion_concepto
            ${anio === undefined ? '' : 'WHERE anio = $1'}
            ORDER BY anio DESC, tipo, codigo`,
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

  async crear(
    ctx: CtxEmpresa,
    dto: CrearConceptoDto,
  ): Promise<ConceptoRetencion> {
    if (dto.tarifaNoDeclarante !== undefined && dto.tipo !== 'RENTA') {
      throw new BadRequestException(
        'Solo la retención de renta distingue entre quien declara y quien no.',
      );
    }
    return this.tx.enContexto(ctx, async (t) => {
      const creado = fila<ConceptoRetencion>(
        await t.query(
          `INSERT INTO retencion_concepto
             (empresa_id, anio, tipo, codigo, nombre, tarifa, tarifa_no_declarante,
              base_minima_uvt, cuenta_id, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING ${CAMPOS}`,
          [
            ctx.empresaId,
            dto.anio,
            dto.tipo,
            dto.codigo.trim().toUpperCase(),
            dto.nombre.trim(),
            dto.tarifa,
            dto.tarifaNoDeclarante ?? null,
            dto.baseMinimaUvt ?? 0,
            dto.cuentaId,
            ctx.usuarioId,
          ],
        ),
      );
      if (creado === undefined) {
        throw new BadRequestException('No se pudo crear el concepto.');
      }
      return creado;
    });
  }

  /**
   * Corregir un concepto **de un año que ya tiene documentos** cambia cómo se
   * explican esos documentos, así que no se toca la tarifa de un año cerrado:
   * se crea el del año nuevo. Acá no se impide —el catálogo recién se está
   * cargando y hay que poder arreglar lo que se escribió mal—, pero queda
   * dicho.
   */
  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarConceptoDto,
  ): Promise<ConceptoRetencion> {
    return this.tx.enContexto(ctx, async (t) => {
      const editado = fila<ConceptoRetencion>(
        await t.query(
          `UPDATE retencion_concepto
              SET nombre = coalesce($2, nombre),
                  tarifa = coalesce($3, tarifa),
                  tarifa_no_declarante = coalesce($4, tarifa_no_declarante),
                  base_minima_uvt = coalesce($5, base_minima_uvt),
                  activo = coalesce($6, activo)
            WHERE id = $1
          RETURNING ${CAMPOS}`,
          [
            id,
            dto.nombre?.trim() ?? null,
            dto.tarifa ?? null,
            dto.tarifaNoDeclarante ?? null,
            dto.baseMinimaUvt ?? null,
            dto.activo ?? null,
          ],
        ),
      );
      if (editado === undefined) {
        throw new BadRequestException('Concepto no encontrado.');
      }
      return editado;
    });
  }
}
