/**
 * Pagos al exterior (R-D14, Fase 8, §8.15): lo que el motor dice y prepara
 * alrededor del cálculo, sin tocar la base.
 */

/**
 * El aviso de un pago al exterior. Con un convenio disponible, el botón
 * «Aplicar convenio» del renglón es el camino: el aviso lo dice y no manda al
 * contador. Sin él, dice dónde se carga el certificado.
 */
export function avisoPagoExterior(hayConvenio: boolean): string {
  return hayConvenio
    ? 'Pago al exterior: retengo la tarifa del Estatuto (art. 408). El proveedor tiene certificado de residencia de un país con convenio: si el pago es intereses o regalías, aplicá el convenio en el renglón y la tarifa baja.'
    : 'Pago al exterior: retengo la tarifa del Estatuto (art. 408). Si el proveedor es de un país con convenio, cargá su certificado de residencia fiscal en sus datos tributarios: la tarifa puede ser menor.';
}

/**
 * Las subcuentas de retefuente (2365xx) que hay que crear para poder
 * practicar las retenciones de renta calculadas: las de los conceptos que la
 * empresa no tiene enlazados a ninguna cuenta, si es agente de renta.
 *
 * Solo subcuentas de seis dígitos bajo la 2365: el decreto las numera, y así
 * se crean igual que las que trae el plan sugerido. El enlace al concepto lo
 * hace el trigger de 0076 al aparecer la cuenta.
 */
export function subcuentasPorCrear(
  retenciones: Array<{
    cuentaId: string | null;
    subcuentaPasivo: string | null;
  }>,
  empresaEsAgente: boolean,
): string[] {
  if (!empresaEsAgente) return [];
  return [
    ...new Set(
      retenciones
        .filter((r) => r.cuentaId === null)
        .flatMap((r) =>
          r.subcuentaPasivo !== null && /^2365\d{2}$/.test(r.subcuentaPasivo)
            ? [r.subcuentaPasivo]
            : [],
        ),
    ),
  ].sort();
}

/**
 * La subcuenta de IVA retenido que crea el sistema: la misma que propone el
 * plan sugerido (`libre('2367', '05')` en `plan-cuentas.reglas.ts`).
 */
export const SUBCUENTA_IVA_RETENIDO = '236705';

/**
 * La subcuenta de IVA retenido (2367) que hay que crear para poder practicar
 * la ReteIVA calculada, o `null` si no hace falta (bug #17).
 *
 * El plan sugerido solo la propone al agente de retención de IVA y al gran
 * contribuyente. Pero cualquier responsable de IVA que contrata servicios con
 * alguien del exterior retiene el IVA al 100 % (art. 437-2 num. 3 ET) y la
 * necesita: si el motor calculó una ReteIVA y ningún concepto de IVA tiene
 * cuenta, se crea sola, igual que la 236550 de renta. No depende de ser
 * agente: si el motor la calculó, la ley ya dijo que se retiene. El enlace al
 * concepto lo hace el trigger de 0076 al aparecer la cuenta.
 */
export function subcuentaIvaPorCrear(
  retenciones: Array<{ cuentaId: string | null }>,
): string | null {
  return retenciones.some((r) => r.cuentaId === null)
    ? SUBCUENTA_IVA_RETENIDO
    : null;
}
