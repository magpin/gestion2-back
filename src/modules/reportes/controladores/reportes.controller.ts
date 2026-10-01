import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  ActorEmpresa,
  ExigeEmpresa,
  Publico,
} from '../../../common/auth/decoradores';
import type { CtxEmpresa } from '../../../common/ctx';
import { hoyEnColombia } from '../../../common/fecha';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import {
  CertificadosReporteDto,
  CorteReporteDto,
  RangoReporteDto,
  type Formato,
} from '../dto/reportes.dto';
import { ATAJOS, ATAJOS_CORTE, type Corte, type Rango } from '../reglas/rango';
import {
  AREAS,
  ETIQUETA_AREA,
  puedeCorrer,
  reportesPara,
  type ClaveReporte,
} from '../reglas/reportes';
import { CarteraReporteService } from '../servicios/cartera-reporte.service';
import { CorridaService } from '../servicios/corrida.service';
import { RetencionesReporteService } from '../servicios/retenciones-reporte.service';
import { FechasReporteService } from '../servicios/fechas.service';
import { MembreteService } from '../servicios/membrete.service';
import { PlantillaService } from '../servicios/plantilla.service';
import { VentasReporteService } from '../servicios/ventas-reporte.service';

/**
 * Los reportes: cuáles hay, y cada uno en pantalla o en PDF.
 *
 * **Leer y nada más.** Ningún endpoint de acá escribe una fila: es lo que
 * permite que `CONSULTA` —que no puede tocar nada— vea casi todos.
 */
@Controller('reportes')
export class ReportesController {
  constructor(
    private readonly ventas: VentasReporteService,
    private readonly cartera: CarteraReporteService,
    private readonly membretes: MembreteService,
    private readonly plantillas: PlantillaService,
    private readonly contabilidad: ContabilidadApi,
    private readonly corridas: CorridaService,
    private readonly fechas: FechasReporteService,
    private readonly retenciones: RetencionesReporteService,
  ) {}

  /**
   * Las tarjetas: los reportes de cada área que quien pregunta puede correr.
   *
   * **Van las seis áreas, aunque cuatro vengan vacías.** Esconderlas haría creer
   * que el producto no reporta compras ni inventario; que se vean sin reportes
   * dice la verdad y dice hacia dónde va. Y lo que el rol no puede correr no se
   * le ofrece: no aparece, en vez de aparecer bloqueado.
   */
  @ExigeEmpresa()
  @Get()
  async listar(@ActorEmpresa() ctx: CtxEmpresa) {
    const suyos = reportesPara(ctx.roles);
    const ultimas = await this.corridas.ultimas(ctx);
    return {
      areas: AREAS.map((area) => ({
        area,
        etiqueta: ETIQUETA_AREA[area],
        reportes: suyos
          .filter((r) => r.area === area)
          .map((r) => ({ ...r, ultimaVez: ultimas.get(r.clave) ?? null })),
      })),
    };
  }

  /**
   * Los atajos de fecha, ya resueltos a días concretos.
   *
   * La pantalla los necesita **antes** de correr nada: el diseño pide que cada
   * opción del selector diga qué fechas va a usar —«Este mes · 1 al 21 sep»—.
   * Podría calcularlos el navegador, pero entonces habría dos implementaciones
   * de «el mes pasado», en dos husos horarios, y una de las dos se va a
   * equivocar un 31. Se resuelven acá, con la misma función que usa el
   * reporte, y la pantalla solo los muestra.
   */
  @ExigeEmpresa()
  @Get('atajos')
  async atajos(@ActorEmpresa() ctx: CtxEmpresa) {
    const [rango, corte, periodo] = await Promise.all([
      Promise.all(
        ATAJOS.map(async (atajo) => ({
          atajo,
          ...(await this.rangoDe(ctx, { atajo })),
        })),
      ),
      Promise.all(
        ATAJOS_CORTE.map(async (atajo) => ({
          atajo,
          ...(await this.corteDe(ctx, { atajo })),
        })),
      ),
      this.contabilidad.periodoEn(ctx, new Date()),
    ]);
    return {
      hoy: hoyEnColombia(),
      // El del periodo lleva su estado: el diseño muestra «abierto» o
      // «cerrado» al lado, porque sacar ventas de un periodo que todavía se
      // mueve no es lo mismo que de uno que ya se cerró.
      rango: rango.map((r) =>
        r.atajo === 'PERIODO' ? { ...r, estado: periodo?.estado ?? null } : r,
      ),
      corte,
    };
  }

  /**
   * Las cinco caras de la tipografía, para la hoja en pantalla.
   *
   * **Pública, y tiene que serlo.** La hoja se muestra en un `iframe` y el
   * navegador pide las fuentes con un `@font-face`, que no manda la cabecera
   * `Authorization`: con autenticación, la hoja caería a la fuente del sistema
   * y se vería distinta de como se imprime. Y no hay nada que proteger: son
   * Inter y JetBrains Mono, con licencia libre, las mismas para todas las
   * empresas. Lo que sí está protegido es la hoja, que es la que trae datos.
   *
   * Un año de caché: el archivo no cambia sin cambiar de versión de paquete.
   */
  @Publico()
  @Get('fuentes/:archivo')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('Content-Type', 'font/woff2')
  fuente(@Param('archivo') archivo: string, @Res() res: Response): void {
    // Solo las cinco del mapa: el nombre sale de la URL y no puede servir para
    // pedir cualquier archivo del disco.
    const contenido = this.plantillas.fuente(archivo);
    if (contenido === undefined) throw new NotFoundException();
    res.end(contenido);
  }

  @ExigeEmpresa()
  @Get('ventas-por-cliente')
  async ventasPorCliente(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: RangoReporteDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.exigir('VENTAS_POR_CLIENTE', ctx);
    const rango = await this.rangoDe(ctx, q);
    const quien = await this.membretes.firmante(ctx);
    const formato = q.formato ?? 'HTML';
    const parametros = {
      desde: rango.desde,
      hasta: rango.hasta,
      etiqueta: rango.etiqueta,
    };

    if (formato === 'XLSX') {
      const xlsx = await this.ventas.xlsx(ctx, rango);
      await this.corridas.registrar(
        ctx,
        'VENTAS_POR_CLIENTE',
        parametros,
        'XLSX',
      );
      this.enviarXlsx(
        res,
        xlsx,
        `ventas-por-cliente-${rango.desde}-a-${rango.hasta}`,
      );
      return;
    }
    if (formato === 'PDF') {
      const pdf = await this.ventas.pdf(ctx, rango, quien);
      await this.corridas.registrar(
        ctx,
        'VENTAS_POR_CLIENTE',
        parametros,
        'PDF',
      );
      this.enviarPdf(
        res,
        pdf,
        `ventas-por-cliente-${rango.desde}-a-${rango.hasta}`,
      );
      return;
    }
    const { html, datos, graficasFallidas } = await this.ventas.armarHoja(
      ctx,
      rango,
      quien,
      'PANTALLA',
      this.baseFuentes(req),
    );
    if (q.previa !== true) {
      await this.corridas.registrar(
        ctx,
        'VENTAS_POR_CLIENTE',
        parametros,
        'HTML',
      );
    }
    this.enviarHtml(
      res,
      html,
      rango,
      datos.grupos.length === 0,
      graficasFallidas,
    );
  }

  @ExigeEmpresa()
  @Get('antiguedad-cartera')
  async antiguedadCartera(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: CorteReporteDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.exigir('ANTIGUEDAD_CARTERA', ctx);
    const elegido = await this.corteDe(ctx, q);
    const corte = elegido.corte;
    const quien = await this.membretes.firmante(ctx);
    const formato: Formato = q.formato ?? 'HTML';

    if (formato === 'XLSX') {
      const xlsx = await this.cartera.xlsx(ctx, elegido);
      await this.corridas.registrar(
        ctx,
        'ANTIGUEDAD_CARTERA',
        { corte, etiqueta: elegido.etiqueta },
        'XLSX',
      );
      this.enviarXlsx(res, xlsx, `antiguedad-cartera-${corte}`);
      return;
    }
    if (formato === 'PDF') {
      const pdf = await this.cartera.pdf(ctx, corte, quien);
      await this.corridas.registrar(
        ctx,
        'ANTIGUEDAD_CARTERA',
        { corte, etiqueta: elegido.etiqueta },
        'PDF',
      );
      this.enviarPdf(res, pdf, `antiguedad-cartera-${corte}`);
      return;
    }
    const { html, datos } = await this.cartera.armarHoja(
      ctx,
      corte,
      quien,
      'PANTALLA',
      this.baseFuentes(req),
    );
    if (q.previa !== true) {
      await this.corridas.registrar(
        ctx,
        'ANTIGUEDAD_CARTERA',
        { corte, etiqueta: elegido.etiqueta },
        'HTML',
      );
    }
    this.enviarHtml(
      res,
      html,
      {
        desde: corte,
        hasta: corte,
        etiqueta: elegido.etiqueta,
        relativo: elegido.relativo,
      },
      datos.clientes.length === 0,
      0,
    );
  }

  /**
   * Formulario 350 del mes (plan motor de retenciones, Fase 6). El rango tiene
   * que ser un mes calendario completo: el servicio lo exige.
   */
  @ExigeEmpresa()
  @Get('retenciones-350')
  async retenciones350(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: RangoReporteDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.correrRango(
      'RETENCIONES_350',
      'formulario-350',
      ctx,
      q,
      req,
      res,
      {
        xlsx: (rango) => this.retenciones.xlsx350(ctx, rango),
        pdf: (rango, quien) => this.retenciones.pdf350(ctx, rango, quien),
        html: async (rango, quien, base) => {
          const { html, datos } = await this.retenciones.hoja350(
            ctx,
            rango,
            quien,
            'PANTALLA',
            base,
          );
          return { html, vacio: datos.filas === 0 };
        },
      },
    );
  }

  @ExigeEmpresa()
  @Get('reteica')
  async reteIca(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: RangoReporteDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.correrRango('RETEICA', 'reteica', ctx, q, req, res, {
      xlsx: (rango) => this.retenciones.xlsxIca(ctx, rango),
      pdf: (rango, quien) => this.retenciones.pdfIca(ctx, rango, quien),
      html: async (rango, quien, base) => {
        const { html, datos } = await this.retenciones.hojaIca(
          ctx,
          rango,
          quien,
          'PANTALLA',
          base,
        );
        return { html, vacio: datos.filas === 0 };
      },
    });
  }

  @ExigeEmpresa()
  @Get('certificados-retencion')
  async certificadosRetencion(
    @ActorEmpresa() ctx: CtxEmpresa,
    @Query() q: CertificadosReporteDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.correrRango(
      'CERTIFICADOS_RETENCION',
      'certificados-retencion',
      ctx,
      q,
      req,
      res,
      {
        xlsx: (rango) =>
          this.retenciones.xlsxCertificados(ctx, rango, q.terceroId),
        pdf: (rango, quien) =>
          this.retenciones.pdfCertificados(ctx, rango, quien, q.terceroId),
        html: async (rango, quien, base) => {
          const { html, datos } = await this.retenciones.hojaCertificados(
            ctx,
            rango,
            quien,
            'PANTALLA',
            base,
            q.terceroId,
          );
          return { html, vacio: datos.certificados.length === 0 };
        },
      },
    );
  }

  /**
   * Lo que tienen en común los reportes de rango sin gráficas: exigir el rol,
   * resolver el rango, sacar el formato pedido y dejar la corrida anotada.
   */
  private async correrRango(
    clave: ClaveReporte &
      ('RETENCIONES_350' | 'RETEICA' | 'CERTIFICADOS_RETENCION'),
    archivo: string,
    ctx: CtxEmpresa,
    q: RangoReporteDto,
    req: Request,
    res: Response,
    hacer: {
      xlsx: (rango: Rango) => Promise<Buffer>;
      pdf: (
        rango: Rango,
        quien: { nombre: string; rol: string },
      ) => Promise<Buffer>;
      html: (
        rango: Rango,
        quien: { nombre: string; rol: string },
        baseFuentes: string,
      ) => Promise<{ html: string; vacio: boolean }>;
    },
  ): Promise<void> {
    this.exigir(clave, ctx);
    const rango = await this.rangoDe(ctx, q);
    const quien = await this.membretes.firmante(ctx);
    const formato: Formato = q.formato ?? 'HTML';
    const parametros = {
      desde: rango.desde,
      hasta: rango.hasta,
      etiqueta: rango.etiqueta,
    };
    const nombre = `${archivo}-${rango.desde}-a-${rango.hasta}`;

    if (formato === 'XLSX') {
      const xlsx = await hacer.xlsx(rango);
      await this.corridas.registrar(ctx, clave, parametros, 'XLSX');
      this.enviarXlsx(res, xlsx, nombre);
      return;
    }
    if (formato === 'PDF') {
      const pdf = await hacer.pdf(rango, quien);
      await this.corridas.registrar(ctx, clave, parametros, 'PDF');
      this.enviarPdf(res, pdf, nombre);
      return;
    }
    const { html, vacio } = await hacer.html(
      rango,
      quien,
      this.baseFuentes(req),
    );
    if (q.previa !== true) {
      await this.corridas.registrar(ctx, clave, parametros, 'HTML');
    }
    this.enviarHtml(res, html, rango, vacio, 0);
  }

  /**
   * La dirección absoluta de las fuentes, vista desde el navegador.
   *
   * `API_URL_PUBLICA` manda cuando existe: detrás de un proxy, el host que
   * llega a la API no es el que ve el navegador. Si no, se arma con el host de
   * la petición, que en desarrollo es exactamente el que el navegador usó.
   */
  private baseFuentes(req: Request): string {
    const publica = process.env.API_URL_PUBLICA;
    const base =
      publica !== undefined && publica !== ''
        ? publica.replace(/\/$/, '')
        : `${req.protocol}://${req.get('host')}/${process.env.API_PREFIX ?? 'api/v1'}`;
    return `${base}/reportes/fuentes`;
  }

  /**
   * Que el rol pueda correrlo. **Se mira acá aunque la lista ya venga
   * filtrada**: la lista decide qué se ofrece, esto decide qué se entrega. Una
   * URL escrita a mano no pasa por la lista.
   *
   * Un 403 y no un 404, a diferencia de lo que no existe: el reporte sí existe,
   * lo que falta es el permiso, y el mensaje tiene que decir eso para que quien
   * lo vea sepa a quién pedírselo.
   */
  private exigir(clave: ClaveReporte, ctx: CtxEmpresa): void {
    if (!puedeCorrer(clave, ctx.roles)) {
      throw new ForbiddenException(
        'Su rol no puede ver este reporte. Solicite acceso a quien administra la cuenta.',
      );
    }
  }

  private rangoDe(ctx: CtxEmpresa, q: RangoReporteDto): Promise<Rango> {
    return this.fechas.rango(ctx, q);
  }

  private corteDe(
    ctx: CtxEmpresa,
    q: { atajo?: CorteReporteDto['atajo']; corte?: string },
  ): Promise<Corte> {
    return this.fechas.corte(ctx, q);
  }

  /**
   * La hoja para el `iframe`.
   *
   * Lleva de vuelta en cabeceras el rango que de verdad se usó: la pantalla lo
   * necesita para mostrarlo arriba —«1 al 30 de septiembre · este mes»— y no
   * debería tener que volver a calcularlo, porque entonces podría calcularlo
   * distinto.
   *
   * `X-Reporte-Vacio` dice si corrió bien y no encontró nada. **Es distinto de
   * un error**, y la pantalla tiene que poder mostrar su propio estado —«no hay
   * ventas en este período, probá con otro rango»— sin abrir el HTML a buscar
   * un cero. Una hoja en blanco con un membrete y un total de $ 0 se ve rota,
   * aunque sea la respuesta correcta.
   */
  private enviarHtml(
    res: Response,
    html: string,
    rango: Rango,
    vacio: boolean,
    graficasFallidas: number,
  ): void {
    res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .setHeader('X-Reporte-Desde', rango.desde)
      .setHeader('X-Reporte-Hasta', rango.hasta)
      .setHeader('X-Reporte-Etiqueta', encodeURIComponent(rango.etiqueta))
      .setHeader('X-Reporte-Relativo', String(rango.relativo))
      .setHeader('X-Reporte-Vacio', String(vacio))
      // Cuántas gráficas se pidieron y no llegaron. La hoja ya lo dice en el
      // hueco, sin alarma; la pantalla lo necesita para avisarlo arriba.
      .setHeader('X-Reporte-Graficas-Fallidas', String(graficasFallidas))
      .setHeader(
        'Access-Control-Expose-Headers',
        'X-Reporte-Desde, X-Reporte-Hasta, X-Reporte-Etiqueta, X-Reporte-Relativo, X-Reporte-Vacio, X-Reporte-Graficas-Fallidas',
      )
      // Una hoja con datos de la empresa no se guarda en ningún caché
      // intermedio: puede cambiar en el minuto siguiente y es de alguien.
      .setHeader('Cache-Control', 'no-store')
      .end(html);
  }

  private enviarXlsx(res: Response, xlsx: Buffer, nombre: string): void {
    res
      .status(200)
      .setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`)
      .setHeader('Content-Length', String(xlsx.length))
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .end(xlsx);
  }

  private enviarPdf(res: Response, pdf: Buffer, nombre: string): void {
    res
      .status(200)
      .setHeader('Content-Type', 'application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${nombre}.pdf"`)
      // Sin esto, el navegador —en otro origen— no deja leer el nombre y el
      // archivo baja como «reporte.pdf».
      .setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      .setHeader('Cache-Control', 'no-store')
      .end(pdf);
  }
}
