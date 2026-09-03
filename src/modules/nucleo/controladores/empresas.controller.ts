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

import {
  Actor,
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { Ctx, CtxEmpresa } from '../../../common/ctx';
import {
  CrearEmpresaDto,
  CrearSedeDto,
  EditarEmpresaDto,
  EditarSedeDto,
} from '../dto/empresa.dto';
import { EmpresaService } from '../servicios/empresa.service';
import { EstadoConfiguracionService } from '../servicios/estado-configuracion.service';

@Controller('empresas')
export class EmpresasController {
  constructor(
    private readonly empresas: EmpresaService,
    private readonly estado: EstadoConfiguracionService,
  ) {}

  /**
   * Crear una empresa es un acto de la cuenta, no de una contabilidad: por eso lo
   * autoriza `ADMIN_TENANT` y no exige empresa elegida. Es lo que permite que el
   * primer usuario de una cuenta nueva cree la primera.
   */
  @Roles('ADMIN_TENANT')
  @Post()
  crear(@Actor() ctx: Ctx, @Body() dto: CrearEmpresaDto) {
    return this.empresas.crear(ctx, dto);
  }

  /** Las empresas del tenant. RLS ya las limita a la cuenta de quien pregunta. */
  @Get()
  listar(@Actor() ctx: Ctx) {
    return this.empresas.listar(ctx);
  }

  /**
   * Qué falta para que la empresa pueda operar.
   *
   * Es la consulta de la que cuelga el asistente de configuración: devuelve los
   * seis pasos, su estado y el campo exacto que falta en cada uno. Sin ella el
   * cliente tendría que pegarle a seis endpoints y deducirlo, y esa deducción
   * quedaría escrita en el frontend en vez de donde viven las reglas.
   *
   * No lleva `@Roles`: cualquiera que entre a la empresa necesita saber si está
   * lista. Quién puede completar cada paso lo deciden los endpoints de cada uno.
   */
  @ExigeEmpresa()
  @Get('actual/estado-configuracion')
  estadoConfiguracion(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.estado.estado(ctx);
  }

  @ExigeEmpresa()
  @Get('actual')
  actual(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.empresas.porId(ctx, ctx.empresaId);
  }

  /**
   * El NIT no se edita: cambiar de NIT no es corregir un dato, es otra persona
   * jurídica con otra contabilidad y otra numeración fiscal.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @ExigeEmpresa()
  @Patch('actual')
  editar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: EditarEmpresaDto) {
    return this.empresas.editar(ctx, ctx.empresaId, dto);
  }

  @Roles('ADMIN_TENANT')
  @ExigeEmpresa()
  @Post('actual/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivar(@ActorEmpresa() ctx: CtxEmpresa): Promise<void> {
    await this.empresas.desactivar(ctx, ctx.empresaId);
  }

  // ---------------------------------------------------------------------------
  // Sedes
  // ---------------------------------------------------------------------------

  @ExigeEmpresa()
  @Get('actual/sedes')
  listarSedes(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.empresas.listarSedes(ctx);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @ExigeEmpresa()
  @Post('actual/sedes')
  crearSede(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CrearSedeDto) {
    return this.empresas.crearSede(ctx, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @ExigeEmpresa()
  @Patch('actual/sedes/:id')
  editarSede(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditarSedeDto,
  ) {
    return this.empresas.editarSede(ctx, id, dto);
  }

  @Roles('ADMIN_TENANT', 'DIRECTOR')
  @ExigeEmpresa()
  @Post('actual/sedes/:id/desactivar')
  @HttpCode(HttpStatus.NO_CONTENT)
  async desactivarSede(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.empresas.desactivarSede(ctx, id);
  }
}
