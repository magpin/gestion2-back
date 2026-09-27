-- =============================================================================
-- 0081 — Perfil tributario del tercero: la ficha lo escribe directo
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 1 (§1.4).
--
-- Hasta la 0080 el perfil se sincronizaba desde las columnas de `tercero` con
-- un trigger: cambiar la ficha cerraba la versión vigente ayer y abría una
-- desde hoy. Con eso no se puede decir «es autorretenedor desde el 15 de
-- septiembre», que es lo que dice su resolución.
--
-- Desde ahora la sección «Datos tributarios» escribe el perfil con su fecha, y
-- las columnas de `tercero` se actualizan para que lo demás del sistema siga
-- leyendo lo vigente. Mientras lo hace, marca la sesión
-- (`app.perfil_directo = on`) y el trigger no abre otra versión encima.
-- El resto de caminos que tocan `tercero` siguen sincronizando como antes.

CREATE OR REPLACE FUNCTION fn_tercero_sincroniza_perfil() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  vigente tercero_perfil_tributario%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('app.perfil_directo', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO tercero_perfil_tributario
      (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
       es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
       vigencia_desde, fuente)
    VALUES
      (NEW.empresa_id, NEW.id, NEW.tipo_persona,
       CASE WHEN NEW.regimen_simple THEN 'SIMPLE' ELSE 'ORDINARIO' END,
       NEW.declarante_renta, NEW.responsable_iva, NEW.es_gran_contribuyente,
       NEW.es_autorretenedor, current_date, 'MANUAL');
    RETURN NEW;
  END IF;

  IF (NEW.tipo_persona, NEW.regimen_simple, NEW.declarante_renta, NEW.responsable_iva,
      NEW.es_gran_contribuyente, NEW.es_autorretenedor)
     IS NOT DISTINCT FROM
     (OLD.tipo_persona, OLD.regimen_simple, OLD.declarante_renta, OLD.responsable_iva,
      OLD.es_gran_contribuyente, OLD.es_autorretenedor) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO vigente
    FROM tercero_perfil_tributario
   WHERE empresa_id = NEW.empresa_id AND tercero_id = NEW.id AND vigencia_hasta IS NULL
   FOR UPDATE;

  IF FOUND AND vigente.vigencia_desde = current_date THEN
    UPDATE tercero_perfil_tributario
       SET tipo_persona = NEW.tipo_persona,
           regimen_renta = CASE WHEN NEW.regimen_simple THEN 'SIMPLE' ELSE 'ORDINARIO' END,
           declarante_renta = NEW.declarante_renta,
           es_responsable_iva = NEW.responsable_iva,
           es_gran_contribuyente = NEW.es_gran_contribuyente,
           es_autorretenedor_renta = NEW.es_autorretenedor
     WHERE id = vigente.id;
    RETURN NEW;
  END IF;

  IF FOUND THEN
    UPDATE tercero_perfil_tributario
       SET vigencia_hasta = current_date - 1
     WHERE id = vigente.id;
  END IF;

  INSERT INTO tercero_perfil_tributario
    (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
     es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
     es_entidad_publica, es_agente_ret_renta, es_autorretenedor_especial,
     es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
     ciiu_principal, ciiu_secundarios, vigencia_desde, fuente)
  VALUES
    (NEW.empresa_id, NEW.id, NEW.tipo_persona,
     CASE WHEN NEW.regimen_simple THEN 'SIMPLE' ELSE 'ORDINARIO' END,
     NEW.declarante_renta, NEW.responsable_iva, NEW.es_gran_contribuyente,
     NEW.es_autorretenedor,
     COALESCE(vigente.es_entidad_publica, false), COALESCE(vigente.es_agente_ret_renta, false),
     COALESCE(vigente.es_autorretenedor_especial, false), COALESCE(vigente.es_agente_ret_iva, false),
     vigente.agente_iva_numeral, COALESCE(vigente.es_zomac, false), vigente.zomac_tamano,
     vigente.ciiu_principal, vigente.ciiu_secundarios, current_date, 'MANUAL');
  RETURN NEW;
END;
$$;
