/**
 * Cartera y recibo de caja: reglas puras.
 *
 * Lo que toca la base está en `recibo-caja.service.ts`.
 * Plan: `docs/planes/plan-integracion-menu-nuevo.md`, Fase 3.
 */

/**
 * Sin fecha de vencimiento pactada, una factura vence a los 30 días de
 * emitida. Es la misma convención de «Antigüedad de cartera» y «Ventas por
 * cliente» (`DIAS_PARA_VENCER` en reportes): dos pantallas que llamen
 * «vencida» a cosas distintas es peor que no tener ninguna.
 */
export const DIAS_PARA_VENCER = 30;

export type EdadCartera =
  'POR_VENCER' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_MAS';

export const EDADES: EdadCartera[] = [
  'POR_VENCER',
  'D1_30',
  'D31_60',
  'D61_90',
  'D90_MAS',
];

const MS_DIA = 86_400_000;

/** Días de `desde` a `hasta`, las dos `aaaa-mm-dd`. Negativo si `hasta` va antes. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) /
      MS_DIA,
  );
}

/** Cuándo vence: la fecha pactada o, sin ella, la fecha más el plazo asumido. */
export function venceEfectivo(fecha: string, vence: string | null): string {
  if (vence !== null) return vence;
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + DIAS_PARA_VENCER * MS_DIA)
    .toISOString()
    .slice(0, 10);
}

/** Días vencidos a `hoy`; cero o negativo si todavía no vence. */
export function diasVencidos(
  fecha: string,
  vence: string | null,
  hoy: string,
): number {
  return diasEntre(venceEfectivo(fecha, vence), hoy);
}

export function edadDe(dias: number): EdadCartera {
  if (dias <= 0) return 'POR_VENCER';
  if (dias <= 30) return 'D1_30';
  if (dias <= 60) return 'D31_60';
  if (dias <= 90) return 'D61_90';
  return 'D90_MAS';
}

/** `RC-000128`. */
export function numeroRecibo(numero: number): string {
  return `RC-${String(numero).padStart(6, '0')}`;
}

export interface AplicacionPedida {
  facturaId: string;
  /** Lo que se abona en plata. Puede ser cero si el renglón es solo descuento. */
  valor: number;
  /** El descuento por pronto pago que se le concede a esta factura. */
  descuento?: number;
}

export type ResultadoRecibo =
  | {
      ok: true;
      /** Lo que el cliente pagó en plata: abonos más anticipo. */
      total: number;
      /** Lo que entra a la caja o al banco: el total menos la comisión. */
      neto: number;
    }
  | { ok: false; motivo: string };

const centavos = (v: number | undefined) => Math.round((v ?? 0) * 100);

/**
 * Lo que se puede validar sin la base: ninguna factura dos veces, cada
 * renglón con algo (plata o descuento), algo de plata en el recibo, y una
 * comisión menor que lo que entró. Que cada abono quepa en el saldo de su
 * factura lo valida el cobro de siempre, factura por factura.
 */
export function validarRecibo(
  aplicaciones: AplicacionPedida[],
  anticipo = 0,
  comision = 0,
): ResultadoRecibo {
  if (aplicaciones.length === 0 && centavos(anticipo) === 0) {
    return {
      ok: false,
      motivo:
        'El recibo tiene que abonar al menos una factura o dejar un anticipo.',
    };
  }
  const vistas = new Set<string>();
  let plata = centavos(anticipo);
  for (const a of aplicaciones) {
    if (vistas.has(a.facturaId)) {
      return {
        ok: false,
        motivo:
          'Una factura aparece dos veces en el recibo: juntá los dos abonos en uno.',
      };
    }
    vistas.add(a.facturaId);
    if (centavos(a.valor) < 0 || centavos(a.descuento) < 0) {
      return { ok: false, motivo: 'Los valores no pueden ser negativos.' };
    }
    if (centavos(a.valor) + centavos(a.descuento) === 0) {
      return {
        ok: false,
        motivo: 'Cada factura del recibo necesita un abono o un descuento.',
      };
    }
    plata += centavos(a.valor);
  }
  if (plata <= 0) {
    return {
      ok: false,
      motivo:
        'El recibo no registra plata: un descuento solo se concede cuando el cliente paga.',
    };
  }
  if (centavos(comision) < 0 || centavos(comision) >= plata) {
    return {
      ok: false,
      motivo: 'La comisión tiene que ser menor que lo que entró.',
    };
  }
  return {
    ok: true,
    total: plata / 100,
    neto: (plata - centavos(comision)) / 100,
  };
}
