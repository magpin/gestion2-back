import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  comprasParecidas,
  comprasRetencionDistinta,
  comprasSinRetencion,
  gastosAInventario,
  gastosEnCuentaDistinta,
  lecturasSinRegistrar,
  periodosSinCerrar,
  productosSinDatosDeVenta,
  tercerosSinMarcar,
  type FilaCompraSinRetencion,
  type FilaRetencionDistinta,
  type FilaGasto,
  type FilaLectura,
  type FilaPeriodoAbierto,
  type FilaProductoIncompleto,
  type FilaTerceroSinMarcar,
} from '../reglas/criterio.reglas';
import {
  asientosDescuadrados,
  comprasDuplicadas,
  documentosYAsientos,
  dosLados,
  ivaAntesDelRegimen,
  kardexDeAnulados,
  mismosTerceros,
  movimientosRepetidos,
  ordenar,
  periodosDistintos,
  tercerosDuplicados,
  type FilaAsiento,
  type FilaCompra,
  type FilaDocumentoYAsiento,
  type FilaDosLados,
  type FilaIvaAntesDelRegimen,
  type FilaKardexDeAnulado,
  type FilaMovimientoRepetido,
  type FilaPeriodoCuenta,
  type FilaTercero,
  type Hallazgo,
} from '../reglas/revision.reglas';

/**
 * Trae las filas para las comprobaciones de `reglas/revision.reglas.ts`.
 *
 * **Solo lee, y lee directo de las tablas de otros módulos**, igual que
 * `reportes`: una comprobación que cruza el kardex con los asientos no es de
 * inventario ni de contabilidad, y pedirle a cada fachada un método por
 * pregunta las llenaría de consultas que solo usa esto. Nunca escribe: lo que
 * encuentra lo corrige una persona, por las pantallas de siempre.
 *
 * Todo en una transacción con el contexto de quien pregunta: el RLS es el suyo,
 * y las comprobaciones ven la misma foto.
 */

/** Cómo se llama un tercero, sea persona natural o jurídica. */
const NOMBRE_TERCERO = `coalesce(nullif(btrim(t.razon_social), ''),
  concat_ws(' ', t.primer_nombre, t.segundo_nombre, t.primer_apellido, t.segundo_apellido))`;

/** Débitos menos créditos de cada cuenta, en asientos registrados. */
const SALDO_CONTABLE = `
  SELECT l.cuenta_id, sum(l.debito) - sum(l.credito) AS saldo
    FROM asiento_linea l
    JOIN asiento a ON a.id = l.asiento_id
   WHERE a.estado = 'REGISTRADO'
   GROUP BY l.cuenta_id`;

const n = (v: unknown) => Number(v ?? 0);

@Injectable()
export class RevisionService {
  private readonly log = new Logger(RevisionService.name);

  constructor(private readonly tx: TxService) {}

  async revisar(ctx: CtxEmpresa): Promise<Hallazgo[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const terceros = mismosTerceros(await this.terceros(t));
      const compras = await this.compras(t);
      const gastos = await this.gastos(t);
      const retencion = await this.comprasSinRetencion(t);
      const hallazgos = [
        // ── Fase 7: se afirman ──
        ...asientosDescuadrados(await this.asientos(t)),
        ...documentosYAsientos(await this.documentosYAsientos(t)),
        ...periodosDistintos(await this.periodos(t)),
        ...dosLados('INVENTARIO_VS_CONTABILIDAD', await this.inventario(t)),
        ...kardexDeAnulados(await this.kardexDeAnulados(t)),
        ...dosLados('CAJA_VS_CONTABILIDAD', await this.cajas(t)),
        ...dosLados('BANCO_VS_CONTABILIDAD', await this.bancos(t)),
        ...comprasDuplicadas(compras, terceros),
        ...movimientosRepetidos(await this.movimientos(t)),
        ...tercerosDuplicados(terceros),
        ...ivaAntesDelRegimen(await this.ivaAntesDelRegimen(t)),
        // ── Fase 9: piden criterio ──
        ...comprasSinRetencion(retencion.sinConceptos, retencion.sobreLaBase),
        ...comprasRetencionDistinta(await this.retencionDistinta(t)),
        ...periodosSinCerrar(await this.periodosAbiertos(t)),
        ...lecturasSinRegistrar(await this.lecturas(t)),
        ...productosSinDatosDeVenta(await this.productosIncompletos(t)),
        ...tercerosSinMarcar(await this.tercerosSinMarcar(t)),
        ...gastosAInventario(gastos),
        ...gastosEnCuentaDistinta(gastos),
        ...comprasParecidas(compras, terceros),
      ];
      this.log.log(`Revisión: ${hallazgos.length} hallazgos.`);
      return ordenar(hallazgos);
    });
  }

  /** Solo los que ya no cuadran: la base no debería tener ninguno. */
  private async asientos(t: Tx): Promise<FilaAsiento[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT a.id, ct.codigo || '-' || a.numero AS numero, a.fecha::text AS fecha,
               a.total_debito, a.total_credito,
               coalesce(sum(l.debito), 0) AS suma_debito,
               coalesce(sum(l.credito), 0) AS suma_credito
          FROM asiento a
          JOIN empresa_comprobante_tipo ct ON ct.id = a.comprobante_tipo_id
          LEFT JOIN asiento_linea l ON l.asiento_id = a.id
         WHERE a.estado = 'REGISTRADO'
         GROUP BY a.id, ct.codigo
        HAVING coalesce(sum(l.debito), 0) <> coalesce(sum(l.credito), 0)
            OR coalesce(sum(l.debito), 0) <> a.total_debito
            OR coalesce(sum(l.credito), 0) <> a.total_credito`),
    );
    return r.map((f) => ({
      id: String(f.id),
      numero: String(f.numero),
      fecha: String(f.fecha),
      totalDebito: n(f.total_debito),
      totalCredito: n(f.total_credito),
      sumaDebito: n(f.suma_debito),
      sumaCredito: n(f.suma_credito),
    }));
  }

  /**
   * Cada cuenta de cada período cerrado: lo congelado contra lo que suman hoy
   * sus asientos. Por los dos lados —una cuenta con movimiento y sin fila
   * congelada también es una diferencia—, con la misma regla con que
   * `periodo.service.ts` congela.
   */
  private async periodos(t: Tx): Promise<FilaPeriodoCuenta[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH cerrado AS (
          SELECT id, anio, mes FROM periodo_contable WHERE estado = 'CERRADO'
        ),
        congelado AS (
          SELECT s.periodo_id, s.cuenta_id, s.debitos, s.creditos
            FROM saldo_cuenta_periodo s
            JOIN cerrado p ON p.id = s.periodo_id
        ),
        movido AS (
          SELECT a.periodo_id, l.cuenta_id,
                 sum(l.debito) AS debitos, sum(l.credito) AS creditos
            FROM asiento_linea l
            JOIN asiento a ON a.id = l.asiento_id
            JOIN cerrado p ON p.id = a.periodo_id
           WHERE a.estado = 'REGISTRADO'
           GROUP BY a.periodo_id, l.cuenta_id
        )
        SELECT p.id AS periodo_id, p.anio, p.mes,
               c.id AS cuenta_id, c.codigo, c.nombre,
               coalesce(k.debitos, 0)  AS congelado_debitos,
               coalesce(k.creditos, 0) AS congelado_creditos,
               coalesce(m.debitos, 0)  AS debitos,
               coalesce(m.creditos, 0) AS creditos
          FROM congelado k
          FULL JOIN movido m
            ON m.periodo_id = k.periodo_id AND m.cuenta_id = k.cuenta_id
          JOIN cerrado p ON p.id = coalesce(k.periodo_id, m.periodo_id)
          JOIN empresa_cuenta c ON c.id = coalesce(k.cuenta_id, m.cuenta_id)
         WHERE coalesce(k.debitos, 0)  <> coalesce(m.debitos, 0)
            OR coalesce(k.creditos, 0) <> coalesce(m.creditos, 0)`),
    );
    return r.map((f) => ({
      periodoId: String(f.periodo_id),
      anio: n(f.anio),
      mes: n(f.mes),
      cuentaId: String(f.cuenta_id),
      cuentaCodigo: String(f.codigo),
      cuentaNombre: String(f.nombre),
      congeladoDebitos: n(f.congelado_debitos),
      congeladoCreditos: n(f.congelado_creditos),
      debitos: n(f.debitos),
      creditos: n(f.creditos),
    }));
  }

  /**
   * El último saldo del kardex de cada producto, sumado por su cuenta de
   * inventario, contra el saldo de esa cuenta.
   */
  private async inventario(t: Tx): Promise<FilaDosLados[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH ultimo AS (
          SELECT DISTINCT ON (producto_id) producto_id, saldo_valor
            FROM producto_movimiento
           ORDER BY producto_id, secuencia DESC
        ),
        inicial AS (
          SELECT producto_id, sum(valor_total) AS valor
            FROM producto_movimiento
           WHERE asiento_id IS NULL
           GROUP BY producto_id
        ),
        anulado AS (
          SELECT m.producto_id,
                 sum(CASE WHEN m.tipo LIKE 'ENTRADA%' THEN m.valor_total ELSE -m.valor_total END) AS valor
            FROM producto_movimiento m
            JOIN asiento a ON a.id = m.asiento_id AND a.estado = 'ANULADO'
           GROUP BY m.producto_id
        ),
        contable AS (${SALDO_CONTABLE})
        SELECT c.id AS cuenta_id, c.codigo, c.nombre,
               coalesce(sum(u.saldo_valor), 0) AS auxiliar,
               coalesce(max(k.saldo), 0)       AS contable,
               coalesce(sum(i.valor), 0)       AS sin_asiento,
               coalesce(sum(an.valor), 0)      AS por_anulaciones,
               json_agg(json_build_object('id', p.id, 'nombre', p.nombre))
                 FILTER (WHERE u.producto_id IS NOT NULL) AS nombres
          FROM producto p
          JOIN empresa_cuenta c ON c.id = p.cuenta_inventario_id
          LEFT JOIN ultimo u  ON u.producto_id = p.id
          LEFT JOIN inicial i ON i.producto_id = p.id
          LEFT JOIN anulado an ON an.producto_id = p.id
          LEFT JOIN contable k ON k.cuenta_id = c.id
         GROUP BY c.id`),
    );
    return r.map((f) => ({
      ...dosLadosDe(f),
      porAnulaciones: n(f.por_anulaciones),
    }));
  }

  /** El último saldo de cada caja, sumado por su cuenta, contra esa cuenta. */
  private async cajas(t: Tx): Promise<FilaDosLados[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH ultimo AS (
          SELECT DISTINCT ON (caja_id) caja_id, saldo_valor
            FROM caja_movimiento
           ORDER BY caja_id, secuencia DESC
        ),
        inicial AS (
          SELECT caja_id, sum(valor) AS valor
            FROM caja_movimiento
           WHERE tipo = 'SALDO_INICIAL'
           GROUP BY caja_id
        ),
        contable AS (${SALDO_CONTABLE})
        SELECT c.id AS cuenta_id, c.codigo, c.nombre,
               coalesce(sum(u.saldo_valor), 0) AS auxiliar,
               coalesce(max(k.saldo), 0)       AS contable,
               coalesce(sum(i.valor), 0)       AS sin_asiento,
               json_agg(json_build_object('id', j.id, 'nombre', 'Caja ' || j.nombre)) AS nombres
          FROM caja j
          JOIN empresa_cuenta c ON c.id = j.cuenta_id
          LEFT JOIN ultimo u  ON u.caja_id = j.id
          LEFT JOIN inicial i ON i.caja_id = j.id
          LEFT JOIN contable k ON k.cuenta_id = c.id
         GROUP BY c.id`),
    );
    return r.map(dosLadosDe);
  }

  /** Igual que las cajas: un banco por cuenta contable. */
  private async bancos(t: Tx): Promise<FilaDosLados[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH ultimo AS (
          SELECT DISTINCT ON (cuenta_bancaria_id) cuenta_bancaria_id, saldo_valor
            FROM banco_movimiento
           ORDER BY cuenta_bancaria_id, secuencia DESC
        ),
        inicial AS (
          SELECT cuenta_bancaria_id, sum(valor) AS valor
            FROM banco_movimiento
           WHERE tipo = 'SALDO_INICIAL'
           GROUP BY cuenta_bancaria_id
        ),
        contable AS (${SALDO_CONTABLE})
        SELECT c.id AS cuenta_id, c.codigo, c.nombre,
               coalesce(sum(u.saldo_valor), 0) AS auxiliar,
               coalesce(max(k.saldo), 0)       AS contable,
               coalesce(sum(i.valor), 0)       AS sin_asiento,
               json_agg(json_build_object('id', b.id, 'nombre', b.banco || ' ' || b.numero_cuenta)) AS nombres
          FROM cuenta_bancaria b
          JOIN empresa_cuenta c ON c.id = b.cuenta_id
          LEFT JOIN ultimo u  ON u.cuenta_bancaria_id = b.id
          LEFT JOIN inicial i ON i.cuenta_bancaria_id = b.id
          LEFT JOIN contable k ON k.cuenta_id = c.id
         GROUP BY c.id`),
    );
    return r.map(dosLadosDe);
  }

  private async terceros(t: Tx): Promise<FilaTercero[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT t.id, t.tipo_documento, t.numero_documento, t.dv,
               ${NOMBRE_TERCERO} AS nombre
          FROM tercero t`),
    );
    return r.map((f) => ({
      id: String(f.id),
      tipoDocumento: String(f.tipo_documento),
      numeroDocumento: String(f.numero_documento),
      dv: f.dv === null ? null : (f.dv as string).trim(),
      nombre: String(f.nombre),
    }));
  }

  /** Las facturas de compra vigentes: una anulada ya no cuenta dos veces. */
  private async compras(t: Tx): Promise<FilaCompra[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT c.id, c.tercero_id, ${NOMBRE_TERCERO} AS proveedor,
               c.numero_factura_proveedor AS numero, c.fecha::text AS fecha, c.total
          FROM compra_documento c
          JOIN tercero t ON t.id = c.tercero_id
         WHERE c.tipo = 'FACTURA' AND c.estado = 'EMITIDA'`),
    );
    return r.map((f) => ({
      id: String(f.id),
      terceroId: String(f.tercero_id),
      proveedor: String(f.proveedor),
      numero: String(f.numero),
      fecha: String(f.fecha),
      total: n(f.total),
    }));
  }

  /**
   * Cobros y pagos idénticos: misma factura, mismo día, mismo valor, misma
   * dirección, entre caja y bancos. Un movimiento de caja reversado, o que es
   * la reversa de otro, no cuenta: ya se corrigió.
   */
  private async movimientos(t: Tx): Promise<FilaMovimientoRepetido[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH m AS (
          SELECT cm.id, 'Caja ' || j.nombre AS medio, cm.origen_tipo, cm.origen_id,
                 cm.fecha, cm.valor,
                 CASE WHEN cm.tipo = 'INGRESO' THEN 'ENTRA' ELSE 'SALE' END AS direccion
            FROM caja_movimiento cm
            JOIN caja j ON j.id = cm.caja_id
           WHERE cm.origen_tipo IN ('FACTURA_VENTA', 'COMPRA')
             AND cm.reversa_de IS NULL
             AND NOT EXISTS (SELECT 1 FROM caja_movimiento r WHERE r.reversa_de = cm.id)
          UNION ALL
          SELECT bm.id, b.banco || ' ' || b.numero_cuenta, bm.origen_tipo, bm.origen_id,
                 bm.fecha, bm.valor,
                 CASE WHEN bm.tipo IN ('CONSIGNACION', 'TRANSFERENCIA_ENTRANTE', 'NOTA_CREDITO')
                      THEN 'ENTRA' ELSE 'SALE' END
            FROM banco_movimiento bm
            JOIN cuenta_bancaria b ON b.id = bm.cuenta_bancaria_id
           -- Un traslado y su anulación mueven lo mismo en los dos sentidos: no son repetidos.
           WHERE bm.origen_tipo IN ('FACTURA_VENTA', 'COMPRA')
        ),
        repetidos AS (
          SELECT origen_tipo, origen_id, fecha, valor,
                 json_agg(json_build_object('id', id, 'medio', medio) ORDER BY id) AS movimientos
            FROM m
           GROUP BY origen_tipo, origen_id, direccion, fecha, valor
          HAVING count(*) > 1
        )
        SELECT r.origen_tipo, r.origen_id, r.fecha::text AS fecha, r.valor, r.movimientos,
               coalesce(
                 CASE WHEN r.origen_tipo = 'FACTURA_VENTA'
                      THEN concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text)
                      ELSE c.numero_factura_proveedor END, '?') AS documento,
               ${NOMBRE_TERCERO} AS tercero
          FROM repetidos r
          LEFT JOIN venta_documento v  ON r.origen_tipo = 'FACTURA_VENTA' AND v.id = r.origen_id
          LEFT JOIN compra_documento c ON r.origen_tipo = 'COMPRA' AND c.id = r.origen_id
          LEFT JOIN tercero t ON t.id = coalesce(v.tercero_id, c.tercero_id)`),
    );
    return r.map((f) => ({
      origenTipo: f.origen_tipo as 'FACTURA_VENTA' | 'COMPRA',
      origenId: String(f.origen_id),
      documento: String(f.documento),
      tercero: (f.tercero as string | null) ?? '?',
      fecha: String(f.fecha),
      valor: n(f.valor),
      movimientos: f.movimientos as Array<{ id: string; medio: string }>,
    }));
  }

  /**
   * Compras cuyo IVA se fue al costo porque a su fecha **no había ningún
   * régimen de IVA cargado** —ni responsable ni no responsable—, y la empresa
   * es responsable desde después.
   *
   * Si a esa fecha estaba cargado «no responsable», la historia es deliberada
   * y no hay contradicción: no se dice nada. Lo sospechoso es el hueco, que es
   * lo que deja cargar el régimen con la fecha en que se actualizó el RUT y no
   * con la fecha en que empezó.
   */
  private async ivaAntesDelRegimen(t: Tx): Promise<FilaIvaAntesDelRegimen[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT c.id, c.numero_factura_proveedor AS numero, ${NOMBRE_TERCERO} AS proveedor,
               c.fecha::text AS fecha, reg.desde::text AS desde,
               sum(l.iva_valor) FILTER (WHERE NOT l.iva_descontable) AS iva_al_costo
          FROM compra_documento c
          JOIN tercero t ON t.id = c.tercero_id
          JOIN compra_documento_linea l ON l.compra_documento_id = c.id
          JOIN LATERAL (
            SELECT min(r.fecha_inicio) AS desde
              FROM empresa_regimen_tributario r
             WHERE r.tipo_regimen = 'RESPONSABLE_IVA'
               AND r.fecha_inicio > c.fecha
          ) reg ON reg.desde IS NOT NULL
         WHERE c.estado = 'EMITIDA'
           AND NOT EXISTS (
             SELECT 1 FROM empresa_regimen_tributario r
              WHERE r.tipo_regimen IN ('RESPONSABLE_IVA', 'NO_RESPONSABLE_IVA')
                AND r.fecha_inicio <= c.fecha
                AND (r.fecha_fin IS NULL OR r.fecha_fin >= c.fecha)
           )
         GROUP BY c.id, t.id, reg.desde
        HAVING sum(l.iva_valor) FILTER (WHERE NOT l.iva_descontable) > 0`),
    );
    return r.map((f) => ({
      compraId: String(f.id),
      numero: String(f.numero),
      proveedor: String(f.proveedor),
      fecha: String(f.fecha),
      regimenDesde: String(f.desde),
      ivaAlCosto: n(f.iva_al_costo),
    }));
  }

  // ── Fase 7, agregadas en la 9 ────────────────────────────────────────────

  /**
   * Lo que el kardex movió con un asiento que después se anuló. Entradas y
   * salidas por asiento: si el documento se anuló bien, dan lo mismo.
   */
  private async kardexDeAnulados(t: Tx): Promise<FilaKardexDeAnulado[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT a.id AS asiento_id,
               CASE a.origen_tipo
                 WHEN 'VENTA'  THEN 'la factura de venta '
                   || coalesce(concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text), '?')
                 WHEN 'COMPRA' THEN 'la compra ' || coalesce(c.numero_factura_proveedor, '?')
                 ELSE 'el asiento ' || ct.codigo || '-' || a.numero
               END AS documento,
               coalesce(sum(m.valor_total) FILTER (WHERE m.tipo LIKE 'ENTRADA%'), 0) AS entradas,
               coalesce(sum(m.valor_total) FILTER (WHERE m.tipo LIKE 'SALIDA%'), 0)  AS salidas
          FROM producto_movimiento m
          JOIN asiento a ON a.id = m.asiento_id
          JOIN empresa_comprobante_tipo ct ON ct.id = a.comprobante_tipo_id
          LEFT JOIN venta_documento v  ON a.origen_tipo = 'VENTA'  AND v.id = a.origen_id
          LEFT JOIN compra_documento c ON a.origen_tipo = 'COMPRA' AND c.id = a.origen_id
         WHERE a.estado = 'ANULADO'
         GROUP BY a.id, a.origen_tipo, v.prefijo, v.consecutivo,
                  c.numero_factura_proveedor, ct.codigo`),
    );
    return r.map((f) => ({
      asientoId: String(f.asiento_id),
      documento: String(f.documento),
      entradas: n(f.entradas),
      salidas: n(f.salidas),
    }));
  }

  /** Documentos cuyo estado no es el de su asiento. */
  private async documentosYAsientos(t: Tx): Promise<FilaDocumentoYAsiento[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT 'VENTA' AS tipo, v.id,
               concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text) AS numero,
               v.estado AS estado_documento, a.estado AS estado_asiento
          FROM venta_documento v
          JOIN asiento a ON a.id = v.asiento_id
         WHERE v.tipo <> 'COTIZACION'
           AND (v.estado = 'ANULADA') <> (a.estado = 'ANULADO')
        UNION ALL
        SELECT 'COMPRA', c.id, c.numero_factura_proveedor, c.estado, a.estado
          FROM compra_documento c
          JOIN asiento a ON a.id = c.asiento_id
         WHERE (c.estado = 'ANULADA') <> (a.estado = 'ANULADO')`),
    );
    return r.map((f) => ({
      tipo: f.tipo as 'VENTA' | 'COMPRA',
      id: String(f.id),
      numero: String(f.numero),
      estadoDocumento: String(f.estado_documento),
      estadoAsiento: String(f.estado_asiento),
    }));
  }

  // ── Fase 9: piden criterio ───────────────────────────────────────────────

  /**
   * Compras vigentes sin retención, de cuando la empresa ya era agente
   * retenedor de renta. Se separan en dos: las de un año sin conceptos de
   * renta configurados —no pudieron llevar retención— y las que superan la
   * base mínima más baja de los conceptos que sí hay.
   */
  /** Las compras con retención impresa por el proveedor, y lo registrado (§8.6). */
  private async retencionDistinta(t: Tx): Promise<FilaRetencionDistinta[]> {
    return filas<Record<string, unknown>>(
      await t.query(`
        SELECT c.id, c.numero_factura_proveedor AS numero, ${NOMBRE_TERCERO} AS proveedor,
               c.fecha::text AS fecha, c.retencion_impresa, c.total_retenciones
          FROM compra_documento c
          JOIN tercero t ON t.id = c.tercero_id
         WHERE c.tipo = 'FACTURA' AND c.estado = 'EMITIDA'
           AND c.retencion_impresa IS NOT NULL
         ORDER BY c.fecha`),
    ).map((r) => ({
      compraId: r.id as string,
      numero: r.numero as string,
      proveedor: r.proveedor as string,
      fecha: r.fecha as string,
      impresa: Number(r.retencion_impresa),
      registrada: Number(r.total_retenciones),
    }));
  }

  private async comprasSinRetencion(t: Tx): Promise<{
    sinConceptos: {
      anio: number;
      desde: string;
      compras: FilaCompraSinRetencion[];
    }[];
    sobreLaBase: FilaCompraSinRetencion[];
  }> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH retenedor AS (
          SELECT fecha_inicio, fecha_fin
            FROM empresa_regimen_tributario
           WHERE tipo_regimen IN ('AGENTE_RETENEDOR_RENTA', 'GRAN_CONTRIBUYENTE', 'AUTORRETENEDOR_RENTA')
        )
        SELECT c.id, c.numero_factura_proveedor AS numero, ${NOMBRE_TERCERO} AS proveedor,
               c.fecha::text AS fecha, c.subtotal,
               extract(year FROM c.fecha)::int AS anio,
               (SELECT min(r.fecha_inicio) FROM retenedor r
                 WHERE r.fecha_inicio <= c.fecha
                   AND (r.fecha_fin IS NULL OR r.fecha_fin >= c.fecha))::text AS desde,
               -- La base mínima más baja de compras y servicios generales en la
               -- ley vigente a la fecha de la compra (motor de retenciones).
               (SELECT count(*) FROM retencion_tarifa x
                  JOIN retencion_concepto_nacional n ON n.id = x.concepto_id
                 WHERE n.codigo IN ('COMPRAS_GENERALES', 'SERVICIOS_GENERALES')
                   AND x.vigencia_desde <= c.fecha
                   AND (x.vigencia_hasta IS NULL OR x.vigencia_hasta >= c.fecha))
                 AS conceptos,
               (SELECT min(x.base_uvt) * u.valor FROM retencion_tarifa x
                  JOIN retencion_concepto_nacional n ON n.id = x.concepto_id
                 WHERE n.codigo IN ('COMPRAS_GENERALES', 'SERVICIOS_GENERALES')
                   AND x.vigencia_desde <= c.fecha
                   AND (x.vigencia_hasta IS NULL OR x.vigencia_hasta >= c.fecha))
                 AS minima
          FROM compra_documento c
          JOIN tercero t ON t.id = c.tercero_id
          LEFT JOIN uvt u ON u.anio = extract(year FROM c.fecha)::int
         WHERE c.tipo = 'FACTURA' AND c.estado = 'EMITIDA'
           -- Las que pasaron por el motor tienen su decisión escrita —no
           -- sujeto, bajo la base, o «sin retención» con motivo— y se respetan.
           AND (c.retencion_decision IS NULL OR c.retencion_decision = 'MANUAL')
           AND NOT EXISTS (SELECT 1 FROM compra_retencion x WHERE x.compra_documento_id = c.id)
           AND EXISTS (SELECT 1 FROM retenedor r
                        WHERE r.fecha_inicio <= c.fecha
                          AND (r.fecha_fin IS NULL OR r.fecha_fin >= c.fecha))
         ORDER BY c.fecha`),
    );

    const sinConceptos = new Map<
      number,
      { anio: number; desde: string; compras: FilaCompraSinRetencion[] }
    >();
    const sobreLaBase: FilaCompraSinRetencion[] = [];
    for (const f of r) {
      const compra: FilaCompraSinRetencion = {
        compraId: String(f.id),
        numero: String(f.numero),
        proveedor: String(f.proveedor),
        fecha: String(f.fecha),
        subtotal: n(f.subtotal),
      };
      const anio = n(f.anio);
      if (f.conceptos === null || n(f.conceptos) === 0) {
        const g = sinConceptos.get(anio) ?? {
          anio,
          desde: (f.desde as string).slice(0, 10),
          compras: [],
        };
        g.compras.push(compra);
        sinConceptos.set(anio, g);
      } else if (f.minima !== null && compra.subtotal >= n(f.minima)) {
        sobreLaBase.push(compra);
      }
    }
    return { sinConceptos: [...sinConceptos.values()], sobreLaBase };
  }

  /** Los meses abiertos, con cuántos días hace que terminaron. */
  private async periodosAbiertos(t: Tx): Promise<FilaPeriodoAbierto[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT id, anio, mes,
               ((now() AT TIME ZONE 'America/Bogota')::date
                 - (make_date(anio, mes, 1) + interval '1 month' - interval '1 day')::date) AS dias
          FROM periodo_contable
         WHERE estado = 'ABIERTO'`),
    );
    return r.map((f) => ({
      periodoId: String(f.id),
      anio: n(f.anio),
      mes: n(f.mes),
      diasDesdeElFin: n(f.dias),
    }));
  }

  /**
   * Las facturas y pedidos leídos, con lo que se registró de cada uno. Una
   * compra o factura anulada no cuenta como registro: el documento volvió a
   * quedar pendiente.
   */
  private async lecturas(t: Tx): Promise<FilaLectura[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT d.id, d.tipo,
               CASE d.tipo WHEN 'FACTURA_COMPRA' THEN d.extraido #>> '{factura,proveedor,nombre}'
                           ELSE d.extraido #>> '{pedido,cliente,nombre}' END AS tercero,
               CASE d.tipo WHEN 'FACTURA_COMPRA' THEN d.extraido #>> '{factura,proveedor,nit}'
                           ELSE d.extraido #>> '{pedido,cliente,nit}' END AS nit,
               CASE d.tipo WHEN 'FACTURA_COMPRA' THEN d.extraido #>> '{factura,numero}'
                           ELSE d.extraido #>> '{pedido,numero}' END AS numero,
               CASE d.tipo WHEN 'FACTURA_COMPRA' THEN d.extraido #>> '{factura,fecha}'
                           ELSE d.extraido #>> '{pedido,fecha}' END AS fecha_documento,
               CASE d.tipo WHEN 'FACTURA_COMPRA' THEN d.extraido #>> '{factura,impreso,total}'
                           ELSE d.extraido #>> '{pedido,subtotalImpreso}' END AS total,
               coalesce(c.numero_factura_proveedor,
                        nullif(concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text), '')) AS registrada_como,
               ((now() AT TIME ZONE 'America/Bogota')::date
                 - (d.creado_en AT TIME ZONE 'America/Bogota')::date) AS dias
          FROM documento_leido d
          LEFT JOIN compra_documento c ON c.documento_leido_id = d.id AND c.estado <> 'ANULADA'
          LEFT JOIN venta_documento v  ON v.documento_leido_id = d.id AND v.estado <> 'ANULADA'
         WHERE d.tipo IN ('FACTURA_COMPRA', 'PEDIDO_VENTA')
           AND d.estado = 'LEIDO'
           AND d.extraido IS NOT NULL`),
    );
    return r
      .filter((f) => f.tercero !== null)
      .map((f) => ({
        id: String(f.id),
        tipo: f.tipo as 'FACTURA_COMPRA' | 'PEDIDO_VENTA',
        tercero: String(f.tercero),
        nit: (f.nit as string | null) ?? null,
        numero: (f.numero as string | null) ?? null,
        fechaDocumento: (f.fecha_documento as string | null) ?? null,
        total: n(f.total),
        registradaComo: (f.registrada_como as string | null) ?? null,
        diasDesdeLaLectura: n(f.dias),
      }));
  }

  /** Productos activos con existencias, y qué les falta para venderse. */
  private async productosIncompletos(t: Tx): Promise<FilaProductoIncompleto[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        WITH ultimo AS (
          SELECT DISTINCT ON (producto_id) producto_id, saldo_cantidad
            FROM producto_movimiento
           ORDER BY producto_id, secuencia DESC
        )
        SELECT p.id, p.codigo, p.nombre, u.saldo_cantidad AS existencias,
               coalesce(pp.precio_venta, 0) <= 0 AS sin_precio,
               -- Sin cuenta es sin la propia NI la de la empresa: un producto
               -- sin cuentas toma las automáticas al venderse.
               (coalesce(p.cuenta_ingreso_id, ic.cuenta_ingreso_id) IS NULL
                OR coalesce(p.cuenta_costo_venta_id, ic.cuenta_costo_venta_id) IS NULL) AS sin_cuentas
          FROM producto p
          JOIN ultimo u ON u.producto_id = p.id AND u.saldo_cantidad > 0
          LEFT JOIN producto_precio pp ON pp.producto_id = p.id AND pp.fecha_fin IS NULL
          LEFT JOIN inventario_configuracion ic ON ic.empresa_id = p.empresa_id
         WHERE p.activo
           AND (coalesce(pp.precio_venta, 0) <= 0
                OR coalesce(p.cuenta_ingreso_id, ic.cuenta_ingreso_id) IS NULL
                OR coalesce(p.cuenta_costo_venta_id, ic.cuenta_costo_venta_id) IS NULL)
         ORDER BY p.codigo`),
    );
    return r.map((f) => ({
      id: String(f.id),
      codigo: String(f.codigo),
      nombre: String(f.nombre),
      existencias: n(f.existencias),
      sinPrecio: f.sin_precio === true,
      sinCuentas: f.sin_cuentas === true,
    }));
  }

  /** Terceros con documentos vigentes que ya no están marcados para tenerlos. */
  private async tercerosSinMarcar(t: Tx): Promise<FilaTerceroSinMarcar[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT t.id, ${NOMBRE_TERCERO} AS nombre, 'PROVEEDOR' AS falta, count(*) AS documentos
          FROM tercero t
          JOIN compra_documento c ON c.tercero_id = t.id AND c.estado = 'EMITIDA'
         WHERE NOT t.es_proveedor
         GROUP BY t.id
        UNION ALL
        SELECT t.id, ${NOMBRE_TERCERO}, 'CLIENTE', count(*)
          FROM tercero t
          JOIN venta_documento v
            ON v.tercero_id = t.id AND v.estado = 'EMITIDA' AND v.tipo = 'FACTURA'
         WHERE NOT t.es_cliente
         GROUP BY t.id`),
    );
    return r.map((f) => ({
      id: String(f.id),
      nombre: String(f.nombre),
      falta: f.falta as 'PROVEEDOR' | 'CLIENTE',
      documentos: n(f.documentos),
    }));
  }

  /** Los renglones de gasto —sin producto— de las compras vigentes. */
  private async gastos(t: Tx): Promise<FilaGasto[]> {
    const r = filas<Record<string, unknown>>(
      await t.query(`
        SELECT c.id AS compra_id, c.numero_factura_proveedor AS numero, c.tercero_id,
               ${NOMBRE_TERCERO} AS proveedor, coalesce(l.detalle, 'sin detalle') AS detalle,
               e.id AS cuenta_id, e.codigo || ' ' || e.nombre AS cuenta, l.total,
               EXISTS (SELECT 1 FROM producto p
                        WHERE p.cuenta_inventario_id = l.cuenta_id) AS inventario
          FROM compra_documento_linea l
          JOIN compra_documento c ON c.id = l.compra_documento_id AND c.estado = 'EMITIDA'
          JOIN tercero t ON t.id = c.tercero_id
          JOIN empresa_cuenta e ON e.id = l.cuenta_id
         WHERE l.producto_id IS NULL`),
    );
    return r.map((f) => ({
      compraId: String(f.compra_id),
      numero: String(f.numero),
      terceroId: String(f.tercero_id),
      proveedor: String(f.proveedor),
      detalle: String(f.detalle),
      cuentaId: String(f.cuenta_id),
      cuenta: String(f.cuenta),
      total: n(f.total),
      esCuentaDeInventario: f.inventario === true,
    }));
  }
}

function dosLadosDe(f: Record<string, unknown>): FilaDosLados {
  return {
    cuentaId: String(f.cuenta_id),
    cuentaCodigo: String(f.codigo),
    cuentaNombre: String(f.nombre),
    auxiliar: n(f.auxiliar),
    contable: n(f.contable),
    sinAsiento: n(f.sin_asiento),
    nombres: (f.nombres as Array<{ id: string; nombre: string }> | null) ?? [],
  };
}
