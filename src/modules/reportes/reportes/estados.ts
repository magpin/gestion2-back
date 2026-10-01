/**
 * Los estados financieros, en filas: lo que imprime la hoja y lo que escribe
 * el Excel. Puro. Una sola transformación para los dos, así el PDF y el
 * Excel no pueden decir cifras distintas.
 */
import type {
  BalanceGeneral,
  EstadoResultados,
  FlujoDirecto,
} from '../../estados-financieros/estados.reglas';
import type { Libro } from './libros';
import { pesos } from './ventas-por-cliente';

export type NivelFila = 'seccion' | 'grupo' | 'cuenta' | 'subtotal' | 'total';

export interface FilaEstado {
  nivel: NivelFila;
  etiqueta: string;
  codigo: string | null;
  actual: number | null;
  /** El del período con que se compara; `undefined` si no se compara. */
  comparado?: number | null;
}

export type TipoEstado = 'RESULTADOS' | 'BALANCE' | 'FLUJO';

export const TITULO_ESTADO: Record<TipoEstado, string> = {
  RESULTADOS: 'Estado de resultados',
  BALANCE: 'Balance general',
  FLUJO: 'Estado de flujo de caja',
};

// ─── Resultados ─────────────────────────────────────────────────────────────

export function filasResultados(
  actual: EstadoResultados,
  comparado?: EstadoResultados,
): FilaEstado[] {
  const filas: FilaEstado[] = [];
  for (const r of actual.renglones) {
    const otro = comparado?.renglones.find((x) => x.clave === r.clave);
    filas.push({
      nivel:
        r.tipo === 'grupo'
          ? 'grupo'
          : r.tipo === 'subtotal'
            ? 'subtotal'
            : 'total',
      etiqueta: r.etiqueta,
      codigo: null,
      actual: r.valor,
      ...(comparado && { comparado: otro?.valor ?? 0 }),
    });
    // Las cuentas de ambos períodos: una que solo se movió en el otro también va.
    const codigos = new Map<string, string>();
    for (const c of [...(r.cuentas ?? []), ...(otro?.cuentas ?? [])])
      codigos.set(c.codigo, c.nombre);
    for (const [codigo, nombre] of [...codigos.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      filas.push({
        nivel: 'cuenta',
        etiqueta: nombre,
        codigo,
        actual: r.cuentas?.find((c) => c.codigo === codigo)?.valor ?? 0,
        ...(comparado && {
          comparado:
            otro?.cuentas?.find((c) => c.codigo === codigo)?.valor ?? 0,
        }),
      });
    }
  }
  return filas;
}

// ─── Balance ────────────────────────────────────────────────────────────────

export function filasBalance(
  actual: BalanceGeneral,
  comparado?: BalanceGeneral,
): FilaEstado[] {
  const filas: FilaEstado[] = [];
  const parte = (titulo: string, clave: 'activo' | 'pasivo' | 'patrimonio') => {
    filas.push({
      nivel: 'seccion',
      etiqueta: titulo,
      codigo: null,
      actual: null,
      ...(comparado && { comparado: null }),
    });
    const a = actual[clave];
    const o = comparado?.[clave];
    // Las secciones y los grupos de los dos cortes, en el orden del actual.
    const secciones = [
      ...new Set(
        [...a.secciones, ...(o?.secciones ?? [])].map((s) => s.etiqueta),
      ),
    ];
    for (const etiqueta of secciones) {
      const sa = a.secciones.find((s) => s.etiqueta === etiqueta);
      const so = o?.secciones.find((s) => s.etiqueta === etiqueta);
      const grupos = [
        ...new Set(
          [...(sa?.renglones ?? []), ...(so?.renglones ?? [])].map(
            (r) => r.grupo,
          ),
        ),
      ];
      for (const g of grupos) {
        const ra = sa?.renglones.find((r) => r.grupo === g);
        const ro = so?.renglones.find((r) => r.grupo === g);
        filas.push({
          nivel: 'grupo',
          etiqueta: (ra ?? ro)!.etiqueta,
          codigo: g.endsWith('*') ? null : g,
          actual: ra?.valor ?? 0,
          ...(comparado && { comparado: ro?.valor ?? 0 }),
        });
        const cuentas = new Map<string, string>();
        for (const c of [...(ra?.cuentas ?? []), ...(ro?.cuentas ?? [])])
          cuentas.set(c.codigo, c.nombre);
        for (const [codigo, nombre] of [...cuentas.entries()].sort((x, y) =>
          x[0].localeCompare(y[0]),
        )) {
          filas.push({
            nivel: 'cuenta',
            etiqueta: nombre,
            codigo,
            actual: ra?.cuentas.find((c) => c.codigo === codigo)?.valor ?? 0,
            ...(comparado && {
              comparado:
                ro?.cuentas.find((c) => c.codigo === codigo)?.valor ?? 0,
            }),
          });
        }
      }
      filas.push({
        nivel: 'subtotal',
        etiqueta: `Total ${etiqueta.toLowerCase()}`,
        codigo: null,
        actual: sa?.total ?? 0,
        ...(comparado && { comparado: so?.total ?? 0 }),
      });
    }
    filas.push({
      nivel: 'total',
      etiqueta: `Total ${titulo.toLowerCase()}`,
      codigo: null,
      actual: a.total,
      ...(comparado && { comparado: o?.total ?? 0 }),
    });
  };
  parte('Activo', 'activo');
  parte('Pasivo', 'pasivo');
  parte('Patrimonio', 'patrimonio');
  filas.push({
    nivel: 'total',
    etiqueta: 'Total pasivo y patrimonio',
    codigo: null,
    actual: actual.pasivo.total + actual.patrimonio.total,
    ...(comparado && {
      comparado: comparado.pasivo.total + comparado.patrimonio.total,
    }),
  });
  return filas;
}

// ─── Flujo ──────────────────────────────────────────────────────────────────

export function filasFlujo(f: FlujoDirecto): FilaEstado[] {
  const filas: FilaEstado[] = [
    {
      nivel: 'subtotal',
      etiqueta: 'Disponible al empezar',
      codigo: null,
      actual: f.saldoInicial,
    },
  ];
  for (const a of f.actividades) {
    filas.push({
      nivel: 'grupo',
      etiqueta: a.etiqueta,
      codigo: null,
      actual: a.neto,
    });
    for (const r of a.rubros)
      filas.push({
        nivel: 'cuenta',
        etiqueta: r.rubro,
        codigo: null,
        actual: r.valor,
      });
  }
  filas.push(
    {
      nivel: 'subtotal',
      etiqueta: 'Aumento (disminución) del disponible',
      codigo: null,
      actual: f.neto,
    },
    {
      nivel: 'total',
      etiqueta: 'Disponible al terminar',
      codigo: null,
      actual: f.saldoFinal,
    },
  );
  return filas;
}

// ─── Hoja y libro ───────────────────────────────────────────────────────────

/** Variación en porcentaje con un decimal; `null` si el otro es cero. */
export function variacionDe(
  actual: number | null,
  otro: number | null | undefined,
): number | null {
  if (actual === null || otro === null || otro === undefined || otro === 0)
    return null;
  return Math.round(((actual - otro) / Math.abs(otro)) * 1000) / 10;
}

const pesosDe = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : pesos(Math.round(v * 100));

/** Lo que la plantilla pinta: las celdas ya escritas. */
export function hojaEstado(
  filas: FilaEstado[],
  columnas: { actual: string; comparado?: string },
) {
  const compara = columnas.comparado !== undefined;
  return {
    compara,
    columnas,
    filas: filas.map((f) => {
      const v = compara ? variacionDe(f.actual, f.comparado) : null;
      return {
        clase: f.nivel,
        etiqueta: f.etiqueta,
        codigo: f.codigo ?? '',
        actual: pesosDe(f.actual),
        comparado: compara ? pesosDe(f.comparado) : '',
        variacion:
          v === null ? '' : `${v > 0 ? '+' : ''}${v.toLocaleString('es-CO')} %`,
      };
    }),
  };
}

/** El Excel: una fila por renglón, las cifras como números. */
export function libroEstado(
  tipo: TipoEstado,
  filas: FilaEstado[],
  parametros: string[],
  columnas: { actual: string; comparado?: string },
  notas: string[],
): Libro {
  const compara = columnas.comparado !== undefined;
  const nivel: Record<NivelFila, string> = {
    seccion: 'Sección',
    grupo: 'Grupo',
    cuenta: 'Cuenta',
    subtotal: 'Subtotal',
    total: 'Total',
  };
  return {
    titulo: TITULO_ESTADO[tipo],
    parametros,
    resumen: [],
    notas,
    tablas: [
      {
        nombre: TITULO_ESTADO[tipo].slice(0, 31),
        columnas: [
          { titulo: 'Nivel', tipo: 'TEXTO', ancho: 10 },
          { titulo: 'Código', tipo: 'TEXTO', ancho: 10 },
          { titulo: 'Concepto', tipo: 'TEXTO', ancho: 44 },
          { titulo: columnas.actual, tipo: 'DINERO', ancho: 18 },
          ...(compara
            ? [
                {
                  titulo: columnas.comparado!,
                  tipo: 'DINERO' as const,
                  ancho: 18,
                },
                {
                  titulo: 'Variación %',
                  tipo: 'PORCIENTO' as const,
                  ancho: 12,
                },
              ]
            : []),
        ],
        filas: filas.map((f) => [
          nivel[f.nivel],
          f.codigo,
          f.etiqueta,
          f.actual,
          ...(compara
            ? [
                f.comparado ?? null,
                (() => {
                  const v = variacionDe(f.actual, f.comparado);
                  return v === null ? null : v / 100;
                })(),
              ]
            : []),
        ]),
        // Sin fila de totales: las filas son de varios niveles y sumarlas
        // contaría dos veces cada cuenta. Los totales ya vienen como filas.
        conTotales: false,
      },
    ],
  };
}
