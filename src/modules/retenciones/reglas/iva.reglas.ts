import {
  elegirTarifa,
  type FotoParametros,
  type TarifaLey,
} from '../servicios/parametros.reglas';
import {
  MOTOR_VERSION,
  redondear,
  type Explicacion,
  type Guarda,
} from './renta.reglas';

/**
 * Retención de IVA (ReteIVA) sobre una compra (plan motor de retenciones,
 * Fase 2; especificación §7.3).
 *
 * Función pura, como la de renta. Tres diferencias con renta que no son
 * detalle:
 *
 * - **La base es el IVA**, no el subtotal. El subtotal solo decide si se llega
 *   al mínimo (compras 10 UVT, servicios 2 UVT).
 * - **Es independiente de renta.** A un proveedor del SIMPLE no se le retiene
 *   renta pero sí IVA (caso borde 14); a un autorretenedor de renta, también.
 * - **Servicios del exterior**: el proveedor no factura IVA y lo asume quien
 *   compra, retenido al 100 % (art. 437-2 num. 3, par. 1 art. 437-1). Esa
 *   retención no baja lo que se le paga al proveedor: es IVA que la empresa
 *   declara y descuenta.
 *
 * Se evalúa por concepto dentro del documento, igual que renta: los renglones
 * de bienes forman la base de «ReteIVA en compras» y los de servicios la de
 * «ReteIVA en servicios».
 */

export interface RenglonIva {
  orden: number;
  /** Sin IVA. */
  subtotal: number;
  /** El IVA que factura el proveedor en el renglón. */
  iva: number;
  /** `true` bien, `false` servicio. `null`: todavía no se sabe (falta el concepto). */
  esBien: boolean | null;
}

export interface ConceptoIva {
  id: string;
  codigo: 'RETEIVA_COMPRAS' | 'RETEIVA_SERVICIOS' | 'RETEIVA_EXTERIOR';
  nombre: string;
}

export interface BeneficiarioIva {
  esResponsableIva: boolean;
  esAgenteRetIva: boolean;
  /** Numeral del art. 437-2 por el que es agente; `null` si no se sabe. */
  agenteIvaNumeral: number | null;
  /** Documento extranjero: sus servicios vienen del exterior. */
  esExterior: boolean;
}

export interface ContextoIva {
  fecha: string;
  empresaEsAgenteIva: boolean;
  /** Numeral del art. 437-2 de la empresa; el gran contribuyente es el 1. */
  empresaNumeral: number | null;
  beneficiario: BeneficiarioIva | null;
  /** Pagada con tarjeta: retiene la entidad de la tarjeta, no la empresa. */
  pagadaConTarjeta: boolean;
  /** La tarifa general de IVA, para el IVA que asume la empresa en servicios del exterior. */
  tarifaIvaGeneral: number;
  foto: FotoParametros;
  conceptos: ConceptoIva[];
}

export interface RetencionIva {
  concepto: ConceptoIva;
  renglones: number[];
  /** La base de la retención: el IVA. */
  base: number;
  subtotal: number;
  tarifa: TarifaLey;
  valor: number;
  /**
   * `true`: IVA que asume la empresa (servicios del exterior). No baja lo que
   * se le paga al proveedor; se debita como IVA descontable.
   */
  asumida: boolean;
  explicacion: Explicacion;
}

export interface ResultadoIva {
  decision: 'CALCULADA' | 'BAJO_BASE' | 'NO_SUJETO' | 'REVISION';
  motivo: string;
  guardas: Guarda[];
  retenciones: RetencionIva[];
  sinRetener: Array<{
    concepto: ConceptoIva;
    renglones: number[];
    explicacion: Explicacion;
  }>;
}

/** Entre agentes de estos numerales no se practica (par. 1 art. 437-2). */
const ENTRE_SI = [1, 2, 5];

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const pct = (f: number) =>
  `${(f * 100).toLocaleString('es-CO', { maximumFractionDigits: 3 })} %`;

export function calcularIva(
  renglones: RenglonIva[],
  ctx: ContextoIva,
): ResultadoIva {
  const guardas: Guarda[] = [];
  const cortar = (
    decision: 'NO_SUJETO' | 'REVISION',
    motivo: string,
  ): ResultadoIva => ({
    decision,
    motivo,
    guardas,
    retenciones: [],
    sinRetener: [],
  });

  guardas.push({
    regla: 'pagador_agente_iva',
    resultado: ctx.empresaEsAgenteIva,
    fundamento: 'Art. 437-2 ET',
  });
  if (!ctx.empresaEsAgenteIva) {
    return cortar(
      'NO_SUJETO',
      'No retengo IVA: la empresa no es agente de retención de IVA (art. 437-2 ET).',
    );
  }

  if (ctx.pagadaConTarjeta) {
    guardas.push({
      regla: 'pago_con_tarjeta',
      resultado: true,
      fundamento: 'Art. 437-2 num. 4 ET',
    });
    return cortar(
      'NO_SUJETO',
      'No retengo IVA: la compra se pagó con tarjeta y la retención la practica la entidad de la tarjeta.',
    );
  }

  const b = ctx.beneficiario;
  if (b === null) {
    return cortar(
      'REVISION',
      'Me falta el perfil tributario del proveedor: si es responsable de IVA.',
    );
  }

  const exterior = b.esExterior;
  const conIva = renglones.filter((r) => r.iva > 0);

  // El exterior no factura IVA: lo asume la empresa sobre los servicios.
  if (!exterior) {
    guardas.push({
      regla: 'vendedor_responsable_iva',
      resultado: b.esResponsableIva,
      fundamento: 'Art. 437 ET',
    });
    if (!b.esResponsableIva) {
      return cortar(
        'NO_SUJETO',
        'No retengo IVA: el proveedor no es responsable de IVA, no lo factura.',
      );
    }
    guardas.push({
      regla: 'renglones_con_iva',
      resultado: conIva.length > 0,
      fundamento: 'Art. 437-1 ET',
    });
    if (conIva.length === 0) {
      return cortar('NO_SUJETO', 'No retengo IVA: la factura no trae IVA.');
    }

    const entreSi =
      b.esAgenteRetIva &&
      b.agenteIvaNumeral !== null &&
      ENTRE_SI.includes(b.agenteIvaNumeral) &&
      ctx.empresaNumeral !== null &&
      ENTRE_SI.includes(ctx.empresaNumeral);
    guardas.push({
      regla: 'entre_agentes_1_2_5',
      resultado: entreSi,
      fundamento: 'Par. 1 art. 437-2 ET',
    });
    if (entreSi) {
      return cortar(
        'NO_SUJETO',
        'No retengo IVA: los dos son agentes de retención de IVA de los numerales 1, 2 o 5 (par. 1 art. 437-2 ET).',
      );
    }
  } else {
    guardas.push({
      regla: 'servicio_desde_el_exterior',
      resultado: true,
      fundamento: 'Art. 437-2 num. 3 ET',
    });
  }

  if (ctx.foto.uvt === null) {
    return cortar('REVISION', `No tengo la UVT del ${ctx.fecha.slice(0, 4)}.`);
  }
  const uvt = ctx.foto.uvt;

  const porCodigo = new Map(ctx.conceptos.map((c) => [c.codigo, c]));
  const grupos = new Map<ConceptoIva['codigo'], RenglonIva[]>();
  for (const r of renglones) {
    if (r.esBien === null) continue;
    let codigo: ConceptoIva['codigo'];
    if (exterior) {
      // Del exterior solo los servicios: los bienes se importan y el IVA se
      // paga en aduana, no por retención.
      if (r.esBien) continue;
      codigo = 'RETEIVA_EXTERIOR';
    } else {
      if (r.iva <= 0) continue;
      codigo = r.esBien ? 'RETEIVA_COMPRAS' : 'RETEIVA_SERVICIOS';
    }
    grupos.set(codigo, [...(grupos.get(codigo) ?? []), r]);
  }

  const retenciones: RetencionIva[] = [];
  const sinRetener: ResultadoIva['sinRetener'] = [];
  const faltaTarifa: string[] = [];

  for (const [codigo, grupo] of grupos) {
    const concepto = porCodigo.get(codigo);
    const tarifa =
      concepto === undefined
        ? null
        : elegirTarifa(ctx.foto, concepto.id, {
            tipoPersona: 'JURIDICA',
            declarante: true,
          });
    if (concepto === undefined || tarifa === null) {
      faltaTarifa.push(concepto?.nombre ?? codigo);
      continue;
    }

    const subtotal = grupo.reduce((s, r) => s + r.subtotal, 0);
    const iva = exterior
      ? redondear(subtotal * ctx.tarifaIvaGeneral)
      : grupo.reduce((s, r) => s + r.iva, 0);
    const minimo = tarifa.baseUvt * uvt;
    const renglonesGrupo = grupo.map((r) => r.orden);

    const explicacionBase: Omit<Explicacion, 'resultado' | 'texto'> = {
      motor_version: MOTOR_VERSION,
      fecha_causacion: ctx.fecha,
      uvt,
      guardas,
      clasificacion: {
        concepto: concepto.codigo,
        nombre: concepto.nombre,
        origen: 'IVA',
        renglones: renglonesGrupo,
      },
      base: { subtotal, descuentos: 0, base_final: iva },
      cuantia_minima: {
        uvt: tarifa.baseUvt,
        valor: minimo,
        supera: tarifa.baseUvt === 0 || subtotal >= minimo,
      },
    };

    // El mínimo se mide contra el subtotal, no contra el IVA.
    if (tarifa.baseUvt > 0 && subtotal < minimo) {
      sinRetener.push({
        concepto,
        renglones: renglonesGrupo,
        explicacion: {
          ...explicacionBase,
          resultado: 0,
          texto: `No retengo IVA en ${concepto.codigo === 'RETEIVA_COMPRAS' ? 'compras' : 'servicios'}: el subtotal (${pesos(subtotal)}) no llega a ${tarifa.baseUvt} UVT (${pesos(minimo)}).`,
        },
      });
      continue;
    }

    const valor = redondear(iva * tarifa.tarifa);
    retenciones.push({
      concepto,
      renglones: renglonesGrupo,
      base: iva,
      subtotal,
      tarifa,
      valor,
      asumida: exterior,
      explicacion: {
        ...explicacionBase,
        tarifa: {
          nominal: tarifa.tarifa,
          factor_zomac: 1,
          efectiva: tarifa.tarifa,
          norma: tarifa.norma,
          tarifa_id: tarifa.id,
          vigencia_desde: tarifa.vigenciaDesde,
        },
        resultado: valor,
        texto: exterior
          ? `ReteIVA · servicio del exterior: asumo el IVA (${pct(ctx.tarifaIvaGeneral)} sobre ${pesos(subtotal)} = ${pesos(iva)}) y lo retengo al ${pct(tarifa.tarifa)} = ${pesos(valor)}.`
          : `ReteIVA · ${pct(tarifa.tarifa)} del IVA (${pesos(iva)}) = ${pesos(valor)}.`,
      },
    });
  }

  if (faltaTarifa.length > 0) {
    return cortar(
      'REVISION',
      `No tengo tarifa de ley para ${faltaTarifa.join(', ')} al ${ctx.fecha}.`,
    );
  }
  if (retenciones.length > 0) {
    return {
      decision: 'CALCULADA',
      motivo: retenciones.map((r) => r.explicacion.texto).join(' '),
      guardas,
      retenciones,
      sinRetener,
    };
  }
  return {
    decision: 'BAJO_BASE',
    motivo:
      sinRetener.map((s) => s.explicacion.texto).join(' ') ||
      'No hay IVA sobre el cual retener.',
    guardas,
    retenciones: [],
    sinRetener,
  };
}

/**
 * Si el concepto de renta de un renglón es de un bien o de un servicio (plan
 * §1.5). Un renglón con producto es un bien; uno de gasto, según su concepto.
 */
const BIENES = new Set([
  'COMPRAS_GENERALES',
  'COMPRAS_TARJETA',
  'AGRICOLAS_SIN_PROCESO',
  'CAFE_PERGAMINO',
  'COMBUSTIBLES',
]);

export function esBien(
  productoId: string | null,
  conceptoRenta: string | null,
): boolean | null {
  if (productoId !== null) return true;
  if (conceptoRenta === null) return null;
  return BIENES.has(conceptoRenta);
}
