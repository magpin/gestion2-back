import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { fechaEnLetras, hoyEnColombia } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  libro350,
  libroCertificados,
  libroReteIca,
} from '../reportes/libros-retenciones';
import {
  armar350,
  armarCertificados,
  armarReteIca,
  type AsientoSuelto,
  type Certificados,
  type Formulario350,
  type LibroDocumento,
  type Periodicidad,
  type ReteIca,
  type Renglon350,
  type RetencionLeida,
} from '../reportes/retenciones';
import { ExcelService } from './excel.service';
import type { Assets } from './gotenberg.service';
import { GotenbergService } from './gotenberg.service';
import { MembreteService } from './membrete.service';
import { PlantillaService, type Destino } from './plantilla.service';
import type { Rango } from './ventas-reporte.service';

type Quien = { nombre: string; rol: string };

/**
 * Los reportes de retenciones —formulario 350, ReteICA y certificados—: de la
 * base al PDF y al Excel (plan motor de retenciones, Fase 6, §6.2).
 *
 * Las **consultas** están acá; las **cuentas** en `reportes/retenciones.ts`,
 * puras y con prueba; el **dibujo** en las plantillas.
 */
@Injectable()
export class RetencionesReporteService {
  constructor(
    private readonly tx: TxService,
    private readonly plantillas: PlantillaService,
    private readonly gotenberg: GotenbergService,
    private readonly membretes: MembreteService,
    private readonly excel: ExcelService,
  ) {}

  /* ── Lecturas ──────────────────────────────────────────────────────────── */

  /**
   * Todas las retenciones del rango: las confirmadas y las reversas en
   * negativo, cada una en la fecha en que se causó. El tipo de persona es el
   * del perfil vigente **en esa fecha**, no el de hoy (R8).
   */
  private async retenciones(t: Tx, rango: Rango): Promise<RetencionLeida[]> {
    return filas<RetencionLeida>(
      await t.query(
        `SELECT rc.id, rc.anula_a AS "anulaA",
                rc.fecha_causacion::text AS fecha,
                rc.documento_id AS "documentoId",
                rc.documento_tipo AS "documentoTipo",
                COALESCE(
                  (SELECT c.numero_factura_proveedor FROM compra_documento c WHERE c.id = rc.documento_id),
                  (SELECT concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text)
                     FROM venta_documento v WHERE v.id = rc.documento_id),
                  left(rc.documento_id::text, 8)) AS documento,
                rc.tercero_id AS "terceroId",
                COALESCE(nullif(btrim(te.razon_social), ''),
                         nullif(btrim(concat_ws(' ', te.primer_nombre, te.segundo_nombre,
                                         te.primer_apellido, te.segundo_apellido)), ''),
                         'Tercero sin nombre') AS tercero,
                CONCAT(te.numero_documento,
                       CASE WHEN te.dv IS NOT NULL THEN CONCAT('-', te.dv) ELSE '' END)
                  AS "terceroDocumento",
                -- En la autorretención la persona es la empresa, no el cliente.
                CASE WHEN rc.es_autorretencion
                     THEN (SELECT e.tipo_persona FROM empresa e WHERE e.id = rc.empresa_id)
                     ELSE COALESCE(p.tipo_persona, te.tipo_persona, 'JURIDICA')
                END AS "tipoPersona",
                rc.impuesto,
                n.codigo AS concepto,
                n.nombre AS "conceptoNombre",
                rc.municipio_codigo AS municipio,
                m.nombre AS "municipioNombre",
                rc.base::text AS base,
                rc.tarifa_efectiva::text AS tarifa,
                rc.valor::text AS valor,
                rc.es_autorretencion AS "esAutorretencion",
                (rc.explicacion ? 'convenio') AS "conConvenio"
           FROM retencion_calculada rc
           JOIN retencion_concepto_nacional n ON n.id = rc.concepto_nacional_id
           LEFT JOIN tercero te ON te.id = rc.tercero_id
           LEFT JOIN municipio m ON m.codigo = rc.municipio_codigo
           LEFT JOIN LATERAL (
             SELECT pt.tipo_persona FROM tercero_perfil_tributario pt
              WHERE pt.tercero_id = rc.tercero_id
                AND pt.vigencia_desde <= rc.fecha_causacion
                AND (pt.vigencia_hasta IS NULL OR pt.vigencia_hasta >= rc.fecha_causacion)
              ORDER BY pt.vigencia_desde DESC
              LIMIT 1) p ON true
          WHERE rc.fecha_causacion BETWEEN $1::date AND $2::date
            AND rc.estado IN ('CONFIRMADA', 'ANULADA')
          ORDER BY rc.fecha_causacion, rc.creado_en`,
        [rango.desde, rango.hasta],
      ),
    );
  }

  /** Los renglones del 350 vigentes el último día del mes. */
  private async renglones(t: Tx, hasta: string): Promise<Renglon350[]> {
    return filas<Renglon350>(
      await t.query(
        `SELECT codigo, seccion, orden, nombre, por_tipo_persona AS "porTipoPersona",
                conceptos, casillas
           FROM formulario_350_renglon
          WHERE vigencia_desde <= $1::date
            AND (vigencia_hasta IS NULL OR vigencia_hasta >= $1::date)
          ORDER BY orden`,
        [hasta],
      ),
    );
  }

  /**
   * Lo que dice el libro mayor del mes en las cuentas de retención que van
   * al 350 (2365 y 2367): por documento de origen, y aparte los asientos que
   * no salieron de uno (a mano, el pago de la declaración).
   *
   * Un documento con el asiento anulado viene igual, en cero y marcado: es la
   * razón más común de que el libro y el motor no coincidan.
   */
  private async libro(
    t: Tx,
    rango: Rango,
  ): Promise<{ documentos: LibroDocumento[]; sueltos: AsientoSuelto[] }> {
    const documentos = filas<LibroDocumento>(
      await t.query(
        `SELECT a.origen_id AS "documentoId",
                a.origen_tipo AS origen,
                COALESCE(
                  (SELECT c.numero_factura_proveedor FROM compra_documento c WHERE c.id = a.origen_id),
                  (SELECT concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text)
                     FROM venta_documento v WHERE v.id = a.origen_id),
                  max(a.numero)) AS documento,
                NOT bool_or(a.estado = 'REGISTRADO') AS anulado,
                sum(CASE WHEN a.estado = 'REGISTRADO' THEN l.credito - l.debito ELSE 0 END)::text AS neto
           FROM asiento a
           JOIN asiento_linea l ON l.asiento_id = a.id
           JOIN empresa_cuenta ec ON ec.id = l.cuenta_id
          WHERE a.fecha BETWEEN $1::date AND $2::date
            AND a.origen_id IS NOT NULL
            AND (ec.codigo LIKE '2365%' OR ec.codigo LIKE '2367%')
          GROUP BY a.origen_id, a.origen_tipo`,
        [rango.desde, rango.hasta],
      ),
    );
    const sueltos = filas<AsientoSuelto>(
      await t.query(
        `SELECT a.numero, a.fecha::text AS fecha, a.glosa,
                sum(l.credito - l.debito)::text AS neto
           FROM asiento a
           JOIN asiento_linea l ON l.asiento_id = a.id
           JOIN empresa_cuenta ec ON ec.id = l.cuenta_id
          WHERE a.fecha BETWEEN $1::date AND $2::date
            AND a.origen_id IS NULL AND a.estado = 'REGISTRADO'
            AND (ec.codigo LIKE '2365%' OR ec.codigo LIKE '2367%')
          GROUP BY a.id, a.numero, a.fecha, a.glosa
          ORDER BY a.fecha, a.numero`,
        [rango.desde, rango.hasta],
      ),
    );
    return { documentos, sueltos };
  }

  /** Cada cuánto declara cada municipio, según el año del rango. */
  private async periodicidades(
    t: Tx,
    anio: number,
  ): Promise<Map<string, Periodicidad>> {
    const crudas = filas<{ municipio: string; periodicidad: Periodicidad }>(
      await t.query(
        `SELECT DISTINCT ON (municipio_codigo) municipio_codigo AS municipio, periodicidad
           FROM ica_parametro
          WHERE anio <= $1
          ORDER BY municipio_codigo, anio DESC`,
        [anio],
      ),
    );
    return new Map(crudas.map((c) => [c.municipio, c.periodicidad]));
  }

  /* ── Formulario 350 ────────────────────────────────────────────────────── */

  /**
   * El 350 es **mensual**: el rango empieza el primero de un mes y no se sale
   * de él. Puede terminar antes del último día: «este mes» llega hasta hoy, y
   * es lo que va del mes en curso. Un rango que cruza meses no se puede
   * declarar, y una hoja que lo pareciera sería peor que un error claro.
   */
  static exigirMes(rango: Rango): string {
    const [a1, m1, d1] = rango.desde.split('-').map(Number);
    const [a2, m2] = rango.hasta.split('-').map(Number);
    if (a1 !== a2 || m1 !== m2 || d1 !== 1) {
      throw new MesIncompleto();
    }
    return rango.desde.slice(0, 7);
  }

  private async datos350(ctx: CtxEmpresa, rango: Rango) {
    const mes = RetencionesReporteService.exigirMes(rango);
    return this.tx.enContexto(ctx, async (t) => ({
      mes,
      filas: await this.retenciones(t, rango),
      renglones: await this.renglones(t, rango.hasta),
      libro: await this.libro(t, rango),
    }));
  }

  /**
   * El 350 del mes, como datos: lo que muestra Impuestos → Retención antes de
   * presentarlo. Es el mismo armado de la hoja, sin el dibujo.
   */
  async formulario350(ctx: CtxEmpresa, mes: string): Promise<Formulario350> {
    const [anio, m] = mes.split('-').map(Number);
    const ultimo = new Date(Date.UTC(anio, m, 0)).getUTCDate();
    const d = await this.datos350(ctx, {
      desde: `${mes}-01`,
      hasta: `${mes}-${String(ultimo).padStart(2, '0')}`,
      etiqueta: mes,
    });
    return armar350(d.mes, d.filas, d.renglones, d.libro);
  }

  async hoja350(
    ctx: CtxEmpresa,
    rango: Rango,
    quien: Quien,
    destino: Destino = 'PDF',
    baseFuentes?: string,
  ): Promise<{ html: string; assets: Assets; datos: Formulario350 }> {
    const [d, empresa] = await Promise.all([
      this.datos350(ctx, rango),
      this.membretes.de(ctx),
    ]);
    const datos = armar350(d.mes, d.filas, d.renglones, d.libro);
    const cuerpo = this.plantillas.cuerpo('retenciones-350', {
      ...datos,
      elaboro: quien.nombre,
      rol: quien.rol,
    });
    return {
      ...this.plantillas.armar({
        titulo: 'Formulario 350 — retenciones del mes',
        parametros: [
          rango.etiqueta,
          'Valores al múltiplo de mil (art. 577 ET)',
        ],
        empresa,
        elaboro: quien.nombre,
        cuerpo,
        orientacion: 'HORIZONTAL',
        conFirmas: true,
        destino,
        baseFuentes,
      }),
      datos,
    };
  }

  async pdf350(ctx: CtxEmpresa, rango: Rango, quien: Quien): Promise<Buffer> {
    const { html, assets } = await this.hoja350(ctx, rango, quien);
    return this.gotenberg.aPdf(html, assets);
  }

  async xlsx350(ctx: CtxEmpresa, rango: Rango): Promise<Buffer> {
    const [d, empresa] = await Promise.all([
      this.datos350(ctx, rango),
      this.membretes.de(ctx),
    ]);
    return this.excel.escribir(
      libro350(
        { mes: d.mes, etiqueta: rango.etiqueta },
        d.filas,
        d.renglones,
        d.libro,
      ),
      empresa,
    );
  }

  /* ── ReteICA ───────────────────────────────────────────────────────────── */

  private async datosIca(ctx: CtxEmpresa, rango: Rango, tx?: Tx) {
    return this.tx.enContexto(
      ctx,
      async (t) => ({
        filas: (await this.retenciones(t, rango)).filter(
          (f) => f.impuesto === 'ICA',
        ),
        periodicidades: await this.periodicidades(
          t,
          Number(rango.hasta.slice(0, 4)),
        ),
      }),
      tx,
    );
  }

  /**
   * El ReteICA del rango, como datos: lo que muestra Impuestos → ICA y
   * ReteICA. Es el mismo armado de la hoja, sin el dibujo.
   */
  async reteIca(ctx: CtxEmpresa, rango: Rango, tx?: Tx): Promise<ReteIca> {
    const d = await this.datosIca(ctx, rango, tx);
    return armarReteIca(d.filas, d.periodicidades, rango);
  }

  async hojaIca(
    ctx: CtxEmpresa,
    rango: Rango,
    quien: Quien,
    destino: Destino = 'PDF',
    baseFuentes?: string,
  ): Promise<{ html: string; assets: Assets; datos: ReteIca }> {
    const [d, empresa] = await Promise.all([
      this.datosIca(ctx, rango),
      this.membretes.de(ctx),
    ]);
    const datos = armarReteIca(d.filas, d.periodicidades, rango);
    const cuerpo = this.plantillas.cuerpo('reteica', {
      ...datos,
      elaboro: quien.nombre,
      rol: quien.rol,
    });
    return {
      ...this.plantillas.armar({
        titulo: 'ReteICA por municipio',
        parametros: [rango.etiqueta],
        empresa,
        elaboro: quien.nombre,
        cuerpo,
        orientacion: 'VERTICAL',
        conFirmas: true,
        destino,
        baseFuentes,
      }),
      datos,
    };
  }

  async pdfIca(ctx: CtxEmpresa, rango: Rango, quien: Quien): Promise<Buffer> {
    const { html, assets } = await this.hojaIca(ctx, rango, quien);
    return this.gotenberg.aPdf(html, assets);
  }

  async xlsxIca(ctx: CtxEmpresa, rango: Rango): Promise<Buffer> {
    const [d, empresa] = await Promise.all([
      this.datosIca(ctx, rango),
      this.membretes.de(ctx),
    ]);
    return this.excel.escribir(
      libroReteIca(rango, d.filas, d.periodicidades),
      empresa,
    );
  }

  /* ── Certificados ──────────────────────────────────────────────────────── */

  /** Lo retenido en el rango; con `terceroId`, solo lo de ese tercero (§8.5). */
  private async datosCertificados(
    ctx: CtxEmpresa,
    rango: Rango,
    terceroId?: string,
  ) {
    const todas = await this.tx.enContexto(ctx, (t) =>
      this.retenciones(t, rango),
    );
    return terceroId === undefined
      ? todas
      : todas.filter((f) => f.terceroId === terceroId);
  }

  async hojaCertificados(
    ctx: CtxEmpresa,
    rango: Rango,
    quien: Quien,
    destino: Destino = 'PDF',
    baseFuentes?: string,
    terceroId?: string,
  ): Promise<{ html: string; assets: Assets; datos: Certificados }> {
    const [f, empresa] = await Promise.all([
      this.datosCertificados(ctx, rango, terceroId),
      this.membretes.de(ctx),
    ]);
    const datos = armarCertificados(f);
    const cuerpo = this.plantillas.cuerpo('certificados-retencion', {
      ...datos,
      empresa,
      // En letras: es un documento que se entrega a un tercero, no una
      // pantalla; «2026-09-28» no se lee así en un certificado.
      desde: fechaEnLetras(rango.desde),
      hasta: fechaEnLetras(rango.hasta),
      expedido: fechaEnLetras(hoyEnColombia()),
      elaboro: quien.nombre,
      rol: quien.rol,
    });
    return {
      ...this.plantillas.armar({
        titulo: 'Certificados de retención',
        parametros: [rango.etiqueta],
        empresa,
        elaboro: quien.nombre,
        cuerpo,
        orientacion: 'VERTICAL',
        // El certificado se expide por medios electrónicos: sin bloque de
        // firmas manuscritas, cada uno lo dice en su pie.
        conFirmas: false,
        destino,
        baseFuentes,
      }),
      datos,
    };
  }

  async pdfCertificados(
    ctx: CtxEmpresa,
    rango: Rango,
    quien: Quien,
    terceroId?: string,
  ): Promise<Buffer> {
    const { html, assets } = await this.hojaCertificados(
      ctx,
      rango,
      quien,
      'PDF',
      undefined,
      terceroId,
    );
    return this.gotenberg.aPdf(html, assets);
  }

  async xlsxCertificados(
    ctx: CtxEmpresa,
    rango: Rango,
    terceroId?: string,
  ): Promise<Buffer> {
    const [f, empresa] = await Promise.all([
      this.datosCertificados(ctx, rango, terceroId),
      this.membretes.de(ctx),
    ]);
    return this.excel.escribir(libroCertificados(rango, f), empresa);
  }
}

/** El 350 se pidió sobre un rango que no está dentro de un mes. */
export class MesIncompleto extends BadRequestException {
  constructor() {
    super(
      'El formulario 350 es mensual: elegí un mes, desde el primero y sin pasarte al siguiente.',
    );
  }
}
