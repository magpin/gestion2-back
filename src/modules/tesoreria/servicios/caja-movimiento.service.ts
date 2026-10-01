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
  ReversarMovimientoCajaDto,
} from '../dto/caja-movimiento.dto';
import { calcularEgreso, calcularIngreso } from './caja.reglas';
import type { Contrapartida } from './contrapartida';

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
  /** El movimiento que este corrige, si es una reversa. */
  reversa_de: string | null;
  motivo_reversa: string | null;
  /** La reversa que corrigió a este, si ya la tiene. */
  reversado_por: string | null;
  /** Si es el ajuste de un arqueo: ese no se reversa, se corrige con otro arqueo. */
  es_ajuste_arqueo: boolean;
}

// `reversado_por` y `es_ajuste_arqueo` se derivan: con ellos la pantalla sabe
// si ofrecer "Reversar" sin tener que repetir las reglas de `reversar`.
const CAMPOS = `id, caja_id, fecha, tipo, valor, concepto, origen_tipo, origen_id,
                tercero_id, saldo_valor, asiento_id, reversa_de, motivo_reversa,
                (SELECT r.id FROM caja_movimiento r
                  WHERE r.reversa_de = caja_movimiento.id) AS reversado_por,
                EXISTS (SELECT 1 FROM caja_arqueo a
                         WHERE a.asiento_ajuste_id = caja_movimiento.asiento_id) AS es_ajuste_arqueo`;

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
    /** Desde el arranque (`SaldosInicialesService`): el id y el asiento de apertura ya están armados. */
    apertura?: { id: string; asientoId: string },
    tx?: Tx,
  ): Promise<MovimientoCajaResumen> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
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
          apertura?.id ?? randomUUID(),
          cajaId,
          'SALDO_INICIAL',
          dto.fecha,
          dto.valor,
          dto.concepto,
          null,
          null,
          null,
          saldo,
          apertura?.asientoId ?? null,
        );
      },
      tx,
    );
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
      centroCostoId: dto.centroCostoId ?? null,
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
      centroCostoId: dto.centroCostoId ?? null,
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
   * Un ingreso o egreso por concepto, con las contrapartidas ya armadas —la
   * llama `MovimientoConceptoService`—. Es un movimiento manual para el libro
   * (sin documento): se corrige con `reversar`, como los demás manuales.
   */
  async registrarConContrapartidas(
    ctx: CtxEmpresa,
    cajaId: string,
    datos: {
      tipo: 'INGRESO' | 'EGRESO';
      fecha: string;
      valor: number;
      concepto: string;
      terceroId: string | null;
      contrapartidas: Contrapartida[];
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
        contraCuentaId: null,
        contrapartidas: datos.contrapartidas,
        origenTipo: null,
        origenId: null,
        terceroId: datos.terceroId,
      },
      t,
    );
  }

  /**
   * Un lado de un traslado —la llama `TrasladoService`—. El asiento ya está
   * hecho (uno solo para los dos lados), así que acá solo se bloquea la
   * caja, se corre el saldo y se inserta el movimiento que apunta a él. No se
   * reversa suelto: se anula el traslado entero.
   */
  async registrarDeTraslado(
    ctx: CtxEmpresa,
    cajaId: string,
    datos: {
      id: string;
      tipo: 'INGRESO' | 'EGRESO';
      fecha: string;
      valor: number;
      concepto: string;
      trasladoId: string;
      asientoId: string;
    },
    t: Tx,
  ): Promise<MovimientoCajaResumen> {
    await this.exigirCajaBloqueada(cajaId, t);
    const actual = (await this.ultimoMovimiento(cajaId, t))?.saldo ?? 0;
    let nuevoSaldo: number;
    if (datos.tipo === 'INGRESO') {
      nuevoSaldo = calcularIngreso(actual, datos.valor);
    } else {
      const resultado = calcularEgreso(actual, datos.valor);
      if (!resultado.ok) throw new BadRequestException(resultado.motivo);
      nuevoSaldo = resultado.saldo;
    }
    return this.insertarMovimiento(
      t,
      ctx,
      datos.id,
      cajaId,
      datos.tipo,
      datos.fecha,
      datos.valor,
      datos.concepto,
      'TRASLADO',
      datos.trasladoId,
      null,
      nuevoSaldo,
      datos.asientoId,
    );
  }

  /**
   * El cobro o pago de un documento de contado cuyo asiento ya está hecho: la
   * factura de contado lleva en su propio asiento el débito (o crédito) a
   * cada caja y banco, así que acá solo se bloquea la caja, se corre el saldo
   * y se inserta el movimiento que apunta a ese asiento. Mismo patrón que
   * `registrarDeTraslado`.
   */
  async registrarDocumentoConAsiento(
    ctx: CtxEmpresa,
    cajaId: string,
    datos: {
      tipo: 'INGRESO' | 'EGRESO';
      fecha: string;
      valor: number;
      concepto: string;
      documentoTipo: 'FACTURA_VENTA' | 'COMPRA';
      documentoId: string;
      terceroId: string;
      asientoId: string;
    },
    t: Tx,
  ): Promise<MovimientoCajaResumen> {
    await this.exigirCajaBloqueada(cajaId, t);
    const actual = (await this.ultimoMovimiento(cajaId, t))?.saldo ?? 0;
    let nuevoSaldo: number;
    if (datos.tipo === 'INGRESO') {
      nuevoSaldo = calcularIngreso(actual, datos.valor);
    } else {
      const resultado = calcularEgreso(actual, datos.valor);
      if (!resultado.ok) throw new BadRequestException(resultado.motivo);
      nuevoSaldo = resultado.saldo;
    }
    return this.insertarMovimiento(
      t,
      ctx,
      randomUUID(),
      cajaId,
      datos.tipo,
      datos.fecha,
      datos.valor,
      datos.concepto,
      datos.documentoTipo,
      datos.documentoId,
      datos.terceroId,
      nuevoSaldo,
      datos.asientoId,
    );
  }

  /** La cuenta contable de la caja: el traslado la necesita para su asiento. */
  async cuentaDe(
    ctx: CtxEmpresa,
    cajaId: string,
    t: Tx,
  ): Promise<{ cuentaId: string; nombre: string }> {
    const caja = fila<{ cuenta_id: string; nombre: string }>(
      await t.query(
        'SELECT cuenta_id, nombre FROM caja WHERE id = $1 AND activa',
        [cajaId],
      ),
    );
    if (caja === undefined)
      throw new NotFoundException('Caja no encontrada o inactiva');
    return { cuentaId: caja.cuenta_id, nombre: caja.nombre };
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

  /**
   * Corrige un ingreso o egreso manual mal cargado con su movimiento contrario:
   * mismo valor, sentido opuesto, y un asiento que invierte las líneas del
   * original. El libro no se edita —el saldo corrido de todo lo posterior ya
   * contó el error—, así que la corrección es un hecho nuevo que dice a quién
   * corrige y por qué.
   *
   * No se reversa:
   *   - un cobro o pago de documento: se corrige devolviendo el cobro o el
   *     pago, que además baja el `monto_pagado` de la factura;
   *   - el ajuste de un arqueo: es lo que se contó, y se corrige con otro
   *     arqueo;
   *   - una reversa, ni algo ya reversado.
   *
   * La base sostiene lo mismo con `tg_caja_reversa_valida` y
   * `ux_caja_mov_reversa`; acá se anticipa con mensajes que se entienden.
   */
  async reversar(
    ctx: CtxEmpresa,
    cajaId: string,
    movimientoId: string,
    dto: ReversarMovimientoCajaDto,
    /** La de quien anula un documento que movió la caja: todo o nada. */
    tExterna?: Tx,
  ): Promise<MovimientoCajaResumen> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        // El asiento invertido ya trae la cuenta de la caja desde el original:
        // acá la caja solo se bloquea, para que el saldo corrido no se pise.
        await this.exigirCajaBloqueada(cajaId, t);

        const original = fila<MovimientoCajaResumen>(
          await t.query(
            `SELECT ${CAMPOS} FROM caja_movimiento WHERE id = $1 AND caja_id = $2`,
            [movimientoId, cajaId],
          ),
        );
        if (original === undefined) {
          throw new NotFoundException('Movimiento no encontrado en esta caja.');
        }
        if (original.tipo === 'SALDO_INICIAL') {
          throw new BadRequestException(
            'El saldo inicial no se reversa: no tiene asiento. Si quedó mal, lo corrige un contador con un ingreso o egreso contra la cuenta que corresponda.',
          );
        }
        if (original.reversa_de !== null) {
          throw new BadRequestException(
            'Este movimiento ya es una reversa. Si la reversa estuvo mal, registre el movimiento de nuevo.',
          );
        }
        if (original.reversado_por !== null) {
          throw new BadRequestException('Este movimiento ya se reversó.');
        }
        if (original.origen_tipo !== null) {
          throw new BadRequestException(
            original.origen_tipo === 'FACTURA_VENTA'
              ? 'Es el cobro de una factura: se corrige devolviendo el cobro desde la factura.'
              : original.origen_tipo === 'TRASLADO'
                ? 'Es un lado de un traslado: se anula el traslado entero, desde Caja y bancos → Traslados.'
                : 'Es el pago de una compra: se corrige con la devolución del pago desde la compra.',
          );
        }
        if (original.es_ajuste_arqueo) {
          throw new BadRequestException(
            'Es el ajuste de un arqueo: se corrige con otro arqueo, no borrando la diferencia.',
          );
        }

        const lineas = await this.contabilidad.lineasInvertidasDe(
          ctx,
          original.asiento_id!,
          t,
        );
        if (lineas === null) {
          throw new BadRequestException(
            'El asiento de este movimiento está anulado: no hay nada que reversar en la contabilidad.',
          );
        }

        const tipo = original.tipo === 'INGRESO' ? 'EGRESO' : 'INGRESO';
        const valor = Number(original.valor);
        const actual = (await this.ultimoMovimiento(cajaId, t))?.saldo ?? 0;
        let nuevoSaldo: number;
        if (tipo === 'INGRESO') {
          nuevoSaldo = calcularIngreso(actual, valor);
        } else {
          // Reversar un ingreso saca plata: si ya no está en el cajón, no se
          // puede sacar, y eso es un faltante que se ve en el arqueo.
          const resultado = calcularEgreso(actual, valor);
          if (!resultado.ok) {
            throw new BadRequestException(resultado.motivo);
          }
          nuevoSaldo = resultado.saldo;
        }

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

        const id = randomUUID();
        const concepto = `Reversa de: ${original.concepto}`;
        const asiento = await this.contabilidad.asentar(
          ctx,
          {
            comprobanteTipoId: comprobante.id,
            fecha: dto.fecha,
            glosa: `${concepto} — ${dto.motivo}`,
            lineas,
          },
          { origenTipo: 'MOVIMIENTO_CAJA', origenId: id },
          t,
        );

        return this.insertarMovimiento(
          t,
          ctx,
          id,
          cajaId,
          tipo,
          dto.fecha,
          valor,
          concepto,
          null,
          null,
          original.tercero_id,
          nuevoSaldo,
          asiento.id,
          { de: original.id, motivo: dto.motivo },
        );
      },
      tExterna,
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
      /** La cuenta contraria de un movimiento de dos líneas. */
      contraCuentaId: string | null;
      /** O, en su lugar, las líneas contrarias ya armadas. */
      contrapartidas?: Contrapartida[];
      /** El centro de un movimiento manual cuya contracuenta es de resultado. */
      centroCostoId?: string | null;
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
      contraCuentaId: string | null;
      contrapartidas?: Contrapartida[];
      terceroId?: string | null;
      centroCostoId?: string | null;
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
        centroCostoId: dto.centroCostoId ?? undefined,
        lineas: [
          {
            cuentaId: caja.cuenta_id,
            debito: tipo === 'INGRESO' ? dto.valor : 0,
            credito: tipo === 'EGRESO' ? dto.valor : 0,
          },
          ...(dto.contrapartidas ?? [
            {
              cuentaId: exigirContraCuenta(dto.contraCuentaId),
              debito: tipo === 'EGRESO' ? dto.valor : 0,
              credito: tipo === 'INGRESO' ? dto.valor : 0,
              // Un cobro o pago va contra Clientes/Proveedores, y esas cuentas
              // exigen tercero: sin él el libro no sabe quién pagó ni a quién.
              // Un movimiento manual no lo trae y su contracuenta no lo pide.
              terceroId: dto.terceroId ?? undefined,
            },
          ]),
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
    origenTipo: 'FACTURA_VENTA' | 'COMPRA' | 'TRASLADO' | null,
    origenId: string | null,
    terceroId: string | null,
    saldoValor: number,
    asientoId: string | null,
    reversa: { de: string; motivo: string } | null = null,
  ): Promise<MovimientoCajaResumen> {
    const creado = fila<MovimientoCajaResumen>(
      await t.query(
        `INSERT INTO caja_movimiento
           (id, empresa_id, caja_id, fecha, tipo, valor, concepto, origen_tipo,
            origen_id, tercero_id, saldo_valor, asiento_id, creado_por,
            reversa_de, motivo_reversa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
          reversa?.de ?? null,
          reversa?.motivo ?? null,
        ],
      ),
    );
    if (creado === undefined) {
      throw new BadRequestException('No se pudo registrar el movimiento.');
    }
    return creado;
  }
}

/** Un movimiento de dos líneas sin contracuenta es un error de quien llama. */
export function exigirContraCuenta(id: string | null): string {
  if (id === null) {
    throw new Error(
      'Inconsistencia: un movimiento sin contrapartidas necesita la cuenta contraria.',
    );
  }
  return id;
}
