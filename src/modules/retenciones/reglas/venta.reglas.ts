import {
  elegirTarifa,
  type FotoParametros,
} from '../servicios/parametros.reglas';
import {
  MOTOR_VERSION,
  redondear,
  type Explicacion,
  type Guarda,
} from './renta.reglas';

/**
 * El otro lado: la empresa **vende** (plan motor de retenciones, Fase 4;
 * especificación §2.2 y §7.1). Función pura.
 *
 * Tres cosas:
 *
 * 1. **Autorretención especial de renta** (responsabilidad 59): sobre todo el
 *    ingreso, a la tarifa de la actividad principal (art. 1.2.6.8 DUR).
 * 2. **Venta a un cliente del SIMPLE**: el SIMPLE no retiene (art. 911 ET), así
 *    que el vendedor del régimen ordinario que es agente de retención **se
 *    autorretiene** lo que el cliente habría retenido (inversión de flujo,
 *    caso borde 15 / T22).
 * 3. **Lo que el cliente debería retener**: si es agente de renta o de IVA, lo
 *    que corresponde por norma. Sirve para avisar si lo registrado no cuadra.
 *
 * Todo lo que se vende en este sistema es un producto del inventario, es decir
 * un bien: desde el comprador, «compras generales».
 */

export interface VentaParaMotor {
  fecha: string;
  /** Sin IVA. */
  subtotal: number;
  iva: number;
}

export interface EmpresaVendedora {
  /** Responsabilidad 59 del RUT vigente a la fecha. */
  autorretenedorEspecial: boolean;
  ciiuPrincipal: string | null;
  regimenSimple: boolean;
  agenteRenta: boolean;
  /** Autorretenedor por resolución (responsabilidad 15): nadie le retiene renta. */
  autorretenedorRenta: boolean;
  responsableIva: boolean;
  tipoPersona: 'NATURAL' | 'JURIDICA';
}

export interface ClienteComprador {
  regimenSimple: boolean;
  agenteRenta: boolean;
  agenteIva: boolean;
}

export interface ContextoVenta {
  foto: FotoParametros;
  /** El id del concepto de la ley «COMPRAS_GENERALES» y de «RETEIVA_COMPRAS». */
  conceptoCompras: string | null;
  conceptoReteIva: string | null;
  /** Tarifa de autorretención especial por CIIU a la fecha; `null` si no está cargada. */
  tarifaEspecial: (ciiu: string) => { tarifa: number; norma: string } | null;
}

export interface Autorretencion {
  tipo: 'ESPECIAL' | 'VENTA_A_SIMPLE';
  base: number;
  tarifa: number;
  valor: number;
  norma: string;
  explicacion: Explicacion;
}

export interface ResultadoVenta {
  autorretenciones: Autorretencion[];
  /** Lo que el cliente debería retener por norma, por impuesto. */
  esperadas: { renta: number; iva: number };
  avisos: string[];
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const pct = (f: number) =>
  `${(f * 100).toLocaleString('es-CO', { maximumFractionDigits: 3 })} %`;

export function calcularVenta(
  v: VentaParaMotor,
  empresa: EmpresaVendedora,
  cliente: ClienteComprador | null,
  ctx: ContextoVenta,
): ResultadoVenta {
  const autorretenciones: Autorretencion[] = [];
  const avisos: string[] = [];
  const esperadas = { renta: 0, iva: 0 };
  const uvt = ctx.foto.uvt;

  const base = (
    texto: string,
    guardas: Guarda[],
    tarifa: number,
    norma: string,
    extra: Partial<Explicacion> = {},
  ): Explicacion => ({
    motor_version: MOTOR_VERSION,
    fecha_causacion: v.fecha,
    uvt,
    guardas,
    base: { subtotal: v.subtotal, descuentos: 0, base_final: v.subtotal },
    tarifa: {
      nominal: tarifa,
      factor_zomac: 1,
      efectiva: tarifa,
      norma,
      tarifa_id: '',
      vigencia_desde: v.fecha,
    },
    resultado: redondear(v.subtotal * tarifa),
    texto,
    ...extra,
  });

  // 1. Autorretención especial: sobre todo el ingreso, sin base mínima.
  if (empresa.autorretenedorEspecial) {
    const t =
      empresa.ciiuPrincipal === null
        ? null
        : ctx.tarifaEspecial(empresa.ciiuPrincipal);
    if (t === null) {
      avisos.push(
        empresa.ciiuPrincipal === null
          ? 'Sos autorretenedor especial pero no tengo tu actividad principal (CIIU): no calculo la autorretención.'
          : `No tengo la tarifa de autorretención especial del CIIU ${empresa.ciiuPrincipal}: no la calculo. Pedile al administrador que la cargue.`,
      );
    } else {
      const valor = redondear(v.subtotal * t.tarifa);
      autorretenciones.push({
        tipo: 'ESPECIAL',
        base: v.subtotal,
        tarifa: t.tarifa,
        valor,
        norma: t.norma,
        explicacion: base(
          `Autorretención especial · ${pct(t.tarifa)} sobre ${pesos(v.subtotal)} = ${pesos(valor)} (CIIU ${empresa.ciiuPrincipal}).`,
          [
            {
              regla: 'autorretenedor_especial',
              resultado: true,
              fundamento: 'RUT, responsabilidad 59; art. 1.2.6.6 DUR',
            },
          ],
          t.tarifa,
          t.norma,
        ),
      });
    }
  }

  if (cliente === null) return { autorretenciones, esperadas, avisos };

  // Lo que retendría un comprador agente, con la empresa como beneficiaria.
  const rentaQueCorresponde = (): {
    tarifa: number;
    norma: string;
    valor: number;
    minimo: number;
  } | null => {
    if (ctx.conceptoCompras === null || uvt === null) return null;
    const t = elegirTarifa(ctx.foto, ctx.conceptoCompras, {
      tipoPersona: empresa.tipoPersona,
      declarante: true,
    });
    if (t === null) return null;
    const minimo = t.baseUvt * uvt;
    if (t.baseUvt > 0 && v.subtotal < minimo)
      return { tarifa: t.tarifa, norma: t.norma, valor: 0, minimo };
    return {
      tarifa: t.tarifa,
      norma: t.norma,
      valor: redondear(v.subtotal * t.tarifa),
      minimo,
    };
  };

  // 2. Venta a un cliente del SIMPLE siendo agente del régimen ordinario.
  if (cliente.regimenSimple && !empresa.regimenSimple && empresa.agenteRenta) {
    const r = rentaQueCorresponde();
    if (r === null) {
      avisos.push(
        'Le vendés a un cliente del SIMPLE y te toca autorretenerte, pero no tengo la tarifa a la fecha.',
      );
    } else if (r.valor > 0) {
      autorretenciones.push({
        tipo: 'VENTA_A_SIMPLE',
        base: v.subtotal,
        tarifa: r.tarifa,
        valor: r.valor,
        norma: r.norma,
        explicacion: base(
          `Autorretención por venta al SIMPLE · ${pct(r.tarifa)} sobre ${pesos(v.subtotal)} = ${pesos(r.valor)}: el cliente del SIMPLE no retiene (art. 911 ET) y te la practicás vos.`,
          [
            {
              regla: 'cliente_simple',
              resultado: true,
              fundamento: 'Art. 911 ET',
            },
            {
              regla: 'vendedor_agente_renta',
              resultado: true,
              fundamento: 'Art. 368 ET',
            },
          ],
          r.tarifa,
          r.norma,
          {
            cuantia_minima: {
              uvt: r.minimo / (uvt ?? 1),
              valor: r.minimo,
              supera: true,
            },
          },
        ),
      });
    }
  }

  // 3. Lo que el cliente debería retener, para avisar si no cuadra.
  if (
    cliente.agenteRenta &&
    !cliente.regimenSimple &&
    !empresa.autorretenedorRenta &&
    !empresa.regimenSimple
  ) {
    esperadas.renta = rentaQueCorresponde()?.valor ?? 0;
  }
  if (
    cliente.agenteIva &&
    empresa.responsableIva &&
    v.iva > 0 &&
    ctx.conceptoReteIva !== null &&
    uvt !== null
  ) {
    const t = elegirTarifa(ctx.foto, ctx.conceptoReteIva, {
      tipoPersona: 'JURIDICA',
      declarante: true,
    });
    if (t !== null && (t.baseUvt === 0 || v.subtotal >= t.baseUvt * uvt)) {
      esperadas.iva = redondear(v.iva * t.tarifa);
    }
  }

  return { autorretenciones, esperadas, avisos };
}

/** El aviso cuando lo que el cliente dice que retuvo no es lo que dice la norma. */
export function compararConCliente(
  esperadas: ResultadoVenta['esperadas'],
  registradas: { renta: number; iva: number },
): string | null {
  const partes: string[] = [];
  if (Math.abs(esperadas.renta - registradas.renta) >= 1) {
    partes.push(
      `de renta registraste ${pesos(registradas.renta)} y por norma corresponden ${pesos(esperadas.renta)}`,
    );
  }
  if (Math.abs(esperadas.iva - registradas.iva) >= 1) {
    partes.push(
      `de IVA registraste ${pesos(registradas.iva)} y por norma corresponden ${pesos(esperadas.iva)}`,
    );
  }
  return partes.length === 0
    ? null
    : `Lo que te retiene el cliente no cuadra con la norma: ${partes.join('; ')}. Revisalo con su certificado.`;
}
