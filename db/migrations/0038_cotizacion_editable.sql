-- =============================================================================
-- 0038_cotizacion_editable — una cotización se corrige y se descarta
-- =============================================================================
-- Una cotización no es un documento fiscal: no numera contra la resolución
-- DIAN, no asienta y no mueve kardex. Es una oferta, y una oferta se negocia:
-- el cliente pide cambiar una cantidad y hoy hay que hacer otra cotización,
-- con otro número, dejando la primera viva para siempre.
--
-- Dos cosas, entonces:
--
--   1. Corregirla: un UPDATE de la cabecera y un reemplazo de sus líneas. El
--      UPDATE de `venta_documento` ya estaba permitido; lo que falta es poder
--      borrar sus líneas. Hoy lo prohíbe `tg_linea_venta_inmutable`, que
--      reusaba `fn_linea_inmutable()` de los asientos —rechaza todo UPDATE y
--      todo DELETE sin mirar de qué documento es la línea—. Se reemplaza por
--      una función propia que sí mira: una cotización vigente deja borrar sus
--      líneas, un documento fiscal asentado no, ni para corregir. El UPDATE
--      sigue prohibido para todos: corregir es reemplazar la línea, no
--      editarla —así el kardex y el libro nunca ven una línea mutar—.
--   2. Descartarla. `ck_venta_estado_tipo` (de `0029`) no dejaba a una
--      COTIZACION llegar a ANULADA. Se afloja: nada se borra en este sistema,
--      así que descartar es anular con motivo, reusando
--      `motivo_anulacion`/`anulado_en`/`anulado_por` que ya están en la tabla.
--      `BORRADOR` sigue existiendo sin usar, igual que antes.
-- =============================================================================

ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_estado_tipo;
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_estado_tipo CHECK (
  (tipo = 'COTIZACION' AND estado IN ('BORRADOR', 'EMITIDA', 'CONVERTIDA', 'ANULADA'))
  OR (tipo <> 'COTIZACION' AND estado IN ('EMITIDA', 'ANULADA'))
);

-- Una función propia, en vez de la genérica de los asientos: esta sí mira de
-- qué documento es la línea. Reusar `fn_linea_inmutable()` fue lo correcto
-- mientras la respuesta era "nunca"; ahora hay una excepción y tiene que
-- vivir en código, no en un privilegio.
CREATE OR REPLACE FUNCTION fn_linea_venta_inmutable() RETURNS trigger AS $$
DECLARE
  v_tipo   text;
  v_estado text;
BEGIN
  -- Editar una línea nunca: corregir es reemplazarla. Así ni el kardex ni el
  -- libro ven mutar una línea que ya leyeron.
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Las lineas de un documento de venta no se editan. Reemplazalas, o anula el documento y volve a hacerlo.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tipo, estado INTO v_tipo, v_estado
    FROM venta_documento WHERE id = OLD.venta_documento_id;

  IF v_tipo = 'COTIZACION' AND v_estado = 'EMITIDA' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Las lineas de un % en estado % no se borran.', v_tipo, v_estado
    USING ERRCODE = 'check_violation',
          HINT = 'Solo se corrigen las lineas de una cotizacion vigente. Una factura se anula y se emite de nuevo; una nota credito corrige lo que ya se facturo.';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_linea_venta_inmutable() IS
  'Reemplaza a fn_linea_inmutable() en venta_documento_linea: el UPDATE sigue prohibido para todos y el DELETE se permite solo en las lineas de una COTIZACION EMITIDA, para poder corregirla.';

DROP TRIGGER tg_linea_venta_inmutable ON venta_documento_linea;
CREATE TRIGGER tg_linea_venta_inmutable
  BEFORE UPDATE OR DELETE ON venta_documento_linea
  FOR EACH ROW EXECUTE FUNCTION fn_linea_venta_inmutable();

GRANT DELETE ON venta_documento_linea TO gestion_app;

COMMENT ON CONSTRAINT ck_venta_estado_tipo ON venta_documento IS
  'Que estados puede tener cada tipo. Una COTIZACION llega a CONVERTIDA (se facturo) o a ANULADA (se descarto); un documento fiscal nace EMITIDA y solo puede terminar ANULADA.';
