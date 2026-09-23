import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';

import { Actor, Roles } from '../../../common/auth/decoradores';
import type { Ctx } from '../../../common/ctx';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import {
  EXTRACTOR_PUERTO,
  type ExtractorPuerto,
} from '../proveedores/extractor.puerto';

class CargaAltaDto {
  @IsString()
  @Length(3, 100)
  tipoMime!: string;
}

class IdentificarAltaDto {
  @IsString()
  @Length(10, 200)
  clave!: string;
}

/** Los archivos de una cuenta que todavía no tiene empresa. */
const prefijoAlta = (tenantId: string) => `altas/${tenantId}`;

/**
 * «Con IA» antes de que la empresa exista: una cuenta nueva sube su RUT y
 * María lee quién es —razón social, NIT, tipo de persona— para crearla.
 *
 * **No exige empresa**, como `POST /empresas`: es un acto de la cuenta, y lo
 * autoriza `ADMIN_TENANT`, que es quien puede crear empresas. No guarda nada:
 * lee, contesta y borra el archivo. La empresa la crea la persona después de
 * revisar, y el RUT completo se vuelve a subir ya dentro de ella.
 *
 * Esta lectura no queda en el consumo de IA —no hay empresa a la cual
 * cargarla—, igual que el «¿qué es esto?» del chat.
 */
@Controller('altas/rut')
export class AltasController {
  constructor(
    private readonly almacenamiento: AlmacenamientoApi,
    @Inject(EXTRACTOR_PUERTO) private readonly extractor: ExtractorPuerto,
    @Optional() private readonly pausa?: PausaIaService,
  ) {}

  @Roles('ADMIN_TENANT')
  @Post('carga')
  carga(@Actor() ctx: Ctx, @Body() dto: CargaAltaDto) {
    return this.almacenamiento.firmarSubida(prefijoAlta(ctx.tenantId), dto.tipoMime);
  }

  @Roles('ADMIN_TENANT')
  @Post('identificar')
  @HttpCode(HttpStatus.OK)
  async identificar(@Actor() ctx: Ctx, @Body() dto: IdentificarAltaDto) {
    if (!dto.clave.startsWith(`${prefijoAlta(ctx.tenantId)}/`)) {
      throw new BadRequestException('Ese archivo no es de esta cuenta.');
    }
    await this.pausa?.exigirActiva(ctx.tenantId, 'LECTURA');
    const archivo = await this.almacenamiento.descargar(dto.clave);
    try {
      const identidad = await this.extractor.identificarEmpresa(archivo);
      return {
        esRut: identidad.esRut,
        razonSocial: identidad.razonSocial,
        nit: identidad.nit,
        dv: identidad.dv,
        tipoPersona: identidad.tipoPersona,
        resumen: identidad.resumen,
      };
    } finally {
      await this.almacenamiento.borrar(dto.clave);
    }
  }
}
