-- =============================================================================
-- 0024_anulacion_asiento — la anulación tiene columnas propias
-- =============================================================================
-- `0022` dejó dos reglas que se contradicen sin que se notara hasta ejercitarlas:
--
--   · `fn_asiento_inmutable` permite cambiar SOLO el estado.
--   · `anular()` cambiaba el estado Y agregaba el motivo a la glosa.
--
-- Resultado: anular era imposible. El trigger rechazaba su propio caso de uso.
--
-- Se arregla por el lado estricto. La glosa dice por qué EXISTE el asiento y eso
-- no cambia nunca; por qué se ANULÓ es otro hecho, de otro momento y de otra
-- persona, y merece sus propias columnas. Meterlo en la glosa perdía las dos
-- cosas que un auditor pregunta primero: quién lo anuló y cuándo.

ALTER TABLE asiento
  ADD COLUMN motivo_anulacion text,
  ADD COLUMN anulado_en       timestamptz,
  ADD COLUMN anulado_por      uuid REFERENCES usuario (id) ON DELETE RESTRICT;

-- Las tres van juntas o no va ninguna, igual que el par estado/cerrado_en de
-- `periodo_contable`: un asiento anulado sin motivo obliga a preguntarle a quien
-- lo anuló, y para cuando alguien audita esa persona ya no se acuerda.
ALTER TABLE asiento
  ADD CONSTRAINT ck_asiento_anulacion CHECK (
    (estado = 'ANULADO'
      AND motivo_anulacion IS NOT NULL
      AND length(btrim(motivo_anulacion)) > 0
      AND anulado_en  IS NOT NULL
      AND anulado_por IS NOT NULL)
    OR
    (estado = 'REGISTRADO'
      AND motivo_anulacion IS NULL
      AND anulado_en  IS NULL
      AND anulado_por IS NULL)
  );

COMMENT ON COLUMN asiento.motivo_anulacion IS
  'Por que se anulo. La glosa dice por que existe el asiento y no cambia nunca; esto es otro hecho.';

-- -----------------------------------------------------------------------------
-- El trigger deja pasar las cuatro columnas de la anulación, y nada más
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_asiento_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Un asiento no se borra. Anulalo, o corregilo con un contra-asiento.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Todo lo que describe el hecho contable queda escrito. Lo único que puede
  -- moverse es la anulación, que es un hecho posterior y distinto.
  IF ROW(NEW.empresa_id, NEW.comprobante_tipo_id, NEW.numero, NEW.fecha,
         NEW.periodo_id, NEW.glosa, NEW.total_debito, NEW.total_credito,
         NEW.origen_tipo, NEW.origen_id, NEW.creado_por)
     IS DISTINCT FROM
     ROW(OLD.empresa_id, OLD.comprobante_tipo_id, OLD.numero, OLD.fecha,
         OLD.periodo_id, OLD.glosa, OLD.total_debito, OLD.total_credito,
         OLD.origen_tipo, OLD.origen_id, OLD.creado_por) THEN
    RAISE EXCEPTION
      'Un asiento registrado no se edita: se anula y se vuelve a hacer, o se corrige con un contra-asiento.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Y la anulación va en un solo sentido. Desanular deshace un hecho que ya
  -- salió en un estado financiero; lo correcto es volver a registrarlo.
  IF OLD.estado = 'ANULADO' AND NEW.estado = 'REGISTRADO' THEN
    RAISE EXCEPTION
      'Un asiento anulado no se reactiva. Registra uno nuevo con el mismo contenido.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
