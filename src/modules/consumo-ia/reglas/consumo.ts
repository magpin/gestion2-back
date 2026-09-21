import {
  costoSimulado,
  costoUsd,
  TARIFAS,
  type Tokens,
} from '../../../common/ia/modelos';

/**
 * El tablero de consumo de la IA (`docs/planes/consumo-ia.md`), armado a
 * partir de las filas. Puro: sin red y sin base.
 *
 * **Solo cifras.** Las filas que entran acá no traen texto: ni la pregunta, ni
 * la respuesta, ni lo que decía un documento.
 */

/** Una respuesta del chat, como la trae la consulta: números y nada más. */
export interface FilaRespuesta {
  id: string;
  empresaId: string;
  empresa: string;
  /** El día en hora de Colombia, `aaaa-mm-dd`. */
  dia: string;
  fecha: string;
  estado: string;
  modelo: string | null;
  uso: Tokens;
  duracionMs: number | null;
  vueltas: number | null;
  consultas: number;
}

/** Una lectura de documento. `uso` es null en lo leído antes de la 0054. */
export interface FilaLectura {
  empresaId: string;
  empresa: string;
  dia: string;
  tipo: string;
  estado: string;
  modelo: string | null;
  uso: Tokens | null;
  duracionMs: number | null;
}

const CERO: Tokens = { entrada: 0, salida: 0, cacheLeido: 0, cacheEscrito: 0 };

const sumar = (a: Tokens, b: Tokens): Tokens => ({
  entrada: a.entrada + b.entrada,
  salida: a.salida + b.salida,
  cacheLeido: a.cacheLeido + b.cacheLeido,
  cacheEscrito: a.cacheEscrito + b.cacheEscrito,
});

const entradaTotal = (t: Tokens) => t.entrada + t.cacheLeido + t.cacheEscrito;

/** Lo que se leyó del caché sobre toda la entrada: cuanto más alto, mejor. */
export const aprovechamientoCache = (t: Tokens): number =>
  entradaTotal(t) === 0 ? 0 : t.cacheLeido / entradaTotal(t);

/** El percentil `p` (0 a 1) de una lista, o null si está vacía. */
export function percentil(
  valores: readonly number[],
  p: number,
): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const i = Math.min(
    orden.length - 1,
    Math.max(0, Math.ceil(p * orden.length) - 1),
  );
  return orden[i];
}

/** Los días de un rango, para que el gráfico no tenga huecos. */
export function diasEntre(desde: string, hasta: string): string[] {
  const dias: string[] = [];
  const fin = Date.parse(`${hasta}T00:00:00Z`);
  for (let t = Date.parse(`${desde}T00:00:00Z`); t <= fin; t += 86_400_000) {
    dias.push(new Date(t).toISOString().slice(0, 10));
    if (dias.length > 400) break;
  }
  return dias;
}

export interface Tablero {
  desde: string;
  hasta: string;
  totales: {
    costoUsd: number;
    respuestas: number;
    documentos: number;
    empresas: number;
    costoPorRespuesta: number | null;
    costoPorEmpresa: number | null;
    tokens: Tokens;
  };
  porDia: {
    dia: string;
    chatUsd: number;
    lecturaUsd: number;
    respuestas: number;
  }[];
  porEmpresa: {
    empresaId: string;
    empresa: string;
    respuestas: number;
    documentos: number;
    tokens: number;
    costoUsd: number;
    costoPorRespuesta: number | null;
    aprovechamientoCache: number;
  }[];
  porModelo: { modelo: string; llamadas: number; costoUsd: number }[];
  eficiencia: {
    aprovechamientoCache: number;
    cacheEscritoPorRespuesta: number | null;
    consultasPorRespuesta: number | null;
    vueltasPorRespuesta: number | null;
    duracionMediana: number | null;
    duracionP95: number | null;
    /** Las respuestas sin duración: las de antes de la 0054. */
    sinDuracion: number;
  };
  /** El mismo período con los mismos tokens en cada modelo. Simulación: no dice si la calidad alcanza. */
  simulacion: { opus: number; sonnet: number; haiku: number };
  masCaras: {
    fecha: string;
    empresa: string;
    estado: string;
    modelo: string | null;
    consultas: number;
    vueltas: number | null;
    tokens: number;
    costoUsd: number;
    duracionMs: number | null;
  }[];
  lectura: {
    tipo: string;
    cantidad: number;
    fallidas: number;
    /** Con medición: las de antes de la 0054 no la tienen. */
    medidas: number;
    costoPromedio: number | null;
    duracionPromedio: number | null;
  }[];
}

/** Arma el tablero del período con las respuestas y las lecturas que trajo la consulta. */
export function armarTablero(
  respuestas: readonly FilaRespuesta[],
  lecturas: readonly FilaLectura[],
  desde: string,
  hasta: string,
): Tablero {
  const costoDe = (uso: Tokens, modelo: string | null) => costoUsd(uso, modelo);
  const conUso = lecturas.filter(
    (l): l is FilaLectura & { uso: Tokens } => l.uso !== null,
  );

  // ── Totales ──
  const tokensChat = respuestas.reduce((s, r) => sumar(s, r.uso), CERO);
  const tokensLectura = conUso.reduce((s, l) => sumar(s, l.uso), CERO);
  const tokens = sumar(tokensChat, tokensLectura);
  const costoChat = respuestas.reduce(
    (s, r) => s + costoDe(r.uso, r.modelo),
    0,
  );
  const costoLectura = conUso.reduce((s, l) => s + costoDe(l.uso, l.modelo), 0);
  const costoTotal = costoChat + costoLectura;
  const empresas = new Set([
    ...respuestas.map((r) => r.empresaId),
    ...lecturas.map((l) => l.empresaId),
  ]);

  // ── Por día ──
  const dias = new Map(
    diasEntre(desde, hasta).map((d) => [
      d,
      { dia: d, chatUsd: 0, lecturaUsd: 0, respuestas: 0 },
    ]),
  );
  for (const r of respuestas) {
    const d = dias.get(r.dia);
    if (d) {
      d.chatUsd += costoDe(r.uso, r.modelo);
      d.respuestas += 1;
    }
  }
  for (const l of conUso) {
    const d = dias.get(l.dia);
    if (d) d.lecturaUsd += costoDe(l.uso, l.modelo);
  }

  // ── Por empresa ──
  const porEmpresa = new Map<
    string,
    {
      empresaId: string;
      empresa: string;
      respuestas: number;
      documentos: number;
      tokens: Tokens;
      costoUsd: number;
    }
  >();
  const deEmpresa = (id: string, nombre: string) => {
    const e = porEmpresa.get(id) ?? {
      empresaId: id,
      empresa: nombre,
      respuestas: 0,
      documentos: 0,
      tokens: CERO,
      costoUsd: 0,
    };
    porEmpresa.set(id, e);
    return e;
  };
  for (const r of respuestas) {
    const e = deEmpresa(r.empresaId, r.empresa);
    e.respuestas += 1;
    e.tokens = sumar(e.tokens, r.uso);
    e.costoUsd += costoDe(r.uso, r.modelo);
  }
  for (const l of lecturas) {
    const e = deEmpresa(l.empresaId, l.empresa);
    e.documentos += 1;
    if (l.uso !== null) {
      e.tokens = sumar(e.tokens, l.uso);
      e.costoUsd += costoDe(l.uso, l.modelo);
    }
  }

  // ── Por modelo ──
  const porModelo = new Map<
    string,
    { modelo: string; llamadas: number; costoUsd: number }
  >();
  for (const x of [
    ...respuestas.map((r) => ({ modelo: r.modelo, uso: r.uso })),
    ...conUso.map((l) => ({ modelo: l.modelo, uso: l.uso })),
  ]) {
    const clave = x.modelo ?? 'sin modelo';
    const m = porModelo.get(clave) ?? {
      modelo: clave,
      llamadas: 0,
      costoUsd: 0,
    };
    m.llamadas += 1;
    m.costoUsd += costoDe(x.uso, x.modelo);
    porModelo.set(clave, m);
  }

  // ── Eficiencia ──
  const duraciones = respuestas
    .map((r) => r.duracionMs)
    .filter((d): d is number => d !== null);
  const conVueltas = respuestas.filter((r) => r.vueltas !== null);
  const promedio = (n: number, d: number) => (d === 0 ? null : n / d);

  // ── Simulación ──
  const todas = [...respuestas.map((r) => r.uso), ...conUso.map((l) => l.uso)];
  const simular = (tarifa: (typeof TARIFAS)[keyof typeof TARIFAS]) =>
    todas.reduce((s, u) => s + costoSimulado(u, tarifa), 0);

  // ── Lectura, por tipo ──
  const porTipo = new Map<string, FilaLectura[]>();
  for (const l of lecturas)
    porTipo.set(l.tipo, [...(porTipo.get(l.tipo) ?? []), l]);

  return {
    desde,
    hasta,
    totales: {
      costoUsd: costoTotal,
      respuestas: respuestas.length,
      documentos: lecturas.length,
      empresas: empresas.size,
      costoPorRespuesta: promedio(costoChat, respuestas.length),
      costoPorEmpresa: promedio(costoTotal, empresas.size),
      tokens,
    },
    porDia: [...dias.values()],
    porEmpresa: [...porEmpresa.values()]
      .map((e) => ({
        empresaId: e.empresaId,
        empresa: e.empresa,
        respuestas: e.respuestas,
        documentos: e.documentos,
        tokens: entradaTotal(e.tokens) + e.tokens.salida,
        costoUsd: e.costoUsd,
        costoPorRespuesta: promedio(
          e.costoUsd,
          e.respuestas === 0 ? 0 : e.respuestas,
        ),
        aprovechamientoCache: aprovechamientoCache(e.tokens),
      }))
      .sort((a, b) => b.costoUsd - a.costoUsd),
    porModelo: [...porModelo.values()].sort((a, b) => b.costoUsd - a.costoUsd),
    eficiencia: {
      aprovechamientoCache: aprovechamientoCache(tokensChat),
      cacheEscritoPorRespuesta: promedio(
        tokensChat.cacheEscrito,
        respuestas.length,
      ),
      consultasPorRespuesta: promedio(
        respuestas.reduce((s, r) => s + r.consultas, 0),
        respuestas.length,
      ),
      vueltasPorRespuesta: promedio(
        conVueltas.reduce((s, r) => s + (r.vueltas ?? 0), 0),
        conVueltas.length,
      ),
      duracionMediana: percentil(duraciones, 0.5),
      duracionP95: percentil(duraciones, 0.95),
      sinDuracion: respuestas.length - duraciones.length,
    },
    simulacion: {
      opus: simular(TARIFAS.OPUS),
      sonnet: simular(TARIFAS.SONNET),
      haiku: simular(TARIFAS.HAIKU),
    },
    masCaras: [...respuestas]
      .map((r) => ({ r, costo: costoDe(r.uso, r.modelo) }))
      .sort((a, b) => b.costo - a.costo)
      .slice(0, 20)
      .map(({ r, costo }) => ({
        fecha: r.fecha,
        empresa: r.empresa,
        estado: r.estado,
        modelo: r.modelo,
        consultas: r.consultas,
        vueltas: r.vueltas,
        tokens: entradaTotal(r.uso) + r.uso.salida,
        costoUsd: costo,
        duracionMs: r.duracionMs,
      })),
    lectura: [...porTipo.entries()].map(([tipo, filas]) => {
      const medidas = filas.filter((f) => f.uso !== null);
      const conTiempo = filas.filter((f) => f.duracionMs !== null);
      return {
        tipo,
        cantidad: filas.length,
        fallidas: filas.filter((f) => f.estado === 'FALLO').length,
        medidas: medidas.length,
        costoPromedio: promedio(
          medidas.reduce((s, f) => s + costoDe(f.uso as Tokens, f.modelo), 0),
          medidas.length,
        ),
        duracionPromedio: promedio(
          conTiempo.reduce((s, f) => s + (f.duracionMs ?? 0), 0),
          conTiempo.length,
        ),
      };
    }),
  };
}
