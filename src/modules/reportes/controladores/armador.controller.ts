import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { ActorEmpresa, ExigeEmpresa } from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import {
  ActualizarReporteDto,
  CorrerArmadorDto,
  GuardarReporteDto,
  ValoresColumnaDto,
} from '../dto/armador.dto';
import type { Definicion } from '../reglas/armador';
import { ORIGENES } from '../reglas/catalogo';
import type { Rango } from '../reglas/rango';
import { ArmadorService } from '../servicios/armador.service';
import { CorridaService } from '../servicios/corrida.service';
import { FechasReporteService } from '../servicios/fechas.service';

/**
 * El armador y los reportes guardados.
 *
 * No lleva `@Roles`: quién puede correr qué lo dice el **origen** de cada
 * definición, y eso solo se sabe al leerla. `ArmadorService.exigirOrigen` lo
 * mira en cada corrida, con los roles de quien corre.
 */
@ExigeEmpresa()
@Controller('reportes')
export class ArmadorController {
  constructor(
    private readonly armador: ArmadorService,
    private readonly corridas: CorridaService,
    private readonly fechas: FechasReporteService,
  ) {}

  /** Los orígenes que el rol puede correr, con sus columnas. Sin SQL. */
  @Get('armador/origenes')
  origenes(@ActorEmpresa() ctx: CtxEmpresa) {
    return this.armador.origenes(ctx);
  }

  /** Los valores de una columna de lista, sacados de los datos de la empresa. */
  @Get('armador/valores')
  valores(@ActorEmpresa() ctx: CtxEmpresa, @Query() q: ValoresColumnaDto) {
    return this.armador.valores(ctx, q.origen, q.columna);
  }

  /** La vista previa: las primeras filas. No cuenta como corrida. */
  @Post('armador/muestra')
  @HttpCode(200)
  async muestra(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CorrerArmadorDto,
  ) {
    const def = this.armador.definicion(dto.definicion);
    return this.armador.muestra(ctx, def, await this.rangoDe(ctx, def));
  }

  /** El resultado: hasta cinco mil filas, con subtotales y total de todas. */
  @Post('armador/correr')
  @HttpCode(200)
  async correr(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: CorrerArmadorDto) {
    const def = this.armador.definicion(dto.definicion);
    const rango = await this.rangoDe(ctx, def);
    const resultado = await this.armador.correr(ctx, def, rango);
    if (dto.guardadoId) {
      await this.corridas.registrar(
        ctx,
        'GUARDADO',
        { desde: rango.desde, hasta: rango.hasta, etiqueta: rango.etiqueta },
        'HTML',
        dto.guardadoId,
      );
    }
    return resultado;
  }

  /** El mismo resultado, en Excel. */
  @Post('armador/excel')
  @HttpCode(200)
  async excel(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Body() dto: CorrerArmadorDto,
    @Res() res: Response,
  ): Promise<void> {
    const def = this.armador.definicion(dto.definicion);
    const rango = await this.rangoDe(ctx, def);
    const nombre =
      dto.nombre ?? `Reporte de ${ORIGENES[def.origen].etiqueta.toLowerCase()}`;
    const xlsx = await this.armador.xlsx(ctx, def, rango, nombre);
    if (dto.guardadoId) {
      await this.corridas.registrar(
        ctx,
        'GUARDADO',
        { desde: rango.desde, hasta: rango.hasta, etiqueta: rango.etiqueta },
        'XLSX',
        dto.guardadoId,
      );
    }
    // El nombre del archivo, sin lo que un sistema de archivos no acepta.
    const archivo = `${nombre}-${rango.desde}-a-${rango.hasta}`
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^\w.-]+/g, '-')
      .toLowerCase();
    res
      .status(200)
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${archivo}.xlsx"`,
      )
      .setHeader('Content-Length', String(xlsx.length))
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .end(xlsx);
  }

  /* ── Guardados ──────────────────────────────────────────────────────── */

  /**
   * Todos los de la empresa, con la última vez que se corrió cada uno y si
   * quien pregunta puede correrlo. **Los que no puede se listan igual**: un
   * reporte de compras que existe no desaparece para un vendedor, se le dice
   * que no es para su rol.
   */
  @Get('guardados')
  async guardados(@ActorEmpresa() ctx: CtxEmpresa) {
    const [todos, ultimas] = await Promise.all([
      this.armador.guardados(ctx),
      this.corridas.ultimas(ctx),
    ]);
    return todos.map((g) => ({
      ...g,
      ultimaVez: ultimas.get(g.id) ?? null,
      puedeCorrer: ORIGENES[g.origen].roles.some((r) => ctx.roles.includes(r)),
    }));
  }

  @Get('guardados/:id')
  guardado(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.armador.guardado(ctx, id);
  }

  @Post('guardados')
  guardar(@ActorEmpresa() ctx: CtxEmpresa, @Body() dto: GuardarReporteDto) {
    return this.armador.guardar(
      ctx,
      dto.nombre,
      this.armador.definicion(dto.definicion),
    );
  }

  @Patch('guardados/:id')
  @HttpCode(204)
  async actualizar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarReporteDto,
  ): Promise<void> {
    await this.armador.actualizar(ctx, id, {
      nombre: dto.nombre,
      definicion: dto.definicion
        ? this.armador.definicion(dto.definicion)
        : undefined,
    });
  }

  /** «Borrar» un guardado es archivarlo. No hay `DELETE` en este sistema. */
  @Post('guardados/:id/archivar')
  @HttpCode(204)
  async archivar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.armador.archivar(ctx, id);
  }

  private rangoDe(ctx: CtxEmpresa, def: Definicion): Promise<Rango> {
    return this.fechas.rango(
      ctx,
      'atajo' in def.fechas
        ? { atajo: def.fechas.atajo }
        : { desde: def.fechas.desde, hasta: def.fechas.hasta },
    );
  }
}
