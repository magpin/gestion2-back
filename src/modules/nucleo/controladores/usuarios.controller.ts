import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { Actor, Roles } from '../../../common/auth/decoradores';
import type { Ctx } from '../../../common/ctx';
import {
  AsignarRolDto,
  CrearUsuarioDto,
  EditarUsuarioDto,
  RevocarRolDto,
} from '../dto/usuario.dto';
import { UsuarioService } from '../servicios/usuario.service';

/**
 * Administración de usuarios de la cuenta. Es de ámbito tenant: no exige empresa
 * elegida, porque un usuario puede tener acceso a varias.
 */
@Controller('usuarios')
@Roles('ADMIN_TENANT')
export class UsuariosController {
  constructor(private readonly usuarios: UsuarioService) {}

  @Get()
  listar(@Actor() ctx: Ctx) {
    return this.usuarios.listar(ctx);
  }

  @Post()
  crear(@Actor() ctx: Ctx, @Body() dto: CrearUsuarioDto) {
    return this.usuarios.crear(ctx, dto);
  }

  @Patch(':id')
  editar(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarUsuarioDto,
  ) {
    return this.usuarios.editar(ctx, id, dto);
  }

  /** Un usuario se desactiva, nunca se borra: sus acciones quedan firmadas. */
  @Post(':id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.usuarios.desactivar(ctx, id);
  }

  @Post(':id/reactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reactivar(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.usuarios.reactivar(ctx, id);
  }

  @Post(':id/roles')
  @HttpCode(HttpStatus.NO_CONTENT)
  async asignarRol(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AsignarRolDto,
  ): Promise<void> {
    await this.usuarios.asignarRol(ctx, id, dto);
  }

  /** Revocar deja el rastro: queda quién tuvo el permiso y hasta cuándo. */
  @Post(':id/roles/revocar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revocarRol(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevocarRolDto,
  ): Promise<void> {
    await this.usuarios.revocarRol(ctx, id, dto.empresaId, dto.rol);
  }

  @Post(':id/admin-tenant')
  @HttpCode(HttpStatus.NO_CONTENT)
  async asignarAdmin(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.usuarios.asignarAdminTenant(ctx, id);
  }

  @Post(':id/admin-tenant/revocar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revocarAdmin(
    @Actor() ctx: Ctx,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.usuarios.revocarAdminTenant(ctx, id);
  }
}
