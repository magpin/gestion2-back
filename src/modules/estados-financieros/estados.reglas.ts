/**
 * Estados financieros: reglas puras. Entran saldos y movimientos por cuenta
 * PUC, salen las estructuras que pinta la pantalla y el PDF. Así se prueban
 * con números a mano, sin base.
 *
 * Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 7. El estado de
 * resultados viene del paquete de Claude Design (`estado-resultados.ts`),
 * con el detalle por cuenta y el GMF donde lo decidió D8 (511595, operacional).
 */

export interface MovimientoCuenta {
  codigo: string;
  nombre: string;
  debito: number;
  credito: number;
}

export interface CuentaValor {
  codigo: string;
  nombre: string;
  valor: number;
}

export interface Renglon {
  clave: string;
  etiqueta: string;
  valor: number;
  tipo: 'grupo' | 'subtotal' | 'total';
  /** El detalle por cuenta, de mayor a menor. Solo en los grupos. */
  cuentas?: CuentaValor[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

const empieza = (codigo: string, prefijos: string[]) =>
  prefijos.some((p) => codigo.startsWith(p));

/** El detalle de un grupo: una fila por cuenta, en su naturaleza, sin ceros. */
function cuentasDe(
  movs: MovimientoCuenta[],
  prefijos: string[],
  naturaleza: 'D' | 'C',
): CuentaValor[] {
  return movs
    .filter((m) => empieza(m.codigo, prefijos))
    .map((m) => ({
      codigo: m.codigo,
      nombre: m.nombre,
      valor: r2(
        naturaleza === 'C' ? m.credito - m.debito : m.debito - m.credito,
      ),
    }))
    .filter((c) => c.valor !== 0)
    .sort((a, b) => b.valor - a.valor);
}

const suma = (cuentas: CuentaValor[]) =>
  r2(cuentas.reduce((t, c) => t + c.valor, 0));

export interface EstadoResultados {
  renglones: Renglon[];
  ingresosOperacionales: number;
  utilidadBruta: number;
  utilidadOperacional: number;
  utilidadAntesDeImpuestos: number;
  utilidadNeta: number;
}

/**
 * El estado de resultados de un período, de los movimientos de las clases 4
 * a 7:
 *
 *   41   Ingresos operacionales       (crédito)
 *   6, 7 Costo de ventas y producción (débito)
 *   51   Gastos de administración     (débito)
 *   52   Gastos de ventas             (débito)
 *   42   Ingresos no operacionales    (crédito)
 *   53   Gastos no operacionales      (débito)
 *   54   Impuesto de renta            (débito)
 */
export function estadoDeResultados(movs: MovimientoCuenta[]): EstadoResultados {
  const grupo = (
    clave: string,
    etiqueta: string,
    prefijos: string[],
    naturaleza: 'D' | 'C',
  ): Renglon => {
    const cuentas = cuentasDe(movs, prefijos, naturaleza);
    return { clave, etiqueta, valor: suma(cuentas), tipo: 'grupo', cuentas };
  };
  const ingresosOp = grupo(
    'ingresos_op',
    'Ingresos operacionales',
    ['41'],
    'C',
  );
  const costo = grupo('costo', 'Costo de ventas', ['6', '7'], 'D');
  const admin = grupo('admin', 'Gastos de administración', ['51'], 'D');
  const ventas = grupo('ventas', 'Gastos de ventas', ['52'], 'D');
  const ingNoOp = grupo('ing_no_op', 'Ingresos no operacionales', ['42'], 'C');
  const gasNoOp = grupo('gas_no_op', 'Gastos no operacionales', ['53'], 'D');
  const renta = grupo('renta', 'Impuesto de renta', ['54'], 'D');

  const bruta = r2(ingresosOp.valor - costo.valor);
  const operacional = r2(bruta - admin.valor - ventas.valor);
  const antes = r2(operacional + ingNoOp.valor - gasNoOp.valor);
  const neta = r2(antes - renta.valor);

  const renglones: Renglon[] = [
    ingresosOp,
    costo,
    {
      clave: 'bruta',
      etiqueta: 'Utilidad bruta',
      valor: bruta,
      tipo: 'subtotal',
    },
    admin,
    ventas,
    {
      clave: 'operacional',
      etiqueta: 'Utilidad operacional',
      valor: operacional,
      tipo: 'subtotal',
    },
    ingNoOp,
    gasNoOp,
    {
      clave: 'antes',
      etiqueta: 'Utilidad antes de impuestos',
      valor: antes,
      tipo: 'total',
    },
  ];
  if (renta.valor !== 0) {
    renglones.push(renta, {
      clave: 'neta',
      etiqueta: 'Utilidad neta',
      valor: neta,
      tipo: 'total',
    });
  }
  return {
    renglones,
    ingresosOperacionales: ingresosOp.valor,
    utilidadBruta: bruta,
    utilidadOperacional: operacional,
    utilidadAntesDeImpuestos: antes,
    utilidadNeta: neta,
  };
}

/** Margen sobre los ingresos operacionales, en porcentaje con un decimal. */
export function margen(valor: number, ingresos: number): number | null {
  if (ingresos === 0) return null;
  return Math.round((valor / ingresos) * 1000) / 10;
}

/** Variación en porcentaje con un decimal; `null` si el anterior es cero. */
export function variacion(actual: number, anterior: number): number | null {
  if (anterior === 0) return null;
  return Math.round(((actual - anterior) / Math.abs(anterior)) * 1000) / 10;
}

// ─── Balance general ────────────────────────────────────────────────────────

/** Los grupos del PUC (Decreto 2650) que nombran los renglones del balance. */
const NOMBRE_GRUPO: Record<string, string> = {
  '11': 'Disponible',
  '12': 'Inversiones',
  '13': 'Deudores',
  '14': 'Inventarios',
  '15': 'Propiedades, planta y equipo',
  '16': 'Intangibles',
  '17': 'Diferidos',
  '18': 'Otros activos',
  '19': 'Valorizaciones',
  '21': 'Obligaciones financieras',
  '22': 'Proveedores',
  '23': 'Cuentas por pagar',
  '24': 'Impuestos, gravámenes y tasas',
  '25': 'Obligaciones laborales',
  '26': 'Pasivos estimados y provisiones',
  '27': 'Diferidos',
  '28': 'Otros pasivos',
  '29': 'Bonos y papeles comerciales',
  '31': 'Capital social',
  '32': 'Superávit de capital',
  '33': 'Reservas',
  '34': 'Revalorización del patrimonio',
  '35': 'Dividendos o participaciones decretados',
  '36': 'Resultados del ejercicio',
  '37': 'Resultados de ejercicios anteriores',
  '38': 'Superávit por valorizaciones',
};

export interface SaldoCuenta {
  codigo: string;
  nombre: string;
  /** Débitos menos créditos acumulados al corte. */
  saldo: number;
}

export interface RenglonBalance {
  grupo: string;
  etiqueta: string;
  valor: number;
  cuentas: CuentaValor[];
}

export interface SeccionBalance {
  etiqueta: string;
  total: number;
  renglones: RenglonBalance[];
}

export interface BalanceGeneral {
  activo: { total: number; secciones: SeccionBalance[] };
  pasivo: { total: number; secciones: SeccionBalance[] };
  patrimonio: { total: number; secciones: SeccionBalance[] };
  /** Activo menos pasivo y patrimonio: cero si el libro cuadra. */
  diferencia: number;
}

function seccion(
  etiqueta: string,
  saldos: SaldoCuenta[],
  grupos: string[],
  naturaleza: 'D' | 'C',
): SeccionBalance {
  const renglones = grupos
    .map((g) => {
      const cuentas = saldos
        .filter((s) => s.codigo.startsWith(g))
        .map((s) => ({
          codigo: s.codigo,
          nombre: s.nombre,
          valor: r2(naturaleza === 'D' ? s.saldo : -s.saldo),
        }))
        .filter((c) => c.valor !== 0)
        .sort((a, b) => a.codigo.localeCompare(b.codigo));
      return {
        grupo: g,
        etiqueta: NOMBRE_GRUPO[g] ?? g,
        valor: suma(cuentas),
        cuentas,
      };
    })
    .filter((r) => r.cuentas.length > 0);
  return {
    etiqueta,
    total: r2(renglones.reduce((t, r) => t + r.valor, 0)),
    renglones,
  };
}

const rango = (desde: number, hasta: number, clase: string) =>
  Array.from({ length: hasta - desde + 1 }, (_, i) => `${clase}${desde + i}`);

/**
 * El balance general al corte. Activo en su naturaleza débito; pasivo y
 * patrimonio, crédito. Mientras no haya asiento de cierre, lo que ganó o
 * perdió la empresa sigue en las clases 4 a 7: entra al patrimonio como
 * resultado del ejercicio (el año del corte) y de ejercicios anteriores.
 */
export function balanceGeneral(
  saldos: SaldoCuenta[],
  resultados: { ejercicio: number; anteriores: number },
): BalanceGeneral {
  const activoCorriente = seccion(
    'Activo corriente',
    saldos,
    rango(1, 4, '1'),
    'D',
  );
  const activoNoCorriente = seccion(
    'Activo no corriente',
    saldos,
    rango(5, 9, '1'),
    'D',
  );
  const pasivoCorriente = seccion(
    'Pasivo corriente',
    saldos,
    rango(1, 6, '2'),
    'C',
  );
  const pasivoNoCorriente = seccion(
    'Pasivo no corriente',
    saldos,
    rango(7, 9, '2'),
    'C',
  );
  const capital = seccion('Patrimonio', saldos, rango(1, 8, '3'), 'C');

  // Los resultados sin cerrar, como renglones del patrimonio.
  const sinCerrar: RenglonBalance[] = [];
  if (r2(resultados.ejercicio) !== 0) {
    sinCerrar.push({
      grupo: '36*',
      etiqueta: 'Resultado del ejercicio (sin cerrar)',
      valor: r2(resultados.ejercicio),
      cuentas: [],
    });
  }
  if (r2(resultados.anteriores) !== 0) {
    sinCerrar.push({
      grupo: '37*',
      etiqueta: 'Resultados de ejercicios anteriores (sin cerrar)',
      valor: r2(resultados.anteriores),
      cuentas: [],
    });
  }
  capital.renglones.push(...sinCerrar);
  capital.total = r2(capital.renglones.reduce((t, r) => t + r.valor, 0));

  const activo = r2(activoCorriente.total + activoNoCorriente.total);
  const pasivo = r2(pasivoCorriente.total + pasivoNoCorriente.total);
  const secciones = (s: SeccionBalance[]) =>
    s.filter((x) => x.renglones.length > 0);
  return {
    activo: {
      total: activo,
      secciones: secciones([activoCorriente, activoNoCorriente]),
    },
    pasivo: {
      total: pasivo,
      secciones: secciones([pasivoCorriente, pasivoNoCorriente]),
    },
    patrimonio: { total: capital.total, secciones: secciones([capital]) },
    diferencia: r2(activo - pasivo - capital.total),
  };
}

/** Lo que ganó o perdió: créditos menos débitos de las clases 4 a 7. */
export function resultadoDe(saldos: SaldoCuenta[]): number {
  return r2(
    -saldos
      .filter((s) => /^[4-7]/.test(s.codigo))
      .reduce((t, s) => t + s.saldo, 0),
  );
}

// ─── Flujo de caja directo ──────────────────────────────────────────────────

export type Actividad = 'OPERACION' | 'INVERSION' | 'FINANCIACION';

export const NOMBRE_ACTIVIDAD: Record<Actividad, string> = {
  OPERACION: 'Actividades de operación',
  INVERSION: 'Actividades de inversión',
  FINANCIACION: 'Actividades de financiación',
};

/** Una línea de un asiento que mueve caja o bancos, que no es de las cuentas 11. */
export interface Contrapartida {
  codigo: string;
  /** Débito menos crédito. */
  neto: number;
  concepto: { nombre: string; tipoFlujo: Actividad } | null;
}

export interface AsientoDeCaja {
  /** Lo que entró (positivo) o salió (negativo) de caja y bancos. */
  netoCaja: number;
  contrapartidas: Contrapartida[];
}

/** Por la cuenta contraria, cuando el asiento no trae concepto. El orden importa: gana el primero. */
const RUBROS_POR_CUENTA: Array<[string, Actividad, string]> = [
  ['1305', 'OPERACION', 'Cobros a clientes'],
  ['2805', 'OPERACION', 'Anticipos de clientes'],
  ['2205', 'OPERACION', 'Pagos a proveedores'],
  ['1330', 'OPERACION', 'Anticipos a proveedores'],
  ['2365', 'OPERACION', 'Retenciones pagadas'],
  ['2367', 'OPERACION', 'Retenciones pagadas'],
  ['2368', 'OPERACION', 'Retenciones pagadas'],
  ['2370', 'OPERACION', 'Nómina y aportes'],
  ['2380', 'OPERACION', 'Nómina y aportes'],
  ['25', 'OPERACION', 'Nómina y aportes'],
  ['24', 'OPERACION', 'Impuestos'],
  ['41', 'OPERACION', 'Ventas de contado'],
  ['42', 'OPERACION', 'Otros ingresos'],
  ['5', 'OPERACION', 'Gastos pagados'],
  ['6', 'OPERACION', 'Costos pagados'],
  ['7', 'OPERACION', 'Costos pagados'],
  ['14', 'OPERACION', 'Compras de inventario'],
  ['21', 'FINANCIACION', 'Obligaciones financieras'],
  ['3', 'FINANCIACION', 'Socios y patrimonio'],
  ['12', 'INVERSION', 'Inversiones'],
  ['15', 'INVERSION', 'Propiedades, planta y equipo'],
  ['16', 'INVERSION', 'Intangibles'],
  ['17', 'INVERSION', 'Diferidos'],
];

/**
 * A qué actividad y rubro va un asiento que movió caja. Primero su concepto
 * —lo que la persona eligió dice mejor qué fue—; si no hay, la cuenta
 * contraria más grande. Lo que no encaja va a «Sin clasificar».
 */
export function clasificar(a: AsientoDeCaja): {
  actividad: Actividad;
  rubro: string;
} {
  const mayor = (xs: Contrapartida[]) =>
    [...xs].sort((x, y) => Math.abs(y.neto) - Math.abs(x.neto))[0];
  const conConcepto = a.contrapartidas.filter((c) => c.concepto !== null);
  if (conConcepto.length > 0) {
    const c = mayor(conConcepto).concepto!;
    return { actividad: c.tipoFlujo, rubro: c.nombre };
  }
  const principal = mayor(a.contrapartidas);
  if (principal !== undefined) {
    const regla = RUBROS_POR_CUENTA.find(([p]) =>
      principal.codigo.startsWith(p),
    );
    if (regla) return { actividad: regla[1], rubro: regla[2] };
  }
  return { actividad: 'OPERACION', rubro: 'Sin clasificar' };
}

export interface ActividadFlujo {
  actividad: Actividad;
  etiqueta: string;
  entradas: number;
  salidas: number;
  neto: number;
  rubros: Array<{ rubro: string; valor: number }>;
}

export interface FlujoDirecto {
  saldoInicial: number;
  actividades: ActividadFlujo[];
  neto: number;
  saldoFinal: number;
  /** Lo que no se pudo explicar: saldo final del libro menos inicial más neto. Cero si cuadra. */
  diferencia: number;
}

/**
 * El flujo de caja por el método directo: cada asiento que movió caja o
 * bancos, a su actividad. Un traslado entre caja y banco no cambia el total
 * (sus dos lados son cuentas 11) y no aparece.
 */
export function flujoDirecto(
  asientos: AsientoDeCaja[],
  saldoInicial: number,
  saldoFinalLibro: number,
): FlujoDirecto {
  const porActividad = new Map<Actividad, Map<string, number>>();
  for (const a of asientos) {
    if (r2(a.netoCaja) === 0) continue;
    const { actividad, rubro } = clasificar(a);
    const rubros = porActividad.get(actividad) ?? new Map<string, number>();
    rubros.set(rubro, (rubros.get(rubro) ?? 0) + a.netoCaja);
    porActividad.set(actividad, rubros);
  }
  const orden: Actividad[] = ['OPERACION', 'INVERSION', 'FINANCIACION'];
  const actividades = orden
    .filter((act) => porActividad.has(act))
    .map((act) => {
      const rubros = [...porActividad.get(act)!.entries()]
        .map(([rubro, valor]) => ({ rubro, valor: r2(valor) }))
        .filter((x) => x.valor !== 0)
        .sort((x, y) => y.valor - x.valor);
      const entradas = r2(
        rubros.filter((x) => x.valor > 0).reduce((t, x) => t + x.valor, 0),
      );
      const salidas = r2(
        -rubros.filter((x) => x.valor < 0).reduce((t, x) => t + x.valor, 0),
      );
      return {
        actividad: act,
        etiqueta: NOMBRE_ACTIVIDAD[act],
        entradas,
        salidas,
        neto: r2(entradas - salidas),
        rubros,
      };
    });
  const neto = r2(actividades.reduce((t, a) => t + a.neto, 0));
  return {
    saldoInicial: r2(saldoInicial),
    actividades,
    neto,
    saldoFinal: r2(saldoFinalLibro),
    diferencia: r2(saldoFinalLibro - saldoInicial - neto),
  };
}

// ─── Flujo de caja proyectado ───────────────────────────────────────────────

export interface Compromiso {
  fecha: string;
  valor: number;
}

export interface SemanaProyectada {
  /** Lunes de la semana, o `null` para lo ya vencido. */
  desde: string | null;
  hasta: string | null;
  etiqueta: string;
  entradas: number;
  salidas: number;
  /** Con lo que quedaría la empresa al final de esa semana. */
  saldo: number;
}

const DIA = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (fecha: string) => Date.parse(`${fecha}T00:00:00Z`);

/** El lunes de la semana de `fecha`. */
export function lunesDe(fecha: string): string {
  const d = new Date(ms(fecha));
  const dia = (d.getUTCDay() + 6) % 7; // lunes = 0
  return iso(ms(fecha) - dia * DIA);
}

/**
 * Lo que va a entrar y salir en las próximas semanas: lo que falta cobrar,
 * lo que falta pagar y lo programado, cada uno en la semana en que vence. Lo
 * ya vencido va aparte, al principio: es plata que ya debió moverse.
 */
export function flujoProyectado(input: {
  hoy: string;
  disponible: number;
  porCobrar: Compromiso[];
  porPagar: Compromiso[];
  semanas: number;
}): SemanaProyectada[] {
  const lunes = lunesDe(input.hoy);
  const indice = (fecha: string) =>
    fecha < input.hoy ? -1 : Math.floor((ms(fecha) - ms(lunes)) / (7 * DIA));
  const entradas = new Array<number>(input.semanas + 1).fill(0);
  const salidas = new Array<number>(input.semanas + 1).fill(0);
  const poner = (xs: Compromiso[], destino: number[]) => {
    for (const x of xs) {
      const i = indice(x.fecha);
      if (i >= input.semanas) continue;
      destino[i + 1] += x.valor;
    }
  };
  poner(input.porCobrar, entradas);
  poner(input.porPagar, salidas);

  let saldo = input.disponible;
  const fmt = (f: string) => {
    const [, m, d] = f.split('-');
    return `${Number(d)}/${Number(m)}`;
  };
  return entradas.map((_, i) => {
    saldo = r2(saldo + entradas[i] - salidas[i]);
    if (i === 0) {
      return {
        desde: null,
        hasta: null,
        etiqueta: 'Vencido',
        entradas: r2(entradas[0]),
        salidas: r2(salidas[0]),
        saldo,
      };
    }
    const desde = iso(ms(lunes) + (i - 1) * 7 * DIA);
    const hasta = iso(ms(desde) + 6 * DIA);
    return {
      desde,
      hasta,
      etiqueta: i === 1 ? 'Esta semana' : `${fmt(desde)} – ${fmt(hasta)}`,
      entradas: r2(entradas[i]),
      salidas: r2(salidas[i]),
      saldo,
    };
  });
}

// ─── Períodos ───────────────────────────────────────────────────────────────

/** Del mes «2026-09»: el primer día, el último, y el mes de antes. */
export function mesDe(mes: string): {
  desde: string;
  hasta: string;
  anterior: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (m === null) throw new Error(`Mes inválido: ${mes}`);
  const anio = Number(m[1]);
  const n = Number(m[2]);
  const ultimo = new Date(Date.UTC(anio, n, 0)).getUTCDate();
  const anterior =
    n === 1 ? `${anio - 1}-12` : `${anio}-${String(n - 1).padStart(2, '0')}`;
  return {
    desde: `${mes}-01`,
    hasta: `${mes}-${String(ultimo).padStart(2, '0')}`,
    anterior,
  };
}

/** Los `n` meses que terminan en `mes`, del más viejo al más nuevo. */
export function mesesHasta(mes: string, n: number): string[] {
  const salida: string[] = [mes];
  while (salida.length < n) salida.unshift(mesDe(salida[0]).anterior);
  return salida;
}

// ─── Por centro de costo ────────────────────────────────────────────────────

/** Un movimiento de cuenta de resultado con el centro de costo de sus líneas. */
export interface MovimientoConCentro extends MovimientoCuenta {
  /** `null`: líneas sin centro (lo anterior a encenderlos, D7). */
  centroId: string | null;
}

export type TipoCentro = 'PRODUCTIVO' | 'APOYO' | 'ADMINISTRATIVO';

export interface CentroDeColumna {
  id: string;
  codigo: string;
  nombre: string;
  tipo: TipoCentro;
}

export interface ColumnaResultados {
  /** El id del centro, el tipo (`PRODUCTIVO`…) o `SIN_CENTRO`. */
  clave: string;
  nombre: string;
  estado: EstadoResultados;
}

const NOMBRE_TIPO: Record<TipoCentro, string> = {
  PRODUCTIVO: 'Productivos',
  APOYO: 'De apoyo',
  ADMINISTRATIVO: 'Administrativos',
};

/**
 * El estado de resultados en columnas: una por centro (o por tipo de centro),
 * «Sin centro» si hay líneas sin él, y el total. La suma de las columnas es
 * el total, renglón por renglón: cada movimiento cae en una sola columna.
 *
 * Las columnas van en el orden de `centros` (o productivos, de apoyo y
 * administrativos), y solo las que tienen movimiento.
 */
export function resultadosPorCentro(
  movs: MovimientoConCentro[],
  centros: CentroDeColumna[],
  agrupar: 'CENTRO' | 'TIPO',
): { columnas: ColumnaResultados[]; total: EstadoResultados } {
  const centroPorId = new Map(centros.map((c) => [c.id, c]));
  const claveDe = (m: MovimientoConCentro): string => {
    const centro =
      m.centroId === null ? undefined : centroPorId.get(m.centroId);
    // Un centro que no viene en la lista no tiene columna: va a «Sin centro»
    // y la suma sigue dando el total. El servicio manda todos, activos o no.
    if (centro === undefined) return 'SIN_CENTRO';
    return agrupar === 'CENTRO' ? centro.id : centro.tipo;
  };
  const grupos = new Map<string, MovimientoCuenta[]>();
  for (const m of movs) {
    const clave = claveDe(m);
    grupos.set(clave, [
      ...(grupos.get(clave) ?? []),
      {
        codigo: m.codigo,
        nombre: m.nombre,
        debito: m.debito,
        credito: m.credito,
      },
    ]);
  }

  const orden: Array<{ clave: string; nombre: string }> =
    agrupar === 'CENTRO'
      ? centros.map((c) => ({
          clave: c.id,
          nombre: `${c.codigo} · ${c.nombre}`,
        }))
      : (Object.keys(NOMBRE_TIPO) as TipoCentro[]).map((t) => ({
          clave: t,
          nombre: NOMBRE_TIPO[t],
        }));
  orden.push({ clave: 'SIN_CENTRO', nombre: 'Sin centro' });

  const columnas = orden
    .filter((o) => grupos.has(o.clave))
    .map((o) => ({
      clave: o.clave,
      nombre: o.nombre,
      estado: estadoDeResultados(grupos.get(o.clave)!),
    }));
  return {
    columnas,
    total: estadoDeResultados(
      movs.map((m) => ({
        codigo: m.codigo,
        nombre: m.nombre,
        debito: m.debito,
        credito: m.credito,
      })),
    ),
  };
}
