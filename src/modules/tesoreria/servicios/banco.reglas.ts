/**
 * El saldo corrido de una cuenta bancaria y la conciliación contra el
 * extracto. Sin base de datos.
 *
 * Los `CHECK` de `0035_bancos.sql` ya sostienen la aritmética de cada fila
 * (`valor > 0`, `fecha_hasta >= fecha_desde`, `ck_extracto_cierre`), pero
 * disparan al COMMIT con un error genérico. Acá se anticipa, para poder
 * señalar qué falta con un mensaje que se entienda — mismo principio que
 * `caja.reglas.ts`, de donde se reusa `redondear`.
 *
 * No reemplaza al `CHECK`: lo anticipa. Si esto y la base discrepan, la
 * base tiene razón.
 */

import { redondear } from './caja.reglas';

/**
 * A diferencia de `caja.reglas.calcularEgreso`, acá NO hay rechazo por
 * negativo: una cuenta bancaria puede tener sobregiro, un cajón de
 * efectivo no — ver `0035_bancos.sql`, `banco_movimiento.saldo_valor` sin
 * `CHECK (>= 0)`.
 */
export function calcularIngresoBanco(
  saldoActual: number,
  valor: number,
): number {
  return redondear(saldoActual + valor);
}

export function calcularEgresoBanco(
  saldoActual: number,
  valor: number,
): number {
  return redondear(saldoActual - valor);
}

/** Una línea de extracto, lo mínimo que hace falta para sumarla. */
export interface LineaExtractoEntrada {
  valor: number;
  tipo: 'DEBITO' | 'CREDITO';
}

/**
 * El saldo final que arrojan las líneas del extracto, partiendo del
 * saldo inicial que dice el banco. `CREDITO` suma, `DEBITO` resta — es
 * la perspectiva del banco sobre la cuenta del cliente, no la nuestra.
 */
export function calcularSaldoExtracto(
  saldoInicial: number,
  lineas: readonly LineaExtractoEntrada[],
): number {
  const suma = lineas.reduce(
    (t, l) => t + (l.tipo === 'CREDITO' ? l.valor : -l.valor),
    saldoInicial,
  );
  return redondear(suma);
}

/**
 * Un movimiento del libro que todavía no se explicó contra el extracto
 * (no está `conciliado`). `direccion` es la que ya decidió el servicio
 * según el `tipo` del movimiento — acá no se vuelve a preguntar cuáles
 * tipos son entrada o salida.
 */
export interface MovimientoPendienteEntrada {
  valor: number;
  direccion: 'ENTRADA' | 'SALIDA';
}

/**
 * El saldo que el banco DEBERÍA mostrar, partiendo del saldo del libro y
 * ajustando por lo que todavía no le llegó — la fórmula clásica de
 * conciliación bancaria. Una salida pendiente (un cheque girado, una
 * transferencia que el banco no ha procesado) ya se restó en el libro
 * pero el banco todavía no la cobra, así que SU saldo sigue más alto que
 * el nuestro por ese valor — se suma de vuelta. Una entrada pendiente
 * (una consignación en tránsito) es al revés — se resta.
 */
export function calcularSaldoBancoEsperado(
  saldoLibro: number,
  pendientes: readonly MovimientoPendienteEntrada[],
): number {
  const ajuste = pendientes.reduce(
    (t, p) => t + (p.direccion === 'SALIDA' ? p.valor : -p.valor),
    0,
  );
  return redondear(saldoLibro + ajuste);
}

export type ResultadoConciliacion =
  { ok: true } | { ok: false; motivo: string };

/**
 * Si un extracto puede cerrar como `CONCILIADO`. Dos cuentas tienen que
 * cuadrar, no una sola:
 *
 *   1. El extracto consigo mismo — sus líneas tienen que sumar al saldo
 *      final que dice el banco, partiendo del inicial.
 *   2. El libro contra el extracto — el saldo corrido de
 *      `banco_movimiento`, ajustado por lo que todavía está pendiente de
 *      conciliar, tiene que dar el mismo saldo final.
 *
 * "Conciliado" exige cuadrar las dos, no solo marcar un estado.
 */
export function verificarConciliacion(datos: {
  saldoInicialBanco: number;
  saldoFinalBanco: number;
  lineas: readonly LineaExtractoEntrada[];
  saldoLibro: number;
  pendientes: readonly MovimientoPendienteEntrada[];
  /**
   * Líneas del extracto que quedan sin cruzar con nota: errores del banco que
   * se le reclaman. El libro no se ajusta por ellas, así que el banco muestra
   * esa diferencia y el saldo esperado la suma.
   */
  porReclamar?: readonly LineaExtractoEntrada[];
}): ResultadoConciliacion {
  const saldoFinalBanco = redondear(datos.saldoFinalBanco);

  const saldoExtractoCalculado = calcularSaldoExtracto(
    datos.saldoInicialBanco,
    datos.lineas,
  );
  if (saldoExtractoCalculado !== saldoFinalBanco) {
    return {
      ok: false,
      motivo:
        `El saldo final del extracto (${saldoFinalBanco}) no cuadra con sus ` +
        `propias líneas: saldo inicial ${redondear(datos.saldoInicialBanco)} ` +
        `más lo digitado da ${saldoExtractoCalculado}.`,
    };
  }

  const saldoBancoEsperado = calcularSaldoExtracto(
    calcularSaldoBancoEsperado(datos.saldoLibro, datos.pendientes),
    datos.porReclamar ?? [],
  );
  if (saldoBancoEsperado !== saldoFinalBanco) {
    return {
      ok: false,
      motivo:
        `El saldo del libro (${redondear(datos.saldoLibro)}) ajustado por ` +
        `las partidas pendientes${datos.porReclamar?.length ? ' y lo que se le reclama al banco' : ''} da ${saldoBancoEsperado}, no los ` +
        `${saldoFinalBanco} que dice el extracto. Revise los movimientos sin conciliar.`,
    };
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Las propuestas de cruce
// -----------------------------------------------------------------------------

/**
 * Cuántos días puede ir el banco antes o después del libro para "fecha
 * cercana": un día antes (se registró tarde con la fecha del día siguiente) y
 * cuatro después (un fin de semana más el canje).
 */
export const DIAS_BANCO_ANTES = 1;
export const DIAS_BANCO_DESPUES = 4;
/** Con la misma referencia se busca más lejos: el cheque que se cobra el mes siguiente. */
export const DIAS_CON_REFERENCIA = 45;

export type CriterioPropuesto = 'REFERENCIA' | 'MISMA_FECHA' | 'FECHA_CERCANA';

/** Una línea del extracto sin cruzar, con lo que hace falta para buscarle pareja. */
export interface LineaParaCruzar {
  id: string;
  fecha: string;
  valor: number;
  tipo: 'DEBITO' | 'CREDITO';
  /** Descripción y referencia del banco, juntas: de ahí salen los números. */
  texto: string;
}

/** Un movimiento del libro sin conciliar. */
export interface MovimientoParaCruzar {
  id: string;
  fecha: string;
  valor: number;
  direccion: 'ENTRADA' | 'SALIDA';
  /** Referencia propia, NIT del tercero, número del documento de origen. */
  referencias: readonly string[];
}

export interface CrucePropuesto {
  lineaId: string;
  movimientoId: string;
  criterio: CriterioPropuesto;
  /** Días del banco respecto al libro: positivo si el banco lo registró después. */
  dias: number;
  /** El número que coincidió, si el criterio es REFERENCIA. */
  referencia: string | null;
}

export interface ResultadoPropuestas {
  propuestas: CrucePropuesto[];
  /** Líneas con más de un candidato igual de bueno: elige una persona. */
  ambiguas: Array<{ lineaId: string; candidatos: string[] }>;
  lineasSueltas: string[];
  movimientosSueltos: string[];
}

/**
 * Los números de un texto que sirven para cruzar: secuencias de 4 dígitos o
 * más, sin ceros a la izquierda. "CHQ 0004512" y "cheque 4512" dan lo mismo;
 * un "15" suelto no, porque coincidiría con cualquier cosa.
 */
export function tokensReferencia(texto: string): string[] {
  const tokens = new Set<string>();
  for (const numero of texto.match(/\d+/g) ?? []) {
    const sinCeros = numero.replace(/^0+/, '');
    if (sinCeros.length >= 4) tokens.add(sinCeros);
  }
  return [...tokens];
}

/** Días de `b` menos `a`, para fechas `AAAA-MM-DD`. */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** El signo que la línea o el movimiento le ponen al saldo de la cuenta. */
function centavosConSigno(valor: number, suma: boolean): number {
  const centavos = Math.round(valor * 100);
  return suma ? centavos : -centavos;
}

interface Candidato {
  lineaId: string;
  movimientoId: string;
  criterio: CriterioPropuesto;
  dias: number;
  referencia: string | null;
  /** Menor es mejor: primero el criterio, después la cercanía. */
  puntaje: number;
}

function evaluar(
  linea: LineaParaCruzar,
  tokensLinea: ReadonlySet<string>,
  movimiento: MovimientoParaCruzar,
  tokensMovimiento: readonly string[],
): Candidato | null {
  const mismoSigno =
    centavosConSigno(linea.valor, linea.tipo === 'CREDITO') ===
    centavosConSigno(movimiento.valor, movimiento.direccion === 'ENTRADA');
  if (!mismoSigno) return null;

  const dias = diasEntre(movimiento.fecha, linea.fecha);
  const base = { lineaId: linea.id, movimientoId: movimiento.id, dias };

  const referencia = tokensMovimiento.find((t) => tokensLinea.has(t));
  if (referencia !== undefined && Math.abs(dias) <= DIAS_CON_REFERENCIA) {
    return {
      ...base,
      criterio: 'REFERENCIA',
      referencia,
      puntaje: Math.abs(dias),
    };
  }
  if (dias === 0) {
    return { ...base, criterio: 'MISMA_FECHA', referencia: null, puntaje: 100 };
  }
  if (dias >= -DIAS_BANCO_ANTES && dias <= DIAS_BANCO_DESPUES) {
    return {
      ...base,
      criterio: 'FECHA_CERCANA',
      referencia: null,
      puntaje: 200 + Math.abs(dias),
    };
  }
  return null;
}

/** El mejor candidato, o `null` si no hay ninguno o si hay empate en el mejor puntaje. */
function mejorUnico(candidatos: readonly Candidato[]): Candidato | null {
  if (candidatos.length === 0) return null;
  const minimo = Math.min(...candidatos.map((c) => c.puntaje));
  const mejores = candidatos.filter((c) => c.puntaje === minimo);
  return mejores.length === 1 ? mejores[0] : null;
}

/**
 * Propone qué línea del extracto va con qué movimiento del libro. Propone, no
 * concilia: lo confirma una persona.
 *
 * Solo uno contra uno, con el mismo valor al centavo y la dirección correcta
 * (un crédito del banco es una entrada del libro). Nunca se propone con valor
 * distinto: una diferencia es otra partida conciliatoria con su propia causa,
 * y se explica aparte — ver la decisión 2 del paso 16.
 *
 * Un par se propone solo si cada uno es el mejor candidato ÚNICO del otro. Si
 * una línea tiene dos movimientos igual de buenos, no se escoge al azar: queda
 * ambigua. Se repite hasta que no salen pares nuevos, porque un par propuesto
 * puede desempatar a otro.
 */
export function proponerCruces(
  lineas: readonly LineaParaCruzar[],
  movimientos: readonly MovimientoParaCruzar[],
): ResultadoPropuestas {
  const tokensLineas = new Map(
    lineas.map((l) => [l.id, new Set(tokensReferencia(l.texto))]),
  );
  const tokensMovimientos = new Map(
    movimientos.map((m) => [m.id, m.referencias.flatMap(tokensReferencia)]),
  );

  let candidatos: Candidato[] = [];
  for (const linea of lineas) {
    for (const movimiento of movimientos) {
      const c = evaluar(
        linea,
        tokensLineas.get(linea.id)!,
        movimiento,
        tokensMovimientos.get(movimiento.id)!,
      );
      if (c !== null) candidatos.push(c);
    }
  }

  const propuestas: CrucePropuesto[] = [];
  for (;;) {
    const nuevos: Candidato[] = [];
    for (const linea of lineas) {
      const deLaLinea = mejorUnico(
        candidatos.filter((c) => c.lineaId === linea.id),
      );
      if (deLaLinea === null) continue;
      const delMovimiento = mejorUnico(
        candidatos.filter((c) => c.movimientoId === deLaLinea.movimientoId),
      );
      if (delMovimiento?.lineaId === linea.id) nuevos.push(deLaLinea);
    }
    if (nuevos.length === 0) break;

    for (const c of nuevos) {
      propuestas.push({
        lineaId: c.lineaId,
        movimientoId: c.movimientoId,
        criterio: c.criterio,
        dias: c.dias,
        referencia: c.referencia,
      });
    }
    const lineasUsadas = new Set(nuevos.map((c) => c.lineaId));
    const movimientosUsados = new Set(nuevos.map((c) => c.movimientoId));
    candidatos = candidatos.filter(
      (c) =>
        !lineasUsadas.has(c.lineaId) && !movimientosUsados.has(c.movimientoId),
    );
  }

  const lineasPropuestas = new Set(propuestas.map((p) => p.lineaId));
  const movimientosPropuestos = new Set(propuestas.map((p) => p.movimientoId));

  const ambiguas = lineas
    .filter((l) => !lineasPropuestas.has(l.id))
    .map((l) => ({
      lineaId: l.id,
      candidatos: candidatos
        .filter((c) => c.lineaId === l.id)
        .sort((a, b) => a.puntaje - b.puntaje)
        .map((c) => c.movimientoId),
    }))
    .filter((a) => a.candidatos.length > 0);
  const lineasAmbiguas = new Set(ambiguas.map((a) => a.lineaId));

  return {
    propuestas,
    ambiguas,
    lineasSueltas: lineas
      .filter((l) => !lineasPropuestas.has(l.id) && !lineasAmbiguas.has(l.id))
      .map((l) => l.id),
    movimientosSueltos: movimientos
      .filter((m) => !movimientosPropuestos.has(m.id))
      .map((m) => m.id),
  };
}

/** El motivo de una propuesta, en palabras, para la pantalla. */
export function describirCruce(c: CrucePropuesto): string {
  const cuando =
    c.dias === 0
      ? 'el mismo día'
      : c.dias > 0
        ? `${c.dias} día${c.dias === 1 ? '' : 's'} después`
        : `${-c.dias} día${c.dias === -1 ? '' : 's'} antes`;
  if (c.criterio === 'REFERENCIA') {
    return `Mismo valor y la referencia ${c.referencia}, ${cuando}`;
  }
  if (c.criterio === 'MISMA_FECHA') return 'Mismo valor y la misma fecha';
  return `Mismo valor, ${cuando}`;
}

// -----------------------------------------------------------------------------
// El grupo de conciliación
// -----------------------------------------------------------------------------

/**
 * Si unas líneas explican unos movimientos: las dos sumas con signo tienen que
 * ser iguales al centavo. `diferencia` es lo que dice el banco menos lo que
 * dice el libro — negativa si el banco sacó más (una comisión que falta
 * registrar), positiva si abonó más.
 */
export function verificarGrupo(
  lineas: readonly LineaExtractoEntrada[],
  movimientos: readonly MovimientoPendienteEntrada[],
): { cuadra: boolean; diferencia: number } {
  const banco = lineas.reduce(
    (t, l) => t + centavosConSigno(l.valor, l.tipo === 'CREDITO'),
    0,
  );
  const libro = movimientos.reduce(
    (t, m) => t + centavosConSigno(m.valor, m.direccion === 'ENTRADA'),
    0,
  );
  const diferencia = (banco - libro) / 100;
  return { cuadra: banco === libro, diferencia };
}

// -----------------------------------------------------------------------------
// Las reglas del extracto
// -----------------------------------------------------------------------------

export interface ReglaParaReconocer {
  id: string;
  palabras: readonly string[];
  tipoLinea: 'DEBITO' | 'CREDITO';
}

/** Mayúsculas, sin tildes, y todo lo que no sea letra o número como espacio. */
function normalizarTexto(texto: string): string {
  return ` ${texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Qué líneas reconoce cada regla: una línea es de la regla si es del mismo tipo
 * y su descripción contiene alguna de las palabras COMPLETA — "GMF" reconoce
 * "IMPTO GMF 4X1000" pero no "PAGMF". Si dos reglas la reconocen, gana la
 * primera: las reglas llegan ordenadas.
 */
export function reconocerPorReglas(
  lineas: ReadonlyArray<{
    id: string;
    tipo: 'DEBITO' | 'CREDITO';
    descripcion: string;
  }>,
  reglas: readonly ReglaParaReconocer[],
): Map<string, string[]> {
  const porRegla = new Map<string, string[]>();
  const palabras = reglas.map((r) => ({
    regla: r,
    palabras: r.palabras.map(normalizarTexto),
  }));

  for (const linea of lineas) {
    const texto = normalizarTexto(linea.descripcion);
    const encontrada = palabras.find(
      ({ regla, palabras: ps }) =>
        regla.tipoLinea === linea.tipo && ps.some((p) => texto.includes(p)),
    );
    if (encontrada === undefined) continue;
    const lista = porRegla.get(encontrada.regla.id) ?? [];
    lista.push(linea.id);
    porRegla.set(encontrada.regla.id, lista);
  }
  return porRegla;
}

/**
 * El corte de un día: con cuánto amaneció la cuenta, qué entró, qué salió y
 * con cuánto cerró. Si alguien leyó el saldo en el portal del banco, la
 * diferencia contra el libro —positiva si el banco dice más—.
 *
 * La diferencia no es un error que haya que ajustar: casi siempre es algo
 * que el banco ya registró y el libro todavía no (el 4×1000, una
 * transferencia que entró tarde), o al revés. La explica la conciliación.
 */
export function armarCorte(
  saldoAnterior: number,
  entradas: number,
  salidas: number,
  saldoBanco?: number,
): {
  saldoAnterior: number;
  entradas: number;
  salidas: number;
  saldoFinal: number;
  saldoBanco: number | null;
  diferencia: number | null;
} {
  const saldoFinal = redondear(saldoAnterior + entradas - salidas);
  return {
    saldoAnterior: redondear(saldoAnterior),
    entradas: redondear(entradas),
    salidas: redondear(salidas),
    saldoFinal,
    saldoBanco: saldoBanco === undefined ? null : redondear(saldoBanco),
    diferencia:
      saldoBanco === undefined ? null : redondear(saldoBanco - saldoFinal),
  };
}

/**
 * Qué impide que una cuenta bancaria (o billetera) lleve esta cuenta
 * contable, o `null`. Tiene que estar activa, recibir asientos y ser de
 * bancos (1110) o de cuentas de ahorro (1120).
 */
export function problemaCuentaDeBanco(cuenta: {
  codigo: string;
  activa: boolean;
  esAuxiliar: boolean;
}): string | null {
  if (!cuenta.activa)
    return `La cuenta ${cuenta.codigo} está inactiva. Actívela en Plan de cuentas.`;
  if (!cuenta.esAuxiliar)
    return `La cuenta ${cuenta.codigo} agrupa otras y no recibe asientos: elija uno de sus auxiliares o cree uno.`;
  if (!cuenta.codigo.startsWith('1110') && !cuenta.codigo.startsWith('1120'))
    return `Una cuenta bancaria va en una cuenta de 1110 (bancos) o 1120 (cuentas de ahorro); la ${cuenta.codigo} no lo es.`;
  return null;
}

/** «Bancos - Bancolombia ···1234»: el nombre del auxiliar de una cuenta bancaria. */
export function nombreDelAuxiliar(banco: string, numero: string): string {
  const ultimos = numero.replace(/\D/g, '').slice(-4);
  return `Bancos - ${banco.trim()}${ultimos ? ` ···${ultimos}` : ''}`;
}
