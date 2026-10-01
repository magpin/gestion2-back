-- Anticipos como sección propia (docs/planes/plan-anticipos.md).
--
-- A. El anticipo dice para qué es: los productos, con cantidad y precio. Un
--    anticipo sigue siendo un recibo de caja sin facturas; estas son sus líneas.
-- B. Un anticipo o saldo a favor se puede aplicar al emitir la factura: el
--    cruce queda dentro del asiento de la factura (`en_factura`) y anularlo
--    asienta solo la inversa del cruce, no la factura entera.

CREATE TABLE recibo_caja_anticipo_linea (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  recibo_id       uuid          NOT NULL,
  orden           int           NOT NULL CHECK (orden > 0),
  producto_id     uuid          NOT NULL,
  cantidad        numeric(18,6) NOT NULL CHECK (cantidad > 0),
  precio_unitario numeric(18,2) NOT NULL CHECK (precio_unitario >= 0),
  CONSTRAINT uq_anticipo_linea_orden UNIQUE (recibo_id, orden),
  CONSTRAINT fk_anticipo_linea_recibo FOREIGN KEY (recibo_id, empresa_id)
    REFERENCES recibo_caja (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_anticipo_linea_producto FOREIGN KEY (producto_id, empresa_id)
    REFERENCES producto (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_anticipo_linea_recibo ON recibo_caja_anticipo_linea (recibo_id);

ALTER TABLE recibo_caja_anticipo_linea ENABLE ROW LEVEL SECURITY;
ALTER TABLE recibo_caja_anticipo_linea FORCE ROW LEVEL SECURITY;
CREATE POLICY p_recibo_caja_anticipo_linea_aislado ON recibo_caja_anticipo_linea
  USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON recibo_caja_anticipo_linea TO gestion_app, gestion_provision;

ALTER TABLE cruce_cartera ADD COLUMN en_factura boolean NOT NULL DEFAULT false;
