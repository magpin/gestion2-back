import type { EntityManager } from 'typeorm';

import type { CtxPlataforma } from '../../../common/ctx';

/** Las acciones que admite el CHECK de `plataforma_bitacora` (0011 y 0055). */
export type AccionBitacora =
  | 'CREAR_CUENTA'
  | 'CREAR_EMPRESA'
  | 'CREAR_USUARIO'
  | 'CAMBIAR_ESTADO'
  | 'CAMBIAR_PLAN'
  | 'AJUSTAR_CUPOS'
  | 'RENOMBRAR_CUENTA'
  | 'RESTABLECER_PASSWORD'
  | 'DESACTIVAR_USUARIO'
  | 'REACTIVAR_USUARIO'
  | 'EDITAR_PLAN'
  | 'CAMBIAR_SUSCRIPCION'
  | 'REGISTRAR_PAGO'
  | 'PAUSAR_IA'
  | 'REANUDAR_IA'
  | 'PUBLICAR_ANUNCIO'
  | 'RETIRAR_ANUNCIO'
  | 'DESACTIVAR_ADMIN'
  | 'REACTIVAR_ADMIN'
  | 'RESTABLECER_ADMIN'
  | 'CARGAR_TARIFA_RETENCION'
  | 'CARGAR_UVT'
  | 'CARGAR_PARAMETRO_ICA'
  | 'CARGAR_AUTORRETENCION'
  | 'RECALCULAR_RETENCIONES';

/**
 * El rastro solo agrega. Un registro que se puede reescribir no sirve.
 *
 * Va dentro de la misma transacción que el cambio: si el cambio no queda, el
 * rastro tampoco, y al revés. **Nunca lleva una contraseña**, ni siquiera la
 * que se acaba de generar.
 *
 * `admin` null es el sistema: la mora automática no tiene quién la firme.
 */
export async function registrar(
  t: EntityManager,
  admin: CtxPlataforma | null,
  accion: AccionBitacora,
  tenantId: string | null,
  detalle: Record<string, unknown>,
): Promise<void> {
  await t.query(
    `INSERT INTO plataforma_bitacora (admin_id, accion, tenant_id, detalle)
     VALUES ($1, $2, $3, $4)`,
    [admin?.adminId ?? null, accion, tenantId, JSON.stringify(detalle)],
  );
}

/** Una fecha de la base como ISO, o null. */
export const iso = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString()
      : new Date(
          typeof v === 'string' || typeof v === 'number' ? v : NaN,
        ).toISOString();
