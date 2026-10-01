-- =============================================================================
-- 0078 — Consola de plataforma: vigencias nuevas de la ley de retenciones
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 0 (§0.8 y R-D7).
--
-- Las tarifas y la UVT son de todos y ninguna empresa las escribe (0075 le
-- quitó la UVT a `gestion_app`). Las carga un superadministrador desde la
-- consola, con la norma y quién la validó, y **nunca se edita una vigencia**:
-- se cierra la anterior y se abre la nueva en la misma transacción. Cada carga
-- queda en la bitácora de la plataforma.

ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
  CHECK (accion IN (
    'CREAR_CUENTA',
    'CREAR_EMPRESA',
    'CREAR_USUARIO',
    'CAMBIAR_ESTADO',
    'CAMBIAR_PLAN',
    'AJUSTAR_CUPOS',
    'RENOMBRAR_CUENTA',
    'RESTABLECER_PASSWORD',
    'DESACTIVAR_USUARIO',
    'REACTIVAR_USUARIO',
    'EDITAR_PLAN',
    'CAMBIAR_SUSCRIPCION',
    'REGISTRAR_PAGO',
    'PAUSAR_IA',
    'REANUDAR_IA',
    'PUBLICAR_ANUNCIO',
    'RETIRAR_ANUNCIO',
    'DESACTIVAR_ADMIN',
    'REACTIVAR_ADMIN',
    'RESTABLECER_ADMIN',
    'CARGAR_TARIFA_RETENCION',
    'CARGAR_UVT'
  ));
