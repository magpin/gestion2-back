import { Injectable, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import { pesos } from '../reportes/ventas-por-cliente';
import { GotenbergService } from './gotenberg.service';
import { MembreteService } from './membrete.service';
import { PlantillaService } from './plantilla.service';

type Quien = { nombre: string; rol: string };

const NOMBRE = `COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))`;
const DOCUMENTO = `CONCAT(x.numero_documento, CASE WHEN x.dv IS NOT NULL THEN CONCAT('-', x.dv) ELSE '' END)`;
const DESTINO = (caja: string, cuenta: string) =>
  `COALESCE((SELECT k.nombre FROM caja k WHERE k.id = ${caja}),
            (SELECT b.banco || ' · ' || initcap(lower(b.tipo_cuenta)) || ' ···' || right(b.numero_cuenta, 4)
               FROM cuenta_bancaria b WHERE b.id = ${cuenta}))`;
const seis = (n: unknown) => String(n).padStart(6, '0');
/** Los montos entran en pesos y la hoja los escribe desde centavos. */
const plata = (v: unknown) => pesos(Math.round(Number(v) * 100)); // voseo-ok: nombre de código

interface Linea {
  concepto: string;
  detalle: string;
  valor: string;
}

/**
 * El recibo de caja y el comprobante de egreso en PDF (Fase 5, tanda 5.7):
 * lo que se imprime para entregar o archivar. Con firmas: se firma al
 * recibir o al entregar la plata.
 */
@Injectable()
export class DocumentosPdfService {
  constructor(
    private readonly tx: TxService,
    private readonly plantillas: PlantillaService,
    private readonly gotenberg: GotenbergService,
    private readonly membretes: MembreteService,
  ) {}

  async reciboCaja(
    ctx: CtxEmpresa,
    id: string,
    quien: Quien,
  ): Promise<{ pdf: Buffer; nombre: string }> {
    const d = await this.tx.enContexto(ctx, async (t) => {
      const r = fila<Record<string, unknown>>(
        await t.query(
          `SELECT r.numero, r.fecha::text AS fecha, r.total, r.comision, r.anticipo, r.estado,
                  r.motivo_anulacion,
                  (SELECT ${NOMBRE} FROM tercero x WHERE x.id = r.tercero_id) AS tercero,
                  (SELECT ${DOCUMENTO} FROM tercero x WHERE x.id = r.tercero_id) AS documento,
                  ${DESTINO('r.caja_id', 'r.cuenta_bancaria_id')} AS destino
             FROM recibo_caja r WHERE r.id = $1`,
          [id],
        ),
      );
      if (r === undefined) throw new NotFoundException('Ese recibo no existe.');
      const aplicaciones = filas<{
        factura: string;
        valor: string;
        descuento: string;
      }>(
        await t.query(
          `SELECT v.prefijo || '-' || lpad(v.consecutivo::text, 6, '0') AS factura, a.valor, a.descuento
             FROM recibo_caja_aplicacion a
             JOIN venta_documento v ON v.id = a.venta_documento_id
            WHERE a.recibo_id = $1 ORDER BY v.consecutivo`,
          [id],
        ),
      );
      return { r, aplicaciones };
    });
    const numero = `RC-${seis(d.r.numero)}`;
    const lineas: Linea[] = d.aplicaciones
      .filter((a) => Number(a.valor) > 0)
      .map((a) => ({
        concepto: 'Abono a factura',
        detalle: a.factura,
        valor: plata(a.valor), // voseo-ok: nombre de código
      }));
    if (Number(d.r.anticipo) > 0) {
      lineas.push({
        concepto: 'Anticipo',
        detalle: 'Para aplicar a una factura futura',
        valor: plata(d.r.anticipo), // voseo-ok: nombre de código
      });
    }
    const notas: string[] = [];
    const descuentos = d.aplicaciones.filter((a) => Number(a.descuento) > 0);
    if (descuentos.length > 0) {
      notas.push(
        `Descuento por pronto pago: ${descuentos.map((a) => `${a.factura} ${plata(a.descuento)}`).join(', ')}.`, // voseo-ok: nombre de código
      );
    }
    if (Number(d.r.comision) > 0) {
      notas.push(
        `El datáfono cobró ${plata(d.r.comision)}: entraron ${plata(Number(d.r.total) - Number(d.r.comision))}.`, // voseo-ok: nombre de código
      );
    }
    const pdf = await this.hoja(ctx, quien, {
      titulo: `Recibo de caja ${numero}`,
      rotuloTotal: 'Recibido',
      total: plata(d.r.total), // voseo-ok: nombre de código
      fecha: d.r.fecha as string,
      medio: `Entró a ${d.r.destino as string}`,
      tercero: (d.r.tercero as string | null) ?? '',
      terceroDocumento: (d.r.documento as string | null) ?? '',
      lineas,
      notas,
      anulado: d.r.estado === 'ANULADO',
      motivoAnulacion: (d.r.motivo_anulacion as string | null) ?? '',
    });
    return { pdf, nombre: numero };
  }

  async comprobanteEgreso(
    ctx: CtxEmpresa,
    id: string,
    quien: Quien,
  ): Promise<{ pdf: Buffer; nombre: string }> {
    const d = await this.tx.enContexto(ctx, async (t) => {
      const c = fila<Record<string, unknown>>(
        await t.query(
          `SELECT c.numero, c.fecha::text AS fecha, c.total, c.anticipo, c.gmf, c.estado, c.motivo_anulacion,
                  coalesce((SELECT m.valor_concepto - m.valor_movido FROM movimiento_concepto m
                             WHERE m.id = c.anticipo_movimiento_id), 0) AS retencion,
                  (SELECT ${NOMBRE} FROM tercero x WHERE x.id = c.tercero_id) AS tercero,
                  (SELECT ${DOCUMENTO} FROM tercero x WHERE x.id = c.tercero_id) AS documento,
                  ${DESTINO('c.caja_id', 'c.cuenta_bancaria_id')} AS destino
             FROM comprobante_egreso c WHERE c.id = $1`,
          [id],
        ),
      );
      if (c === undefined)
        throw new NotFoundException('Ese comprobante no existe.');
      const aplicaciones = filas<{
        compra: string;
        valor: string;
        descuento: string;
      }>(
        await t.query(
          `SELECT d.numero_factura_proveedor AS compra, a.valor, a.descuento
             FROM comprobante_egreso_aplicacion a
             JOIN compra_documento d ON d.id = a.compra_documento_id
            WHERE a.comprobante_id = $1 ORDER BY d.fecha`,
          [id],
        ),
      );
      return { c, aplicaciones };
    });
    const numero = `EG-${seis(d.c.numero)}`;
    const lineas: Linea[] = d.aplicaciones
      .filter((a) => Number(a.valor) > 0)
      .map((a) => ({
        concepto: 'Pago de factura',
        detalle: a.compra,
        valor: plata(a.valor), // voseo-ok: nombre de código
      }));
    const retencion = Number(d.c.retencion);
    if (Number(d.c.anticipo) > 0) {
      lineas.push({
        concepto: 'Anticipo',
        detalle: 'Para legalizar con la factura',
        valor: plata(d.c.anticipo), // voseo-ok: nombre de código
      });
      if (retencion > 0) {
        lineas.push({
          concepto: 'Retención practicada',
          detalle: 'Sobre el anticipo',
          valor: `− ${plata(retencion)}`, // voseo-ok: nombre de código
        });
      }
    }
    // `total` ya es lo que salió: abonos más el neto del anticipo.
    const salio = Number(d.c.total);
    const notas: string[] = [];
    const descuentos = d.aplicaciones.filter((a) => Number(a.descuento) > 0);
    if (descuentos.length > 0) {
      notas.push(
        `Descuento por pronto pago: ${descuentos.map((a) => `${a.compra} ${plata(a.descuento)}`).join(', ')}.`, // voseo-ok: nombre de código
      );
    }
    if (Number(d.c.gmf) > 0) {
      notas.push(
        `El banco cobró ${plata(d.c.gmf)} de 4×1000, en su propio movimiento.`, // voseo-ok: nombre de código
      );
    }
    const pdf = await this.hoja(ctx, quien, {
      titulo: `Comprobante de egreso ${numero}`,
      rotuloTotal: 'Pagado',
      total: plata(salio), // voseo-ok: nombre de código
      fecha: d.c.fecha as string,
      medio: `Salió de ${d.c.destino as string}`,
      tercero: (d.c.tercero as string | null) ?? '',
      terceroDocumento: (d.c.documento as string | null) ?? '',
      lineas,
      notas,
      anulado: d.c.estado === 'ANULADO',
      motivoAnulacion: (d.c.motivo_anulacion as string | null) ?? '',
    });
    return { pdf, nombre: numero };
  }

  private async hoja(
    ctx: CtxEmpresa,
    quien: Quien,
    datos: {
      titulo: string;
      rotuloTotal: string;
      total: string;
      fecha: string;
      medio: string;
      tercero: string;
      terceroDocumento: string;
      lineas: Linea[];
      notas: string[];
      anulado: boolean;
      motivoAnulacion: string;
    },
  ): Promise<Buffer> {
    const empresa = await this.membretes.de(ctx);
    const cuerpo = this.plantillas.cuerpo('comprobante-tesoreria', datos);
    const { html, assets } = this.plantillas.armar({
      titulo: datos.titulo,
      parametros: [datos.fecha, datos.medio],
      empresa,
      elaboro: quien.nombre,
      cuerpo,
      orientacion: 'VERTICAL',
      conFirmas: true,
    });
    return this.gotenberg.aPdf(html, assets);
  }
}
