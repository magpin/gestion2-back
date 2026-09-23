import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  DescartarLecturaDto,
  RegistrarCompraLeidaDto,
} from '../dto/lectura.dto';
import { ConfirmacionFacturaService } from '../servicios/confirmacion-factura.service';
import { DocumentoService } from '../servicios/documento.service';

/**
 * Las facturas de compra que María leyó.
 *
 * **No va bajo `configuracion/ia/`** aunque lo sirva el mismo módulo: para
 * quien usa el sistema esto es compras, no configuración, y la ruta es lo que
 * queda escrito en el frontend y en cualquier integración.
 *
 * Tampoco va bajo `compras/lecturas`, que era lo natural y estuvo escrito así:
 * `ComprasController` tiene un `GET compras/:id` y se tragaba esa ruta tomando
 * «lecturas» por un id —contestaba «uuid is expected»—. Anidarla obligaría a
 * depender del orden en que Nest registra dos módulos, que es una trampa
 * esperando a que alguien reordene un `imports`.
 *
 * Subir el archivo sigue por los endpoints de siempre: eso es plomería —firmar,
 * subir, encolar— y es la misma para los cuatro documentos.
 */
@Controller('facturas-leidas')
@ExigeEmpresa()
export class FacturasLeidasController {
  constructor(
    private readonly documentos: DocumentoService,
    private readonly facturas: ConfirmacionFacturaService,
  ) {}

  /** Las últimas leídas: las registradas, las que fallaron y las que esperan. */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get()
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.documentos.listarFacturas(ctx);
  }

  /** Una, con sus renglones, sus comprobaciones y lo que quedó por preguntar. */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA')
  @Get(':id')
  ver(@ActorEmpresa() ctx: CtxEmpresa, @Param('id', ParseUUIDPipe) id: string) {
    return this.documentos.porId(ctx, id);
  }

  /**
   * Registra la compra. Los mismos roles que `POST /compras`, que es adonde va
   * a parar: **que la factura la haya leído María no le da a nadie un permiso
   * que no tiene.**
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'COMPRAS')
  @Post(':id/registrar')
  registrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarCompraLeidaDto,
  ) {
    return this.facturas.confirmar(ctx, id, dto);
  }

  /**
   * La deja sin registrar, con el motivo: «es la misma, descartala» sobre un
   * posible duplicado. Los mismos roles que registrarla: decidir que no se
   * registra es la otra mitad de la misma decisión.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'COMPRAS')
  @Post(':id/descartar')
  descartar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DescartarLecturaDto,
  ) {
    return this.documentos.descartar(ctx, id, 'FACTURA_COMPRA', dto.motivo);
  }
}
