-- =============================================================================
-- 0088 — Recálculo de retenciones por cambio de norma
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 6 (§6.3). R-D6: el
-- recálculo produce diferencias y cada una se corrige con un ajuste que aprueba
-- una persona. Nunca toca un asiento ni una retención registrada.
--
-- 1. `retencion_documento_entrada`: lo que el motor recibió al confirmar una
--    compra —renglones, ZOMAC, tarjeta, municipios— y el concepto que quedó en
--    cada renglón. La compra no guarda todo eso, y sin ello recalcular sería
--    adivinar. Con esto, recalcular es correr el mismo motor con la misma
--    entrada y la norma nueva (R3).
-- 2. `retencion_recalculo`: cada corrida de la consola (quién, cuándo, qué
--    rango, por qué norma). Es de la plataforma: sin RLS.
-- 3. `retencion_recalculo_diferencia`: lo que cambió, por compra y retención,
--    en cada empresa (con RLS). Una persona la ajusta o la descarta.

-- -----------------------------------------------------------------------------
-- 1. retencion_documento_entrada
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_documento_entrada (
  empresa_id      uuid        NOT NULL REFERENCES empresa (id),
  documento_tipo  text        NOT NULL CHECK (documento_tipo IN ('COMPRA')),
  documento_id    uuid        NOT NULL,
  -- `DocumentoRenta` tal cual lo recibió el motor.
  entrada         jsonb       NOT NULL CHECK (jsonb_typeof(entrada) = 'object'),
  -- El concepto que quedó en cada renglón: `{ conceptos: [{ orden, conceptoCodigo }] }`.
  respuestas      jsonb       NOT NULL CHECK (jsonb_typeof(respuestas) = 'object'),
  motor_version   text        NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, documento_tipo, documento_id)
);

ALTER TABLE retencion_documento_entrada ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_documento_entrada FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_retencion_entrada_aislada ON retencion_documento_entrada
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
-- Solo inserción: la entrada de un documento registrado no cambia.
GRANT SELECT, INSERT ON retencion_documento_entrada TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 2. retencion_recalculo — cada corrida, de la plataforma
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_recalculo (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  desde           date        NOT NULL,
  hasta           date        NOT NULL,
  -- NULL = todas las empresas.
  empresa_id      uuid        REFERENCES empresa (id),
  motivo          text        NOT NULL CHECK (length(btrim(motivo)) > 0),
  creado_por      uuid        NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  -- Cifras de la corrida: documentos, diferencias, los que no se pudieron.
  resumen         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ck_recalculo_rango CHECK (hasta >= desde)
);

COMMENT ON TABLE retencion_recalculo IS
  'Cada recálculo de retenciones por cambio de norma, lanzado desde la consola. Plan motor de retenciones, Fase 6.';

-- La empresa lee de qué recálculo salió su diferencia (el motivo); solo la
-- consola crea corridas.
GRANT SELECT ON retencion_recalculo TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON retencion_recalculo TO gestion_provision;

-- -----------------------------------------------------------------------------
-- 3. retencion_recalculo_diferencia — lo que cambió, por empresa
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_recalculo_diferencia (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid          NOT NULL REFERENCES empresa (id),
  recalculo_id          uuid          NOT NULL REFERENCES retencion_recalculo (id),
  documento_tipo        text          NOT NULL CHECK (documento_tipo IN ('COMPRA')),
  documento_id          uuid          NOT NULL,
  tercero_id            uuid          NOT NULL,
  fecha_causacion       date          NOT NULL,
  impuesto              text          NOT NULL CHECK (impuesto IN ('RENTA', 'IVA', 'ICA')),
  concepto_nacional_id  uuid          NOT NULL REFERENCES retencion_concepto_nacional (id),
  municipio_codigo      char(5),
  -- La retención registrada que cambia; NULL si antes no se retenía nada.
  retencion_id          uuid          REFERENCES retencion_calculada (id),
  base                  numeric(18,2) NOT NULL,
  valor_antes           numeric(18,2) NOT NULL,
  valor_nuevo           numeric(18,2) NOT NULL,
  diferencia            numeric(18,2) NOT NULL CHECK (diferencia <> 0),
  tarifa_antes          numeric(8,6),
  tarifa_nueva          numeric(8,6),
  explicacion           jsonb         NOT NULL,
  estado                text          NOT NULL DEFAULT 'PENDIENTE'
                          CHECK (estado IN ('PENDIENTE', 'AJUSTADA', 'DESCARTADA')),
  motivo                text,
  asiento_id            uuid,
  retencion_ajuste_id   uuid          REFERENCES retencion_calculada (id),
  resuelta_por          uuid,
  resuelta_en           timestamptz,
  creado_en             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_diferencia_diferencia CHECK (diferencia = valor_nuevo - valor_antes),
  -- Pendiente = nadie la tocó; ajustada = tiene su asiento; descartada = motivo.
  CONSTRAINT ck_diferencia_resuelta CHECK (
       (estado = 'PENDIENTE'  AND resuelta_en IS NULL AND asiento_id IS NULL)
    OR (estado = 'AJUSTADA'   AND resuelta_en IS NOT NULL AND asiento_id IS NOT NULL
                              AND retencion_ajuste_id IS NOT NULL)
    OR (estado = 'DESCARTADA' AND resuelta_en IS NOT NULL
                              AND length(btrim(coalesce(motivo, ''))) > 0)
  )
);

-- Una sola diferencia pendiente por retención de un documento: un recálculo
-- nuevo descarta la anterior antes de dejar la suya.
CREATE UNIQUE INDEX ux_diferencia_pendiente
  ON retencion_recalculo_diferencia (
       empresa_id, documento_id, impuesto, concepto_nacional_id, COALESCE(municipio_codigo, ''))
  WHERE estado = 'PENDIENTE';
CREATE INDEX ix_diferencia_recalculo ON retencion_recalculo_diferencia (recalculo_id);

ALTER TABLE retencion_recalculo_diferencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_recalculo_diferencia FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_retencion_diferencia_aislada ON retencion_recalculo_diferencia
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON retencion_recalculo_diferencia TO gestion_app, gestion_provision;
-- Lo único que cambia de una diferencia es cómo se resolvió.
GRANT UPDATE (estado, motivo, asiento_id, retencion_ajuste_id, resuelta_por, resuelta_en)
  ON retencion_recalculo_diferencia TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 4. La bitácora de la consola admite el recálculo
-- -----------------------------------------------------------------------------
ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
  CHECK (accion IN (
    'CREAR_CUENTA', 'CREAR_EMPRESA', 'CREAR_USUARIO', 'CAMBIAR_ESTADO',
    'CAMBIAR_PLAN', 'AJUSTAR_CUPOS', 'RENOMBRAR_CUENTA', 'RESTABLECER_PASSWORD',
    'DESACTIVAR_USUARIO', 'REACTIVAR_USUARIO', 'EDITAR_PLAN', 'CAMBIAR_SUSCRIPCION',
    'REGISTRAR_PAGO', 'PAUSAR_IA', 'REANUDAR_IA', 'PUBLICAR_ANUNCIO',
    'RETIRAR_ANUNCIO', 'DESACTIVAR_ADMIN', 'REACTIVAR_ADMIN', 'RESTABLECER_ADMIN',
    'CARGAR_TARIFA_RETENCION', 'CARGAR_UVT', 'CARGAR_PARAMETRO_ICA',
    'CARGAR_AUTORRETENCION', 'RECALCULAR_RETENCIONES'));
