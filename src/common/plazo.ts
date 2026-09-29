/**
 * El vence de un documento a crédito desde el plazo del tercero (Fase 7 de las
 * pantallas complementarias, PC25): la fecha más los días. Sin plazo, `null`,
 * y Cobros y Pagos cuentan 30 días como siempre.
 */
export function venceDesdePlazo(
  fecha: string,
  dias: number | null | undefined,
): string | null {
  if (dias === null || dias === undefined) return null;
  const ms = Date.parse(`${fecha}T00:00:00Z`) + dias * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Los días de plazo del tercero en un rol, o `null`. Solo se consulta cuando
 * hace falta: un documento a crédito que no trae su vence.
 */
export async function diasDePlazo(
  t: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  terceroId: string,
  rol: 'cliente' | 'proveedor',
): Promise<number | null> {
  const r = await t.query(
    `SELECT dias_plazo_${rol} AS dias FROM tercero WHERE id = $1`,
    [terceroId],
  );
  const f = Array.isArray(r)
    ? (r[0] as { dias?: number | null } | undefined)
    : undefined;
  return f?.dias ?? null;
}
