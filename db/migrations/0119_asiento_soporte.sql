-- El soporte del comprobante manual (Fase 9 de
-- docs/planes/plan-pantallas-complementarias.md, pantalla 52).
--
-- Un comprobante de contabilidad (CD) puede llevar el documento que lo
-- respalda: el cuadro de depreciación, la liquidación de la prima, la póliza.
-- Va en una tabla aparte porque el asiento no se edita (trigger de 0022): el
-- archivo se sube antes y la fila se inserta en la misma transacción que el
-- asiento. La llave es del almacenamiento y la decide el servidor.

CREATE TABLE asiento_soporte (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid        NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  asiento_id  uuid        NOT NULL,
  clave       text        NOT NULL CHECK (length(btrim(clave)) > 0),
  nombre      text        NOT NULL CHECK (length(btrim(nombre)) > 0),
  creado_por  uuid        NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_asiento_soporte_asiento FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id)
);

CREATE INDEX ix_asiento_soporte_asiento ON asiento_soporte (asiento_id);

ALTER TABLE asiento_soporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE asiento_soporte FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_asiento_soporte_aislado ON asiento_soporte
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
-- Como el asiento: se registra una vez y no se edita.
GRANT SELECT, INSERT ON asiento_soporte TO gestion_app, gestion_provision;
