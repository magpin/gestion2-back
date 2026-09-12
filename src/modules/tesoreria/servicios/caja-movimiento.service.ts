import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  NotFoundException,
  Injectable,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import type {
  CargaInicialCajaDto,
  EgresoCajaDto,
  IngresoCajaDto,
  ListarMovimientosCajaDto,
} from '../dto/caja-movimiento.dto';
import { calcularEgreso, calcularIngreso } from './caja.reglas';

export interface MovimientoCajaResumen {
  id: string;
  caja_id: string;
  fecha: string;
  tipo: string;
  valor: string;
  concepto: string;
  origen_tipo: string | null;
  origen_id: string | null;
  tercero_id: string | null;
  saldo_valor: string;
  asiento_id: string | null;
}

const CAMPOS = `id, caja_id, fecha, tipo, valor, concepto, origen_tipo, origen_id,
                tercero_id, saldo_valor, asiento_id`;

/** Comprobante de ingreso para lo que entra, de egreso para lo que sale. */
const CODIGO_COMPROBANTE: Record<'INGRESO' | 'EGRESO', string> = {
  INGRESO: 'CI',
  EGRESO: 'CE',
};

/**
 * El libro de caja. Cada método que escribe bloquea la fila de la caja antes
 * de leer su último saldo — mismo motivo que `KardexService`: sin ese
 * candado, dos movimientos simultáneos leerían el mismo "saldo actual" y uno
 * pisaría al otro.
 */
@Injectable()
export class CajaMovimientoService {
  constructor(
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /**
   * El saldo con el que arranca una caja. Solo una vez — si ya tiene
   * movimientos, se rechaza, mismo criterio que
   * `KardexService.registrarCargaInicial`.
   */
  async registrarSaldoInicial(
    ctx: CtxEmpresa,
    cajaId: string,
    dto: CargaInicialCajaDto,
  ): Promise<MovimientoCajaResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCajaBloqueada(cajaId, t);
      const ultimo = await this.ultimoMovimiento(cajaId, t);
      if (ultimo !== null) {
        throw new BadRequestException(
          'Esta caja ya tiene movimientos; el saldo inicial ya se cargó.',
        );
      }

      const saldo = calcularIngreso(0, dto.valor);

      return this.insertarMovimiento(
        t,
        ctx,
        randomUUID(),
        cajaId,
        'SALDO_INICIAL',
        dto.fecha,
        dto.valor,
        dto.concepto,
        null,
        null,
        null,
        saldo,
        null,
      );
    });
  }

  /**
   * Un ingreso manual: entra plata a la caja sin factura de por medio.
   * Siempre se puede — no hay saldo que "se quede corto" para recibir.
   */
  async registrarIngreso(
    ctx: CtxEmpresa,
    cajaId: string,
    dto: IngresoCajaDto,
  ): Promise<MovimientoCajaResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const caja = await this.exigirCajaBloqueada(cajaId, t);
      const actual = (await this.ultimoMovimiento(cajaId, t))?.saldo ?? 0;
      const nuevoSaldo = calcularIngreso(actual, dto.valor);

      const movimientoId = randomUUID();
      const asientoId = await this.asentarMovimiento(
        ctx,
        caja,
        dto,
        'INGRESO',
        movimientoId,
        t,
      );

      return this.insertarMovimiento(
        t,
        ctx,
        movimientoId,
        cajaId,
        'INGRESO',
        dto.fecha,
        dto.valor,
        dto.concepto,
        null,
        null,
        null,
        nuevoSaldo,
        asientoId,
      );
    });
  }

  /**
   * Un egreso manual: sale plata de la caja sin factura de por medio. Se
   * rechaza si deja la caja en negativo — antes de asentar nada.
   */
  async registrarEgreso(
    ctx: CtxEmpresa,
    cajaId: string,
    dto: EgresoCajaDto,
  ): Promise<MovimientoCajaResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const caja = await this.exigirCajaBloqueada(cajaId, t);
      const actual = (await this.ultimoMovimiento(cajaId, t))?.saldo ?? 0;
      const resultado = calcularEgreso(actual, dto.valor);
      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

      const movimientoId = randomUUID();
      const asientoId = await this.asentarMovimiento(
        ctx,
        caja,
        dto,
        'EGRESO',
        movimientoId,
        t,
      );

      return this.insertarMovimiento(
        t,
        ctx,
        movimientoId,
        cajaId,
        'EGRESO',
        dto.fecha,
        dto.valor,
        dto.concepto,
        null,
        null,
        null,
        resultado.saldo,
        asientoId,
      );
    });
  }

  /** El libro de una caja. Orden de digitación, el más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    cajaId: string,
    p: ListarMovimientosCajaDto,
  ): Promise<Pagina<MovimientoCajaResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = fila<{ total: string }>(
        await t.query(
          'SELECT count(*) AS total FROM caja_movimiento WHERE caja_id = $1',
          [cajaId],
        ),
      );

      const datos = filas<MovimientoCajaResumen>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM caja_movimiento
            WHERE caja_id = $1
            ORDER BY creado_en DESC, id DESC
            LIMIT $2 OFFSET $3`,
          [cajaId, p.tamano, p.salto],
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Bloquea la fila de la caja por el resto de la transacción. Sin esto, dos
   * movimientos simultáneos sobre la misma caja leerían el mismo "último
   * saldo" y uno pisaría el resultado del otro.
   */
  private async exigirCajaBloqueada(
    cajaId: string,
    t: Tx,
  ): Promise<{ id: string; cuenta_id: string }> {
    const caja = fila<{ id: string; cuenta_id: string }>(
      await t.query(
        `SELECT id, cuenta_id FROM caja WHERE id = $1 AND activa FOR UPDATE`,
        [cajaId],
      ),
    );
    if (caja === undefined) {
      throw new NotFoundException('Caja no encontrada o inactiva');
    }
    return caja;
  }

  /**
   * El asiento de un movimiento manual: debita o acredita la cuenta de la
   * caja contra `contraCuentaId`, la que eligió quien registra el
   * movimiento. `origenTipo` siempre es `MOVIMIENTO_CAJA` acá — el
   * `origen_tipo`/`origen_id` de `caja_movimiento` (`FACTURA_VENTA`/
   * `COMPRA`) es otra cosa, y sigue `NULL` para un movimiento manual.
   */
  private async asentarMovimiento(
    ctx: CtxEmpresa,
    caja: { cuenta_id: string },
    dto: {
      fecha: string;
      concepto: string;
      valor: number;
      contraCuentaId: string;
    },
    tipo: 'INGRESO' | 'EGRESO',
    movimientoId: string,
    t: Tx,
  ): Promise<string> {
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      CODIGO_COMPROBANTE[tipo],
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        `La empresa no tiene el comprobante de ${tipo === 'INGRESO' ? 'ingreso' : 'egreso'} sembrado.`,
      );
    }

    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: dto.fecha,
        glosa: dto.concepto,
        lineas: [
          {
            cuentaId: caja.cuenta_id,
            debito: tipo === 'INGRESO' ? dto.valor : 0,
            credito: tipo === 'EGRESO' ? dto.valor : 0,
          },
          {
            cuentaId: dto.contraCuentaId,
            debito: tipo === 'EGRESO' ? dto.valor : 0,
            credito: tipo === 'INGRESO' ? dto.valor : 0,
          },
        ],
      },
      { origenTipo: 'MOVIMIENTO_CAJA', origenId: movimientoId },
      t,
    );
    return asiento.id;
  }

  /** El saldo con el que sigue el próximo movimiento, o `null` si la caja no tiene ninguno. */
  private async ultimoMovimiento(
    cajaId: string,
    t: Tx,
  ): Promise<{ saldo: number } | null> {
    const ultimo = fila<{ saldo_valor: string }>(
      await t.query(
        `SELECT saldo_valor
           FROM caja_movimiento
          WHERE caja_id = $1
          ORDER BY creado_en DESC, id DESC
          LIMIT 1`,
        [cajaId],
      ),
    );
    if (ultimo === undefined) return null;
    return { saldo: Number(ultimo.saldo_valor) };
  }

  private async insertarMovimiento(
    t: Tx,
    ctx: CtxEmpresa,
    id: string,
    cajaId: string,
    tipo: 'SALDO_INICIAL' | 'INGRESO' | 'EGRESO',
    fecha: string,
    valor: number,
    concepto: string,
    origenTipo: 'FACTURA_VENTA' | 'COMPRA' | null,
    origenId: string | null,
    terceroId: string | null,
    saldoValor: number,
    asientoId: string | null,
  ): Promise<MovimientoCajaResumen> {
    const creado = fila<MovimientoCajaResumen>(
      await t.query(
        `INSERT INTO caja_movimiento
           (id, empresa_id, caja_id, fecha, tipo, valor, concepto, origen_tipo,
            origen_id, tercero_id, saldo_valor, asiento_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ${CAMPOS}`,
        [
          id,
          ctx.empresaId,
          cajaId,
          fecha,
          tipo,
          valor,
          concepto,
          origenTipo,
          origenId,
          terceroId,
          saldoValor,
          asientoId,
          ctx.usuarioId,
        ],
      ),
    );
    if (creado === undefined) {
      throw new BadRequestException('No se pudo registrar el movimiento.');
    }
    return creado;
  }
}
