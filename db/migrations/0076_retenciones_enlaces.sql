-- =============================================================================
-- 0076 — Retenciones: los enlaces concepto → cuenta los crea el sistema
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 0 (§0.7.5).
--
-- Nadie carga conceptos a mano. Cada concepto de la ley se enlaza solo a las
-- cuentas de la empresa donde va:
--
-- * `cuenta_id`: lo que la empresa retiene (un pasivo, 2365xx / 2367xx /
--   2368xx). Solo existe si la empresa es agente de ese impuesto: sin él, el
--   concepto no se puede practicar en compras.
-- * `cuenta_activo_id` (nueva): lo que a la empresa le retienen (un anticipo,
--   135515). Existe aunque no sea agente: la retención se la practican por
--   vender.
--
-- Un trigger sobre `empresa_cuenta` crea o completa el enlace cuando aparece
-- la cuenta —la cree el plan sugerido, el contador a mano o una importación—,
-- y al final se corre una vez para las empresas que ya existen. Un enlace que
-- ya tiene cuenta no se pisa: si el contador la cambió, manda la suya.
--
-- ReteIVA y ReteICA que nos practican (135517 / 135518) no están en el
-- catálogo PUC cargado (R-D12, lo decide Yeris): hasta entonces esos enlaces
-- quedan sin cuenta de activo.

ALTER TABLE retencion_concepto
  ADD COLUMN cuenta_activo_id uuid,
  ADD CONSTRAINT fk_retencion_cuenta_activo
    FOREIGN KEY (cuenta_activo_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id),
  ALTER COLUMN cuenta_id  DROP NOT NULL,
  -- NULL = lo creó el sistema, no una persona.
  ALTER COLUMN creado_por DROP NOT NULL,
  ADD CONSTRAINT ck_retencion_alguna_cuenta
    CHECK (cuenta_id IS NOT NULL OR cuenta_activo_id IS NOT NULL);

COMMENT ON COLUMN retencion_concepto.cuenta_id IS
  'Donde va lo que la empresa retiene (pasivo). NULL si no es agente de ese impuesto.';
COMMENT ON COLUMN retencion_concepto.cuenta_activo_id IS
  'Donde va lo que a la empresa le retienen (anticipo, 1355xx).';

-- La cuenta de la empresa para una subcuenta del catálogo de la ley. Con seis
-- dígitos es esa cuenta; con cuatro (2367, 2368) el decreto deja libre la
-- numeración y se toma la primera auxiliar que cuelga de ella.
CREATE FUNCTION fn_retencion_cuenta_de(p_empresa uuid, p_subcuenta varchar)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT c.id
    FROM empresa_cuenta c
   WHERE c.empresa_id = p_empresa
     AND c.activa
     AND c.es_auxiliar
     AND (c.codigo = p_subcuenta
          OR (length(p_subcuenta) = 4 AND c.codigo LIKE p_subcuenta || '%'))
   ORDER BY c.codigo
   LIMIT 1
$$;

CREATE FUNCTION fn_retencion_enlaza(p_empresa uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n        record;
  pasivo   uuid;
  activo_c uuid;
BEGIN
  FOR n IN SELECT * FROM retencion_concepto_nacional LOOP
    pasivo   := fn_retencion_cuenta_de(p_empresa, n.subcuenta_pasivo);
    activo_c := fn_retencion_cuenta_de(p_empresa, n.subcuenta_activo);
    CONTINUE WHEN pasivo IS NULL AND activo_c IS NULL;

    UPDATE retencion_concepto
       SET cuenta_id        = coalesce(cuenta_id, pasivo),
           cuenta_activo_id = coalesce(cuenta_activo_id, activo_c)
     WHERE empresa_id = p_empresa
       AND concepto_nacional_id = n.id
       AND anio IS NULL
       AND activo;

    IF NOT FOUND THEN
      INSERT INTO retencion_concepto
        (empresa_id, tipo, codigo, nombre, cuenta_id, cuenta_activo_id,
         concepto_nacional_id)
      VALUES
        (p_empresa, n.impuesto, n.codigo, n.nombre, pasivo, activo_c, n.id);
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION fn_empresa_cuenta_enlaza_retencion()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_retencion_enlaza(NEW.empresa_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER tg_empresa_cuenta_enlaza_retencion
  AFTER INSERT OR UPDATE OF codigo, es_auxiliar, activa ON empresa_cuenta
  FOR EACH ROW
  WHEN (NEW.codigo LIKE '2365%' OR NEW.codigo LIKE '2367%'
        OR NEW.codigo LIKE '2368%' OR NEW.codigo LIKE '1355%')
  EXECUTE FUNCTION fn_empresa_cuenta_enlaza_retencion();

-- Las empresas que ya existen.
SELECT fn_retencion_enlaza(e.id) FROM empresa e;

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0076', 'ENLACES_CREADOS',
       jsonb_build_object(
         'enlaces',          count(*),
         'con_cuenta_pasivo', count(*) FILTER (WHERE cuenta_id IS NOT NULL),
         'con_cuenta_activo', count(*) FILTER (WHERE cuenta_activo_id IS NOT NULL))
  FROM retencion_concepto
 WHERE anio IS NULL;
