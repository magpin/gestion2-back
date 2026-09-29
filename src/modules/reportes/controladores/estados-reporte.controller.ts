import { Controller, Get, Query, Res } from '@nestjs/common';
import { IsIn, IsOptional, Matches } from 'class-validator';
import type { Response } from 'express';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { hoyEnColombia } from '../../../common/fecha';
import type { TipoEstado } from '../reportes/estados';
import {
  CorridaService,
  type ClaveCorrida,
} from '../servicios/corrida.service';
import { EstadosReporteService } from '../servicios/estados-reporte.service';
import { MembreteService } from '../servicios/membrete.service';

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export class EstadoReporteDto {
  @IsIn(['RESULTADOS', 'BALANCE', 'FLUJO'])
  estado!: TipoEstado;

  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  mes?: string;

  @IsOptional()
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  comparar?: string;

  @IsIn(['PDF', 'XLSX'])
  formato!: 'PDF' | 'XLSX';
}

const CORRIDA: Record<TipoEstado, ClaveCorrida> = {
  RESULTADOS: 'ESTADO_RESULTADOS',
  BALANCE: 'BALANCE_GENERAL',
  FLUJO: 'FLUJO_CAJA',
};

const ARCHIVO: Record<TipoEstado, string> = {
  RESULTADOS: 'estado-de-resultados',
  BALANCE: 'balance-general',
  FLUJO: 'flujo-de-caja',
};

/**
 * Los estados financieros en PDF o Excel, desde Análisis → Estados
 * financieros. La pantalla los muestra; esto los imprime y los descarga. Como
 * todo reporte, deja su rastro en las corridas.
 */
@Controller('reportes/estados-financieros')
@ExigeEmpresa()
export class EstadosReporteController {
  constructor(
    private readonly estados: EstadosReporteService,
    private readonly membretes: MembreteService,
    private readonly corridas: CorridaService,
  ) {}

  @Roles('DIRECTOR', 'CONTADOR', 'CONSULTA')
  @Get()
  async descargar(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: EstadoReporteDto,
    @Res() res: Response,
  ): Promise<void> {
    const mes = q.mes ?? hoyEnColombia().slice(0, 7);
    const nombre = `${ARCHIVO[q.estado]}-${mes}`;
    const parametros = { mes, comparar: q.comparar ?? null };
    if (q.formato === 'XLSX') {
      const xlsx = await this.estados.xlsx(ctx, q.estado, mes, q.comparar);
      await this.corridas.registrar(ctx, CORRIDA[q.estado], parametros, 'XLSX');
      res
        .status(200)
        .setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .setHeader(
          'Content-Disposition',
          `attachment; filename="${nombre}.xlsx"`,
        )
        .setHeader('Content-Length', String(xlsx.length))
        .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
        .setHeader('Cache-Control', 'no-store')
        .end(xlsx);
      return;
    }
    const quien = await this.membretes.firmante(ctx);
    const pdf = await this.estados.pdf(ctx, q.estado, mes, q.comparar, quien);
    await this.corridas.registrar(ctx, CORRIDA[q.estado], parametros, 'PDF');
    res
      .status(200)
      .setHeader('Content-Type', 'application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${nombre}.pdf"`)
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .end(pdf);
  }
}
