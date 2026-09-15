import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type {
  CargaInicialDto,
  EntradaAjusteDto,
  FiltroMovimientosDto,
  SalidaAjusteDto,
} from '../dto/movimiento.dto';
import { ConfiguracionService } from './configuracion.service';
import {
  calcularEntrada,
  calcularSalida,
  type ResultadoEntrada,
  type SaldoKardex,
} from './kardex.reglas';

export interface MovimientoResumen {
  id: string;
  producto_id: string;
  fecha: string;
  tipo: string;
  cantidad: string;
  costo_unitario: string;
  valor_total: string;
  saldo_cantidad: string;
  saldo_costo_promedio: string;
  saldo_valor: string;
  motivo: string;
  asiento_id: string | null;
}

const CAMPOS = `id, producto_id, fecha, tipo, cantidad, costo_unitario, valor_total,
                saldo_cantidad, saldo_costo_promedio, saldo_valor, motivo, asiento_id`;

/** Todo ajuste de inventario se asienta contra el comprobante de diario. */
const CODIGO_COMPROBANTE_AJUSTE = 'CD';

/**
 * El kardex. Cada método abre su propia transacción (o se engancha a una) y
 * bloquea la fila del producto antes de leer su último saldo: sin ese
 * candado, dos ajustes simultáneos leerían el mismo saldo "actual" y uno
 * pisaría al otro.
 *
 * Las reglas puras (`kardex.reglas.ts`) ya están probadas sin base de datos.
 * Este servicio solo las alimenta con lo que sale de Postgres y decide qué
 * pasa con el resultado: insertar, o rechazar antes de escribir nada.
 */
@Injectable()
export class KardexService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly configuracion: ConfiguracionService,
  ) {}

  /**
   * La existencia con la que arranca un producto. Solo una vez por producto
   * — si ya tiene movimientos, se rechaza. No genera asiento: ver el porqué
   * en `0025_producto_inventario.sql`.
   */
  async registrarCargaInicial(
    ctx: CtxEmpresa,
    productoId: string,
    dto: CargaInicialDto,
  ): Promise<MovimientoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirProductoBloqueado(productoId, t);
      const ultimo = await this.ultimoMovimiento(productoId, t);
      if (ultimo !== null) {
        throw new BadRequestException(
          'Este producto ya tiene movimientos; la carga inicial ya se hizo.',
        );
      }

      const { decimalesCantidad, decimalesCosto } =
        await this.exigirPromedioPonderado(ctx, t);
      const resultado = calcularEntrada(
        { cantidad: 0, costoPromedio: 0 },
        dto.cantidad,
        dto.costoUnitario,
        decimalesCantidad,
        decimalesCosto,
      );

      return this.insertarMovimiento(
        t,
        ctx,
        randomUUID(),
        productoId,
        'ENTRADA_INICIAL',
        dto.fecha,
        dto.cantidad,
        dto.costoUnitario,
        resultado,
        dto.motivo,
        null,
      );
    });
  }

  /** Sobrante encontrado en bodega. Sí genera asiento: debita la cuenta del producto. */
  async registrarEntradaAjuste(
    ctx: CtxEmpresa,
    productoId: string,
    dto: EntradaAjusteDto,
  ): Promise<MovimientoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const producto = await this.exigirProductoBloqueado(productoId, t);
      const { decimalesCantidad, decimalesCosto } =
        await this.exigirPromedioPonderado(ctx, t);
      const actual = (await this.ultimoMovimiento(productoId, t)) ?? {
        cantidad: 0,
        costoPromedio: 0,
      };

      const resultado = calcularEntrada(
        actual,
        dto.cantidad,
        dto.costoUnitario,
        decimalesCantidad,
        decimalesCosto,
      );

      const movimientoId = randomUUID();
      const asientoId = await this.asentarAjuste(
        ctx,
        producto,
        dto.fecha,
        dto.motivo,
        resultado.valorMovimiento,
        'DEBITO',
        movimientoId,
        t,
      );

      return this.insertarMovimiento(
        t,
        ctx,
        movimientoId,
        productoId,
        'ENTRADA_AJUSTE',
        dto.fecha,
        dto.cantidad,
        dto.costoUnitario,
        resultado,
        dto.motivo,
        asientoId,
      );
    });
  }

  /** Faltante encontrado en bodega. Se valora al promedio vigente, no a uno nuevo. */
  async registrarSalidaAjuste(
    ctx: CtxEmpresa,
    productoId: string,
    dto: SalidaAjusteDto,
  ): Promise<MovimientoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const producto = await this.exigirProductoBloqueado(productoId, t);
      const { decimalesCantidad } = await this.exigirPromedioPonderado(ctx, t);
      const actual = (await this.ultimoMovimiento(productoId, t)) ?? {
        cantidad: 0,
        costoPromedio: 0,
      };

      const resultado = calcularSalida(actual, dto.cantidad, decimalesCantidad);
      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

      const movimientoId = randomUUID();
      const asientoId = await this.asentarAjuste(
        ctx,
        producto,
        dto.fecha,
        dto.motivo,
        resultado.valorMovimiento,
        'CREDITO',
        movimientoId,
        t,
      );

      return this.insertarMovimiento(
        t,
        ctx,
        movimientoId,
        productoId,
        'SALIDA_AJUSTE',
        dto.fecha,
        dto.cantidad,
        actual.costoPromedio,
        resultado,
        dto.motivo,
        asientoId,
      );
    });
  }

  /**
   * El costo de vender una cantidad, SIN insertar nada — para que `ventas`
   * arme su asiento antes de comprometer el movimiento. Exige `tx` (no es
   * opcional, a diferencia de `ultimoSaldo`): quien llama tiene que seguir
   * dentro de la misma transacción hasta insertar el movimiento con
   * `registrarSalidaVenta`, porque el candado de `exigirProductoBloqueado`
   * solo sostiene mientras la transacción sigue abierta.
   *
   * No inserta porque el asiento todavía no existe: `ventas` necesita este
   * costo para armar SU línea de costo de venta, y el asiento se crea
   * DESPUÉS, no antes — ver `docs/planes/ventas-backend.md`, decisión 2.
   */
  async costearSalida(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    tx: Tx,
  ): Promise<{ costoUnitario: number; valorTotal: number }> {
    await this.exigirProductoBloqueado(productoId, tx);
    const { decimalesCantidad } = await this.exigirPromedioPonderado(ctx, tx);
    const actual = (await this.ultimoMovimiento(productoId, tx)) ?? {
      cantidad: 0,
      costoPromedio: 0,
    };

    const resultado = calcularSalida(actual, cantidad, decimalesCantidad);
    if (!resultado.ok) {
      throw new BadRequestException(resultado.motivo);
    }

    return {
      costoUnitario: actual.costoPromedio,
      valorTotal: resultado.valorMovimiento,
    };
  }

  /**
   * Inserta el movimiento de una venta, con el asiento ya resuelto. Se
   * llama DESPUÉS de `costearSalida` y del `ContabilidadApi.asentar` de
   * `ventas`, en la MISMA transacción que las dos — el `FOR UPDATE` de
   * `costearSalida` sigue bloqueando la fila desde ahí, así que el saldo no
   * pudo cambiar entre medio y recalcular acá da exactamente el mismo
   * resultado. No recibe el costo por parámetro a propósito: la única
   * fuente de verdad del costo es este cálculo, no lo que `ventas` haya
   * guardado en su propia línea.
   */
  async registrarSalidaVenta(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    fecha: string,
    motivo: string,
    asientoId: string,
    tx: Tx,
  ): Promise<MovimientoResumen> {
    const { decimalesCantidad } = await this.exigirPromedioPonderado(ctx, tx);
    const actual = (await this.ultimoMovimiento(productoId, tx)) ?? {
      cantidad: 0,
      costoPromedio: 0,
    };

    const resultado = calcularSalida(actual, cantidad, decimalesCantidad);
    if (!resultado.ok) {
      throw new BadRequestException(resultado.motivo);
    }

    return this.insertarMovimiento(
      tx,
      ctx,
      randomUUID(),
      productoId,
      'SALIDA_VENTA',
      fecha,
      cantidad,
      actual.costoPromedio,
      resultado,
      motivo,
      asientoId,
    );
  }

  /**
   * Devuelve al kardex lo que una compra anulada había metido.
   *
   * Sin asiento propio: el de la compra queda anulado y con eso el libro ya
   * dejó de contar esa mercancía, así que la salida referencia ese mismo
   * asiento y el conjunto queda en cero por los dos lados. Se valora al
   * promedio vigente, igual que cualquier salida. Rechaza si las unidades ya
   * no están —se vendieron— porque entonces no hay qué devolver.
   */
  async registrarSalidaPorAnulacionCompra(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    fecha: string,
    motivo: string,
    asientoId: string,
    tx: Tx,
  ): Promise<MovimientoResumen> {
    await this.exigirProductoBloqueado(productoId, tx);
    const { decimalesCantidad } = await this.exigirPromedioPonderado(ctx, tx);
    const actual = (await this.ultimoMovimiento(productoId, tx)) ?? {
      cantidad: 0,
      costoPromedio: 0,
    };
    const resultado = calcularSalida(actual, cantidad, decimalesCantidad);
    if (!resultado.ok) {
      throw new BadRequestException(resultado.motivo);
    }
    return this.insertarMovimiento(
      tx,
      ctx,
      randomUUID(),
      productoId,
      'SALIDA_AJUSTE',
      fecha,
      cantidad,
      actual.costoPromedio,
      resultado,
      motivo,
      asientoId,
    );
  }

  /**
   * Inserta el movimiento de una compra, con el asiento ya resuelto. A
   * diferencia de una venta, una compra no tiene fase de "costear sin
   * insertar": el costo de una entrada es un dato de la factura del
   * proveedor, no algo que dependa del saldo actual, así que no hay nada
   * que calcular antes de tener el asiento — ver `docs/planes/compras-backend.md`,
   * decisión 7. Por eso, a diferencia de `registrarSalidaVenta`, este
   * método sí bloquea la fila él mismo: no hay un `costearSalida` previo
   * que ya la haya bloqueado.
   *
   * `costoUnitario` es el que ya incluye el IVA no descontable, si
   * corresponde (decisión 4 del plan) — quien llama ya resolvió esa
   * cuenta; acá solo se recalcula el promedio ponderado con lo que llega.
   */
  async registrarEntradaCompra(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    costoUnitario: number,
    fecha: string,
    motivo: string,
    asientoId: string,
    tx: Tx,
  ): Promise<MovimientoResumen> {
    await this.exigirProductoBloqueado(productoId, tx);
    const { decimalesCantidad, decimalesCosto } =
      await this.exigirPromedioPonderado(ctx, tx);
    const actual = (await this.ultimoMovimiento(productoId, tx)) ?? {
      cantidad: 0,
      costoPromedio: 0,
    };

    const resultado = calcularEntrada(
      actual,
      cantidad,
      costoUnitario,
      decimalesCantidad,
      decimalesCosto,
    );

    return this.insertarMovimiento(
      tx,
      ctx,
      randomUUID(),
      productoId,
      'ENTRADA_COMPRA',
      fecha,
      cantidad,
      costoUnitario,
      resultado,
      motivo,
      asientoId,
    );
  }

  /** El kardex, opcionalmente de un solo producto. Orden de digitación, el más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    p: FiltroMovimientosDto,
  ): Promise<Pagina<MovimientoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      if (p.productoId !== undefined) {
        params.push(p.productoId);
        condiciones.push(`producto_id = $${params.length}`);
      }

      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const conteo = fila<{ total: string }>(
        await t.query(
          `SELECT count(*) AS total FROM producto_movimiento ${where}`,
          params,
        ),
      );

      params.push(p.tamano, p.salto);
      const datos = filas<MovimientoResumen>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM producto_movimiento
             ${where}
            ORDER BY secuencia DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /**
   * El saldo vigente de un producto, para consumo de otro módulo a través de
   * `InventarioApi`. `null` si el producto todavía no tiene movimientos (no
   * se le cargó su saldo inicial). No bloquea la fila — a diferencia de
   * `exigirProductoBloqueado`, esto es una lectura suelta, no el primer paso
   * de un registro que va a escribir a continuación.
   */
  async ultimoSaldo(
    ctx: CtxEmpresa,
    productoId: string,
    tx?: Tx,
  ): Promise<SaldoKardex | null> {
    return this.tx.enContexto(
      ctx,
      (t) => this.ultimoMovimiento(productoId, t),
      tx,
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Bloquea la fila del producto por el resto de la transacción. Sin esto,
   * dos ajustes simultáneos sobre el mismo producto leerían el mismo "último
   * saldo" y uno pisaría el resultado del otro — el mismo problema que
   * `ComprobanteService.siguienteNumero` resuelve con `UPDATE ... RETURNING`,
   * pero acá no hay un contador que incrementar, así que se bloquea la fila.
   */
  private async exigirProductoBloqueado(
    productoId: string,
    t: Tx,
  ): Promise<{ id: string; cuenta_inventario_id: string }> {
    const producto = fila<{ id: string; cuenta_inventario_id: string }>(
      await t.query(
        `SELECT id, cuenta_inventario_id FROM producto WHERE id = $1 AND activo FOR UPDATE`,
        [productoId],
      ),
    );
    if (producto === undefined) {
      throw new NotFoundException('Producto no encontrado o inactivo');
    }
    return producto;
  }

  /** El saldo con el que sigue el próximo movimiento, o `null` si el producto no tiene ninguno. */
  private async ultimoMovimiento(
    productoId: string,
    t: Tx,
  ): Promise<SaldoKardex | null> {
    const ultimo = fila<{
      saldo_cantidad: string;
      saldo_costo_promedio: string;
    }>(
      await t.query(
        `SELECT saldo_cantidad, saldo_costo_promedio
           FROM producto_movimiento
          WHERE producto_id = $1
          ORDER BY secuencia DESC
          LIMIT 1`,
        [productoId],
      ),
    );
    if (ultimo === undefined) return null;
    return {
      cantidad: Number(ultimo.saldo_cantidad),
      costoPromedio: Number(ultimo.saldo_costo_promedio),
    };
  }

  /** Rechaza si la empresa está en PEPS: este motor solo sabe promedio ponderado. */
  private async exigirPromedioPonderado(
    ctx: CtxEmpresa,
    t: Tx,
  ): Promise<{ decimalesCantidad: number; decimalesCosto: number }> {
    const config = await this.nucleo.configuracionContable(ctx, t);
    if (config.metodo_valoracion_inventario !== 'PROMEDIO_PONDERADO') {
      throw new BadRequestException(
        'La empresa esta configurada en PEPS. Este modulo solo calcula promedio ponderado.',
      );
    }
    return {
      decimalesCantidad: Number(config.decimales_cantidad),
      decimalesCosto: Number(config.decimales_valor),
    };
  }

  /**
   * El asiento de un ajuste: debita o acredita la cuenta del producto contra
   * la cuenta de ajuste configurada. `origenId` es el id del movimiento que
   * se va a insertar a continuación, en la MISMA transacción — se genera
   * antes para poder enlazarlo en los dos lados.
   */
  private async asentarAjuste(
    ctx: CtxEmpresa,
    producto: { id: string; cuenta_inventario_id: string },
    fecha: string,
    motivo: string,
    valor: number,
    ladoProducto: 'DEBITO' | 'CREDITO',
    movimientoId: string,
    t: Tx,
  ): Promise<string> {
    const config = await this.configuracion.obtener(ctx, t);
    if (config.cuenta_ajuste_id === null) {
      throw new BadRequestException(
        'Configura primero la cuenta de ajuste de inventario (PUT /inventario/configuracion).',
      );
    }

    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      CODIGO_COMPROBANTE_AJUSTE,
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        'La empresa no tiene el comprobante de diario sembrado.',
      );
    }

    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha,
        glosa: `Ajuste de inventario: ${motivo}`,
        lineas: [
          {
            cuentaId: producto.cuenta_inventario_id,
            debito: ladoProducto === 'DEBITO' ? valor : 0,
            credito: ladoProducto === 'CREDITO' ? valor : 0,
          },
          {
            cuentaId: config.cuenta_ajuste_id,
            debito: ladoProducto === 'CREDITO' ? valor : 0,
            credito: ladoProducto === 'DEBITO' ? valor : 0,
          },
        ],
      },
      { origenTipo: 'AJUSTE_INVENTARIO', origenId: movimientoId },
      t,
    );
    return asiento.id;
  }

  private async insertarMovimiento(
    t: Tx,
    ctx: CtxEmpresa,
    id: string,
    productoId: string,
    tipo:
      | 'ENTRADA_INICIAL'
      | 'ENTRADA_AJUSTE'
      | 'ENTRADA_COMPRA'
      | 'SALIDA_AJUSTE'
      | 'SALIDA_VENTA',
    fecha: string,
    cantidad: number,
    costoUnitario: number,
    resultado: ResultadoEntrada,
    motivo: string,
    asientoId: string | null,
  ): Promise<MovimientoResumen> {
    const saldoValor =
      Math.round(
        resultado.saldo.cantidad * resultado.saldo.costoPromedio * 100,
      ) / 100;

    const creado = fila<MovimientoResumen>(
      await t.query(
        `INSERT INTO producto_movimiento
           (id, empresa_id, producto_id, fecha, tipo, cantidad, costo_unitario, valor_total,
            saldo_cantidad, saldo_costo_promedio, saldo_valor, motivo, asiento_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${CAMPOS}`,
        [
          id,
          ctx.empresaId,
          productoId,
          fecha,
          tipo,
          cantidad,
          costoUnitario,
          resultado.valorMovimiento,
          resultado.saldo.cantidad,
          resultado.saldo.costoPromedio,
          saldoValor,
          motivo,
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
