-- =============================================================================
-- 0098 — Los datos tributarios del tercero viven solo en su perfil
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 7 (limpieza).
--
-- Desde la 0075 el perfil con historia (`tercero_perfil_tributario`) es lo que
-- lee el motor, y un trigger lo sincronizaba desde las columnas viejas de
-- `tercero` mientras el código siguiera escribiéndolas. Ya no: la ficha del
-- tercero escribe el perfil y lee el vigente. Se van las columnas y el trigger.
--
-- «Agente retenedor» de la ficha nunca pasó al perfil (el trigger no lo
-- copiaba). Antes de borrarlo, el que lo tenga marcado y su perfil no lo diga
-- abre una versión desde hoy con `es_agente_ret_renta`, como lo habría hecho el
-- trigger con cualquier otro dato.

DROP TRIGGER tg_tercero_sincroniza_perfil ON tercero;
DROP FUNCTION fn_tercero_sincroniza_perfil();

-- La versión vigente que empezó hoy se corrige; la de antes se cierra ayer.
UPDATE tercero_perfil_tributario p
   SET es_agente_ret_renta = true
  FROM tercero t
 WHERE t.id = p.tercero_id AND t.es_agente_retenedor
   AND p.vigencia_hasta IS NULL AND NOT p.es_agente_ret_renta
   AND p.vigencia_desde = current_date;

WITH cerradas AS (
  UPDATE tercero_perfil_tributario p
     SET vigencia_hasta = current_date - 1
    FROM tercero t
   WHERE t.id = p.tercero_id AND t.es_agente_retenedor
     AND p.vigencia_hasta IS NULL AND NOT p.es_agente_ret_renta
     AND p.vigencia_desde < current_date
  RETURNING p.*
)
INSERT INTO tercero_perfil_tributario
  (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
   es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
   es_entidad_publica, es_agente_ret_renta, es_autorretenedor_especial,
   es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
   ciiu_principal, ciiu_secundarios, vigencia_desde, fuente)
SELECT empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
       es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
       es_entidad_publica, true, es_autorretenedor_especial,
       es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
       ciiu_principal, ciiu_secundarios, current_date, 'MIGRACION'
  FROM cerradas;

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0098', 'COLUMNAS_TERCERO_RETIRADAS',
       jsonb_build_object('agente_retenedor_al_perfil',
         (SELECT count(*) FROM tercero WHERE es_agente_retenedor));

ALTER TABLE tercero
  DROP COLUMN responsable_iva,
  DROP COLUMN es_agente_retenedor,
  DROP COLUMN es_autorretenedor,
  DROP COLUMN es_gran_contribuyente,
  DROP COLUMN regimen_simple,
  DROP COLUMN declarante_renta;
