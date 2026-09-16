import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { CambiarPrecioDto, ListarPreciosDto } from '../dto/precio.dto';
import {
  CrearProductoDto,
  EditarProductoDto,
  ListarProductosDto,
} from '../dto/producto.dto';
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import { CargarImagenDto, FijarImagenDto } from '../dto/imagen.dto';
import { PrecioService } from '../servicios/precio.service';
import { ProductoService } from '../servicios/producto.service';

/**
 * El maestro de productos y su historial de precio. El kardex vive en
 * `movimientos.controller.ts` — comparte producto pero no comparte roles ni
 * ciclo de vida (un precio se cambia cuando se quiera; un movimiento de
 * kardex no se edita nunca).
 */
@Controller('productos')
@ExigeEmpresa()
export class ProductosController {
  constructor(
    private readonly productos: ProductoService,
    private readonly precios: PrecioService,
    private readonly almacenamiento: AlmacenamientoApi,
  ) {}

  /**
   * La bitácora completa de precios, de todos los productos. Va antes de
   * `:id` para que 'precios' no entre como si fuera un UUID — mismo motivo
   * que `centros-costo` en `plan-cuentas.controller.ts`.
   */
  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get('precios')
  bitacoraPrecios(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: ListarPreciosDto,
  ) {
    return this.precios.listarTodos(ctx, q);
  }

  /**
   * La URL a la que el navegador le hace `PUT` con la imagen, y la llave con
   * la que después la confirma.
   *
   * El archivo **no pasa por la API**: se sube directo al bucket. La llave la
   * decide el servidor —si la eligiera el cliente podría pisar la imagen de
   * otro producto— y la URL caduca en cinco minutos.
   */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Post(':id/imagen/carga')
  async urlDeCarga(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CargarImagenDto,
  ) {
    return this.almacenamiento.firmarSubida(`productos/${id}`, dto.tipoMime);
  }

  /** Confirma la subida: guarda la llave y borra la imagen anterior. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Put(':id/imagen')
  fijarImagen(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FijarImagenDto,
  ) {
    return this.productos.fijarImagen(ctx, id, dto.clave);
  }

  /** Quita la imagen. El objeto se borra del bucket después de la columna. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Delete(':id/imagen')
  quitarImagen(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.productos.fijarImagen(ctx, id, null);
  }

  /** Va antes de `:id`, por lo mismo que `precios`. */
  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get('valor')
  valorInventario(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.productos.valorInventario(ctx);
  }

  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ListarProductosDto) {
    return this.productos.listar(ctx, q, {
      incluirInactivos: q.incluirInactivos,
      soloInactivos: q.soloInactivos,
    });
  }

  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get(':id')
  porId(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.productos.porId(ctx, id);
  }

  /** El historial de precio de UN producto, para su ficha. */
  @Roles('DIRECTOR', 'CONTADOR', 'INVENTARIO', 'VENTAS', 'COMPRAS', 'CONSULTA')
  @Get(':id/precios')
  precioDe(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.precios.historialDe(ctx, id);
  }

  @Roles('INVENTARIO', 'DIRECTOR')
  @Post()
  crear(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearProductoDto) {
    return this.productos.crear(ctx, dto);
  }

  @Roles('INVENTARIO', 'DIRECTOR')
  @Patch(':id')
  editar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarProductoDto,
  ) {
    return this.productos.editar(ctx, id, dto);
  }

  /** No borra: desactiva. Un producto con kardex no se puede quitar. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.productos.desactivar(ctx, id);
  }

  @Roles('INVENTARIO', 'DIRECTOR')
  @Post(':id/activar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.productos.activar(ctx, id);
  }

  /** Nunca un PATCH sobre el precio: cambiar de precio cierra uno y abre otro. */
  @Roles('INVENTARIO', 'DIRECTOR')
  @Post(':id/precio')
  cambiarPrecio(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarPrecioDto,
  ) {
    return this.precios.cambiar(ctx, id, dto);
  }
}
