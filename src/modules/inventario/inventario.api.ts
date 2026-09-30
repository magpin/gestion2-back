import { Injectable } from '@nestjs/common';

import { PaginacionDto } from '../../common/dto/paginacion.dto';

import type { CtxEmpresa } from '../../common/ctx';
import type { Tx } from '../../common/db/tx.service';
import type { SaldoKardex } from './servicios/kardex.reglas';
import { ConfiguracionService } from './servicios/configuracion.service';
import { KardexService } from './servicios/kardex.service';
import { PrecioService } from './servicios/precio.service';
import {
  ProductoService,
  type ProductoResumen,
} from './servicios/producto.service';

/**
 * La única clase que `inventario` expone a otros módulos.
 *
 * Todo lo demás —servicios, controladores, DTOs— es interno. Ventas y Compras
 * (módulos #4 y #5 de `docs/decisiones/secuencia-modulos.md`) llaman acá, no
 * a `ProductoService` ni `KardexService` directamente. Esa regla es lo que
 * permite cambiar cómo se guarda el kardex sin que se entere nadie más.
 *
 * `costearSalida`/`descontarPorVenta` los completó Ventas (#4) al
 * diseñarse — ver `docs/planes/ventas-backend.md`, decisión 2.
 * `incrementarPorCompra` los completó Compras (#5) — ver
 * `docs/planes/compras-backend.md`, decisión 7.
 */
/** Lo que hay de un producto hoy. Lo que el asistente contesta a «¿cuántos quedan?». */
export interface Existencia {
  codigo: string;
  nombre: string;
  unidad: string;
  cantidad: string;
  costoPromedio: string;
  valor: string;
}

/** Los productos que devuelve una búsqueda de existencias. */
const EXISTENCIAS_POR_BUSQUEDA = 20;

@Injectable()
export class InventarioApi {
  constructor(
    private readonly productos: ProductoService,
    private readonly kardex: KardexService,
    private readonly precios: PrecioService,
    private readonly configuracion: ConfiguracionService,
  ) {}

  /**
   * Las existencias de hoy de los productos activos que coinciden con la
   * búsqueda (código, código de barras o nombre sin tildes), los primeros 20.
   * Solo lectura: lo pide el asistente (paso 6 de `asistente-conversacion.md`),
   * con la misma búsqueda que `GET /productos`. **No mira roles**: eso lo hace
   * quien llama, igual que el controlador.
   */
  /**
   * Las cuentas automáticas de inventario, creadas y asignadas si faltan.
   * Ver `ConfiguracionService.preparar`.
   */
  async prepararCuentas(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<{ cuentasCreadas: string[] }> {
    return this.configuracion.preparar(ctx, tx);
  }

  async existencias(ctx: CtxEmpresa, busqueda: string): Promise<Existencia[]> {
    const p = Object.assign(new PaginacionDto(), {
      tamano: EXISTENCIAS_POR_BUSQUEDA,
      q: busqueda,
    });
    const pagina = await this.productos.listar(ctx, p, {});
    return pagina.datos.map((r) => ({
      codigo: r.codigo,
      nombre: r.nombre,
      unidad: r.unidad_medida,
      cantidad: r.saldo_cantidad,
      costoPromedio: r.saldo_costo_promedio,
      valor: r.saldo_valor,
    }));
  }

  /**
   * Los productos activos que coinciden con la búsqueda, **con su id**.
   *
   * Hermano de `existencias`, que devuelve casi lo mismo sin el id porque va a
   * una respuesta del chat. Acá el id es el punto: quien llama está cruzando el
   * renglón de una factura para armar una compra, y necesita poder apuntarle.
   */
  async buscarProductos(
    ctx: CtxEmpresa,
    busqueda: string,
  ): Promise<Array<{ id: string; codigo: string; nombre: string }>> {
    const p = Object.assign(new PaginacionDto(), {
      tamano: EXISTENCIAS_POR_BUSQUEDA,
      q: busqueda,
    });
    const pagina = await this.productos.listar(ctx, p, {});
    return pagina.datos.map((r) => ({
      id: r.id,
      codigo: r.codigo,
      nombre: r.nombre,
    }));
  }

  /** Los datos de un producto para ponerlo en un documento. `null` si no existe. */
  async producto(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<ProductoResumen | null> {
    return this.productos.buscar(ctx, id, tx);
  }

  /**
   * El precio de lista vigente de un producto, para proponerlo en una línea
   * de venta. `null` si el producto no tiene ninguno configurado. La línea
   * puede llevar otro —el que se pactó con el cliente—: ver `resolverPrecio`
   * en `ventas`.
   */
  async precioVigente(
    ctx: CtxEmpresa,
    productoId: string,
    tx?: Tx,
  ): Promise<number | null> {
    return this.precios.vigenteDe(ctx, productoId, tx);
  }

  /**
   * El saldo de existencias vigente. `null` si el producto todavía no tiene
   * movimientos (no se le cargó su saldo inicial).
   */
  async saldoActual(
    ctx: CtxEmpresa,
    productoId: string,
    tx?: Tx,
  ): Promise<SaldoKardex | null> {
    return this.kardex.ultimoSaldo(ctx, productoId, tx);
  }

  /**
   * El costo de vender una cantidad, sin insertar nada en el kardex.
   *
   * `tx` es obligatorio y no opcional: quien llama tiene que seguir en la
   * MISMA transacción hasta `descontarPorVenta` — el candado que bloquea la
   * fila del producto solo dura mientras esa transacción sigue abierta.
   * Rechaza si la cantidad deja el saldo negativo, con el costo unitario
   * (el promedio vigente, que una salida no modifica) y el valor total ya
   * redondeados a pesos.
   *
   * `sinExistencia` es la confirmación de quien factura: con ella, y solo si
   * la empresa habilitó el descubierto, la salida se permite igual y
   * `faltante` dice cuántas unidades no estaban. Sigue rechazando si el
   * producto nunca tuvo una entrada: sin costo conocido no hay con qué
   * valorar la venta.
   */
  async costearSalida(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    tx: Tx,
    sinExistencia = false,
  ): Promise<{ costoUnitario: number; valorTotal: number; faltante: number }> {
    return this.kardex.costearSalida(
      ctx,
      productoId,
      cantidad,
      tx,
      sinExistencia,
    );
  }

  /**
   * Descuenta la venta del kardex, con el asiento ya creado.
   *
   * Se llama DESPUÉS de `costearSalida` y del `ContabilidadApi.asentar` de
   * quien vende, en la MISMA transacción que las dos — inventario nunca
   * asienta la venta completa, solo mueve su propio kardex y confía en que
   * quien es dueño de la cabecera ya armó y guardó el asiento.
   */
  async descontarPorVenta(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    fecha: string,
    motivo: string,
    asientoId: string,
    tx: Tx,
    sinExistencia = false,
  ): Promise<{ movimientoId: string }> {
    const movimiento = await this.kardex.registrarSalidaVenta(
      ctx,
      productoId,
      cantidad,
      fecha,
      motivo,
      asientoId,
      tx,
      sinExistencia,
    );
    return { movimientoId: movimiento.id };
  }

  /**
   * Aumenta el kardex por una compra, con el asiento ya creado.
   *
   * A diferencia de `descontarPorVenta`, no hay una fase previa de
   * "costear sin insertar": el costo de una entrada es un dato de la
   * factura del proveedor, no algo que dependa del saldo actual — así que
   * `compras` arma y guarda su asiento primero, y llama acá después, en la
   * MISMA transacción, para que el candado de la fila del producto siga
   * sosteniendo mientras tanto.
   */
  async incrementarPorCompra(
    ctx: CtxEmpresa,
    productoId: string,
    cantidad: number,
    costoUnitario: number,
    fecha: string,
    motivo: string,
    asientoId: string,
    tx: Tx,
  ): Promise<{ movimientoId: string }> {
    const movimiento = await this.kardex.registrarEntradaCompra(
      ctx,
      productoId,
      cantidad,
      costoUnitario,
      fecha,
      motivo,
      asientoId,
      tx,
    );
    return { movimientoId: movimiento.id };
  }

  /**
   * Deja en cero, al mismo valor, lo que movió en el kardex un documento que
   * se anula —una venta o una compra—. En la MISMA transacción que la
   * anulación, con el asiento del documento, ya anulado, como referencia.
   *
   * Lo que salió vuelve al costo con que salió y lo que entró sale al costo con
   * que entró: así el kardex queda igual que la cuenta del inventario, que es
   * la que el asiento anulado dejó de contar. Correrlo sobre un asiento que ya
   * está en cero no hace nada.
   */
  async revertirPorAnulacion(
    ctx: CtxEmpresa,
    asientoId: string,
    fecha: string,
    motivo: string,
    tx: Tx,
  ): Promise<{ movimientos: number }> {
    const hechos = await this.kardex.revertirAsiento(
      ctx,
      asientoId,
      fecha,
      motivo,
      tx,
    );
    return { movimientos: hechos.length };
  }
}
