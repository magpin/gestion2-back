import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import {
  AnalizarDocumentoDto,
  RegistrarDocumentoDto,
  UrlDeCargaDto,
} from '../dto/lectura.dto';
import { TIPOS_SUBIBLES } from '../reglas/contenido';
import { DocumentoService, prefijoDe } from '../servicios/documento.service';
import { ExtractorService } from '../servicios/extractor.service';

/**
 * Los documentos del modo IA: subir, encolar, ver en qué van y qué se leyó.
 *
 * Escriben los mismos roles que pueden configurar a mano —`ADMIN_TENANT`,
 * `DIRECTOR`, `CONTADOR`—. La IA no amplía permisos: lo que no se puede hacer a
 * mano, tampoco leyendo un PDF.
 */
@Controller('configuracion/ia')
@ExigeEmpresa()
export class DocumentosController {
  constructor(
    private readonly almacenamiento: AlmacenamientoApi,
    private readonly documentos: DocumentoService,
    private readonly extractor: ExtractorService,
  ) {}

  /**
   * Si el modo IA se puede ofrecer. Sin clave de Anthropic o sin bucket, no: el
   * asistente manual funciona igual y la pantalla no muestra una puerta cerrada.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get('disponible')
  disponible() {
    return { disponible: this.extractor.disponible };
  }

  /**
   * La URL a la que el navegador le hace `PUT` con el archivo, y la llave con la
   * que después se registra.
   *
   * El archivo **no pasa por la API**, igual que las fotos del catálogo. La llave
   * la decide el servidor y lleva el id de la empresa adentro: es lo que después
   * permite rechazar una llave ajena.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('documentos/carga')
  urlDeCarga(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: UrlDeCargaDto) {
    return this.almacenamiento.firmarSubida(
      prefijoDe(ctx.empresaId),
      dto.tipoMime,
      TIPOS_SUBIBLES,
    );
  }

  /**
   * Registra un archivo ya subido y lo encola. Contesta apenas la fila existe:
   * la lectura sigue por su cuenta y se mira por `GET progreso`.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('documentos')
  registrar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: RegistrarDocumentoDto,
  ) {
    return this.extractor.encolar(ctx, dto);
  }

  /**
   * Un archivo cualquiera, subido sin decir qué es. Contesta qué es; si es
   * uno de los tres documentos, la lectura ya arrancó y viene en `documento`.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('documentos/analizar')
  @HttpCode(HttpStatus.OK)
  analizar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: AnalizarDocumentoDto) {
    return this.extractor.analizar(ctx, dto.clave);
  }

  /**
   * El último intento de cada tipo. Es lo que la tarjeta de documentos necesita
   * para dibujarse después de un F5, cuando ya no hay eventos que escuchar.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get('documentos')
  listar(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.documentos.listar(ctx);
  }

  // Acá estaba `GET extraido`: todo lo leído de la empresa, en una sola lista.
  // Se borró el 20 de septiembre, al cerrar el modo IA, porque nunca tuvo
  // consumidor y no podía tenerlo: devolvía los datos **sueltos, sin el id del
  // documento**, y confirmar necesita ese id. `GET documentos` da las dos
  // cosas, así que lo que hacía este era `listar()` aplanado — tres líneas que
  // duplicaban una consulta y perdían la mitad de lo que hace falta.

  /**
   * «Detener» del §7.7: corta la llamada en curso. Si ya había terminado no hay
   * nada que cortar, y decirlo es la respuesta correcta.
   */
  @Roles('ADMIN_TENANT', 'DIRECTOR', 'CONTADOR')
  @Post('documentos/:id/detener')
  async detener(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // Que el documento sea de esta empresa lo decide RLS, no este código: si no
    // lo es, `porId` no lo encuentra.
    const documento = await this.documentos.porId(ctx, id);
    if (documento.estado === 'LEIDO' || documento.estado === 'FALLO') {
      throw new NotFoundException('Esa lectura ya terminó.');
    }
    return { detenida: await this.extractor.detener(ctx, documento) };
  }
}
