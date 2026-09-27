import { costoUsd, tarifaDe, type Tokens } from '../../../common/ia/modelos';
import type { FilaLectura, FilaRespuesta } from './consumo';

/**
 * El detalle del gasto: cada llamada al modelo, una por fila, con **en qué**
 * se gastó (`docs/planes/consumo-ia.md`, «El detalle»). Puro: sin red y sin
 * base.
 *
 * **Solo cifras**, como el resto del tablero. «En qué» sale del nombre de las
 * herramientas que usó la respuesta —«consultar_cartera», «proponer_cobro»—,
 * nunca de lo que se preguntó, de lo que se filtró ni de lo que se contestó.
 */

/** Para qué se llamó al modelo. */
export type Categoria = 'AYUDA' | 'CONSULTA' | 'PROPUESTA' | 'LECTURA';

export const ETIQUETA_CATEGORIA: Record<Categoria, string> = {
  AYUDA: 'Ayuda sobre el sistema',
  CONSULTA: 'Consulta de datos',
  PROPUESTA: 'Propuesta de cobro o pago',
  LECTURA: 'Lectura de documentos',
};

/**
 * Las herramientas del chat, con palabras de la aplicación. Es solo para
 * mostrar: una que no esté acá sale con su nombre. No se importa de
 * `conversacion` —un módulo no importa lo de adentro de otro—; si se suma una
 * herramienta allá, conviene sumarla acá.
 */
const ETIQUETA_HERRAMIENTA: Record<string, string> = {
  consultar_ventas: 'Ventas',
  consultar_compras: 'Compras',
  consultar_cartera: 'Cartera',
  consultar_inventario: 'Inventario',
  consultar_tesoreria: 'Tesorería',
  consultar_contabilidad: 'Contabilidad',
  consultar_saldos: 'Saldos de caja y bancos',
  consultar_existencias: 'Existencias',
  buscar_valores: 'Búsqueda de nombres',
  proponer_cobro: 'Propuesta de cobro',
  proponer_pago: 'Propuesta de pago',
};

export const etiquetaHerramienta = (nombre: string): string =>
  ETIQUETA_HERRAMIENTA[nombre] ?? nombre;

const TIPO_DOCUMENTO: Record<string, string> = {
  RUT: 'RUT',
  CAMARA_COMERCIO: 'Cámara de Comercio',
  RESOLUCION_DIAN: 'Resolución DIAN',
  CONCEPTO_RETENCION: 'Concepto de retención',
};

/** Una respuesta del chat con lo que usó: los nombres de las herramientas, en orden. */
export interface FilaRespuestaDetalle extends FilaRespuesta {
  herramientas: string[];
  /** Las propuestas que dejó la respuesta (migración 0052). */
  propuestas: number;
}

/** Una lectura con su id y su hora, para listarla. */
export interface FilaLecturaDetalle extends FilaLectura {
  id: string;
  fecha: string;
}

/** Lo que costó cada clase de token, en US$. Suman el total. */
export interface CostoDesglosado {
  entrada: number;
  cacheLeido: number;
  cacheEscrito: number;
  salida: number;
  total: number;
}

/** Una llamada al modelo, como la lista la tabla. */
export interface FilaDetalle {
  id: string;
  fecha: string;
  empresaId: string;
  empresa: string;
  categoria: Categoria;
  /** En pocas palabras: «Cartera, Búsqueda de nombres», «RUT», «Sin consultas». */
  enQue: string;
  herramientas: { nombre: string; etiqueta: string; veces: number }[];
  estado: string;
  modelo: string | null;
  vueltas: number | null;
  duracionMs: number | null;
  /** `null` en una lectura de antes de la 0054: se leyó, pero no se midió. */
  tokens: Tokens | null;
  costo: CostoDesglosado | null;
}

export type OrdenDetalle = 'FECHA' | 'COSTO';

export interface FiltroDetalle {
  categoria: Categoria | null;
  orden: OrdenDetalle;
  pagina: number;
  porPagina: number;
}

export interface Detalle {
  desde: string;
  hasta: string;
  /** El gasto del período por categoría, sin el filtro de categoría: es el «en qué» de todo. */
  porCategoria: {
    categoria: Categoria;
    etiqueta: string;
    llamadas: number;
    costoUsd: number;
    /** Sobre el costo del período, de 0 a 1. */
    participacion: number;
  }[];
  /**
   * Las herramientas que más pesan. Una respuesta que usó dos cuenta en las
   * dos: el costo de una respuesta no se puede partir entre sus consultas.
   */
  porHerramienta: {
    herramienta: string;
    etiqueta: string;
    respuestas: number;
    veces: number;
    costoUsd: number;
  }[];
  filas: FilaDetalle[];
  /** Las filas que cumplen el filtro, en todas las páginas. */
  total: number;
  /** El costo de esas filas. */
  totalUsd: number;
  pagina: number;
  paginas: number;
  porPagina: number;
}

export const POR_PAGINA = 50;

/** Para qué fue una respuesta: proponer pesa más que consultar, y consultar más que ayudar. */
export function categoriaDe(r: FilaRespuestaDetalle): Categoria {
  if (r.propuestas > 0 || r.herramientas.some((h) => h.startsWith('proponer_')))
    return 'PROPUESTA';
  return r.herramientas.length > 0 ? 'CONSULTA' : 'AYUDA';
}

/** El costo partido por clase de token, con la tarifa del modelo que respondió. */
export function desglosar(t: Tokens, modelo: string | null): CostoDesglosado {
  const tarifa = tarifaDe(modelo);
  const d = {
    entrada: (t.entrada * tarifa.entrada) / 1e6,
    cacheLeido: (t.cacheLeido * tarifa.cacheLeido) / 1e6,
    cacheEscrito: (t.cacheEscrito * tarifa.cacheEscrito) / 1e6,
    salida: (t.salida * tarifa.salida) / 1e6,
  };
  return { ...d, total: costoUsd(t, modelo) };
}

function contarHerramientas(
  nombres: readonly string[],
): { nombre: string; etiqueta: string; veces: number }[] {
  const veces = new Map<string, number>();
  for (const n of nombres) veces.set(n, (veces.get(n) ?? 0) + 1);
  return [...veces.entries()].map(([nombre, v]) => ({
    nombre,
    etiqueta: etiquetaHerramienta(nombre),
    veces: v,
  }));
}

function deRespuesta(r: FilaRespuestaDetalle): FilaDetalle {
  const herramientas = contarHerramientas(r.herramientas);
  return {
    id: r.id,
    fecha: r.fecha,
    empresaId: r.empresaId,
    empresa: r.empresa,
    categoria: categoriaDe(r),
    enQue:
      herramientas.length === 0
        ? 'Sin consultas'
        : herramientas.map((h) => h.etiqueta).join(', '),
    herramientas,
    estado: r.estado,
    modelo: r.modelo,
    vueltas: r.vueltas,
    duracionMs: r.duracionMs,
    tokens: r.uso,
    costo: desglosar(r.uso, r.modelo),
  };
}

function deLectura(l: FilaLecturaDetalle): FilaDetalle {
  return {
    id: l.id,
    fecha: l.fecha,
    empresaId: l.empresaId,
    empresa: l.empresa,
    categoria: 'LECTURA',
    enQue: TIPO_DOCUMENTO[l.tipo] ?? l.tipo,
    herramientas: [],
    estado: l.estado,
    modelo: l.modelo,
    vueltas: null,
    duracionMs: l.duracionMs,
    tokens: l.uso,
    costo: l.uso === null ? null : desglosar(l.uso, l.modelo),
  };
}

const costoDe = (f: FilaDetalle) => f.costo?.total ?? 0;

/** Arma el detalle del período: el resumen por categoría y herramienta, y la página pedida. */
export function armarDetalle(
  respuestas: readonly FilaRespuestaDetalle[],
  lecturas: readonly FilaLecturaDetalle[],
  desde: string,
  hasta: string,
  filtro: FiltroDetalle,
): Detalle {
  const todas = [...respuestas.map(deRespuesta), ...lecturas.map(deLectura)];
  const costoPeriodo = todas.reduce((s, f) => s + costoDe(f), 0);

  // ── Por categoría: siempre las cuatro, para que se vea lo que no se usó ──
  const porCategoria = (Object.keys(ETIQUETA_CATEGORIA) as Categoria[]).map(
    (categoria) => {
      const filas = todas.filter((f) => f.categoria === categoria);
      const costo = filas.reduce((s, f) => s + costoDe(f), 0);
      return {
        categoria,
        etiqueta: ETIQUETA_CATEGORIA[categoria],
        llamadas: filas.length,
        costoUsd: costo,
        participacion: costoPeriodo === 0 ? 0 : costo / costoPeriodo,
      };
    },
  );

  // ── Por herramienta ──
  const herramientas = new Map<
    string,
    {
      herramienta: string;
      etiqueta: string;
      respuestas: number;
      veces: number;
      costoUsd: number;
    }
  >();
  for (const f of todas) {
    for (const h of f.herramientas) {
      const x = herramientas.get(h.nombre) ?? {
        herramienta: h.nombre,
        etiqueta: h.etiqueta,
        respuestas: 0,
        veces: 0,
        costoUsd: 0,
      };
      x.respuestas += 1;
      x.veces += h.veces;
      x.costoUsd += costoDe(f);
      herramientas.set(h.nombre, x);
    }
  }

  // ── La página ──
  const filtradas = todas
    .filter(
      (f) => filtro.categoria === null || f.categoria === filtro.categoria,
    )
    .sort((a, b) =>
      filtro.orden === 'COSTO'
        ? costoDe(b) - costoDe(a) || b.fecha.localeCompare(a.fecha)
        : b.fecha.localeCompare(a.fecha),
    );
  const paginas = Math.max(1, Math.ceil(filtradas.length / filtro.porPagina));
  const pagina = Math.min(Math.max(1, filtro.pagina), paginas);
  const inicio = (pagina - 1) * filtro.porPagina;

  return {
    desde,
    hasta,
    porCategoria,
    porHerramienta: [...herramientas.values()].sort(
      (a, b) => b.costoUsd - a.costoUsd,
    ),
    filas: filtradas.slice(inicio, inicio + filtro.porPagina),
    total: filtradas.length,
    totalUsd: filtradas.reduce((s, f) => s + costoDe(f), 0),
    pagina,
    paginas,
    porPagina: filtro.porPagina,
  };
}
