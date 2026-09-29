import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Roles,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { DocumentosPdfService } from '../servicios/documentos-pdf.service';
import { MembreteService } from '../servicios/membrete.service';

/** Los que ven los recibos y los comprobantes en Cobros y Pagos. */
const LEEN = [
  'DIRECTOR',
  'CONTADOR',
  'CAJA',
  'VENTAS',
  'COMPRAS',
  'CONSULTA',
] as const;

/**
 * Imprimir un recibo de caja o un comprobante de egreso (Fase 5, tanda 5.7):
 * el PDF del documento, con membrete y firmas.
 */
@Controller('documentos')
@ExigeEmpresa()
export class DocumentosController {
  constructor(
    private readonly documentos: DocumentosPdfService,
    private readonly membretes: MembreteService,
  ) {}

  @Roles(...LEEN)
  @Get('recibos-caja/:id/pdf')
  async recibo(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const quien = await this.membretes.firmante(ctx);
    const { pdf, nombre } = await this.documentos.reciboCaja(ctx, id, quien);
    enviar(res, pdf, nombre);
  }

  @Roles(...LEEN)
  @Get('comprobantes-egreso/:id/pdf')
  async comprobante(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const quien = await this.membretes.firmante(ctx);
    const { pdf, nombre } = await this.documentos.comprobanteEgreso(
      ctx,
      id,
      quien,
    );
    enviar(res, pdf, nombre);
  }
}

function enviar(res: Response, pdf: Buffer, nombre: string): void {
  res
    .status(200)
    .setHeader('Content-Type', 'application/pdf')
    .setHeader('Content-Disposition', `attachment; filename="${nombre}.pdf"`)
    .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
    .setHeader('Cache-Control', 'no-store')
    .end(pdf);
}
