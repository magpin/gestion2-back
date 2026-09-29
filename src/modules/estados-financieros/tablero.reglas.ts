/**
 * Inicio → tablero de la plata (Fase 8 del menú nuevo). Reglas puras: juntan
 * lo que ya calculan tesorería, ventas, compras y el estado de resultados en
 * los bloques del lienzo, y deciden qué alertas ofrece María.
 *
 * Las alertas solo ofrecen lo que existe (C4 del plan): abrir el chat con la
 * pregunta ya escrita, o ir a la pantalla donde se resuelve. Nada de «¿le
 * mando el recordatorio?»: no hay envío de correos.
 */

const r2 = (v: number) => Math.round(v * 100) / 100;
const DIA = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (fecha: string) => Date.parse(`${fecha}T00:00:00Z`);

// ─── Lo que entra ───────────────────────────────────────────────────────────

export interface LugarPlata {
  id: string;
  medio: 'CAJA' | 'BANCO';
  nombre: string;
  saldo: number;
}

export interface ClienteCartera {
  terceroId: string;
  nombre: string;
  facturas: number;
  vencido: number;
  total: number;
  maxDiasVencidos: number;
}

export interface CompraPendiente {
  id: string;
  numero: string;
  venceEfectivo: string;
  tramo: string;
  pendiente: number;
  descuentoSugerido: number;
  descuentoPct: number | null;
  descuentoHasta: string | null;
}

export interface ProveedorPendiente {
  terceroId: string;
  nombre: string;
  compras: CompraPendiente[];
}

export interface Programado {
  fecha: string;
  valor: number;
  descripcion: string;
  compraId: string | null;
}

export interface EntradaTablero {
  hoy: string;
  lugares: LugarPlata[];
  cartera: { total: number; facturas: number; clientes: ClienteCartera[] };
  porPagar: {
    total: number;
    compras: number;
    tramos: Record<string, number>;
    proveedores: ProveedorPendiente[];
  };
  /** Lo pendiente por cobrar, factura por factura, con su vencimiento. */
  porCobrar: Array<{ vence: string; pendiente: number }>;
  programados: Programado[];
  /** `null` si quien mira no ve los estados financieros. */
  resultado: {
    mes: string;
    ingresos: number;
    utilidad: number;
    utilidadAnterior: number | null;
    mesAnterior: string | null;
  } | null;
}

// ─── Lo que sale ────────────────────────────────────────────────────────────

/** Un texto con montos: los números se pintan como plata. */
export type Parte = string | number;

export type AccionAlerta =
  | { tipo: 'MARIA'; pregunta: string }
  | { tipo: 'IR'; href: string; etiqueta: string };

export interface Alerta {
  clave: string;
  partes: Parte[];
  accion: AccionAlerta;
}

export interface Tablero {
  hoy: string;
  plataHoy: { total: number; lugares: LugarPlata[] };
  teDeben: {
    total: number;
    facturas: number;
    clientes: number;
    vencido: number;
    masVencidos: Array<{
      terceroId: string;
      nombre: string;
      vencido: number;
      facturas: number;
      dias: number;
    }>;
  };
  debes: {
    total: number;
    facturas: number;
    proveedores: number;
    vencido: number;
    proximos: Array<{
      compraId: string;
      proveedor: string;
      numero: string;
      vence: string;
      valor: number;
      vencida: boolean;
      descuentoPct: number | null;
      descuentoHasta: string | null;
    }>;
  };
  /** Los siete días desde hoy. Lo ya vencido no está: está en «te deben» y «debés». */
  semana: Array<{ dia: string; entra: number; sale: number }>;
  resultadoMes: {
    mes: string;
    ingresos: number;
    costosYGastos: number;
    utilidad: number;
    mesAnterior: string | null;
    variacion: number | null;
  } | null;
  alertas: Alerta[];
}

/** Un cliente con más de estos días vencido merece alerta. */
const DIAS_ALERTA_CARTERA = 30;
/** Cuántas filas va en cada tarjeta y cuántas alertas como mucho. */
const FILAS = 3;
const ALERTAS = 3;

export function armarTablero(e: EntradaTablero): Tablero {
  const dias = Array.from({ length: 7 }, (_, i) => iso(ms(e.hoy) + i * DIA));
  const entra = new Map(dias.map((d) => [d, 0]));
  const sale = new Map(dias.map((d) => [d, 0]));
  const sumar = (m: Map<string, number>, dia: string, valor: number) => {
    if (m.has(dia)) m.set(dia, m.get(dia)! + valor);
  };
  for (const f of e.porCobrar) sumar(entra, f.vence, f.pendiente);
  const compras = e.porPagar.proveedores.flatMap((p) =>
    p.compras.map((c) => ({ ...c, proveedor: p.nombre })),
  );
  for (const c of compras) sumar(sale, c.venceEfectivo, c.pendiente);
  // Un programado que apunta a una compra ya está en lo que falta pagar.
  for (const p of e.programados) {
    if (p.compraId === null) sumar(sale, p.fecha, p.valor);
  }

  const vencidoCobrar = r2(
    e.cartera.clientes.reduce((t, c) => t + c.vencido, 0),
  );
  const masVencidos = e.cartera.clientes
    .filter((c) => c.vencido > 0)
    .slice(0, FILAS)
    .map((c) => ({
      terceroId: c.terceroId,
      nombre: c.nombre,
      vencido: c.vencido,
      facturas: c.facturas,
      dias: c.maxDiasVencidos,
    }));

  const proximos = [...compras]
    .sort((a, b) => a.venceEfectivo.localeCompare(b.venceEfectivo))
    .slice(0, FILAS)
    .map((c) => ({
      compraId: c.id,
      proveedor: c.proveedor,
      numero: c.numero,
      vence: c.venceEfectivo,
      valor: c.pendiente,
      vencida: c.venceEfectivo < e.hoy,
      descuentoPct: c.descuentoPct,
      descuentoHasta: c.descuentoHasta,
    }));

  const resultadoMes =
    e.resultado === null
      ? null
      : {
          mes: e.resultado.mes,
          ingresos: e.resultado.ingresos,
          costosYGastos: r2(e.resultado.ingresos - e.resultado.utilidad),
          utilidad: e.resultado.utilidad,
          mesAnterior: e.resultado.mesAnterior,
          variacion:
            e.resultado.utilidadAnterior === null ||
            e.resultado.utilidadAnterior === 0
              ? null
              : Math.round(
                  ((e.resultado.utilidad - e.resultado.utilidadAnterior) /
                    Math.abs(e.resultado.utilidadAnterior)) *
                    1000,
                ) / 10,
        };

  const plata = r2(e.lugares.reduce((t, l) => t + l.saldo, 0));
  const semana = dias.map((dia) => ({
    dia,
    entra: r2(entra.get(dia)!),
    sale: r2(sale.get(dia)!),
  }));

  return {
    hoy: e.hoy,
    plataHoy: { total: plata, lugares: e.lugares },
    teDeben: {
      total: e.cartera.total,
      facturas: e.cartera.facturas,
      clientes: e.cartera.clientes.length,
      vencido: vencidoCobrar,
      masVencidos,
    },
    debes: {
      total: e.porPagar.total,
      facturas: e.porPagar.compras,
      proveedores: e.porPagar.proveedores.length,
      vencido: e.porPagar.tramos.VENCIDO ?? 0,
      proximos,
    },
    semana,
    resultadoMes,
    alertas: alertas(e, compras, plata, semana),
  };
}

/** «el jueves 1 oct». */
export function diaEnPalabras(fecha: string, hoy: string): string {
  if (fecha === hoy) return 'hoy';
  if (fecha === iso(ms(hoy) + DIA)) return 'mañana';
  const d = new Date(ms(fecha));
  const dias = [
    'domingo',
    'lunes',
    'martes',
    'miércoles',
    'jueves',
    'viernes',
    'sábado',
  ];
  const meses = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ];
  return `el ${dias[d.getUTCDay()]} ${d.getUTCDate()} ${meses[d.getUTCMonth()]}`;
}

function alertas(
  e: EntradaTablero,
  compras: Array<CompraPendiente & { proveedor: string }>,
  plata: number,
  semana: Tablero['semana'],
): Alerta[] {
  const salida: Alerta[] = [];

  // 1. La plata no alcanza para lo que vence en la semana.
  let saldo = plata;
  let faltante: { dia: string; saldo: number } | null = null;
  for (const d of semana) {
    saldo = r2(saldo + d.entra - d.sale);
    if (saldo < 0 && faltante === null) faltante = { dia: d.dia, saldo };
  }
  if (faltante !== null) {
    salida.push({
      clave: 'faltante',
      partes: [
        `Con lo que vence, ${diaEnPalabras(faltante.dia, e.hoy)} la plata no alcanza: faltarían `,
        -faltante.saldo,
        '.',
      ],
      accion: { tipo: 'IR', href: '/dashboard/pagos', etiqueta: 'Ver pagos' },
    });
  }

  // 2. El cliente más atrasado.
  const atrasado = e.cartera.clientes.find(
    (c) => c.vencido > 0 && c.maxDiasVencidos > DIAS_ALERTA_CARTERA,
  );
  if (atrasado) {
    salida.push({
      clave: `cartera:${atrasado.terceroId}`,
      partes: [
        `${atrasado.nombre} lleva ${atrasado.maxDiasVencidos} días sin pagar `,
        atrasado.vencido,
        '.',
      ],
      accion: {
        tipo: 'MARIA',
        pregunta: `¿Qué facturas me debe ${atrasado.nombre} y desde cuándo?`,
      },
    });
  }

  // 3. Un descuento por pronto pago que se vence en la semana.
  const limite = iso(ms(e.hoy) + 6 * DIA);
  const descuento = compras
    .filter(
      (c) =>
        c.descuentoSugerido > 0 &&
        c.descuentoHasta !== null &&
        c.descuentoHasta >= e.hoy &&
        c.descuentoHasta <= limite,
    )
    .sort((a, b) => b.descuentoSugerido - a.descuentoSugerido)[0];
  if (descuento) {
    salida.push({
      clave: `descuento:${descuento.id}`,
      partes: [
        `Si le pagás a ${descuento.proveedor} hasta ${diaEnPalabras(descuento.descuentoHasta!, e.hoy)}, te ahorrás `,
        descuento.descuentoSugerido,
        '.',
      ],
      accion: { tipo: 'IR', href: '/dashboard/pagos', etiqueta: 'Pagar' },
    });
  }

  // 4. Lo que vence esta semana y no está programado.
  const programadas = new Set(
    e.programados.map((p) => p.compraId).filter((x) => x !== null),
  );
  const sinProgramar = compras
    .filter(
      (c) =>
        c.venceEfectivo >= e.hoy &&
        c.venceEfectivo <= limite &&
        !programadas.has(c.id) &&
        c.id !== descuento?.id,
    )
    .sort((a, b) => a.venceEfectivo.localeCompare(b.venceEfectivo))[0];
  if (sinProgramar) {
    salida.push({
      clave: `vence:${sinProgramar.id}`,
      partes: [
        `${diaEnPalabras(sinProgramar.venceEfectivo, e.hoy).replace(/^./, (x) => x.toUpperCase())} vence la factura ${sinProgramar.numero} de ${sinProgramar.proveedor}, `,
        sinProgramar.pendiente,
        '. Todavía no está programada.',
      ],
      accion: { tipo: 'IR', href: '/dashboard/pagos', etiqueta: 'Programar' },
    });
  }

  return salida.slice(0, ALERTAS);
}
