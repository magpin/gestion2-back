import {
  elegirTarifa,
  type FotoParametros,
  type TarifaLey,
} from '../servicios/parametros.reglas';

/**
 * Retención en la fuente de renta sobre una compra (plan motor de retenciones,
 * Fase 1, §1.3; especificación §7.2).
 *
 * **Función pura**: recibe todo lo que necesita —la foto de la ley a la fecha,
 * el perfil del proveedor, el acumulado— y devuelve lo que se retiene con su
 * explicación. Los mismos insumos dan siempre el mismo resultado (T20); por
 * eso una retención se puede volver a explicar años después.
 *
 * Renta se evalúa **por concepto dentro del documento**: los renglones del
 * mismo concepto se suman y esa suma se compara contra la base mínima de su
 * concepto (factura mixta, caso borde 1). Entre documentos **no** se acumula
 * (caso 3), salvo los honorarios de persona natural contra 3.300 UVT.
 */

export const MOTOR_VERSION = '1.0.0';

export interface ConceptoRenta {
  id: string;
  codigo: string;
  nombre: string;
  usaAcumuladoAnual: boolean;
  umbralAcumuladoUvt: number | null;
  /**
   * A la persona natural que no contrató dos o más trabajadores se le retiene
   * con la tabla del art. 383 (Fase 8, §8.14). Ausente = no.
   */
  usaTabla383?: boolean;
  /**
   * Retiene sobre el AIU, no sobre el total (temporales, aseo y vigilancia;
   * par. art. 462-1 ET, R-D3). Ausente = no.
   */
  baseEsAiu?: boolean;
}

export interface PerfilBeneficiario {
  tipoPersona: 'NATURAL' | 'JURIDICA';
  regimenRenta:
    'ORDINARIO' | 'SIMPLE' | 'NO_CONTRIBUYENTE' | 'REGIMEN_ESPECIAL';
  declaranteRenta: boolean;
  esAutorretenedorRenta: boolean;
  esGranContribuyente: boolean;
  esZomac: boolean;
  zomacTamano: 'MICRO' | 'PEQUENA' | 'MEDIANA' | 'GRANDE' | null;
  /** Si contrató dos o más trabajadores para la actividad (art. 383 par. 2). */
  contratoDosOMasTrabajadores?: boolean;
  /** Desde cuándo rige esta versión del perfil. */
  desde: string;
}

/** Un renglón ya clasificado. */
export interface RenglonRenta {
  orden: number;
  /** Sin IVA. */
  subtotal: number;
  descuento: number;
  /** El AIU del renglón, si la factura lo discrimina (§8.13). */
  aiu?: number;
  conceptoCodigo: string;
  origen: 'CONFIRMADO' | 'PRODUCTO' | 'CIIU' | 'PALABRAS' | 'IA' | 'MANUAL';
}

export interface ContextoRenta {
  fecha: string;
  /** Si la empresa es agente de retención de renta a la fecha. */
  empresaEsAgente: boolean;
  /** `null`: el proveedor no tiene perfil tributario → revisión, nunca cero. */
  beneficiario: PerfilBeneficiario | null;
  /** Si la factura informa la categoría ZOMAC. Sin ella, tarifa plena. */
  zomacEnFactura: boolean;
  /**
   * Pagada con tarjeta débito o crédito: la retención la practica la entidad
   * de la tarjeta (1,5 %, caso borde 6), no la empresa.
   */
  pagadaConTarjeta?: boolean;
  foto: FotoParametros;
  conceptos: Map<string, ConceptoRenta>;
  /** Factor ZOMAC del año para un tamaño; `null` si no hay. */
  factorZomac: (tamano: string, anio: number) => number | null;
  /** Base acumulada del año por concepto, **sin** este documento. */
  acumulado: (conceptoId: string) => number;
  /**
   * Los aportes obligatorios a salud y pensión que el proveedor soporta con
   * su planilla, para la depuración de la tabla del art. 383. Sin ellos, se
   * depura sin restarlos.
   */
  aportesSeguridadSocial?: number;
}

export interface Guarda {
  regla: string;
  resultado: boolean;
  fundamento: string;
}

export interface Explicacion {
  motor_version: string;
  fecha_causacion: string;
  uvt: number | null;
  guardas: Guarda[];
  clasificacion?: {
    concepto: string;
    nombre: string;
    origen: string;
    renglones: number[];
  };
  base?: {
    subtotal: number;
    descuentos: number;
    base_final: number;
    /** Cuando retiene sobre el AIU: sobre cuánto se retuvo (§8.13). */
    aiu?: number;
  };
  acumulado?: {
    anterior: number;
    con_este: number;
    umbral_uvt: number;
    umbral: number;
    supera: boolean;
  };
  cuantia_minima?: { uvt: number; valor: number; supera: boolean };
  tarifa?: {
    nominal: number;
    factor_zomac: number;
    efectiva: number;
    norma: string;
    tarifa_id: string;
    vigencia_desde: string;
  };
  zomac?: string;
  /** Cuando se aplicó la tarifa de un convenio (CDI) (Fase 8, §8.15). */
  convenio?: {
    pais: string;
    pais_nombre: string;
    tipo_renta: 'INTERESES' | 'REGALIAS';
    tarifa: number;
    ley: string;
    tarifa_nacional: number;
  };
  /** Cuando se retuvo con la tabla del art. 383 (Fase 8, §8.14). */
  tabla_383?: {
    ingreso: number;
    aportes: number;
    renta_exenta: number;
    gravado: number;
    gravado_uvt: number;
    retencion_uvt: number;
    norma: string;
  };
  perfil?: { desde: string; aproximado: boolean };
  resultado: number;
  /** Una frase para la persona. */
  texto: string;
}

export interface RetencionRenta {
  concepto: ConceptoRenta;
  renglones: number[];
  origen: RenglonRenta['origen'];
  base: number;
  tarifa: TarifaLey;
  tarifaNominal: number;
  factorZomac: number;
  tarifaEfectiva: number;
  valor: number;
  uvt: number;
  explicacion: Explicacion;
}

export interface SinRetener {
  concepto: ConceptoRenta;
  renglones: number[];
  base: number;
  motivo: 'BAJO_BASE';
  explicacion: Explicacion;
}

export type ResultadoRenta =
  | {
      decision: 'NO_SUJETO';
      motivo: string;
      guardas: Guarda[];
      retenciones: [];
      sinRetener: [];
    }
  | {
      decision: 'REVISION';
      motivo: string;
      guardas: Guarda[];
      retenciones: [];
      sinRetener: [];
    }
  | {
      decision: 'CALCULADA' | 'BAJO_BASE';
      motivo: string;
      guardas: Guarda[];
      retenciones: RetencionRenta[];
      sinRetener: SinRetener[];
    };

/** Al peso, en el documento. El múltiplo de mil es de la declaración (art. 577 ET). */
export function redondear(valor: number): number {
  return Math.round(valor);
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const pct = (f: number) =>
  `${(f * 100).toLocaleString('es-CO', { maximumFractionDigits: 3 })} %`;

/**
 * La retención de rentas de trabajo de un pago (art. 383 ET), después de la
 * depuración: se restan los aportes obligatorios (ingreso no constitutivo), y
 * la renta exenta del 25 % (art. 206 num. 10) con su tope mensual y el del
 * 40 % (art. 336). Lo gravado se lleva a UVT y se busca en la tabla.
 *
 * `null` si la foto no trae la tabla o sus topes: entonces no se usa.
 */
export function retencionTabla383(
  ingreso: number,
  aportes: number,
  foto: FotoParametros,
  uvt: number,
): {
  valor: number;
  aportes: number;
  rentaExenta: number;
  gravado: number;
  gravadoUvt: number;
  retencionUvt: number;
  norma: string;
} | null {
  const tabla = foto.tabla383 ?? [];
  const ley = foto.ley ?? {};
  const pct = ley.RENTA_EXENTA_TRABAJO_PORCENTAJE;
  const topeAnual = ley.RENTA_EXENTA_TRABAJO_TOPE_UVT_ANUAL;
  const topePct = ley.DEPURACION_TOPE_PORCENTAJE;
  const topeDepuracion = ley.DEPURACION_TOPE_UVT_ANUAL;
  if (
    tabla.length === 0 ||
    pct === undefined ||
    topeAnual === undefined ||
    topePct === undefined ||
    topeDepuracion === undefined
  ) {
    return null;
  }
  const aportesUsados = Math.min(Math.max(aportes, 0), ingreso);
  const neto = ingreso - aportesUsados;
  const rentaExenta = Math.min(
    neto * pct,
    (topeAnual / 12) * uvt,
    neto * topePct,
    (topeDepuracion / 12) * uvt,
  );
  const gravado = Math.max(neto - rentaExenta, 0);
  const gravadoUvt = gravado / uvt;
  const fila =
    tabla.find(
      (f) =>
        gravadoUvt > f.desdeUvt &&
        (f.hastaUvt === null || gravadoUvt <= f.hastaUvt),
    ) ?? tabla[0];
  const retencionUvt =
    fila.tarifaMarginal === 0
      ? 0
      : (gravadoUvt - fila.desdeUvt) * fila.tarifaMarginal +
        fila.uvtAdicionales;
  return {
    valor: redondear(retencionUvt * uvt),
    aportes: aportesUsados,
    rentaExenta: Math.round(rentaExenta),
    gravado: Math.round(gravado),
    gravadoUvt: Math.round(gravadoUvt * 100) / 100,
    retencionUvt: Math.round(retencionUvt * 100) / 100,
    norma: fila.norma,
  };
}

/** La tarifa de un convenio para evitar la doble imposición (CDI). */
export interface TarifaConvenio {
  pais: string;
  paisNombre: string;
  tipoRenta: 'INTERESES' | 'REGALIAS';
  tarifa: number;
  ley: string;
}

/**
 * Aplica a una retención de un pago al exterior la tarifa del convenio que una
 * persona eligió (Fase 8, §8.15). Solo si es menor que la del Estatuto: un
 * convenio limita, no sube. Devuelve la misma retención si no aplica.
 */
export function aplicarConvenio(
  r: RetencionRenta,
  c: TarifaConvenio,
): RetencionRenta {
  if (c.tarifa >= r.tarifaEfectiva) return r;
  const valor = redondear(r.base * c.tarifa);
  return {
    ...r,
    tarifaNominal: c.tarifa,
    tarifaEfectiva: c.tarifa,
    valor,
    explicacion: {
      ...r.explicacion,
      convenio: {
        pais: c.pais,
        pais_nombre: c.paisNombre,
        tipo_renta: c.tipoRenta,
        tarifa: c.tarifa,
        ley: c.ley,
        tarifa_nacional: r.tarifaEfectiva,
      },
      resultado: valor,
      texto: `Retención en la fuente · ${r.concepto.nombre} con el convenio con ${c.paisNombre} (${c.ley}, ${c.tipoRenta === 'INTERESES' ? 'intereses' : 'regalías'}): ${pct(c.tarifa)} sobre ${pesos(r.base)} = ${pesos(valor)}, en vez del ${pct(r.tarifaEfectiva)} del Estatuto. El proveedor probó su residencia con el certificado.`,
    },
  };
}

export function calcularRenta(
  renglones: RenglonRenta[],
  ctx: ContextoRenta,
): ResultadoRenta {
  const guardas: Guarda[] = [];
  const cortar = (
    decision: 'NO_SUJETO' | 'REVISION',
    motivo: string,
  ): ResultadoRenta => ({
    decision,
    motivo,
    guardas,
    retenciones: [],
    sinRetener: [],
  });

  // --- Guardas de sujeción, en este orden (especificación §7.2) -------------
  guardas.push({
    regla: 'pagador_es_agente',
    resultado: ctx.empresaEsAgente,
    fundamento: 'Art. 368 ET',
  });
  if (!ctx.empresaEsAgente) {
    return cortar(
      'NO_SUJETO',
      'No retengo: tu empresa no es agente de retención en la fuente (art. 368 ET).',
    );
  }

  const b = ctx.beneficiario;
  if (b === null) {
    return cortar(
      'REVISION',
      'Me falta el perfil tributario del proveedor: si declara renta y si es autorretenedor.',
    );
  }

  const simple = b.regimenRenta === 'SIMPLE';
  guardas.push({
    regla: 'beneficiario_simple',
    resultado: simple,
    fundamento: 'Art. 911 ET',
  });
  if (simple) {
    return cortar(
      'NO_SUJETO',
      'No retengo: el proveedor es del régimen simple (art. 911 ET).',
    );
  }

  const noContribuyente = b.regimenRenta === 'NO_CONTRIBUYENTE';
  guardas.push({
    regla: 'beneficiario_no_contribuyente',
    resultado: noContribuyente,
    fundamento: 'Art. 369 ET',
  });
  if (noContribuyente) {
    return cortar(
      'NO_SUJETO',
      'No retengo: el proveedor no es contribuyente de renta (art. 369 ET).',
    );
  }

  guardas.push({
    regla: 'beneficiario_autorretenedor',
    resultado: b.esAutorretenedorRenta,
    fundamento: 'RUT, responsabilidad 15',
  });
  if (b.esAutorretenedorRenta) {
    return cortar(
      'NO_SUJETO',
      'No retengo: el proveedor es autorretenedor; se retiene él mismo.',
    );
  }

  if (ctx.pagadaConTarjeta === true) {
    guardas.push({
      regla: 'pago_con_tarjeta',
      resultado: true,
      fundamento: 'DUR 1625/2016 art. 1.2.4.9.1',
    });
    return cortar(
      'NO_SUJETO',
      'No retengo renta: la compra se pagó con tarjeta y la retención la practica la entidad de la tarjeta.',
    );
  }

  if (ctx.foto.uvt === null) {
    return cortar(
      'REVISION',
      `No tengo la UVT del ${ctx.fecha.slice(0, 4)}: sin ella no sé si la base llega al mínimo.`,
    );
  }
  const uvt = ctx.foto.uvt;

  // --- Por concepto ------------------------------------------------------
  const grupos = new Map<string, RenglonRenta[]>();
  for (const r of renglones) {
    grupos.set(r.conceptoCodigo, [...(grupos.get(r.conceptoCodigo) ?? []), r]);
  }

  const retenciones: RetencionRenta[] = [];
  const sinRetener: SinRetener[] = [];
  const faltaTarifa: string[] = [];

  for (const [codigo, grupo] of grupos) {
    const concepto = [...ctx.conceptos.values()].find(
      (c) => c.codigo === codigo,
    );
    if (concepto === undefined) {
      faltaTarifa.push(codigo);
      continue;
    }

    const subtotal = grupo.reduce((s, r) => s + r.subtotal, 0);
    const descuentos = grupo.reduce((s, r) => s + r.descuento, 0);
    const base = subtotal - descuentos;
    if (base <= 0) continue;

    // Persona natural que no contrató dos o más trabajadores: tabla del art.
    // 383, no la tarifa del art. 392 (Fase 8, §8.14, R-D16).
    const tabla =
      concepto.usaTabla383 === true &&
      b.tipoPersona === 'NATURAL' &&
      b.contratoDosOMasTrabajadores !== true
        ? retencionTabla383(
            base,
            ctx.aportesSeguridadSocial ?? 0,
            ctx.foto,
            uvt,
          )
        : null;
    if (tabla !== null) {
      const renglonesGrupo = grupo.map((r) => r.orden);
      const explicacion = {
        motor_version: MOTOR_VERSION,
        fecha_causacion: ctx.fecha,
        uvt,
        guardas,
        clasificacion: {
          concepto: concepto.codigo,
          nombre: concepto.nombre,
          origen: grupo[0].origen,
          renglones: renglonesGrupo,
        },
        base: { subtotal, descuentos, base_final: base },
        tabla_383: {
          ingreso: base,
          aportes: tabla.aportes,
          renta_exenta: tabla.rentaExenta,
          gravado: tabla.gravado,
          gravado_uvt: tabla.gravadoUvt,
          retencion_uvt: tabla.retencionUvt,
          norma: tabla.norma,
        },
        perfil: { desde: b.desde, aproximado: b.desde > ctx.fecha },
      };
      const depuracion = `${pesos(base)}${tabla.aportes > 0 ? ` menos ${pesos(tabla.aportes)} de aportes` : ''} menos ${pesos(tabla.rentaExenta)} de renta exenta = ${pesos(tabla.gravado)} (${tabla.gravadoUvt.toLocaleString('es-CO')} UVT)`;
      if (tabla.valor <= 0) {
        sinRetener.push({
          concepto,
          renglones: renglonesGrupo,
          base,
          motivo: 'BAJO_BASE',
          explicacion: {
            ...explicacion,
            resultado: 0,
            texto: `No retengo ${concepto.nombre.toLowerCase()}: es persona natural sin dos o más trabajadores, va por la tabla del art. 383, y ${depuracion} no llega a 95 UVT.`,
          },
        });
        continue;
      }
      const efectiva = tabla.valor / base;
      retenciones.push({
        concepto,
        renglones: renglonesGrupo,
        origen: grupo[0].origen,
        base,
        tarifa: {
          id: '',
          conceptoId: concepto.id,
          tipoPersona: 'NATURAL',
          declarante: null,
          baseUvt: 0,
          tarifa: efectiva,
          vigenciaDesde: ctx.fecha,
          vigenciaHasta: null,
          norma: `ET art. 383 (${tabla.norma})`,
        },
        tarifaNominal: efectiva,
        factorZomac: 1,
        tarifaEfectiva: efectiva,
        valor: tabla.valor,
        uvt,
        explicacion: {
          ...explicacion,
          resultado: tabla.valor,
          texto: `Retención en la fuente · ${concepto.nombre} por la tabla del art. 383 (persona natural sin dos o más trabajadores): ${depuracion} → ${pesos(tabla.valor)}.`,
        },
      });
      continue;
    }

    // Honorarios y comisiones de persona natural: el umbral de 3.300 UVT del
    // año decide si va como declarante (11 %) aunque no lo sea.
    let declarante = b.declaranteRenta;
    let acumulado: Explicacion['acumulado'];
    if (
      concepto.usaAcumuladoAnual &&
      b.tipoPersona === 'NATURAL' &&
      concepto.umbralAcumuladoUvt !== null
    ) {
      const anterior = ctx.acumulado(concepto.id);
      const umbral = concepto.umbralAcumuladoUvt * uvt;
      const supera = anterior + base > umbral;
      declarante = b.declaranteRenta || supera;
      acumulado = {
        anterior,
        con_este: anterior + base,
        umbral_uvt: concepto.umbralAcumuladoUvt,
        umbral,
        supera,
      };
    }

    const tarifa = elegirTarifa(ctx.foto, concepto.id, {
      tipoPersona: b.tipoPersona,
      declarante,
    });
    if (tarifa === null) {
      faltaTarifa.push(concepto.nombre);
      continue;
    }

    const renglonesGrupo = grupo.map((r) => r.orden);
    const origen = grupo[0].origen;
    const minimo = tarifa.baseUvt * uvt;
    const explicacionBase: Omit<Explicacion, 'resultado' | 'texto'> = {
      motor_version: MOTOR_VERSION,
      fecha_causacion: ctx.fecha,
      uvt,
      guardas,
      clasificacion: {
        concepto: concepto.codigo,
        nombre: concepto.nombre,
        origen,
        renglones: renglonesGrupo,
      },
      base: { subtotal, descuentos, base_final: base },
      acumulado,
      cuantia_minima: {
        uvt: tarifa.baseUvt,
        valor: minimo,
        supera: tarifa.baseUvt === 0 || base >= minimo,
      },
      perfil: { desde: b.desde, aproximado: b.desde > ctx.fecha },
    };

    // Base mínima por documento; con 0 UVT se retiene desde el primer peso.
    if (tarifa.baseUvt > 0 && base < minimo) {
      sinRetener.push({
        concepto,
        renglones: renglonesGrupo,
        base,
        motivo: 'BAJO_BASE',
        explicacion: {
          ...explicacionBase,
          resultado: 0,
          texto: `No retengo ${concepto.nombre.toLowerCase()}: la base (${pesos(base)}) no llega a ${tarifa.baseUvt} UVT (${pesos(minimo)}).`,
        },
      });
      continue;
    }

    // ZOMAC: el factor solo si la factura informa la categoría.
    let factor = 1;
    let zomac: string | undefined;
    if (b.esZomac && ctx.zomacEnFactura && b.zomacTamano !== null) {
      factor =
        ctx.factorZomac(b.zomacTamano, Number(ctx.fecha.slice(0, 4))) ?? 1;
      zomac = `ZOMAC ${b.zomacTamano.toLowerCase()}: factor ${factor} (Decreto 1650/2017).`;
    } else if (b.esZomac) {
      zomac = 'ZOMAC sin categoría informada en la factura: tarifa plena.';
    }

    // Temporales, aseo y vigilancia retienen sobre el AIU, nunca menos del
    // 10 % del renglón (par. art. 462-1 ET; Concepto DIAN 016207 de 2026).
    // La cuantía mínima ya se comparó arriba contra el total. Un renglón sin
    // AIU escrito retiene sobre su total (R-D3, Fase 8, §8.13).
    const sinAiu =
      concepto.baseEsAiu === true &&
      grupo.some((r) => r.aiu === undefined || r.aiu <= 0);
    const baseRetencion =
      concepto.baseEsAiu === true
        ? grupo.reduce((s, r) => {
            const neto = r.subtotal - r.descuento;
            return (
              s +
              (r.aiu !== undefined && r.aiu > 0
                ? Math.max(Math.min(r.aiu, neto), neto * 0.1)
                : neto)
            );
          }, 0)
        : base;
    const efectiva = tarifa.tarifa * factor;
    const valor = redondear(baseRetencion * efectiva);
    const sobre =
      concepto.baseEsAiu === true && baseRetencion !== base
        ? `${pesos(baseRetencion)} de AIU (de ${pesos(base)})`
        : pesos(base);
    retenciones.push({
      concepto,
      renglones: renglonesGrupo,
      origen,
      base: baseRetencion,
      tarifa,
      tarifaNominal: tarifa.tarifa,
      factorZomac: factor,
      tarifaEfectiva: efectiva,
      valor,
      uvt,
      explicacion: {
        ...explicacionBase,
        base:
          concepto.baseEsAiu === true
            ? { subtotal, descuentos, base_final: base, aiu: baseRetencion }
            : explicacionBase.base,
        tarifa: {
          nominal: tarifa.tarifa,
          factor_zomac: factor,
          efectiva,
          norma: tarifa.norma,
          tarifa_id: tarifa.id,
          vigencia_desde: tarifa.vigenciaDesde,
        },
        zomac,
        resultado: valor,
        texto: `Retención en la fuente · ${concepto.nombre} ${pct(efectiva)} sobre ${sobre} = ${pesos(valor)}.${sinAiu ? ' Sin el AIU escrito, retengo sobre el total: si la factura lo discrimina, escribilo.' : ''}`,
      },
    });
  }

  if (faltaTarifa.length > 0) {
    return cortar(
      'REVISION',
      `No tengo tarifa de ley para ${faltaTarifa.join(', ')} al ${ctx.fecha}. Pedile al administrador que la cargue.`,
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
      'No hay base sobre la cual retener.',
    guardas,
    retenciones: [],
    sinRetener,
  };
}
