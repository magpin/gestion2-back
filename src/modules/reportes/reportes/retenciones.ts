/**
 * Los reportes de retenciones — formulario 350, ReteICA y certificados — de
 * filas a hoja (plan motor de retenciones, Fase 6, §6.2).
 *
 * Puro, como los demás: entran las filas de `retencion_calculada` que lee el
 * servicio y sale el modelo que la plantilla dibuja. Sin base y sin reloj.
 *
 * Lo que manda en los tres:
 *
 * - **Todas las filas del período cuentan**, las confirmadas y las reversas en
 *   negativo (notas crédito y anulaciones), cada una en el mes de su fecha. En
 *   el 350 las reversas van en su propio renglón —«menos retenciones
 *   practicadas en exceso…»—, no restando del concepto.
 * - **Al peso en el documento, al mil en la declaración** (art. 577 ET): cada
 *   renglón del 350 se redondea al múltiplo de mil más cercano, y los totales
 *   son la suma de lo redondeado, como en el formulario.
 * - Todo en **centavos enteros**: sumar pesos con decimales en coma flotante
 *   descuadra un peso en el mes que menos conviene.
 */
import { aCentavos, pesos } from './ventas-por-cliente';

export type TipoPersona = 'NATURAL' | 'JURIDICA';

/** Una fila de `retencion_calculada`, como la lee el servicio. */
export interface RetencionLeida {
  id: string;
  /** La fila que esta corrige (una reversa), o null si es una original. */
  anulaA: string | null;
  fecha: string;
  documentoId: string;
  documentoTipo: string;
  /** El número que la persona reconoce: «FV-1234», «SETT-13». */
  documento: string;
  terceroId: string;
  tercero: string;
  terceroDocumento: string;
  tipoPersona: TipoPersona;
  impuesto: 'RENTA' | 'IVA' | 'ICA';
  concepto: string;
  conceptoNombre: string;
  municipio: string | null;
  municipioNombre: string | null;
  base: string;
  tarifa: string;
  valor: string;
  esAutorretencion: boolean;
  /** Pago al exterior con la tarifa de un convenio (§8.15). */
  conConvenio?: boolean;
}

/** Un renglón de `formulario_350_renglon` vigente en el mes. */
export interface Renglon350 {
  codigo: string;
  seccion:
    | 'RENTA'
    | 'RENTA_EXTERIOR'
    | 'AUTORRETENCION'
    | 'RENTA_MENOS'
    | 'IVA'
    | 'IVA_MENOS';
  orden: number;
  nombre: string;
  porTipoPersona: boolean;
  conceptos: string[];
  /**
   * Números de casilla del formulario: {base PJ, retención PJ, base PN,
   * retención PN} si distingue persona; si no, {base, valor}.
   */
  casillas: Array<number | null>;
}

/**
 * Lo que el libro mayor dice de cada documento en el mes: lo acreditado menos
 * lo debitado en las cuentas de retención (2365 y 2367) por los asientos
 * vigentes que salieron de él.
 */
export interface LibroDocumento {
  documentoId: string;
  documento: string;
  /** Si el documento está anulado: explica casi todas las diferencias. */
  anulado: boolean;
  /** De dónde salió el asiento: COMPRA, VENTA, NOMINA… */
  origen: string;
  neto: string;
}

/** Un asiento del mes que toca esas cuentas sin salir de un documento. */
export interface AsientoSuelto {
  numero: string;
  fecha: string;
  glosa: string;
  neto: string;
}

/* ── Utilidades ─────────────────────────────────────────────────────────── */

/** Al múltiplo de mil más cercano (art. 577 ET). En centavos. */
export function alMil(centavos: number): number {
  return Math.round(centavos / 100_000) * 100_000;
}

const valorDe = (f: RetencionLeida): number => aCentavos(f.valor);
const baseDe = (f: RetencionLeida): number => aCentavos(f.base);

/** «2,5 %», «0,966 %», «100 %». La tarifa llega como fracción. */
export function tarifaTexto(tarifa: string | number): string {
  const pct = Number(tarifa) * 100;
  return `${pct.toLocaleString('es-CO', { maximumFractionDigits: 3 })} %`;
}

/* ── Formulario 350 ──────────────────────────────────────────────────────── */

export interface Cifra350 {
  base: string;
  valor: string;
  /** Redondeado al mil, en centavos: lo que se lleva al formulario. */
  baseMil: number;
  valorMil: number;
}

export interface RenglonVista {
  codigo: string;
  seccion: Renglon350['seccion'];
  nombre: string;
  /** «PJ 29 / 42 · PN 79 / 95», o «131»: dónde va cada cifra en MUISCA. */
  casillas: string;
  porTipoPersona: boolean;
  /** Personas jurídicas y naturales; `unico` cuando el renglón no distingue. */
  pj: Cifra350 | null;
  pn: Cifra350 | null;
  unico: Cifra350 | null;
  vacio: boolean;
  /** Cuántos documentos suman en el renglón: «14 facturas de proveedor». */
  documentos: number;
  /**
   * La tarifa del renglón, «2,5 %», si todas sus retenciones van a la misma;
   * `null` si hay varias (la autorretención, que va según el CIIU).
   */
  tarifa: string | null;
}

export interface Formulario350 {
  mes: string;
  secciones: {
    titulo: string;
    /** Si la sección separa jurídicas de naturales: cambia la cabecera. */
    porTipoPersona: boolean;
    renglones: RenglonVista[];
  }[];
  totales: {
    renta: string;
    iva: string;
    total: string;
    /** Sin redondear: para ver cuánto movió el redondeo. */
    exacto: string;
    centavos: { renta: number; iva: number; total: number };
  };
  /** Filas cuyo concepto no tiene renglón: no se pierden, se avisan. */
  sinRenglon: {
    documento: string;
    tercero: string;
    concepto: string;
    valor: string;
    /** Por qué no entró, cuando no es solo que el concepto no tiene renglón. */
    motivo?: string;
  }[];
  cuadre: {
    motor: string;
    libro: string;
    diferencia: string;
    cuadra: boolean;
    documentos: {
      documento: string;
      motor: string;
      libro: string;
      diferencia: string;
      razon: string;
      centavos: { motor: number; libro: number };
    }[];
    sueltos: { numero: string; fecha: string; glosa: string; neto: string }[];
  };
  /** Retenciones del mes que siguen en pie (`retencionesEfectivas`), no filas. */
  filas: number;
}

const TITULO_SECCION: Record<Renglon350['seccion'], string> = {
  RENTA: 'Retenciones a título de renta',
  RENTA_EXTERIOR: 'Pagos al exterior',
  AUTORRETENCION: 'Autorretenciones',
  RENTA_MENOS: 'Menos, en renta',
  IVA: 'Retenciones a título de IVA',
  IVA_MENOS: 'Menos, en IVA',
};

interface Acumulado {
  base: number;
  valor: number;
}

const cifra = (a: Acumulado | undefined): Cifra350 | null =>
  a === undefined
    ? null
    : {
        base: pesos(a.base),
        valor: pesos(a.valor),
        baseMil: alMil(a.base),
        valorMil: alMil(a.valor),
      };

/**
 * En qué renglón va una fila. `null` si ninguno la suma: sale en «Sin
 * renglón», no desaparece.
 */
/** Las casillas de un renglón, como se leen al pasarlas al formulario. */
export function casillasTexto(r: Renglon350): string {
  const par = (
    base: number | null | undefined,
    valor: number | null | undefined,
  ) => [base, valor].filter((c) => c !== null && c !== undefined).join(' / ');
  const [a, b, c, d] = r.casillas;
  if (!r.porTipoPersona) return par(a, b) || '—';
  return (
    [par(a, b) && `PJ ${par(a, b)}`, par(c, d) && `PN ${par(c, d)}`]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

export function renglonDe(
  f: RetencionLeida,
  renglones: Renglon350[],
): Renglon350 | null {
  if (f.impuesto === 'ICA') return null;
  // Una reversa —nota crédito o anulación— va en «menos» de su impuesto.
  if (valorDe(f) < 0) {
    const seccion = f.impuesto === 'IVA' ? 'IVA_MENOS' : 'RENTA_MENOS';
    return renglones.find((r) => r.seccion === seccion) ?? null;
  }
  // Un pago al exterior con la tarifa de un convenio va al renglón de los
  // países con convenio vigente (§8.15).
  if (f.conConvenio === true) {
    return renglones.find((r) => r.codigo === 'EXTERIOR_CON_CONVENIO') ?? null;
  }
  const secciones: Renglon350['seccion'][] =
    f.impuesto === 'IVA'
      ? ['IVA']
      : f.esAutorretencion
        ? ['AUTORRETENCION']
        : ['RENTA', 'RENTA_EXTERIOR'];
  return (
    renglones.find(
      (r) => secciones.includes(r.seccion) && r.conceptos.includes(f.concepto),
    ) ?? null
  );
}

/**
 * Si la fila cae en un renglón que separa persona jurídica de natural, pero
 * el formulario no trae casilla para la suya: la autorretención especial
 * (casillas 59 y 68) es solo de personas jurídicas (art. 1.2.6.6 DUR), y la
 * de una persona natural se quedaba en una columna que no existe en MUISCA
 * (bug 6). Devuelve el porqué, o `null` si tiene casilla.
 *
 * Se mira el renglón de su concepto sin importar el signo: la reversa de una
 * fila sin casilla tampoco tiene dónde restar.
 */
export function sinCasilla(
  f: RetencionLeida,
  renglones: Renglon350[],
): string | null {
  const positiva = { ...f, valor: f.valor.replace(/^-/, '') };
  const r = renglonDe(positiva, renglones);
  if (r === null || !r.porTipoPersona) return null;
  const casilla = f.tipoPersona === 'NATURAL' ? r.casillas[3] : r.casillas[1];
  if (casilla !== null && casilla !== undefined) return null;
  const persona =
    f.tipoPersona === 'NATURAL' ? 'persona natural' : 'persona jurídica';
  return `El formulario no trae casilla de «${r.nombre}» para ${persona}: no la sumo. Revisala con tu contador.`;
}

export function armar350(
  mes: string,
  filas: RetencionLeida[],
  renglones: Renglon350[],
  libro: { documentos: LibroDocumento[]; sueltos: AsientoSuelto[] },
): Formulario350 {
  const ordenados = [...renglones].sort((a, b) => a.orden - b.orden);
  // Por renglón y columna: 'PJ', 'PN' o 'U'.
  const acumulado = new Map<string, Acumulado>();
  const sinRenglon: Formulario350['sinRenglon'] = [];
  // Por renglón: qué documentos lo suman y con qué tarifas.
  const documentos = new Map<string, Set<string>>();
  const tarifas = new Map<string, Set<string>>();
  let exacto = 0;

  const sumar = (llave: string, base: number, valor: number) => {
    const a = acumulado.get(llave) ?? { base: 0, valor: 0 };
    a.base += base;
    a.valor += valor;
    acumulado.set(llave, a);
  };

  // Una reversa de algo del **mismo mes** no es una «retención practicada en
  // exceso» de un período ya declarado: resta en el renglón de lo que
  // corrige, y «Menos» queda para lo declarado en meses anteriores.
  const porId = new Map(filas.map((f) => [f.id, f]));
  const origenEnElMes = (f: RetencionLeida): RetencionLeida | null => {
    let o = f.anulaA === null ? undefined : porId.get(f.anulaA);
    if (o === undefined) return null;
    for (;;) {
      const arriba: RetencionLeida | undefined =
        o.anulaA === null ? undefined : porId.get(o.anulaA);
      if (arriba === undefined) return o;
      o = arriba;
    }
  };

  for (const f of filas) {
    if (f.impuesto === 'ICA') continue;
    const r = renglonDe(origenEnElMes(f) ?? f, ordenados);
    const valor = valorDe(f);
    const motivo =
      r === null ? null : sinCasilla(origenEnElMes(f) ?? f, ordenados);
    if (r === null || motivo !== null) {
      sinRenglon.push({
        documento: f.documento,
        tercero: f.tercero,
        concepto: f.conceptoNombre,
        valor: pesos(valor),
        ...(motivo === null ? {} : { motivo }),
      });
      continue;
    }
    exacto += valor;
    const menos = r.seccion === 'RENTA_MENOS' || r.seccion === 'IVA_MENOS';
    // En «menos» se escribe en positivo: el formulario ya lo resta.
    const base = menos ? 0 : baseDe(f);
    const columna = r.porTipoPersona
      ? f.tipoPersona === 'NATURAL'
        ? 'PN'
        : 'PJ'
      : 'U';
    sumar(`${r.codigo}|${columna}`, base, menos ? -valor : valor);
    if (f.anulaA === null) {
      documentos.set(
        r.codigo,
        (documentos.get(r.codigo) ?? new Set()).add(f.documentoId),
      );
      tarifas.set(
        r.codigo,
        (tarifas.get(r.codigo) ?? new Set()).add(tarifaTexto(f.tarifa)),
      );
    }
  }

  const vistas: RenglonVista[] = ordenados.map((r) => {
    const pj = r.porTipoPersona ? acumulado.get(`${r.codigo}|PJ`) : undefined;
    const pn = r.porTipoPersona ? acumulado.get(`${r.codigo}|PN`) : undefined;
    const u = r.porTipoPersona ? undefined : acumulado.get(`${r.codigo}|U`);
    return {
      codigo: r.codigo,
      seccion: r.seccion,
      nombre: r.nombre,
      casillas: casillasTexto(r),
      porTipoPersona: r.porTipoPersona,
      pj: r.porTipoPersona ? (cifra(pj) ?? cifra({ base: 0, valor: 0 })) : null,
      pn: r.porTipoPersona ? (cifra(pn) ?? cifra({ base: 0, valor: 0 })) : null,
      unico: r.porTipoPersona
        ? null
        : (cifra(u) ?? cifra({ base: 0, valor: 0 })),
      vacio: pj === undefined && pn === undefined && u === undefined,
      documentos: documentos.get(r.codigo)?.size ?? 0,
      tarifa:
        tarifas.get(r.codigo)?.size === 1
          ? [...tarifas.get(r.codigo)!][0]
          : null,
    };
  });

  const retenidoMil = (v: RenglonVista): number =>
    (v.pj?.valorMil ?? 0) + (v.pn?.valorMil ?? 0) + (v.unico?.valorMil ?? 0);
  const sumaSeccion = (secciones: Renglon350['seccion'][]): number =>
    vistas
      .filter((v) => secciones.includes(v.seccion))
      .reduce((s, v) => s + retenidoMil(v), 0);

  const renta =
    sumaSeccion(['RENTA', 'RENTA_EXTERIOR', 'AUTORRETENCION']) -
    sumaSeccion(['RENTA_MENOS']);
  const iva = sumaSeccion(['IVA']) - sumaSeccion(['IVA_MENOS']);

  const secciones: Formulario350['secciones'] = [];
  for (const v of vistas) {
    const titulo = TITULO_SECCION[v.seccion];
    const ultima = secciones[secciones.length - 1];
    if (ultima?.titulo === titulo) {
      ultima.renglones.push(v);
      ultima.porTipoPersona ||= v.porTipoPersona;
    } else {
      secciones.push({
        titulo,
        porTipoPersona: v.porTipoPersona,
        renglones: [v],
      });
    }
  }

  return {
    mes,
    secciones,
    totales: {
      renta: pesos(renta),
      iva: pesos(iva),
      total: pesos(renta + iva),
      exacto: pesos(exacto),
      centavos: { renta, iva, total: renta + iva },
    },
    sinRenglon,
    cuadre: cuadrar(filas, libro),
    filas: retencionesEfectivas(filas),
  };
}

/**
 * Cuántas retenciones del mes siguen en pie: las originales (no las reversas
 * ni las anulaciones, que son movimientos sobre otra) a las que, con lo que
 * les cuelga en el mismo mes, les queda algo. Una compra y su nota crédito,
 * anuladas las dos, son cuatro filas y ninguna retención (bug 21). Sin ICA,
 * que no va al 350.
 */
export function retencionesEfectivas(filas: RetencionLeida[]): number {
  const delMes = filas.filter((f) => f.impuesto !== 'ICA');
  const hijas = new Map<string, RetencionLeida[]>();
  for (const f of delMes) {
    if (f.anulaA === null) continue;
    hijas.set(f.anulaA, [...(hijas.get(f.anulaA) ?? []), f]);
  }
  const vivo = (f: RetencionLeida, vistas: Set<string>): number => {
    if (vistas.has(f.id)) return 0;
    vistas.add(f.id);
    return (hijas.get(f.id) ?? []).reduce(
      (s, h) => s + vivo(h, vistas),
      valorDe(f),
    );
  };
  return delMes.filter((f) => f.anulaA === null && vivo(f, new Set()) !== 0)
    .length;
}

/**
 * Lo del motor contra lo del libro, documento por documento.
 *
 * Por documento y no solo en total: así la diferencia llega explicada. Casi
 * siempre es una de tres cosas, y la hoja la dice:
 *
 * - un documento **anulado**: el libro lo quita de su mes (el asiento queda
 *   anulado), y el motor lo descuenta en el mes de la anulación, que es
 *   cuando se declara;
 * - una compra registrada **antes del motor**: está en el libro y no en el
 *   motor;
 * - un asiento hecho a mano contra esas cuentas.
 */
export function cuadrar(
  filas: RetencionLeida[],
  libro: { documentos: LibroDocumento[]; sueltos: AsientoSuelto[] },
): Formulario350['cuadre'] {
  const motor = new Map<string, { documento: string; valor: number }>();
  for (const f of filas) {
    if (f.impuesto === 'ICA') continue;
    const m = motor.get(f.documentoId) ?? { documento: f.documento, valor: 0 };
    m.valor += valorDe(f);
    motor.set(f.documentoId, m);
  }
  const enLibro = new Map(libro.documentos.map((d) => [d.documentoId, d]));

  let totalMotor = 0;
  let totalLibro = 0;
  const documentos: Formulario350['cuadre']['documentos'] = [];
  const ids = new Set([...motor.keys(), ...enLibro.keys()]);
  for (const id of ids) {
    const m = motor.get(id);
    const l = enLibro.get(id);
    const vm = m?.valor ?? 0;
    const vl = l === undefined ? 0 : aCentavos(l.neto);
    totalMotor += vm;
    totalLibro += vl;
    if (vm === vl) continue;
    const razon =
      l?.anulado === true || (l === undefined && vm < 0)
        ? 'Anulado: el libro lo quita de su mes; el 350 lo descuenta en el mes de la anulación.'
        : m === undefined &&
            l !== undefined &&
            l.origen !== 'COMPRA' &&
            l.origen !== 'VENTA'
          ? `Asiento de ${l.origen.toLowerCase()}: esa retención no pasa por el motor.`
          : m === undefined
            ? 'Está en el libro y no en el motor: registrado antes del motor de retenciones.'
            : l === undefined
              ? 'Está en el motor y no en el libro del mes: su asiento está anulado o en otro mes.'
              : 'El libro y el motor no coinciden en este documento: revisalo.';
    documentos.push({
      documento: m?.documento ?? l?.documento ?? id,
      motor: pesos(vm),
      libro: pesos(vl),
      diferencia: pesos(vm - vl),
      razon,
      centavos: { motor: vm, libro: vl },
    });
  }

  return {
    motor: pesos(totalMotor),
    libro: pesos(totalLibro),
    diferencia: pesos(totalMotor - totalLibro),
    cuadra: totalMotor === totalLibro,
    documentos,
    sueltos: libro.sueltos.map((s) => ({
      numero: s.numero,
      fecha: s.fecha,
      glosa: s.glosa,
      neto: pesos(aCentavos(s.neto)),
    })),
  };
}

/* ── ReteICA por municipio ───────────────────────────────────────────────── */

export type Periodicidad = 'MENSUAL' | 'BIMESTRAL' | 'TRIMESTRAL' | 'ANUAL';

const MESES_PERIODO: Record<Periodicidad, number> = {
  MENSUAL: 1,
  BIMESTRAL: 2,
  TRIMESTRAL: 3,
  ANUAL: 12,
};

export interface ReteIcaMunicipio {
  codigo: string;
  nombre: string;
  periodicidad: Periodicidad | null;
  /** Si el rango elegido no es un período de declaración del municipio. */
  aviso: string | null;
  terceros: {
    tercero: string;
    terceroDocumento: string;
    base: string;
    tarifas: string;
    retenido: string;
    centavos: { base: number; retenido: number };
  }[];
  base: string;
  retenido: string;
  centavos: number;
}

export interface ReteIca {
  municipios: ReteIcaMunicipio[];
  total: string;
  totalCentavos: number;
  filas: number;
  /** «2 municipios · 5 retenciones». */
  detalle: string;
}

/**
 * Si `desde`–`hasta` es exactamente un período del municipio: bimestre
 * enero-febrero, marzo-abril…; trimestre enero-marzo… El municipio declara
 * por período, y un reporte de otro rango sirve para mirar, no para declarar.
 */
export function esPeriodoDe(
  desde: string,
  hasta: string,
  periodicidad: Periodicidad,
): boolean {
  const [a1, m1, d1] = desde.split('-').map(Number);
  const [a2, m2, d2] = hasta.split('-').map(Number);
  const meses = MESES_PERIODO[periodicidad];
  const ultimoDia = new Date(Date.UTC(a2, m2, 0)).getUTCDate();
  return (
    a1 === a2 &&
    d1 === 1 &&
    d2 === ultimoDia &&
    (m1 - 1) % meses === 0 &&
    m2 - m1 + 1 === meses
  );
}

export function armarReteIca(
  filas: RetencionLeida[],
  periodicidades: Map<string, Periodicidad>,
  rango: { desde: string; hasta: string },
): ReteIca {
  type PorTercero = {
    tercero: string;
    documento: string;
    base: number;
    valor: number;
    tarifas: Set<string>;
  };
  const porMunicipio = new Map<
    string,
    { nombre: string; terceros: Map<string, PorTercero> }
  >();
  let n = 0;
  for (const f of filas) {
    if (f.impuesto !== 'ICA' || f.municipio === null) continue;
    n += 1;
    const m = porMunicipio.get(f.municipio) ?? {
      nombre: f.municipioNombre ?? f.municipio,
      terceros: new Map<string, PorTercero>(),
    };
    // La autorretención de la empresa (§8.9) no es algo retenido a un
    // tercero: va en su propia línea.
    const llave = f.esAutorretencion ? '__autorretencion' : f.terceroId;
    const t: PorTercero = m.terceros.get(llave) ?? {
      tercero: f.esAutorretencion
        ? 'Autorretención de la empresa (sus ventas)'
        : f.tercero,
      documento: f.esAutorretencion ? '—' : f.terceroDocumento,
      base: 0,
      valor: 0,
      tarifas: new Set<string>(),
    };
    t.base += baseDe(f);
    t.valor += valorDe(f);
    // La tarifa del ICA se lee por mil.
    if (valorDe(f) > 0) {
      t.tarifas.add(
        `${(Number(f.tarifa) * 1000).toLocaleString('es-CO', { maximumFractionDigits: 3 })} ‰`,
      );
    }
    m.terceros.set(llave, t);
    porMunicipio.set(f.municipio, m);
  }

  const municipios: ReteIcaMunicipio[] = [...porMunicipio.entries()]
    .map(([codigo, m]) => {
      const periodicidad = periodicidades.get(codigo) ?? null;
      const terceros = [...m.terceros.values()].sort(
        (a, b) => b.valor - a.valor,
      );
      const base = terceros.reduce((s, t) => s + t.base, 0);
      const retenido = terceros.reduce((s, t) => s + t.valor, 0);
      return {
        codigo,
        nombre: m.nombre,
        periodicidad,
        aviso:
          periodicidad === null
            ? 'Sin periodicidad cargada para este municipio.'
            : esPeriodoDe(rango.desde, rango.hasta, periodicidad)
              ? null
              : `Declara ${periodicidad.toLowerCase()}: este rango no es uno de sus períodos. Sirve para revisar, no para declarar.`,
        terceros: terceros.map((t) => ({
          tercero: t.tercero,
          terceroDocumento: t.documento,
          base: pesos(t.base),
          tarifas: [...t.tarifas].join(' · ') || '—',
          retenido: pesos(t.valor),
          centavos: { base: t.base, retenido: t.valor },
        })),
        base: pesos(base),
        retenido: pesos(retenido),
        centavos: retenido,
      };
    })
    .sort((a, b) => b.centavos - a.centavos);

  return {
    municipios,
    total: pesos(municipios.reduce((s, m) => s + m.centavos, 0)),
    totalCentavos: municipios.reduce((s, m) => s + m.centavos, 0),
    filas: n,
    detalle: `${municipios.length} ${municipios.length === 1 ? 'municipio' : 'municipios'} · ${n} ${n === 1 ? 'retención' : 'retenciones'}`,
  };
}

/* ── Certificados de retención ───────────────────────────────────────────── */

/** Una cifra del certificado: escrita para la hoja y en centavos para el Excel. */
export interface CifraCertificado {
  base: string;
  retenido: string;
  centavos: { base: number; retenido: number };
}

export interface Certificado {
  tercero: string;
  terceroDocumento: string;
  renta: (CifraCertificado & { concepto: string; tarifas: string })[];
  iva: CifraCertificado | null;
  ica: (CifraCertificado & { municipio: string })[];
  totalRetenido: string;
}

export interface Certificados {
  certificados: Certificado[];
  total: string;
  totalCentavos: number;
}

/**
 * Un certificado por tercero con lo que se le retuvo en el rango, neto de
 * notas crédito y anulaciones (art. 381 ET). Las autorretenciones no van: nadie
 * se las practicó a un tercero. Un tercero que quedó en cero no recibe
 * certificado.
 *
 * El rango lo elige quien lo saca: el año para renta; el bimestre cuando un
 * proveedor pide el de IVA.
 */
export function armarCertificados(filas: RetencionLeida[]): Certificados {
  type Suma = { base: number; valor: number; tarifas: Set<string> };
  const nueva = (): Suma => ({ base: 0, valor: 0, tarifas: new Set() });
  const porTercero = new Map<
    string,
    {
      tercero: string;
      documento: string;
      renta: Map<string, Suma>;
      iva: Suma;
      ica: Map<string, Suma>;
    }
  >();

  for (const f of filas) {
    if (f.esAutorretencion) continue;
    const t = porTercero.get(f.terceroId) ?? {
      tercero: f.tercero,
      documento: f.terceroDocumento,
      renta: new Map<string, Suma>(),
      iva: nueva(),
      ica: new Map<string, Suma>(),
    };
    let s: Suma;
    if (f.impuesto === 'RENTA') {
      s = t.renta.get(f.conceptoNombre) ?? nueva();
      t.renta.set(f.conceptoNombre, s);
    } else if (f.impuesto === 'IVA') {
      s = t.iva;
    } else {
      const m = f.municipioNombre ?? f.municipio ?? '—';
      s = t.ica.get(m) ?? nueva();
      t.ica.set(m, s);
    }
    s.base += baseDe(f);
    s.valor += valorDe(f);
    if (valorDe(f) > 0) s.tarifas.add(tarifaTexto(f.tarifa));
    porTercero.set(f.terceroId, t);
  }

  const cifraDe = (x: Suma): CifraCertificado => ({
    base: pesos(x.base),
    retenido: pesos(x.valor),
    centavos: { base: x.base, retenido: x.valor },
  });
  const certificados: Certificado[] = [];
  let total = 0;
  for (const t of porTercero.values()) {
    const renta = [...t.renta.entries()]
      .filter(([, x]) => x.valor !== 0)
      .map(([concepto, x]) => ({
        concepto,
        tarifas: [...x.tarifas].join(' · '),
        ...cifraDe(x),
      }));
    const ica = [...t.ica.entries()]
      .filter(([, x]) => x.valor !== 0)
      .map(([municipio, x]) => ({ municipio, ...cifraDe(x) }));
    const iva = t.iva.valor === 0 ? null : cifraDe(t.iva);
    if (renta.length === 0 && ica.length === 0 && iva === null) continue;
    const suma =
      renta.reduce((acc, r) => acc + r.centavos.retenido, 0) +
      (iva?.centavos.retenido ?? 0) +
      ica.reduce((acc, r) => acc + r.centavos.retenido, 0);
    total += suma;
    certificados.push({
      tercero: t.tercero,
      terceroDocumento: t.documento,
      renta,
      iva,
      ica,
      totalRetenido: pesos(suma),
    });
  }
  certificados.sort((a, b) => a.tercero.localeCompare(b.tercero, 'es'));
  return { certificados, total: pesos(total), totalCentavos: total };
}
