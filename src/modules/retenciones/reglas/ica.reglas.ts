import {
  MOTOR_VERSION,
  redondear,
  type Explicacion,
  type Guarda,
} from './renta.reglas';

/**
 * Retención de ICA (ReteICA) sobre una compra, municipio por municipio (plan
 * motor de retenciones, Fase 3; especificación §7.4 y §7.5).
 *
 * Función pura. El ICA es municipal: cada renglón se causa en **un municipio**
 * (art. 343 Ley 1819/2016) y ahí se miran las reglas de ese municipio —si la
 * empresa es agente allí, si el proveedor es contribuyente allí, la base
 * mínima, si acumula en el período y la tarifa—. Una misma factura puede
 * causar ICA en dos municipios (caso borde 9).
 *
 * **Municipio sin parámetros cargados: no calcula y lo dice** (nunca calcula en
 * cero en silencio). Los parámetros los carga la plataforma con su acuerdo.
 */

export interface RenglonIca {
  orden: number;
  /** Sin IVA. */
  subtotal: number;
  /** `true` bien, `false` servicio, `null` todavía no se sabe. */
  esBien: boolean | null;
  /** Donde se causa, ya resuelto (ver `municipioDeCausacion`). */
  municipio: string | null;
}

export interface ParametroIca {
  municipio: string;
  anio: number;
  baseMinimaUvtCompras: number | null;
  baseMinimaUvtServicios: number | null;
  tarifaGeneralPorMil: number | null;
  usaTarifaPorActividad: boolean;
  acumulaEnPeriodo: boolean;
  periodicidad: 'MENSUAL' | 'BIMESTRAL' | 'TRIMESTRAL' | 'ANUAL';
  acuerdo: string;
}

export interface PerfilIcaTercero {
  regimen: 'COMUN' | 'PREFERENCIAL' | 'NO_CONTRIBUYENTE';
  esAutorretenedor: boolean;
  codigoActividad: string | null;
}

export interface FilaMatriz {
  perfilPagador: string;
  perfilBeneficiario: string;
  retiene: boolean;
  fundamento: string | null;
}

export interface ContextoIca {
  fecha: string;
  uvt: number | null;
  /** El proveedor está en el SIMPLE: el ICA va integrado allá (art. 911 ET). */
  beneficiarioSimple: boolean;
  /** «GRAN_CONTRIBUYENTE_DIAN», «ORDINARIO»… para la matriz municipal. */
  perfilPagador: string;
  perfilBeneficiario: string;
  /** Los municipios donde la empresa es agente de ICA a la fecha. */
  agenteEn: Set<string>;
  nombreMunicipio: (codigo: string) => string;
  parametro: (municipio: string) => ParametroIca | null;
  /** El perfil de ICA del proveedor allí; `null` = sin datos (se toma común). */
  perfilProveedor: (municipio: string) => PerfilIcaTercero | null;
  /** Tarifa por mil de una actividad del proveedor; `null` si no está. */
  tarifaActividad: (
    municipio: string,
    actividad: string | null,
  ) => number | null;
  matriz: (municipio: string) => FilaMatriz[];
  /** Base ya acumulada con este proveedor en el período, sin este documento. */
  acumulado: (municipio: string) => number;
}

export interface RetencionIca {
  municipio: string;
  renglones: number[];
  base: number;
  /** Por mil. */
  tarifaPorMil: number;
  valor: number;
  acuerdo: string;
  /** La base que se sumó al acumulado del período (todo lo causado allí). */
  baseDelPeriodo: number;
  explicacion: Explicacion;
}

export interface ResultadoIca {
  decision: 'CALCULADA' | 'BAJO_BASE' | 'NO_SUJETO' | 'REVISION';
  motivo: string;
  retenciones: RetencionIca[];
  /** Lo que no se retuvo en cada municipio, y por qué. */
  sinRetener: Array<{ municipio: string; texto: string }>;
  /** Municipios donde no se pudo calcular: sin parámetros, sin tarifa. */
  avisos: string[];
  /** Base del período por municipio (para el acumulado), retenga o no. */
  acumular: Array<{ municipio: string; base: number; retenido: number }>;
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/** El período dentro del año según la periodicidad del municipio. */
export function periodoDe(
  fecha: string,
  periodicidad: ParametroIca['periodicidad'],
): number {
  const mes = Number(fecha.slice(5, 7));
  switch (periodicidad) {
    case 'MENSUAL':
      return mes;
    case 'BIMESTRAL':
      return Math.ceil(mes / 2);
    case 'TRIMESTRAL':
      return Math.ceil(mes / 3);
    default:
      return 1;
  }
}

/**
 * Dónde se causa el ICA de un renglón (art. 343 Ley 1819/2016), con lo que el
 * sistema sabe hoy:
 *
 * - si el renglón dice su municipio, ese;
 * - un **bien de un proveedor industrial** (CIIU 10–33): el municipio del
 *   proveedor, como su sede fabril (T17);
 * - lo demás —comercio y servicios—: el municipio de la sede que recibe la
 *   compra (donde se perfecciona la venta o se presta el servicio).
 */
export function municipioDeCausacion(r: {
  municipioRenglon: string | null;
  esBien: boolean | null;
  ciiuProveedor: string | null;
  municipioProveedor: string | null;
  municipioCompra: string | null;
}): string | null {
  if (r.municipioRenglon !== null) return r.municipioRenglon;
  const industrial =
    r.ciiuProveedor !== null &&
    Number(r.ciiuProveedor.slice(0, 2)) >= 10 &&
    Number(r.ciiuProveedor.slice(0, 2)) <= 33;
  if (r.esBien === true && industrial && r.municipioProveedor !== null) {
    return r.municipioProveedor;
  }
  return r.municipioCompra;
}

export function calcularIca(
  renglones: RenglonIca[],
  ctx: ContextoIca,
): ResultadoIca {
  const vacio = (
    decision: ResultadoIca['decision'],
    motivo: string,
  ): ResultadoIca => ({
    decision,
    motivo,
    retenciones: [],
    sinRetener: [],
    avisos: [],
    acumular: [],
  });

  if (ctx.agenteEn.size === 0) {
    return vacio(
      'NO_SUJETO',
      'No retengo ICA: la empresa no es agente de retención de ICA en ningún municipio.',
    );
  }
  if (ctx.beneficiarioSimple) {
    return vacio(
      'NO_SUJETO',
      'No retengo ICA: el proveedor es del SIMPLE, que integra el ICA (art. 911 ET).',
    );
  }
  if (ctx.uvt === null) {
    return vacio('REVISION', `No tengo la UVT del ${ctx.fecha.slice(0, 4)}.`);
  }
  const uvt = ctx.uvt;

  const porMunicipio = new Map<string, RenglonIca[]>();
  for (const r of renglones) {
    if (r.municipio === null || !ctx.agenteEn.has(r.municipio)) continue;
    porMunicipio.set(r.municipio, [
      ...(porMunicipio.get(r.municipio) ?? []),
      r,
    ]);
  }
  if (porMunicipio.size === 0) {
    return vacio(
      'NO_SUJETO',
      'No retengo ICA: la compra no se causa en un municipio donde seas agente.',
    );
  }

  const retenciones: RetencionIca[] = [];
  const sinRetener: ResultadoIca['sinRetener'] = [];
  const avisos: string[] = [];
  const acumular: ResultadoIca['acumular'] = [];

  for (const [municipio, grupo] of porMunicipio) {
    const nombre = ctx.nombreMunicipio(municipio);
    const param = ctx.parametro(municipio);
    if (param === null) {
      avisos.push(
        `No tengo los parámetros de ReteICA de ${nombre} para ${ctx.fecha.slice(0, 4)}: no la calculo. Solicite al administrador que los cargue con su acuerdo.`,
      );
      continue;
    }

    const guardas: Guarda[] = [
      {
        regla: 'agente_ica_en_municipio',
        resultado: true,
        fundamento: param.acuerdo,
      },
    ];
    const perfil = ctx.perfilProveedor(municipio);
    const noContribuyente = perfil?.regimen === 'NO_CONTRIBUYENTE';
    guardas.push({
      regla: 'proveedor_no_contribuyente_ica',
      resultado: noContribuyente,
      fundamento: param.acuerdo,
    });
    if (noContribuyente) {
      sinRetener.push({
        municipio,
        texto: `No retengo ICA en ${nombre}: el proveedor no es contribuyente allí.`,
      });
      continue;
    }
    const autorretenedor = perfil?.esAutorretenedor === true;
    guardas.push({
      regla: 'proveedor_autorretenedor_ica',
      resultado: autorretenedor,
      fundamento: param.acuerdo,
    });
    if (autorretenedor) {
      sinRetener.push({
        municipio,
        texto: `No retengo ICA en ${nombre}: el proveedor es autorretenedor allí.`,
      });
      continue;
    }

    // La matriz municipal: sin filas, se retiene (la regla general).
    const filas = ctx.matriz(municipio);
    const regla =
      filas.find(
        (f) =>
          f.perfilPagador === ctx.perfilPagador &&
          f.perfilBeneficiario === ctx.perfilBeneficiario,
      ) ??
      filas.find(
        (f) =>
          f.perfilPagador === ctx.perfilPagador && f.perfilBeneficiario === '*',
      ) ??
      filas.find(
        (f) =>
          f.perfilPagador === '*' &&
          f.perfilBeneficiario === ctx.perfilBeneficiario,
      );
    if (regla !== undefined && !regla.retiene) {
      guardas.push({
        regla: 'matriz_municipal',
        resultado: false,
        fundamento: regla.fundamento ?? param.acuerdo,
      });
      sinRetener.push({
        municipio,
        texto: `No retengo ICA en ${nombre}: la matriz del municipio no ordena retención para esta combinación${regla.fundamento ? ` (${regla.fundamento})` : ''}.`,
      });
      continue;
    }

    const base = grupo.reduce((s, r) => s + r.subtotal, 0);
    const renglonesGrupo = grupo.map((r) => r.orden);

    // La base mínima: la de compras si todo son bienes, la de servicios si todo
    // son servicios; con los dos, la menor (la más exigente para no dejar de
    // retener).
    const bienes = grupo.some((r) => r.esBien !== false);
    const servicios = grupo.some((r) => r.esBien === false);
    const minimos = [
      bienes ? param.baseMinimaUvtCompras : null,
      servicios ? param.baseMinimaUvtServicios : null,
    ].filter((x): x is number => x !== null);
    const minUvt = minimos.length === 0 ? 0 : Math.min(...minimos);
    const minimo = minUvt * uvt;
    const anterior = param.acumulaEnPeriodo ? ctx.acumulado(municipio) : 0;
    const evaluada = base + anterior;

    const tarifaPorMil = param.usaTarifaPorActividad
      ? (ctx.tarifaActividad(municipio, perfil?.codigoActividad ?? null) ??
        param.tarifaGeneralPorMil)
      : param.tarifaGeneralPorMil;

    const explicacionBase: Omit<Explicacion, 'resultado' | 'texto'> = {
      motor_version: MOTOR_VERSION,
      fecha_causacion: ctx.fecha,
      uvt,
      guardas,
      clasificacion: {
        concepto: 'RETEICA',
        nombre: `ReteICA ${nombre}`,
        origen: 'MUNICIPIO',
        renglones: renglonesGrupo,
      },
      base: { subtotal: base, descuentos: 0, base_final: base },
      cuantia_minima: {
        uvt: minUvt,
        valor: minimo,
        supera: minUvt === 0 || evaluada >= minimo,
      },
      ...(param.acumulaEnPeriodo
        ? {
            acumulado: {
              anterior,
              con_este: evaluada,
              umbral_uvt: minUvt,
              umbral: minimo,
              supera: minUvt === 0 || evaluada >= minimo,
            },
          }
        : {}),
    };

    if (minUvt > 0 && evaluada < minimo) {
      acumular.push({ municipio, base, retenido: 0 });
      sinRetener.push({
        municipio,
        texto: param.acumulaEnPeriodo
          ? `No retengo ICA en ${nombre}: con lo del período van ${pesos(evaluada)} y no llegan a ${minUvt} UVT (${pesos(minimo)}).`
          : `No retengo ICA en ${nombre}: la base (${pesos(base)}) no llega a ${minUvt} UVT (${pesos(minimo)}).`,
      });
      continue;
    }

    if (tarifaPorMil === null) {
      avisos.push(
        `No tengo la tarifa de ReteICA de ${nombre} para la actividad del proveedor: no la calculo. Cargue la actividad del proveedor en su ficha, o solicite la tarifa al administrador.`,
      );
      continue;
    }

    const valor = redondear((base * tarifaPorMil) / 1000);
    acumular.push({ municipio, base, retenido: valor });
    retenciones.push({
      municipio,
      renglones: renglonesGrupo,
      base,
      tarifaPorMil,
      valor,
      acuerdo: param.acuerdo,
      baseDelPeriodo: base,
      explicacion: {
        ...explicacionBase,
        tarifa: {
          nominal: tarifaPorMil / 1000,
          factor_zomac: 1,
          efectiva: tarifaPorMil / 1000,
          norma: param.acuerdo,
          tarifa_id: `${municipio}-${param.anio}`,
          vigencia_desde: `${param.anio}-01-01`,
        },
        resultado: valor,
        texto: `ReteICA ${nombre} · ${tarifaPorMil.toLocaleString('es-CO')} por mil sobre ${pesos(base)} = ${pesos(valor)}${anterior > 0 ? ` (con lo del período se pasó la base)` : ''}.`,
      },
    });
  }

  const decision: ResultadoIca['decision'] =
    retenciones.length > 0
      ? 'CALCULADA'
      : sinRetener.length > 0
        ? 'BAJO_BASE'
        : avisos.length > 0
          ? 'REVISION'
          : 'NO_SUJETO';
  return {
    decision,
    motivo: [
      ...retenciones.map((r) => r.explicacion.texto),
      ...sinRetener.map((s) => s.texto),
    ].join(' '),
    retenciones,
    sinRetener,
    avisos,
    acumular,
  };
}

/**
 * El acumulado de ICA del período con el que se calcula un documento.
 *
 * Al confirmar es el de hoy. Al recalcular, el de hoy ya trae el aporte de la
 * misma compra: sumarlo otra vez a su base la contaba dos veces y en Medellín
 * (que acumula el bimestre) salía una diferencia falsa (bug 3). Por eso el
 * recálculo pasa el que había antes de la compra —el guardado en su entrada,
 * o el reconstruido con los aportes anteriores— y, si lo trae para ese
 * municipio, manda ese.
 */
export function acumuladoIcaAntes(
  guardado: Record<string, number> | undefined,
  hoy: Map<string, number>,
  municipio: string,
): number {
  if (guardado !== undefined && Object.hasOwn(guardado, municipio)) {
    return Number(guardado[municipio]);
  }
  return hoy.get(municipio) ?? 0;
}
