import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  AgregarLineaExtractoDto,
  ConciliarManualDto,
  CrearExtractoDto,
  ListarExtractosDto,
} from '../dto/extracto.dto';
import { DIRECCION_MOVIMIENTO_BANCO } from './banco-movimiento.service';
import {
  emparejarPorFechaValor,
  verificarConciliacion,
  type ElementoParaAparear,
} from './banco.reglas';

export interface ExtractoResumen {
  id: string;
  cuenta_bancaria_id: string;
  fecha_desde: string;
  fecha_hasta: string;
  saldo_inicial_banco: string;
  saldo_final_banco: string;
  estado: 'ABIERTO' | 'CONCILIADO';
  conciliado_en: string | null;
  conciliado_por: string | null;
}

export interface LineaExtractoResumen {
  id: string;
  extracto_id: string;
  fecha: string;
  descripcion: string;
  valor: string;
  tipo: 'DEBITO' | 'CREDITO';
  banco_movimiento_id: string | null;
}

export interface ExtractoDetalle extends ExtractoResumen {
  lineas: LineaExtractoResumen[];
}

export interface ResumenConciliacionAutomatica {
  pares: number;
  lineasSinAparear: number;
  movimientosSinAparear: number;
}

const CAMPOS_EXTRACTO = `id, cuenta_bancaria_id, fecha_desde, fecha_hasta,
                          saldo_inicial_banco, saldo_final_banco, estado,
                          conciliado_en, conciliado_por`;

const CAMPOS_LINEA = `id, extracto_id, fecha, descripcion, valor, tipo, banco_movimiento_id`;

/**
 * La conciliación bancaria: un extracto es un rango de fechas, no un día
 * — no encadena con el anterior, el banco lleva su propio calendario. Ver
 * "Por qué Bancos no tiene arqueo" en `docs/planes/caja-bancos-fase2.md`.
 *
 * `agregarLinea`/`conciliarAutomatico`/`conciliarManual`/`cerrar`
 * bloquean la fila del extracto (`FOR UPDATE`) antes de tocarlo — mismo
 * motivo que el resto del módulo: dos conciliaciones simultáneas del
 * mismo extracto no pueden pisarse.
 */
@Injectable()
export class ExtractoService {
  constructor(private readonly tx: TxService) {}

  async crear(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: CrearExtractoDto,
  ): Promise<ExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const cuenta = fila<{ id: string }>(
        await t.query(
          `SELECT id FROM cuenta_bancaria WHERE id = $1 AND activa`,
          [cuentaBancariaId],
        ),
      );
      if (cuenta === undefined) {
        throw new NotFoundException('Cuenta bancaria no encontrada o inactiva');
      }

      const creado = fila<ExtractoResumen>(
        await t.query(
          `INSERT INTO extracto_bancario
             (empresa_id, cuenta_bancaria_id, fecha_desde, fecha_hasta,
              saldo_inicial_banco, saldo_final_banco)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${CAMPOS_EXTRACTO}`,
          [
            ctx.empresaId,
            cuentaBancariaId,
            dto.fechaDesde,
            dto.fechaHasta,
            dto.saldoInicialBanco,
            dto.saldoFinalBanco,
          ],
        ),
      );
      if (creado === undefined) {
        throw new BadRequestException('No se pudo crear el extracto.');
      }
      return creado;
    });
  }

  async agregarLinea(
    ctx: CtxEmpresa,
    extractoId: string,
    dto: AgregarLineaExtractoDto,
  ): Promise<LineaExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirExtractoAbierto(extractoId, t);

      const creada = fila<LineaExtractoResumen>(
        await t.query(
          `INSERT INTO extracto_linea
             (empresa_id, extracto_id, fecha, descripcion, valor, tipo)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${CAMPOS_LINEA}`,
          [
            ctx.empresaId,
            extractoId,
            dto.fecha,
            dto.descripcion,
            dto.valor,
            dto.tipo,
          ],
        ),
      );
      if (creada === undefined) {
        throw new BadRequestException('No se pudo agregar la línea.');
      }
      return creada;
    });
  }

  /** El historial de extractos de una cuenta bancaria. Más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    p: ListarExtractosDto,
  ): Promise<Pagina<ExtractoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = fila<{ total: string }>(
        await t.query(
          'SELECT count(*) AS total FROM extracto_bancario WHERE cuenta_bancaria_id = $1',
          [cuentaBancariaId],
        ),
      );

      const datos = filas<ExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS_EXTRACTO}
             FROM extracto_bancario
            WHERE cuenta_bancaria_id = $1
            ORDER BY fecha_desde DESC
            LIMIT $2 OFFSET $3`,
          [cuentaBancariaId, p.tamano, p.salto],
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<ExtractoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const extracto = fila<ExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS_EXTRACTO} FROM extracto_bancario WHERE id = $1`,
          [id],
        ),
      );
      if (extracto === undefined) {
        throw new NotFoundException('Extracto no encontrado');
      }

      const lineas = filas<LineaExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS_LINEA} FROM extracto_linea
            WHERE extracto_id = $1
            ORDER BY fecha, id`,
          [id],
        ),
      );

      return { ...extracto, lineas };
    });
  }

  /**
   * Aparea automáticamente por `(fecha, valor)` exacto lo que todavía no
   * se conciliaba de los dos lados — las líneas de este extracto sin
   * `banco_movimiento_id`, y los movimientos sin conciliar de la misma
   * cuenta bancaria. El caso ambiguo queda para `conciliarManual`, ver
   * `banco.reglas.emparejarPorFechaValor`.
   */
  async conciliarAutomatico(
    ctx: CtxEmpresa,
    extractoId: string,
  ): Promise<ResumenConciliacionAutomatica> {
    return this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);

      const lineas = filas<ElementoParaAparear>(
        await t.query(
          `SELECT id, fecha, valor FROM extracto_linea
            WHERE extracto_id = $1 AND banco_movimiento_id IS NULL`,
          [extractoId],
        ),
      );
      const movimientos = filas<ElementoParaAparear>(
        await t.query(
          `SELECT id, fecha, valor FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1 AND NOT conciliado AND tipo <> 'SALDO_INICIAL'`,
          [extracto.cuenta_bancaria_id],
        ),
      );

      const resultado = emparejarPorFechaValor(lineas, movimientos);

      for (const par of resultado.pares) {
        await t.query(
          `UPDATE extracto_linea SET banco_movimiento_id = $2 WHERE id = $1`,
          [par.lineaId, par.movimientoId],
        );
        await t.query(
          `UPDATE banco_movimiento SET conciliado = true WHERE id = $1`,
          [par.movimientoId],
        );
      }

      return {
        pares: resultado.pares.length,
        lineasSinAparear: resultado.lineasSinAparear.length,
        movimientosSinAparear: resultado.movimientosSinAparear.length,
      };
    });
  }

  /**
   * Aparea a mano una línea suelta con un movimiento suelto — lo que el
   * automático dejó sin tocar (el caso ambiguo, o lo que de verdad no
   * calza en fecha/valor: un cheque que el banco cobró por un valor
   * distinto al girado, por ejemplo).
   */
  async conciliarManual(
    ctx: CtxEmpresa,
    extractoId: string,
    dto: ConciliarManualDto,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);

      const linea = fila<{ id: string; banco_movimiento_id: string | null }>(
        await t.query(
          `SELECT id, banco_movimiento_id FROM extracto_linea
            WHERE id = $1 AND extracto_id = $2`,
          [dto.lineaId, extractoId],
        ),
      );
      if (linea === undefined) {
        throw new NotFoundException('Línea no encontrada en este extracto');
      }
      if (linea.banco_movimiento_id !== null) {
        throw new BadRequestException('Esta línea ya está conciliada.');
      }

      const movimiento = fila<{ id: string; conciliado: boolean }>(
        await t.query(
          `SELECT id, conciliado FROM banco_movimiento
            WHERE id = $1 AND cuenta_bancaria_id = $2`,
          [dto.movimientoId, extracto.cuenta_bancaria_id],
        ),
      );
      if (movimiento === undefined) {
        throw new NotFoundException(
          'Movimiento no encontrado en esta cuenta bancaria',
        );
      }
      if (movimiento.conciliado) {
        throw new BadRequestException('Ese movimiento ya está conciliado.');
      }

      await t.query(
        `UPDATE extracto_linea SET banco_movimiento_id = $2 WHERE id = $1`,
        [dto.lineaId, dto.movimientoId],
      );
      await t.query(
        `UPDATE banco_movimiento SET conciliado = true WHERE id = $1`,
        [dto.movimientoId],
      );
    });
  }

  /**
   * Cierra el extracto como `CONCILIADO`. Exige que cuadren las DOS
   * cuentas de `verificarConciliacion` — el extracto consigo mismo, y el
   * saldo del libro (ajustado por lo que sigue pendiente de conciliar)
   * contra el saldo final que dice el banco. Rechaza con el detalle de
   * la diferencia si no cuadra.
   */
  async cerrar(ctx: CtxEmpresa, extractoId: string): Promise<ExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);

      const lineas = filas<{ valor: string; tipo: 'DEBITO' | 'CREDITO' }>(
        await t.query(
          `SELECT valor, tipo FROM extracto_linea WHERE extracto_id = $1`,
          [extractoId],
        ),
      );

      const ultimoMovimiento = fila<{ saldo_valor: string }>(
        await t.query(
          `SELECT saldo_valor FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1
            ORDER BY secuencia DESC
            LIMIT 1`,
          [extracto.cuenta_bancaria_id],
        ),
      );
      const saldoLibro = Number(ultimoMovimiento?.saldo_valor ?? 0);

      const pendientesFilas = filas<{ valor: string; tipo: string }>(
        await t.query(
          `SELECT valor, tipo FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1 AND NOT conciliado AND tipo <> 'SALDO_INICIAL'`,
          [extracto.cuenta_bancaria_id],
        ),
      );

      const resultado = verificarConciliacion({
        saldoInicialBanco: Number(extracto.saldo_inicial_banco),
        saldoFinalBanco: Number(extracto.saldo_final_banco),
        lineas: lineas.map((l) => ({ valor: Number(l.valor), tipo: l.tipo })),
        saldoLibro,
        pendientes: pendientesFilas.map((m) => ({
          valor: Number(m.valor),
          direccion:
            DIRECCION_MOVIMIENTO_BANCO[
              m.tipo as keyof typeof DIRECCION_MOVIMIENTO_BANCO
            ],
        })),
      });

      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

      const cerrado = fila<ExtractoResumen>(
        await t.query(
          `UPDATE extracto_bancario
              SET estado = 'CONCILIADO', conciliado_en = now(), conciliado_por = $2
            WHERE id = $1
          RETURNING ${CAMPOS_EXTRACTO}`,
          [extractoId, ctx.usuarioId],
        ),
      );
      if (cerrado === undefined) {
        throw new BadRequestException('No se pudo cerrar el extracto.');
      }
      return cerrado;
    });
  }

  // ---------------------------------------------------------------------------

  private async exigirExtractoAbierto(
    extractoId: string,
    t: Tx,
  ): Promise<ExtractoResumen> {
    const extracto = fila<ExtractoResumen>(
      await t.query(
        `SELECT ${CAMPOS_EXTRACTO} FROM extracto_bancario WHERE id = $1 FOR UPDATE`,
        [extractoId],
      ),
    );
    if (extracto === undefined) {
      throw new NotFoundException('Extracto no encontrado');
    }
    if (extracto.estado !== 'ABIERTO') {
      throw new BadRequestException('Este extracto ya está conciliado.');
    }
    return extracto;
  }
}
