import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import type { Tx } from '../../../common/db/tx.service';
import { MOTOR_VERSION } from '../reglas/renta.reglas';
import { calcularVenta, compararConCliente } from '../reglas/venta.reglas';
import { ParametrosService } from './parametros.service';
import { retencionesVivas, type RetencionViva } from './retenciones-vivas';

export interface VentaConfirmada {
  /** Las líneas que suma el asiento de la venta: anticipo contra autorretención. */
  lineasAsiento: Array<{
    cuentaId: string;
    debito: number;
    credito: number;
    baseGravable?: number;
  }>;
  /** Lo que conviene saber: el cliente retuvo distinto, falta una tarifa. */
  aviso: string | null;
}

/** Quien puede practicar retención de renta (art. 368 ET). */
const AGENTE_RENTA = [
  'AGENTE_RETENEDOR_RENTA',
  'AUTORRETENEDOR_RENTA',
  'GRAN_CONTRIBUYENTE',
];

/**
 * El motor del lado de la venta (plan motor de retenciones, Fase 4): arma el
 * contexto de la empresa y del cliente, llama a las reglas puras, guarda cada
 * autorretención en `retencion_calculada` y devuelve lo que va al asiento.
 */
@Injectable()
export class MotorVentaService {
  constructor(private readonly parametros: ParametrosService) {}

  async confirmar(
    ctx: CtxEmpresa,
    venta: {
      documentoId: string;
      terceroId: string;
      fecha: string;
      subtotal: number;
      iva: number;
      /** Lo que el cliente dice que retuvo, por impuesto. */
      registradas: { renta: number; iva: number };
    },
    t: Tx,
  ): Promise<VentaConfirmada> {
    const { resultado, conceptos, foto, empresa } = await this.calcular(
      ctx,
      venta,
      t,
    );
    const fecha = venta.fecha;

    // Lo que recibió el motor, para recalcular si cambia la norma (§8.10).
    await t.query(
      `INSERT INTO retencion_documento_entrada
         (empresa_id, documento_tipo, documento_id, entrada, respuestas, motor_version)
       VALUES ($1, 'VENTA', $2, $3, '{}', $4)
       ON CONFLICT DO NOTHING`,
      [
        ctx.empresaId,
        venta.documentoId,
        JSON.stringify({
          terceroId: venta.terceroId,
          fecha: venta.fecha,
          subtotal: venta.subtotal,
          iva: venta.iva,
        }),
        MOTOR_VERSION,
      ],
    );

    const lineasAsiento: VentaConfirmada['lineasAsiento'] = [];
    if (resultado.autorretenciones.length > 0) {
      // Las dos van contra la 236575 (autorretenciones) y su anticipo 135515.
      const cuentas = conceptos.get('AUTORRETENCION_ESPECIAL');
      if (cuentas?.cuenta_id == null || cuentas.cuenta_activo_id == null) {
        throw new BadRequestException(
          'Esta venta lleva autorretención y te falta la cuenta 236575 (autorretenciones) o la 135515 (retención que te practican). Creala en el plan de cuentas y se enlaza sola.',
        );
      }
      for (const a of resultado.autorretenciones) {
        const concepto =
          a.tipo === 'ESPECIAL'
            ? cuentas.id
            : (conceptos.get('COMPRAS_GENERALES')?.id ?? cuentas.id);
        await t.query(
          `INSERT INTO retencion_calculada
             (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
              concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
              tarifa_efectiva, valor, uvt_valor, norma_aplicada, origen_clasificacion,
              explicacion, estado, es_autorretencion, motor_version, creado_por)
           VALUES ($1,'VENTA',$2,$3,'RENTA',$4,$5,$6,$7,1,$7,$8,$9,$10,'PRODUCTO',$11,'CONFIRMADA',true,$12,$13)`,
          [
            ctx.empresaId,
            venta.documentoId,
            venta.terceroId,
            concepto,
            fecha,
            a.base,
            a.tarifa,
            a.valor,
            foto.uvt,
            a.norma,
            JSON.stringify({ ...a.explicacion, autorretencion: a.tipo }),
            MOTOR_VERSION,
            ctx.usuarioId,
          ],
        );
        lineasAsiento.push(
          { cuentaId: cuentas.cuenta_activo_id, debito: a.valor, credito: 0 },
          {
            cuentaId: cuentas.cuenta_id,
            baseGravable: a.base,
            debito: 0,
            credito: a.valor,
          },
        );
      }
    }

    // Autorretención de ICA (Fase 8, §8.9): en el municipio de la sede
    // principal, si la empresa es autorretenedora allí, con la tarifa de su
    // propia actividad. La venta no guarda de qué sede sale: se toma la
    // principal.
    const avisosIca: string[] = [];
    const [autoIca] = filas<{
      municipio_codigo: string;
      nombre: string;
      provisional: string | null;
    }>(
      await t.query(
        `SELECT eim.municipio_codigo, m.nombre,
                eim.tarifa_provisional_por_mil::text AS provisional
           FROM empresa_ica_municipio eim
           JOIN empresa_sede s ON s.empresa_id = eim.empresa_id
                              AND s.municipio_codigo = eim.municipio_codigo
                              AND s.es_principal AND s.activo
           JOIN municipio m ON m.codigo = eim.municipio_codigo
          WHERE eim.empresa_id = $1 AND eim.es_autorretenedor
            AND eim.fecha_inicio <= $2::date
            AND (eim.fecha_fin IS NULL OR eim.fecha_fin >= $2::date)
          LIMIT 1`,
        [ctx.empresaId, fecha],
      ),
    );
    if (autoIca !== undefined && venta.subtotal > 0) {
      const [ley] = filas<{ tarifa_por_mil: string; acuerdo: string }>(
        await t.query(
          `SELECT tarifa_por_mil::text AS tarifa_por_mil, acuerdo FROM ica_tarifa
            WHERE municipio_codigo = $1 AND anio = $2 AND ciiu = $3
            ORDER BY tarifa_por_mil DESC LIMIT 1`,
          [
            autoIca.municipio_codigo,
            Number(fecha.slice(0, 4)),
            empresa?.ciiu?.slice(0, 4) ?? '',
          ],
        ),
      );
      const porMil =
        ley !== undefined
          ? Number(ley.tarifa_por_mil)
          : autoIca.provisional !== null
            ? Number(autoIca.provisional)
            : null;
      if (porMil === null) {
        avisosIca.push(
          `Sos autorretenedor de ICA en ${autoIca.nombre} y no tengo la tarifa de tu actividad para ${fecha.slice(0, 4)}: no la calculé. Pedile al administrador que cargue la ley de ICA de ese municipio.`,
        );
      } else {
        const cuentasIca = await this.cuentasAutorretencion(t, ctx, 'RETEICA');
        if (cuentasIca === null) {
          throw new BadRequestException(
            `Sos autorretenedor de ICA en ${autoIca.nombre} y te falta la cuenta 2368 (ICA retenido) o la 135518 (ICA que te retienen). Creala en el plan de cuentas y se enlaza sola.`,
          );
        }
        const [reteica] = filas<{ id: string }>(
          await t.query(
            `SELECT id FROM retencion_concepto_nacional WHERE codigo = 'RETEICA'`,
          ),
        );
        const valorIca = Math.round((venta.subtotal * porMil) / 1000);
        const norma =
          ley?.acuerdo ??
          `Tarifa provisional de ${autoIca.nombre} (configuración)`;
        const texto = `Autorretención de ICA en ${autoIca.nombre}: ${porMil.toLocaleString('es-CO')} por mil sobre ${venta.subtotal.toLocaleString('es-CO')} = ${valorIca.toLocaleString('es-CO')}.`;
        if (valorIca > 0) {
          await t.query(
            `INSERT INTO retencion_calculada
               (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
                concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
                tarifa_efectiva, valor, uvt_valor, norma_aplicada, origen_clasificacion,
                explicacion, estado, es_autorretencion, motor_version, creado_por,
                municipio_codigo)
             VALUES ($1,'VENTA',$2,$3,'ICA',$4,$5,$6,$7,1,$7,$8,$9,$10,'PRODUCTO',$11,'CONFIRMADA',true,$12,$13,$14)`,
            [
              ctx.empresaId,
              venta.documentoId,
              venta.terceroId,
              reteica.id,
              fecha,
              venta.subtotal,
              porMil / 1000,
              valorIca,
              foto.uvt,
              norma,
              JSON.stringify({
                motor_version: MOTOR_VERSION,
                autorretencion: 'ICA',
                texto,
              }),
              MOTOR_VERSION,
              ctx.usuarioId,
              autoIca.municipio_codigo,
            ],
          );
          lineasAsiento.push(
            { cuentaId: cuentasIca.activo, debito: valorIca, credito: 0 },
            {
              cuentaId: cuentasIca.pasivo,
              baseGravable: venta.subtotal,
              debito: 0,
              credito: valorIca,
            },
          );
          avisosIca.push(texto);
        }
      }
    }

    const avisos = [
      ...avisosIca,
      ...resultado.autorretenciones.map((a) => a.explicacion.texto),
      ...resultado.avisos,
      compararConCliente(resultado.esperadas, venta.registradas),
    ].filter((x): x is string => x !== null);
    return {
      lineasAsiento,
      aviso: avisos.length === 0 ? null : avisos.join(' '),
    };
  }
  /**
   * Las autorretenciones de renta de una venta con la norma que rige hoy para
   * su fecha, sin guardar nada (recálculo, §8.10).
   */
  async autorretencionesDe(
    ctx: CtxEmpresa,
    venta: { terceroId: string; fecha: string; subtotal: number; iva: number },
    t: Tx,
  ) {
    const { resultado, conceptos } = await this.calcular(ctx, venta, t);
    // Un aviso es un dato que falta (CIIU, tarifa): no se sabe cuánto va, y
    // eso no es lo mismo que «ya no va».
    const faltan = resultado.avisos;
    const nuevas = resultado.autorretenciones.map((a) => {
      const codigo =
        a.tipo === 'ESPECIAL' ? 'AUTORRETENCION_ESPECIAL' : 'COMPRAS_GENERALES';
      return {
        impuesto: 'RENTA' as const,
        conceptoCodigo: codigo,
        conceptoId: conceptos.get(codigo)?.id ?? '',
        municipio: null,
        nombre:
          a.tipo === 'ESPECIAL'
            ? 'Autorretención especial de renta'
            : 'Autorretención de renta',
        base: a.base,
        valor: a.valor,
        tarifa: a.tarifa,
        texto: a.explicacion.texto,
      };
    });
    return { nuevas, faltan };
  }

  /**
   * El cálculo de la venta, sin guardar nada: lo usan `confirmar` y el
   * recálculo por cambio de norma (§8.10).
   */
  async calcular(
    ctx: CtxEmpresa,
    venta: { terceroId: string; fecha: string; subtotal: number; iva: number },
    t: Tx,
  ) {
    const fecha = venta.fecha;
    const regimenes = filas<{ tipo_regimen: string }>(
      await t.query(
        `SELECT tipo_regimen FROM empresa_regimen_tributario
          WHERE empresa_id = $1 AND fecha_inicio <= $2::date
            AND (fecha_fin IS NULL OR fecha_fin >= $2::date)`,
        [ctx.empresaId, fecha],
      ),
    ).map((r) => r.tipo_regimen);
    const [empresa] = filas<{
      tipo_persona: 'NATURAL' | 'JURIDICA';
      especial: boolean;
      por_resolucion: boolean;
      ciiu: string | null;
    }>(
      await t.query(
        `SELECT e.tipo_persona,
                EXISTS (SELECT 1 FROM empresa_responsabilidad_rut r
                         WHERE r.empresa_id = e.id AND r.codigo = 59
                           AND r.fecha_inicio <= $2::date
                           AND (r.fecha_fin IS NULL OR r.fecha_fin >= $2::date)) AS especial,
                -- Autorretenedor por resolución (15): a este nadie le retiene
                -- renta. El 59 (especial) no exime a los clientes de retener.
                EXISTS (SELECT 1 FROM empresa_responsabilidad_rut r
                         WHERE r.empresa_id = e.id AND r.codigo = 15
                           AND r.fecha_inicio <= $2::date
                           AND (r.fecha_fin IS NULL OR r.fecha_fin >= $2::date)) AS por_resolucion,
                (SELECT a.codigo_ciiu FROM empresa_actividad_economica a
                  WHERE a.empresa_id = e.id AND a.es_principal
                    AND a.fecha_inicio <= $2::date
                    AND (a.fecha_fin IS NULL OR a.fecha_fin >= $2::date)
                  LIMIT 1) AS ciiu
           FROM empresa e WHERE e.id = $1`,
        [ctx.empresaId, fecha],
      ),
    );
    const [cliente] = filas<{
      regimen_renta: string;
      agente_renta: boolean;
      agente_iva: boolean;
    }>(
      await t.query(
        `SELECT regimen_renta,
                es_agente_ret_renta OR es_gran_contribuyente AS agente_renta,
                es_agente_ret_iva OR es_gran_contribuyente AS agente_iva
           FROM tercero_perfil_tributario
          WHERE tercero_id = $1
          ORDER BY (vigencia_desde <= $2::date AND (vigencia_hasta IS NULL OR vigencia_hasta >= $2::date)) DESC,
                   vigencia_desde
          LIMIT 1`,
        [venta.terceroId, fecha],
      ),
    );
    const conceptos = new Map(
      filas<{
        codigo: string;
        id: string;
        cuenta_id: string | null;
        cuenta_activo_id: string | null;
      }>(
        await t.query(
          `SELECT n.codigo, n.id,
                  (SELECT rc.cuenta_id FROM retencion_concepto rc
                    WHERE rc.empresa_id = $1 AND rc.concepto_nacional_id = n.id
                      AND rc.anio IS NULL AND rc.activo LIMIT 1) AS cuenta_id,
                  (SELECT rc.cuenta_activo_id FROM retencion_concepto rc
                    WHERE rc.empresa_id = $1 AND rc.concepto_nacional_id = n.id
                      AND rc.anio IS NULL AND rc.activo LIMIT 1) AS cuenta_activo_id
             FROM retencion_concepto_nacional n
            WHERE n.codigo IN ('COMPRAS_GENERALES', 'RETEIVA_COMPRAS', 'AUTORRETENCION_ESPECIAL')`,
          [ctx.empresaId],
        ),
      ).map((c) => [c.codigo, c]),
    );
    const especiales = filas<{ ciiu: string; tarifa: string; norma: string }>(
      await t.query(
        `SELECT ciiu, tarifa, norma FROM retencion_autorretencion_ciiu
          WHERE vigencia_desde <= $1::date AND (vigencia_hasta IS NULL OR vigencia_hasta >= $1::date)`,
        [fecha],
      ),
    );
    const foto = await this.parametros.fotoEn(ctx, fecha, t);

    const resultado = calcularVenta(
      { fecha, subtotal: venta.subtotal, iva: venta.iva },
      {
        autorretenedorEspecial: empresa?.especial === true,
        ciiuPrincipal: empresa?.ciiu ?? null,
        regimenSimple: regimenes.includes('REGIMEN_SIMPLE'),
        agenteRenta: regimenes.some((r) => AGENTE_RENTA.includes(r)),
        autorretenedorRenta: empresa?.por_resolucion === true,
        responsableIva: regimenes.includes('RESPONSABLE_IVA'),
        tipoPersona: empresa?.tipo_persona ?? 'JURIDICA',
      },
      cliente === undefined
        ? null
        : {
            regimenSimple: cliente.regimen_renta === 'SIMPLE',
            agenteRenta: cliente.agente_renta,
            agenteIva: cliente.agente_iva,
          },
      {
        foto,
        conceptoCompras: conceptos.get('COMPRAS_GENERALES')?.id ?? null,
        conceptoReteIva: conceptos.get('RETEIVA_COMPRAS')?.id ?? null,
        tarifaEspecial: (ciiu) => {
          const e = especiales.find((x) => x.ciiu === ciiu);
          return e === undefined
            ? null
            : { tarifa: Number(e.tarifa), norma: e.norma };
        },
      },
    );

    return { resultado, conceptos, foto, empresa };
  }

  /**
   * La nota crédito devuelve parte de la venta: su autorretención baja en la
   * misma proporción (plan, §6.0). Sin esto la venta devuelta seguía sumando
   * en el 350 y en la 236575.
   *
   * Nada se edita: por cada autorretención de la venta, una fila nueva en
   * negativo que apunta a la original, sin pasar de lo que le quede viva.
   * Devuelve las dos líneas del asiento de la nota: autorretención contra
   * anticipo, al revés que en la venta.
   */
  async reversarPorNota(
    ctx: CtxEmpresa,
    datos: {
      ventaId: string;
      notaId: string;
      proporcion: number;
      fecha: string;
    },
    t: Tx,
  ): Promise<VentaConfirmada['lineasAsiento']> {
    const vivas = (await retencionesVivas(t, datos.ventaId)).filter(
      (o) => o.es_autorretencion && o.documento_tipo === 'VENTA',
    );
    const pct = Math.round(datos.proporcion * 10000) / 100;

    // Renta e ICA van a cuentas distintas (Fase 8, §8.9).
    const total: Record<string, number> = {};
    for (const o of vivas) {
      const valor = Math.min(
        Math.round(Number(o.valor_original) * datos.proporcion),
        Number(o.valor),
      );
      if (valor <= 0) continue;
      await this.insertarReversa(
        ctx,
        o,
        {
          documentoTipo: 'NOTA_CREDITO_VENTA',
          documentoId: datos.notaId,
          fecha: datos.fecha,
          base:
            Math.round(Number(o.base_original) * datos.proporcion * 100) / 100,
          valor,
          explicacion: {
            proporcion: datos.proporcion,
            texto: `Nota crédito: reversé el ${pct.toLocaleString('es-CO')} % de la autorretención (${valor.toLocaleString('es-CO')}), con la misma tarifa y norma de la venta.`,
          },
        },
        t,
      );
      total[o.impuesto] = (total[o.impuesto] ?? 0) + valor;
    }

    const lineas: VentaConfirmada['lineasAsiento'] = [];
    for (const [impuesto, valor] of Object.entries(total)) {
      if (valor <= 0) continue;
      const cuentas = await this.cuentasAutorretencion(
        t,
        ctx,
        impuesto === 'ICA' ? 'RETEICA' : 'AUTORRETENCION_ESPECIAL',
      );
      if (cuentas === null) {
        throw new BadRequestException(
          impuesto === 'ICA'
            ? 'Esta nota devuelve una venta con autorretención de ICA y te falta la cuenta 2368 (ICA retenido) o la 135518 (ICA que te retienen). Creala en el plan de cuentas y se enlaza sola.'
            : 'Esta nota devuelve una venta con autorretención y te falta la cuenta 236575 (autorretenciones) o la 135515 (retención que te practican). Creala en el plan de cuentas y se enlaza sola.',
        );
      }
      lineas.push(
        { cuentaId: cuentas.pasivo, debito: valor, credito: 0 },
        { cuentaId: cuentas.activo, debito: 0, credito: valor },
      );
    }
    return lineas;
  }

  /** Las cuentas de una autorretención: el pasivo y su anticipo. */
  private async cuentasAutorretencion(
    t: Tx,
    ctx: CtxEmpresa,
    codigo: string,
  ): Promise<{ pasivo: string; activo: string } | null> {
    const [c] = filas<{
      cuenta_id: string | null;
      cuenta_activo_id: string | null;
    }>(
      await t.query(
        `SELECT rc.cuenta_id, rc.cuenta_activo_id
           FROM retencion_concepto rc
           JOIN retencion_concepto_nacional n ON n.id = rc.concepto_nacional_id
          WHERE rc.empresa_id = $1 AND n.codigo = $2
            AND rc.anio IS NULL AND rc.activo
          LIMIT 1`,
        [ctx.empresaId, codigo],
      ),
    );
    return c?.cuenta_id == null || c.cuenta_activo_id == null
      ? null
      : { pasivo: c.cuenta_id, activo: c.cuenta_activo_id };
  }

  /**
   * Anular una factura —o una nota crédito— deja su autorretención en cero
   * (plan, §6.0): en la factura se reversa lo que le quedaba; en la nota
   * vuelve lo que la nota había quitado. El asiento ya se anula entero, así
   * que acá no hay líneas: solo el registro que lee el 350.
   */
  async anular(
    ctx: CtxEmpresa,
    datos: { documentoId: string; fecha: string; motivo: string },
    t: Tx,
  ): Promise<void> {
    const vivas = (await retencionesVivas(t, datos.documentoId)).filter(
      (o) => o.es_autorretencion,
    );
    for (const o of vivas) {
      const valor = Number(o.valor);
      if (valor === 0) continue;
      await this.insertarReversa(
        ctx,
        o,
        {
          documentoTipo: o.documento_tipo,
          documentoId: datos.documentoId,
          fecha: datos.fecha,
          base: Number(o.base),
          valor,
          explicacion: {
            anulacion: datos.motivo,
            texto:
              valor > 0
                ? `Venta anulada: reversé los ${valor.toLocaleString('es-CO')} que quedaban de esta autorretención. Motivo: ${datos.motivo}`
                : `Nota anulada: volvieron los ${(-valor).toLocaleString('es-CO')} de autorretención que la nota había reversado. Motivo: ${datos.motivo}`,
          },
        },
        t,
      );
    }
  }

  /** La fila que contrarresta `valor` de una autorretención: nunca un UPDATE. */
  private async insertarReversa(
    ctx: CtxEmpresa,
    o: RetencionViva,
    r: {
      documentoTipo: string;
      documentoId: string;
      fecha: string;
      base: number;
      valor: number;
      explicacion: Record<string, unknown>;
    },
    t: Tx,
  ): Promise<void> {
    await t.query(
      `INSERT INTO retencion_calculada
         (empresa_id, documento_tipo, documento_id, tercero_id, impuesto,
          concepto_nacional_id, fecha_causacion, base, tarifa_nominal, factor_zomac,
          tarifa_efectiva, valor, uvt_valor, norma_aplicada, origen_clasificacion,
          explicacion, estado, anula_a, es_autorretencion, motor_version, creado_por,
          municipio_codigo)
       VALUES ($1,$2,$3,$4,$17,$5,$6,$7,$8,1,$8,$9,$10,$11,$12,$13,'ANULADA',$14,true,$15,$16,$18)`,
      [
        ctx.empresaId,
        r.documentoTipo,
        r.documentoId,
        o.tercero_id,
        o.concepto_nacional_id,
        r.fecha,
        -r.base,
        o.tarifa_nominal,
        -r.valor,
        o.uvt_valor,
        o.norma_aplicada,
        o.origen_clasificacion,
        JSON.stringify({
          motor_version: MOTOR_VERSION,
          reversa_de: o.id,
          ...r.explicacion,
        }),
        o.id,
        MOTOR_VERSION,
        ctx.usuarioId,
        o.impuesto,
        o.municipio_codigo,
      ],
    );
  }
}
