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
    return this.moverCaja(ctx, cajaId, {
      tipo: 'INGRESO',
      fecha: dto.fecha,
      valor: dto.valor,
      concepto: dto.concepto,
      contraCuentaId: dto.contraCuentaId,
      origenTipo: null,
      origenId: null,
      terceroId: null,
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
    return this.moverCaja(ctx, cajaId, {
      tipo: 'EGRESO',
      fecha: dto.fecha,
      valor: dto.valor,
      concepto: dto.concepto,
      contraCuentaId: dto.contraCuentaId,
      origenTipo: null,
      origenId: null,
      terceroId: null,
    });
  }

  /**
   * Un cobro o pago ligado a un documento (factura de venta o de compra) —
   * la llama `TesoreriaApi.registrarCobro`/`registrarPago`. A diferencia
   * de `registrarIngreso`/`registrarEgreso`, acá sí se conoce el documento
   * y el tercero, así que `caja_movimiento.origen_tipo`/`origen_id`/
   * `tercero_id` los llevan en vez de quedar `NULL`.
   *
   * `t` es opcional: quien vende o compra abre su propia transacción (para
   * actualizar `monto_pagado` del documento en el mismo commit que este
   * movimiento) y la pasa acá — sin ella, se abre una nueva, mismo
   * criterio que `ContabilidadApi.periodoAbiertoEn`.
   */
  async registrarMovimientoDocumento(
    ctx: CtxEmpresa,
    cajaId: string,
    datos: {
      tipo: 'INGRESO' | 'EGRESO';
      fecha: string;
      valor: number;
      concepto: string;
      contraCuentaId: string;
      documentoTipo: 'FACTURA_VENTA' | 'COMPRA';
      documentoId: string;
      terceroId: string;
    },
    t?: Tx,
  ): Promise<MovimientoCajaResumen> {
    return this.moverCaja(
      ctx,
      cajaId,
      {
        tipo: datos.tipo,
        fecha: datos.fecha,
        valor: datos.valor,
        concepto: datos.concepto,
        contraCuentaId: datos.contraCuentaId,
        origenTipo: datos.documentoTipo,
        origenId: datos.documentoId,
        terceroId: datos.terceroId,
      },
      t,
    );
  }

  /**
   * El `caja_movimiento` correctivo de un arqueo cerrado con diferencia.
   * Solo la llama `CajaArqueoService`, dentro de la MISMA transacción del
   * cierre (`t` no es opcional, a propósito: quien la llama ya abrió la
   * suya y ya bloqueó la caja). El asiento de ajuste se arma antes, en
   * `CajaArqueoService`, con `datos.id` como `origenId` — acá se inserta
   * con ese MISMO id, para que `asiento.origen_id` y este movimiento
   * queden enlazados.
   */
  async registrarAjusteArqueo(
    ctx: CtxEmpresa,
    cajaId: string,
    datos: {
      id: string;
      tipo: 'INGRESO' | 'EGRESO';
      fecha: string;
      valor: number;
      concepto: string;
      saldoValor: number;
      asientoId: string;
    },
    t: Tx,
  ): Promise<MovimientoCajaResumen> {
    return this.insertarMovimiento(
      t,
      ctx,
      datos.id,
      cajaId,
      datos.tipo,
      datos.fecha,
      datos.valor,
      datos.concepto,
      null,
      null,
      null,
      datos.saldoValor,
      datos.asientoId,
    );
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
            ORDER BY secuencia DESC
            LIMIT $2 OFFSET $3`,
          [cajaId, p.tamano, p.salto],
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /**
   * Cuánto entró y cuánto salió en el libro entero, y con qué saldo quedó.
   *
   * No se saca de sumar la página que se está mirando: el libro viene paginado
   * y sumar cincuenta renglones para titularlo "entradas" sería mentir. El
   * saldo inicial no entra en ninguno de los dos —no es plata que entró, es de
   * dónde arrancó la cuenta— y por eso va aparte.
   */
  async resumen(
    ctx: CtxEmpresa,
    cajaId: string,
  ): Promise<{
    entradas: string;
    salidas: string;
    saldo_inicial: string;
    saldo: string;
  }> {
    return this.tx.enContexto(ctx, async (t) => {
      const total = fila<{
        entradas: string;
        salidas: string;
        saldo_inicial: string;
        saldo: string;
      }>(
        await t.query(
          `SELECT coalesce(sum(valor) FILTER (WHERE tipo = 'INGRESO'), 0)::text AS entradas,
                  coalesce(sum(valor) FILTER (WHERE tipo = 'EGRESO'), 0)::text AS salidas,
                  coalesce(sum(valor) FILTER (WHERE tipo = 'SALDO_INICIAL'), 0)::text AS saldo_inicial,
                  coalesce(
                    (SELECT m.saldo_valor FROM caja_movimiento m
                      WHERE m.caja_id = $1
                      ORDER BY m.secuencia DESC
                      LIMIT 1), 0)::text AS saldo
             FROM caja_movimiento
            WHERE caja_id = $1`,
          [cajaId],
        ),
      );
      return (
        total ?? {
          entradas: '0',
          salidas: '0',
          saldo_inicial: '0',
          saldo: '0',
        }
      );
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
   * Lo que comparten `registrarIngreso`/`registrarEgreso`/
   * `registrarMovimientoDocumento`: bloquear la caja, calcular el nuevo
   * saldo (rechazando el egreso que la deje en negativo), asentar y luego
   * insertar. Lo único que cambia entre los tres es qué llevan
   * `caja_movimiento.origen_tipo`/`origen_id`/`tercero_id` — `NULL` para
   * un movimiento manual, el documento y el tercero para un cobro/pago.
   */
  private async moverCaja(
    ctx: CtxEmpresa,
    cajaId: string,
    datos: {
      tipo: 'INGRESO' | 'EGRESO';
      fecha: string;
      valor: number;
      concepto: string;
      contraCuentaId: string;
      origenTipo: 'FACTURA_VENTA' | 'COMPRA' | null;
      origenId: string | null;
      terceroId: string | null;
    },
    tExterna?: Tx,
  ): Promise<MovimientoCajaResumen> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const caja = await this.exigirCajaBloqueada(cajaId, t);
        const actual = (await this.ultimoMovimiento(cajaId, t))?.saldo ?? 0;

        let nuevoSaldo: number;
        if (datos.tipo === 'INGRESO') {
          nuevoSaldo = calcularIngreso(actual, datos.valor);
        } else {
          const resultado = calcularEgreso(actual, datos.valor);
          if (!resultado.ok) {
            throw new BadRequestException(resultado.motivo);
          }
          nuevoSaldo = resultado.saldo;
        }

        const movimientoId = randomUUID();
        const asientoId = await this.asentarMovimiento(
          ctx,
          caja,
          datos,
          datos.tipo,
          movimientoId,
          t,
        );

        return this.insertarMovimiento(
          t,
          ctx,
          movimientoId,
          cajaId,
          datos.tipo,
          datos.fecha,
          datos.valor,
          datos.concepto,
          datos.origenTipo,
          datos.origenId,
          datos.terceroId,
          nuevoSaldo,
          asientoId,
        );
      },
      tExterna,
    );
  }

  /**
   * El asiento de un cobro/pago: debita o acredita la cuenta de la caja
   * contra `contraCuentaId` — la que eligió quien registra el movimiento
   * manual, o la de Clientes/Proveedores para un cobro/pago de documento.
   * `origenTipo` del ASIENTO siempre es `MOVIMIENTO_CAJA` acá, sea cual
   * sea el origen del `caja_movimiento` — es otra columna, y es la que sí
   * distingue manual de documento.
   */
  private async asentarMovimiento(
    ctx: CtxEmpresa,
    caja: { cuenta_id: string },
    dto: {
      fecha: string;
      concepto: string;
      valor: number;
      contraCuentaId: string;
      terceroId?: string | null;
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
            // Un cobro o pago va contra Clientes/Proveedores, y esas cuentas
            // exigen tercero: sin él el libro no sabe quién pagó ni a quién.
            // Un movimiento manual no lo trae y su contracuenta no lo pide.
            terceroId: dto.terceroId ?? undefined,
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
          ORDER BY secuencia DESC
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
