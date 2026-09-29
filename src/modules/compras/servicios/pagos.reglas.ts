/**
 * Pagos: reglas puras.
 *
 * Lo que toca la base está en `comprobante-egreso.service.ts`.
 * Plan: `docs/planes/plan-integracion-menu-nuevo.md`, Fase 4.
 */

/** Sin vencimiento pactado, la compra vence a los 30 días (la misma convención de la cartera). */
export const DIAS_PARA_VENCER = 30;

const MS_DIA = 86_400_000;

export type TramoPago =
  'VENCIDO' | 'ESTA_SEMANA' | 'PROXIMA_SEMANA' | 'RESTO_MES' | 'DESPUES';

export const TRAMOS: TramoPago[] = [
  'VENCIDO',
  'ESTA_SEMANA',
  'PROXIMA_SEMANA',
  'RESTO_MES',
  'DESPUES',
];

/** Cuándo vence: la fecha pactada o, sin ella, la fecha más 30 días. */
export function venceEfectivo(fecha: string, vence: string | null): string {
  if (vence !== null) return vence;
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + DIAS_PARA_VENCER * MS_DIA)
    .toISOString()
    .slice(0, 10);
}

const dia = (s: string) => Date.parse(`${s}T00:00:00Z`);

/**
 * En qué tramo cae lo que vence, visto desde `hoy`. La semana va de lunes a
 * domingo; «resto del mes» es hasta fin de mes, o hasta fin del mes
 * siguiente si la próxima semana ya lo cruza.
 */
export function tramoDe(vence: string, hoy: string): TramoPago {
  if (vence < hoy) return 'VENCIDO';
  const h = dia(hoy);
  const diaSemana = (new Date(h).getUTCDay() + 6) % 7; // lunes = 0
  const finSemana = h + (6 - diaSemana) * MS_DIA;
  const finProxima = finSemana + 7 * MS_DIA;
  const d = new Date(h);
  const finMes = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  const p = new Date(finProxima);
  const finTramo =
    finMes > finProxima
      ? finMes
      : Date.UTC(p.getUTCFullYear(), p.getUTCMonth() + 1, 0);
  const v = dia(vence);
  if (v <= finSemana) return 'ESTA_SEMANA';
  if (v <= finProxima) return 'PROXIMA_SEMANA';
  if (v <= finTramo) return 'RESTO_MES';
  return 'DESPUES';
}

/** `EG-000077`. EG y no CE: «CE-» ya es la numeración de los asientos de egreso. */
export function numeroComprobante(numero: number): string {
  return `EG-${String(numero).padStart(6, '0')}`;
}

/**
 * El descuento por pronto pago que corresponde si se paga hoy: el porcentaje
 * sobre lo que se debe, al peso, si todavía está en plazo. Es una propuesta:
 * la persona lo puede cambiar.
 */
export function descuentoSugerido(
  pendiente: number,
  pct: number | null,
  hasta: string | null,
  fecha: string,
): number {
  if (pct === null || hasta === null || fecha > hasta || pendiente <= 0)
    return 0;
  return Math.round((pendiente * pct) / 100);
}

export interface AplicacionPago {
  compraId: string;
  valor: number;
  descuento?: number;
}

const centavos = (v: number | undefined) => Math.round((v ?? 0) * 100);

/**
 * Lo que se puede validar sin la base: ninguna compra dos veces, cada
 * renglón con algo, y algo de plata que salga (abonos o anticipo).
 */
export function validarComprobante(
  aplicaciones: AplicacionPago[],
  anticipo = 0,
): { ok: true } | { ok: false; motivo: string } {
  if (aplicaciones.length === 0 && centavos(anticipo) === 0) {
    return {
      ok: false,
      motivo:
        'El comprobante tiene que pagar al menos una compra o entregar un anticipo.',
    };
  }
  const vistas = new Set<string>();
  let plata = centavos(anticipo);
  for (const a of aplicaciones) {
    if (vistas.has(a.compraId)) {
      return {
        ok: false,
        motivo: 'Una compra aparece dos veces: juntá los dos pagos en uno.',
      };
    }
    vistas.add(a.compraId);
    if (centavos(a.valor) < 0 || centavos(a.descuento) < 0) {
      return { ok: false, motivo: 'Los valores no pueden ser negativos.' };
    }
    if (centavos(a.valor) + centavos(a.descuento) === 0) {
      return {
        ok: false,
        motivo: 'Cada compra del comprobante necesita un pago o un descuento.',
      };
    }
    plata += centavos(a.valor);
  }
  if (plata <= 0) {
    return {
      ok: false,
      motivo:
        'El comprobante no saca plata: el descuento se aplica cuando se paga.',
    };
  }
  return { ok: true };
}
