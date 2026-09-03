import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { Publico } from '../../../common/auth/decoradores';
import {
  CrearCuentaDto,
  CrearEmpresaEnCuentaDto,
  CrearUsuarioEnCuentaDto,
  EditarCuentaDto,
} from '../dto/cuentas.dto';
import { Admin } from '../plataforma.decoradores';
import type { CtxPlataforma } from '../../../common/ctx';
import { PlataformaGuard } from '../plataforma.guard';
import { CuentasService } from '../servicios/cuentas.service';

/**
 * La administración del producto.
 *
 * Va bajo `/plataforma` y con guard propio: los guards globales del sistema
 * esperan un token de cliente, y este es de otro ámbito. `@Publico()` los
 * desactiva y `PlataformaGuard` toma su lugar.
 *
 * Acá NO se entra: el login es uno solo y vive en `POST /auth/login`, que
 * devuelve `ambito: 'PLATAFORMA'` cuando el correo administra el producto. Este
 * controlador solo recibe tokens ya emitidos.
 *
 * Lo que este controlador NO tiene es tan importante como lo que tiene: no hay
 * un endpoint para entrar a una contabilidad, ni para leer asientos, facturas o
 * terceros. Administrar el producto y operar una contabilidad son dos cosas
 * distintas, y acá solo vive la primera.
 */
@Controller('plataforma')
@Publico()
export class PlataformaController {
  constructor(private readonly cuentas: CuentasService) {}

  @UseGuards(PlataformaGuard)
  @Get('auth/yo')
  yo(@Admin() admin: CtxPlataforma) {
    return admin;
  }

  // --- Cuentas --------------------------------------------------------------

  @UseGuards(PlataformaGuard)
  @Get('cuentas')
  listar(@Query('q') q?: string) {
    return this.cuentas.listar(q);
  }

  @UseGuards(PlataformaGuard)
  @Get('cuentas/:id')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.cuentas.detalle(id);
  }

  /** Cuenta, primer usuario y —lo habitual— su empresa, en una sola transacción. */
  @UseGuards(PlataformaGuard)
  @Post('cuentas')
  crear(@Admin() admin: CtxPlataforma, @Body() dto: CrearCuentaDto) {
    return this.cuentas.crearCuenta(admin, dto);
  }

  /** Plan, cupos y estado. Suspender no borra nada: el cliente deja de emitir. */
  @UseGuards(PlataformaGuard)
  @Patch('cuentas/:id')
  editar(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarCuentaDto,
  ) {
    return this.cuentas.editar(admin, id, dto);
  }

  // --- Dentro de una cuenta -------------------------------------------------

  @UseGuards(PlataformaGuard)
  @Post('cuentas/:id/empresas')
  crearEmpresa(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CrearEmpresaEnCuentaDto,
  ) {
    return this.cuentas.crearEmpresa(admin, id, dto);
  }

  @UseGuards(PlataformaGuard)
  @Post('cuentas/:id/usuarios')
  crearUsuario(
    @Admin() admin: CtxPlataforma,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CrearUsuarioEnCuentaDto,
  ) {
    return this.cuentas.crearUsuario(admin, id, dto);
  }
}
