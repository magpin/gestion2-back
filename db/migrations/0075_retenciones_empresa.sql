-- =============================================================================
-- 0075 — Retenciones: lo de cada empresa, enlazado a la ley
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 0 (§0.3 y §0.4).
--
-- Tres cosas, y ninguna toca un dato registrado:
--
-- 1. `retencion_concepto` (0043) deja de ser un catálogo que cada contador
--    digita con tarifas: pasa a ser el enlace «concepto de la ley → cuenta de
--    esta empresa». Lo que ya se cargó a mano se enlaza por código; lo que no
--    tenga equivalente queda marcado para que la configuración lo pregunte una
--    sola vez. Sus columnas de tarifa se conservan para lo histórico.
-- 2. `compra_retencion` (0031) solo aceptaba 6 conceptos viejos, pero el
--    catálogo guarda códigos libres: una compra manual con un concepto que no
--    se llamara exactamente así fallaba en la base. Se quita esa restricción.
-- 3. Los datos tributarios del tercero pasan a tener historia
--    (`tercero_perfil_tributario`): un proveedor que pasa al SIMPLE en julio no
--    cambia las facturas de marzo. Una sola verdad durante la transición: hoy
--    el código todavía escribe en las columnas de `tercero`, así que un trigger
--    lleva cada cambio de esas columnas al perfil (cierra la versión vigente y
--    abre otra). Cuando la ficha escriba el perfil directo (Fase 1), el sentido
--    se invierte, y en la Fase 7 se retiran las columnas viejas.

-- -----------------------------------------------------------------------------
-- 1. retencion_concepto → enlace con la ley
-- -----------------------------------------------------------------------------
ALTER TABLE retencion_concepto
  ADD COLUMN concepto_nacional_id uuid REFERENCES retencion_concepto_nacional (id),
  ADD COLUMN sin_equivalente      boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN retencion_concepto.concepto_nacional_id IS
  'El concepto de la ley al que corresponde. La tarifa sale de retencion_tarifa, no de esta fila.';
COMMENT ON COLUMN retencion_concepto.sin_equivalente IS
  'Cargado a mano antes del motor y sin equivalente claro en la ley: la configuración lo pregunta una vez.';

-- Equivalencias por código (normalizado) y, para IVA e ICA, por tipo.
UPDATE retencion_concepto rc
   SET concepto_nacional_id = n.id
  FROM retencion_concepto_nacional n
 WHERE n.codigo = CASE
         WHEN rc.tipo = 'ICA' THEN 'RETEICA'
         WHEN upper(btrim(rc.codigo)) IN ('COMPRAS', 'COMPRAS_GENERALES')      THEN 'COMPRAS_GENERALES'
         WHEN upper(btrim(rc.codigo)) IN ('SERVICIOS', 'SERVICIOS_GENERALES')  THEN 'SERVICIOS_GENERALES'
         WHEN upper(btrim(rc.codigo)) = 'HONORARIOS'                           THEN 'HONORARIOS'
         WHEN upper(btrim(rc.codigo)) = 'COMISIONES'                           THEN 'COMISIONES'
         WHEN upper(btrim(rc.codigo)) IN ('ARRENDAMIENTOS', 'ARREND_INMUEBLES') THEN 'ARREND_INMUEBLES'
         WHEN upper(btrim(rc.codigo)) IN ('OTROS', 'OTROS_INGRESOS')           THEN 'OTROS_INGRESOS'
         -- Un código que ya es el de la ley se enlaza tal cual.
         ELSE upper(btrim(rc.codigo))
       END;

UPDATE retencion_concepto
   SET sin_equivalente = true
 WHERE concepto_nacional_id IS NULL;

-- Los enlaces que crea el sistema no llevan año ni tarifa: la tarifa sale de
-- la ley a la fecha de cada documento. Las columnas viejas quedan opcionales
-- (las filas cargadas a mano conservan lo suyo, para lo histórico).
ALTER TABLE retencion_concepto
  ALTER COLUMN anio           DROP NOT NULL,
  ALTER COLUMN tarifa         DROP NOT NULL,
  ALTER COLUMN base_minima_uvt DROP NOT NULL;

-- Un solo enlace activo por concepto de la ley en cada empresa.
CREATE UNIQUE INDEX ux_retencion_concepto_nacional
  ON retencion_concepto (empresa_id, concepto_nacional_id)
  WHERE activo AND concepto_nacional_id IS NOT NULL AND anio IS NULL;

-- La UVT ya no la escribe cada empresa: es de todos y la valida un contador
-- desde la consola de plataforma (R-D7).
REVOKE INSERT, UPDATE ON uvt FROM gestion_app;

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0075', 'CONCEPTOS_ENLAZADOS',
       jsonb_build_object(
         'enlazados',       count(*) FILTER (WHERE concepto_nacional_id IS NOT NULL),
         'sin_equivalente', count(*) FILTER (WHERE sin_equivalente))
  FROM retencion_concepto;

-- -----------------------------------------------------------------------------
-- 2. compra_retencion: fuera la lista de 6 conceptos
-- -----------------------------------------------------------------------------
ALTER TABLE compra_retencion DROP CONSTRAINT compra_retencion_concepto_check;

-- -----------------------------------------------------------------------------
-- 3. Perfil tributario del tercero, con historia
-- -----------------------------------------------------------------------------
CREATE TABLE tercero_perfil_tributario (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id                  uuid        NOT NULL REFERENCES empresa (id),
  tercero_id                  uuid        NOT NULL,

  tipo_persona                text        NOT NULL CHECK (tipo_persona IN ('NATURAL', 'JURIDICA')),

  -- Renta
  regimen_renta               text        NOT NULL DEFAULT 'ORDINARIO'
                                CHECK (regimen_renta IN ('ORDINARIO', 'SIMPLE', 'NO_CONTRIBUYENTE', 'REGIMEN_ESPECIAL')),
  declarante_renta            boolean     NOT NULL DEFAULT true,

  -- IVA
  es_responsable_iva          boolean     NOT NULL DEFAULT false,

  -- Calidades: se superponen a cualquier régimen, no son una escalera.
  es_gran_contribuyente       boolean     NOT NULL DEFAULT false,
  es_entidad_publica          boolean     NOT NULL DEFAULT false,
  es_agente_ret_renta         boolean     NOT NULL DEFAULT false,
  es_autorretenedor_renta     boolean     NOT NULL DEFAULT false,
  es_autorretenedor_especial  boolean     NOT NULL DEFAULT false,
  es_agente_ret_iva           boolean     NOT NULL DEFAULT false,
  agente_iva_numeral          smallint,

  -- ZOMAC: sin categoría informada en la factura se aplica la tarifa plena.
  es_zomac                    boolean     NOT NULL DEFAULT false,
  zomac_tamano                text        CHECK (zomac_tamano IS NULL OR zomac_tamano IN ('MICRO', 'PEQUENA', 'MEDIANA', 'GRANDE')),

  ciiu_principal              varchar(8),
  ciiu_secundarios            varchar(8)[],

  vigencia_desde              date        NOT NULL,
  vigencia_hasta              date,
  fuente                      text        NOT NULL DEFAULT 'MANUAL'
                                CHECK (fuente IN ('RUT', 'FACTURA', 'MANUAL', 'FE_XML', 'MIGRACION')),
  -- Lo automático propone; una persona aprueba (especificación §5.2).
  propuesto_por               uuid,
  aprobado_por                uuid,
  aprobado_en                 timestamptz,
  creado_en                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fk_perfil_tercero
    FOREIGN KEY (tercero_id, empresa_id) REFERENCES tercero (id, empresa_id),
  CONSTRAINT ck_perfil_vigencia CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  -- Un tercero no puede tener dos perfiles vigentes a la vez.
  CONSTRAINT ex_perfil_sin_solape EXCLUDE USING gist (
    empresa_id WITH =,
    tercero_id WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);

CREATE INDEX ix_perfil_tercero ON tercero_perfil_tributario (empresa_id, tercero_id, vigencia_desde DESC);

COMMENT ON TABLE tercero_perfil_tributario IS
  'Datos tributarios del tercero con historia. Un cambio cierra la versión vigente (vigencia_hasta) y abre otra; nunca se edita.';

GRANT SELECT, INSERT, UPDATE ON tercero_perfil_tributario TO gestion_app, gestion_provision;

ALTER TABLE tercero_perfil_tributario ENABLE ROW LEVEL SECURITY;
ALTER TABLE tercero_perfil_tributario FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_perfil_tercero_aislado ON tercero_perfil_tributario
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- La primera versión de cada tercero: lo que tiene hoy, desde que se creó.
INSERT INTO tercero_perfil_tributario
  (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
   es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
   vigencia_desde, fuente)
SELECT t.empresa_id, t.id, t.tipo_persona,
       CASE WHEN t.regimen_simple THEN 'SIMPLE' ELSE 'ORDINARIO' END,
       t.declarante_renta,
       t.responsable_iva, t.es_gran_contribuyente, t.es_autorretenedor,
       t.creado_en::date, 'MIGRACION'
  FROM tercero t;

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0075', 'PERFILES_CREADOS', jsonb_build_object('terceros', count(*))
  FROM tercero_perfil_tributario;

-- -----------------------------------------------------------------------------
-- Sincronía mientras el código siga escribiendo en `tercero` (hasta la Fase 1)
-- -----------------------------------------------------------------------------
-- Tercero nuevo → su primera versión. Cambio en un dato tributario → se cierra
-- la vigente ayer y se abre una desde hoy con lo nuevo, conservando lo que el
-- perfil sabe y `tercero` no (agente de IVA, ZOMAC, CIIU…).
CREATE FUNCTION fn_tercero_sincroniza_perfil() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  vigente tercero_perfil_tributario%ROWTYPE;
BEGIN
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
    -- Cambió dos veces el mismo día: se corrige la versión de hoy, no se abre
    -- otra de un día de duración cero.
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

CREATE TRIGGER tg_tercero_sincroniza_perfil
  AFTER INSERT OR UPDATE ON tercero
  FOR EACH ROW EXECUTE FUNCTION fn_tercero_sincroniza_perfil();
