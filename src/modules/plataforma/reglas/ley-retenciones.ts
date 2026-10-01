/**
 * Cómo entra una vigencia nueva de la ley de retenciones (plan motor de
 * retenciones, Fase 0, §0.8 y R-D7).
 *
 * **Nunca se edita una vigencia.** Una factura de marzo se explica con la
 * tarifa que regía en marzo, y reescribirla cambia lo que ya se liquidó. Lo que
 * se hace es cerrar la que está abierta el día antes de que empiece la nueva, y
 * abrir la nueva — en la misma transacción.
 *
 * Separado del acceso a datos para poder probarlo sin base.
 */

export interface VigenciaExistente {
  id: string;
  desde: string;
  hasta: string | null;
}

export type Plan =
  | { ok: true; cerrar: { id: string; hasta: string } | null }
  | { ok: false; motivo: string };

/** `YYYY-MM-DD` del día anterior. */
export function diaAnterior(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Las vigencias existentes son las de la **misma fila de la ley**: mismo
 * concepto, mismo tipo de persona y misma condición de declarante.
 */
export function planearVigencia(
  existentes: VigenciaExistente[],
  nueva: { desde: string; hasta: string | null },
): Plan {
  if (nueva.hasta !== null && nueva.hasta < nueva.desde) {
    return { ok: false, motivo: '«Hasta» no puede ser antes de «desde».' };
  }

  const posterior = existentes.find((v) => v.desde >= nueva.desde);
  if (posterior !== undefined) {
    return {
      ok: false,
      motivo: `Ya hay una vigencia que empieza el ${posterior.desde}. Una vigencia no se reescribe: si cambió, cargue la que sigue desde después.`,
    };
  }

  const abierta = existentes.find((v) => v.hasta === null);
  if (abierta !== undefined) {
    return {
      ok: true,
      cerrar: { id: abierta.id, hasta: diaAnterior(nueva.desde) },
    };
  }

  const cruzada = existentes.find(
    (v) => v.hasta !== null && v.hasta >= nueva.desde,
  );
  if (cruzada !== undefined) {
    return {
      ok: false,
      motivo: `Se cruza con la vigencia del ${cruzada.desde} al ${cruzada.hasta}.`,
    };
  }

  return { ok: true, cerrar: null };
}
