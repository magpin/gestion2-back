-- =============================================================================
-- 0084 — Autorretenciones y lo que retienen los clientes
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 4.
--
-- 1. `retencion_autorretencion_ciiu`: la tarifa de autorretención especial de
--    renta por la actividad principal (art. 1.2.6.8 DUR, modificado por el
--    Decreto 572 de 2025). Es ley: sin RLS, la aplicación solo lee y la carga
--    la consola con su norma. **Sin semilla**: la especificación cita la norma
--    pero no trae la tabla de tarifas, y no se inventa.
-- 2. El concepto `AUTORRETENCION_ESPECIAL` en el catálogo de la ley, para que
--    lo autorretenido quede en `retencion_calculada` como todo lo demás. Su
--    cuenta es la 236575 (autorretenciones) y su anticipo la 135515.
-- 3. `venta_documento.retencion_aviso`: lo que el motor encontró al facturar
--    —el cliente retuvo distinto de lo que dice la norma, falta una tarifa—.
--    Queda escrito en la factura, no solo en pantalla.

CREATE TABLE retencion_autorretencion_ciiu (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  ciiu            varchar(8)    NOT NULL,
  -- Fracción: 0.008 es 0,8 %.
  tarifa          numeric(8,6)  NOT NULL CHECK (tarifa >= 0 AND tarifa <= 0.1),
  vigencia_desde  date          NOT NULL,
  vigencia_hasta  date,
  norma           text          NOT NULL CHECK (length(btrim(norma)) > 0),
  validado_por    text          NOT NULL,
  validado_en     date          NOT NULL,
  creado_en       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_autorretencion_vigencia CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT ex_autorretencion_sin_solape EXCLUDE USING gist (
    ciiu WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);

GRANT SELECT ON retencion_autorretencion_ciiu TO gestion_app;
REVOKE INSERT, UPDATE, DELETE ON retencion_autorretencion_ciiu FROM gestion_app;
GRANT SELECT, INSERT, UPDATE ON retencion_autorretencion_ciiu TO gestion_provision;

INSERT INTO retencion_concepto_nacional
  (codigo, nombre, impuesto, usa_declarante, usa_acumulado_anual, umbral_acumulado_uvt,
   base_es_iva, subcuenta_pasivo, subcuenta_activo)
VALUES
  ('AUTORRETENCION_ESPECIAL', 'Autorretención especial de renta', 'RENTA',
   false, false, NULL, false, '236575', '135515')
ON CONFLICT (codigo) DO NOTHING;

-- Los enlaces de las empresas que ya tienen la 236575 o la 135515 (0076).
SELECT fn_retencion_enlaza(e.id) FROM empresa e;

ALTER TABLE venta_documento ADD COLUMN retencion_aviso text;

ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
  CHECK (accion IN (
    'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
    'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
    'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
    'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
    'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN',
    'CARGAR_TARIFA_RETENCION', 'CARGAR_UVT', 'CARGAR_PARAMETRO_ICA',
    'CARGAR_AUTORRETENCION'));
