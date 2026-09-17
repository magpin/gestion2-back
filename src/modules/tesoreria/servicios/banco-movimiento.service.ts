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
  CargaInicialBancoDto,
  ListarMovimientosBancoDto,
  RegistrarMovimientoBancoDto,
  TIPOS_MOVIMIENTO_BANCO_MANUAL,
} from '../dto/banco-movimiento.dto';
import { calcularEgresoBanco, calcularIngresoBanco } from './banco.reglas';

export interface MovimientoBancoResumen {
  id: string;
  cuenta_bancaria_id: string;
  fecha: string;
  tipo: string;
  valor: string;
  concepto: string;
  origen_tipo: string | null;
  origen_id: string | null;
  tercero_id: string | null;
  saldo_valor: string;
  asiento_id: string | null;
  conciliado: boolean;
}

/** Exportada: el corte diario lista los movimientos del día con las mismas columnas. */
export const CAMPOS_MOVIMIENTO_BANCO = `id, cuenta_bancaria_id, fecha, tipo, valor, concepto, origen_tipo,
                origen_id, tercero_id, saldo_valor, asiento_id, conciliado`;
const CAMPOS = CAMPOS_MOVIMIENTO_BANCO;

export type TipoMovimientoManual =
  (typeof TIPOS_MOVIMIENTO_BANCO_MANUAL)[number];

/**
 * Hacia dónde mueve el saldo cada tipo. `CONSIGNACION`/`NOTA_CREDITO`/
 * `TRANSFERENCIA_ENTRANTE` suman; el resto resta — de acá sale también
 * qué comprobante usar (`CI` para lo que entra, `CE` para lo que sale).
 * Exportada: `ExtractoService.cerrar` la reusa para clasificar qué
 * movimientos sin conciliar son "pendientes de entrada" o "de salida" al
 * armar `calcularSaldoBancoEsperado` — la clasificación es una sola, no
 * se vuelve a decidir en dos lugares.
 */
export const DIRECCION_MOVIMIENTO_BANCO: Record<
  TipoMovimientoManual,
  'ENTRADA' | 'SALIDA'
> = {
  CONSIGNACION: 'ENTRADA',
  RETIRO: 'SALIDA',
  TRANSFERENCIA_ENTRANTE: 'ENTRADA',
  TRANSFERENCIA_SALIENTE: 'SALIDA',
  NOTA_DEBITO: 'SALIDA',
  NOTA_CREDITO: 'ENTRADA',
  CHEQUE: 'SALIDA',
};

/**
 * Los tipos que entran y los que salen, sacados de `DIRECCION_MOVIMIENTO_BANCO`
 * y no escritos a mano: el resumen del libro tenía su propia lista y dejaba
 * afuera las notas débito, las notas crédito y los cheques. El saldo cuadraba
 * —se lee del último movimiento— pero "entradas" y "salidas" no sumaban lo
 * mismo que el libro.
 */
export const TIPOS_ENTRADA_BANCO = Object.entries(DIRECCION_MOVIMIENTO_BANCO)
  .filter(([, direccion]) => direccion === 'ENTRADA')
  .map(([tipo]) => tipo);
export const TIPOS_SALIDA_BANCO = Object.entries(DIRECCION_MOVIMIENTO_BANCO)
  .filter(([, direccion]) => direccion === 'SALIDA')
  .map(([tipo]) => tipo);

/** Comprobante de ingreso para lo que entra, de egreso para lo que sale — mismo criterio que Caja. */
const CODIGO_COMPROBANTE: Record<'ENTRADA' | 'SALIDA', string> = {
  ENTRADA: 'CI',
  SALIDA: 'CE',
};

/**
 * El libro de una cuenta bancaria. Cada método que escribe bloquea la
 * fila de `cuenta_bancaria` antes de leer su último saldo — mismo motivo
 * que `CajaMovimientoService`. Sin arqueo: el saldo corre continuo, y la
 * conciliación (`ExtractoService`, paso 17) es una auditoría periódica
 * aparte, no una compuerta de escritura — ver
 * `docs/planes/caja-bancos-fase2.md`.
 */
@Injectable()
export class BancoMovimientoService {
  constructor(
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /**
   * El saldo con el que arranca una cuenta bancaria. Solo una vez — si ya
   * tiene movimientos, se rechaza, mismo criterio que
   * `CajaMovimientoService.registrarSaldoInicial`.
   */
  async registrarSaldoInicial(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: CargaInicialBancoDto,
  ): Promise<MovimientoBancoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCuentaBloqueada(cuentaBancariaId, t);
      const ultimo = await this.ultimoMovimiento(cuentaBancariaId, t);
      if (ultimo !== null) {
        throw new BadRequestException(
          'Esta cuenta bancaria ya tiene movimientos; el saldo inicial ya se cargó.',
        );
      }

      const saldo = calcularIngresoBanco(0, dto.valor);

      return this.insertarMovimiento(
        t,
        ctx,
        randomUUID(),
        cuentaBancariaId,
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
   * Un movimiento manual, sin factura de por medio. Nunca rechaza por
   * negativo — a diferencia de Caja, una cuenta bancaria puede tener
   * sobregiro.
   */
  async registrarMovimiento(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: RegistrarMovimientoBancoDto,
  ): Promise<MovimientoBancoResumen> {
    return this.moverBanco(ctx, cuentaBancariaId, {
      tipo: dto.tipo,
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
   * Un cobro o pago por transferencia, ligado a un documento — la llama
   * `TesoreriaApi.registrarCobro`/`registrarPago` cuando `medio: 'BANCO'`
   * (paso 18). Mismo criterio que
   * `CajaMovimientoService.registrarMovimientoDocumento`: acá sí se
   * conoce el documento y el tercero, así que
   * `banco_movimiento.origen_tipo`/`origen_id`/`tercero_id` los llevan en
   * vez de quedar `NULL`.
   *
   * `t` opcional, mismo motivo que `CajaMovimientoService`: quien cobra o
   * paga una factura real abre su propia transacción para actualizar
   * `monto_pagado` en el mismo commit.
   */
  async registrarMovimientoDocumento(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    datos: {
      tipo: 'TRANSFERENCIA_ENTRANTE' | 'TRANSFERENCIA_SALIENTE';
      fecha: string;
      valor: number;
      concepto: string;
      contraCuentaId: string;
      documentoTipo: 'FACTURA_VENTA' | 'COMPRA';
      documentoId: string;
      terceroId: string;
    },
    t?: Tx,
  ): Promise<MovimientoBancoResumen> {
    return this.moverBanco(
      ctx,
      cuentaBancariaId,
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

  /** El libro de una cuenta bancaria. Orden de digitación, el más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    p: ListarMovimientosBancoDto,
  ): Promise<Pagina<MovimientoBancoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = fila<{ total: string }>(
        await t.query(
          'SELECT count(*) AS total FROM banco_movimiento WHERE cuenta_bancaria_id = $1',
          [cuentaBancariaId],
        ),
      );

      const datos = filas<MovimientoBancoResumen>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1
            ORDER BY secuencia DESC
            LIMIT $2 OFFSET $3`,
          [cuentaBancariaId, p.tamano, p.salto],
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /**
   * Cuánto entró y cuánto salió en el libro entero. Espejo del de caja, y allá
   * está escrito el porqué; lo que cambia es qué cuenta como entrada, que en
   * un banco son dos tipos y no uno.
   */
  async resumen(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
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
          `SELECT coalesce(sum(valor) FILTER (WHERE tipo = ANY($2::text[])), 0)::text AS entradas,
                  coalesce(sum(valor) FILTER (WHERE tipo = ANY($3::text[])), 0)::text AS salidas,
                  coalesce(sum(valor) FILTER (WHERE tipo = 'SALDO_INICIAL'), 0)::text AS saldo_inicial,
                  coalesce(
                    (SELECT m.saldo_valor FROM banco_movimiento m
                      WHERE m.cuenta_bancaria_id = $1
                      ORDER BY m.secuencia DESC
                      LIMIT 1), 0)::text AS saldo
             FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1`,
          [cuentaBancariaId, TIPOS_ENTRADA_BANCO, TIPOS_SALIDA_BANCO],
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
   * Bloquea la fila de la cuenta bancaria por el resto de la transacción
   * — mismo motivo que `CajaMovimientoService.exigirCajaBloqueada`.
   */
  private async exigirCuentaBloqueada(
    cuentaBancariaId: string,
    t: Tx,
  ): Promise<{ id: string; cuenta_id: string }> {
    const cuenta = fila<{ id: string; cuenta_id: string }>(
      await t.query(
        `SELECT id, cuenta_id FROM cuenta_bancaria WHERE id = $1 AND activa FOR UPDATE`,
        [cuentaBancariaId],
      ),
    );
    if (cuenta === undefined) {
      throw new NotFoundException('Cuenta bancaria no encontrada o inactiva');
    }
    return cuenta;
  }

  /**
   * Lo que comparten `registrarMovimiento`/`registrarMovimientoDocumento`:
   * bloquear la cuenta, calcular el nuevo saldo (sin rechazo posible),
   * asentar y luego insertar — mismo patrón que
   * `CajaMovimientoService.moverCaja`.
   */
  private async moverBanco(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    datos: {
      tipo: TipoMovimientoManual;
      fecha: string;
      valor: number;
      concepto: string;
      contraCuentaId: string;
      origenTipo: 'FACTURA_VENTA' | 'COMPRA' | null;
      origenId: string | null;
      terceroId: string | null;
    },
    tExterna?: Tx,
  ): Promise<MovimientoBancoResumen> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const cuenta = await this.exigirCuentaBloqueada(cuentaBancariaId, t);
        const actual =
          (await this.ultimoMovimiento(cuentaBancariaId, t))?.saldo ?? 0;
        const direccion = DIRECCION_MOVIMIENTO_BANCO[datos.tipo];
        const nuevoSaldo =
          direccion === 'ENTRADA'
            ? calcularIngresoBanco(actual, datos.valor)
            : calcularEgresoBanco(actual, datos.valor);

        const movimientoId = randomUUID();
        const asientoId = await this.asentarMovimiento(
          ctx,
          cuenta,
          datos,
          direccion,
          movimientoId,
          t,
        );

        return this.insertarMovimiento(
          t,
          ctx,
          movimientoId,
          cuentaBancariaId,
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
   * El asiento de un movimiento: debita o acredita la cuenta bancaria
   * contra `contraCuentaId` según la `direccion` — mismo criterio que
   * `CajaMovimientoService.asentarMovimiento`. `origenTipo` del ASIENTO
   * siempre es `MOVIMIENTO_BANCO` acá, sea manual o ligado a un
   * documento — el `origen_tipo` de `banco_movimiento` es otra columna.
   */
  private async asentarMovimiento(
    ctx: CtxEmpresa,
    cuenta: { cuenta_id: string },
    dto: {
      fecha: string;
      concepto: string;
      valor: number;
      contraCuentaId: string;
      terceroId?: string | null;
    },
    direccion: 'ENTRADA' | 'SALIDA',
    movimientoId: string,
    t: Tx,
  ): Promise<string> {
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      CODIGO_COMPROBANTE[direccion],
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        `La empresa no tiene el comprobante de ${direccion === 'ENTRADA' ? 'ingreso' : 'egreso'} sembrado.`,
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
            cuentaId: cuenta.cuenta_id,
            debito: direccion === 'ENTRADA' ? dto.valor : 0,
            credito: direccion === 'SALIDA' ? dto.valor : 0,
          },
          {
            cuentaId: dto.contraCuentaId,
            debito: direccion === 'SALIDA' ? dto.valor : 0,
            credito: direccion === 'ENTRADA' ? dto.valor : 0,
            // Un cobro o pago va contra Clientes/Proveedores, y esas cuentas
            // exigen tercero: sin él el libro no sabe quién pagó ni a quién.
            // Un movimiento manual no lo trae y su contracuenta no lo pide.
            terceroId: dto.terceroId ?? undefined,
          },
        ],
      },
      { origenTipo: 'MOVIMIENTO_BANCO', origenId: movimientoId },
      t,
    );
    return asiento.id;
  }

  /** El saldo con el que sigue el próximo movimiento, o `null` si la cuenta no tiene ninguno. */
  private async ultimoMovimiento(
    cuentaBancariaId: string,
    t: Tx,
  ): Promise<{ saldo: number } | null> {
    const ultimo = fila<{ saldo_valor: string }>(
      await t.query(
        `SELECT saldo_valor
           FROM banco_movimiento
          WHERE cuenta_bancaria_id = $1
          ORDER BY secuencia DESC
          LIMIT 1`,
        [cuentaBancariaId],
      ),
    );
    if (ultimo === undefined) return null;
    return { saldo: Number(ultimo.saldo_valor) };
  }

  private async insertarMovimiento(
    t: Tx,
    ctx: CtxEmpresa,
    id: string,
    cuentaBancariaId: string,
    tipo: 'SALDO_INICIAL' | TipoMovimientoManual,
    fecha: string,
    valor: number,
    concepto: string,
    origenTipo: 'FACTURA_VENTA' | 'COMPRA' | null,
    origenId: string | null,
    terceroId: string | null,
    saldoValor: number,
    asientoId: string | null,
  ): Promise<MovimientoBancoResumen> {
    const creado = fila<MovimientoBancoResumen>(
      await t.query(
        `INSERT INTO banco_movimiento
           (id, empresa_id, cuenta_bancaria_id, fecha, tipo, valor, concepto, origen_tipo,
            origen_id, tercero_id, saldo_valor, asiento_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING ${CAMPOS}`,
        [
          id,
          ctx.empresaId,
          cuentaBancariaId,
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
