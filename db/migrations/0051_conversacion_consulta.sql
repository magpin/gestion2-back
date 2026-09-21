-- 0051 — Qué consultó el asistente para cada respuesta.
--
-- Paso 6b de `docs/planes/asistente-conversacion.md`. Desde el paso 6, el
-- asistente contesta con datos de la empresa: consulta el armador de reportes,
-- los saldos de caja y bancos o las existencias, con los permisos de quien
-- pregunta.
--
-- Se guarda **qué se consultó**, no lo que devolvió:
--
--   - Para contestar «¿de dónde sacó esa cifra?». Con la herramienta y lo que
--     pidió, la consulta se puede volver a correr en la pantalla de Reportes.
--   - Las filas no: los datos cambian, ya viven en sus tablas, y copiarlas acá
--     sería guardar dos veces lo mismo con otro dueño.
--
-- Como los turnos, solo se agrega.

CREATE TABLE conversacion_consulta (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  -- La respuesta que la usó. Se inserta junto con el turno del asistente.
  turno_id    uuid        NOT NULL REFERENCES conversacion_turno (id) ON DELETE CASCADE,
  -- En qué orden se hicieron dentro del turno.
  orden       smallint    NOT NULL,
  -- `consultar_cartera`, `consultar_saldos`, `buscar_valores`…
  herramienta text        NOT NULL,
  -- Lo que pidió el modelo, tal cual: columnas, filtros, fechas.
  entrada     jsonb       NOT NULL,
  -- Cuántas filas devolvió, cuando la consulta las cuenta.
  filas       integer,
  -- Lo que salió mal, si salió mal: una columna que no existe, un rol sin el
  -- reporte. El modelo lo leyó y corrigió o lo explicó.
  error       text,
  creado_en   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_conversacion_consulta_orden UNIQUE (turno_id, orden),
  CONSTRAINT ck_conversacion_consulta_orden CHECK (orden BETWEEN 1 AND 50),
  CONSTRAINT ck_conversacion_consulta_herramienta
    CHECK (char_length(herramienta) BETWEEN 1 AND 60),
  CONSTRAINT ck_conversacion_consulta_filas CHECK (filas IS NULL OR filas >= 0),
  CONSTRAINT ck_conversacion_consulta_error
    CHECK (error IS NULL OR char_length(error) BETWEEN 1 AND 1000)
);

-- Una consulta cuelga de una respuesta del asistente de su misma empresa. La
-- clave foránea no mira ni la empresa ni el autor.
CREATE OR REPLACE FUNCTION fn_conversacion_consulta_turno() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t conversacion_turno%ROWTYPE;
BEGIN
  SELECT * INTO t FROM conversacion_turno WHERE id = NEW.turno_id;
  IF t.empresa_id IS DISTINCT FROM NEW.empresa_id THEN
    RAISE EXCEPTION 'La consulta y su turno son de empresas distintas.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF t.autor IS DISTINCT FROM 'ASISTENTE' THEN
    RAISE EXCEPTION 'Solo una respuesta del asistente tiene consultas.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_conversacion_consulta_turno
  BEFORE INSERT ON conversacion_consulta
  FOR EACH ROW EXECUTE FUNCTION fn_conversacion_consulta_turno();

COMMENT ON TABLE conversacion_consulta IS
  'Lo que el asistente consultó para una respuesta: la herramienta y lo que pidió, no lo que devolvió. Solo se agrega. Cada persona ve solo las de sus conversaciones (lo filtra el servicio).';

ALTER TABLE conversacion_consulta ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversacion_consulta FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_conversacion_consulta_aislada ON conversacion_consulta
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- El mismo REVOKE que en la 0050, por la misma razón: la 0044 da UPDATE a toda
-- tabla nueva, y un GRANT más estrecho no lo quita.
REVOKE UPDATE ON conversacion_consulta FROM gestion_app, gestion_provision;
GRANT SELECT, INSERT ON conversacion_consulta TO gestion_app, gestion_provision;
