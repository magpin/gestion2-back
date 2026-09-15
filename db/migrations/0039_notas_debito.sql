-- =============================================================================
-- 0039_notas_debito — notas débito, y notas de compra
-- =============================================================================
-- Faltaban dos cosas simétricas:
--
--   * En ventas existe la nota crédito (baja lo que el cliente debe) pero no
--     la nota débito (lo sube: un interés de mora, un flete que no se cobró,
--     un menor valor facturado).
--   * En compras no existe ninguna de las dos. Toda fila de `compra_documento`
--     es hoy una factura de proveedor, y cuando el proveedor acredita o cobra
--     de más no hay dónde registrarlo.
--
-- Y una tercera, la que hace posible la nota PARCIAL: hasta ahora una nota
-- crédito copiaba todas las líneas de la factura y reversaba el 100%. Para
-- devolver solo parte hay que poder responder "cuánto de ESTA línea ya se
-- devolvió", y eso pide que la línea de la nota apunte a la línea que corrige
-- (`linea_origen_id`).
--
-- Lo que NO cambia, a propósito:
--
--   * `ck_venta_fiscal` sigue exigiendo resolución y asiento a todo lo que no
--     sea cotización: una nota débito de venta es un documento electrónico y
--     numera igual que la factura.
--   * `ck_venta_estado_tipo` ya cubre a la nota débito sin tocarlo: su rama
--     `tipo <> 'COTIZACION'` permite EMITIDA y ANULADA, que son las dos que
--     una nota necesita.
--   * El kardex. Ninguna nota lo mueve, igual que hoy la nota crédito de
--     venta — la decisión 3 de `ventas-backend.md`, extendida a compras: si la
--     mercancía vuelve o se va físicamente, eso es un ajuste de inventario
--     aparte y deliberado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ventas: el tipo que faltaba y el enlace obligatorio
-- -----------------------------------------------------------------------------
ALTER TABLE venta_documento DROP CONSTRAINT venta_documento_tipo_check;
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_tipo CHECK (
  tipo IN ('COTIZACION', 'FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO')
);

-- Sin factura no hay nota: ni crédito ni débito. Una factura puede venir de
-- una cotización (opcional) y una cotización nunca tiene origen.
ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_origen;
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_origen CHECK (
  (tipo IN ('NOTA_CREDITO', 'NOTA_DEBITO') AND documento_origen_id IS NOT NULL)
  OR (tipo = 'FACTURA')
  OR (tipo = 'COTIZACION' AND documento_origen_id IS NULL)
);

COMMENT ON COLUMN venta_documento.documento_origen_id IS
  'En NOTA_CREDITO y NOTA_DEBITO: la factura que corrigen (obligatorio). En FACTURA: la cotizacion de la que se convirtio, si vino de una (opcional). NULL siempre en COTIZACION.';

-- -----------------------------------------------------------------------------
-- 2. La línea que corrige a otra línea
-- -----------------------------------------------------------------------------
-- `UNIQUE (id, empresa_id)` primero: la FK compuesta de abajo lo necesita, y
-- es el mismo patrón que el resto de las tablas del sistema.
ALTER TABLE venta_documento_linea
  ADD CONSTRAINT uq_linea_venta_id_empresa UNIQUE (id, empresa_id);
ALTER TABLE compra_documento_linea
  ADD CONSTRAINT uq_linea_compra_id_empresa UNIQUE (id, empresa_id);

ALTER TABLE venta_documento_linea ADD COLUMN linea_origen_id uuid;
ALTER TABLE venta_documento_linea
  ADD CONSTRAINT fk_linea_venta_origen
  FOREIGN KEY (linea_origen_id, empresa_id)
  REFERENCES venta_documento_linea (id, empresa_id) ON DELETE RESTRICT;

ALTER TABLE compra_documento_linea ADD COLUMN linea_origen_id uuid;
ALTER TABLE compra_documento_linea
  ADD CONSTRAINT fk_linea_compra_origen
  FOREIGN KEY (linea_origen_id, empresa_id)
  REFERENCES compra_documento_linea (id, empresa_id) ON DELETE RESTRICT;

COMMENT ON COLUMN venta_documento_linea.linea_origen_id IS
  'La linea de la factura que esta linea corrige. NULL en una factura o cotizacion. Es lo que hace posible la nota parcial: sin esto, "cuanto de esta linea ya se devolvio" no se puede responder.';
COMMENT ON COLUMN compra_documento_linea.linea_origen_id IS
  'La linea de la compra que esta linea corrige. Ver venta_documento_linea.linea_origen_id.';

-- Es la consulta de toda nota parcial: "que notas apuntan a esta linea".
CREATE INDEX ix_linea_venta_origen
  ON venta_documento_linea (linea_origen_id)
  WHERE linea_origen_id IS NOT NULL;
CREATE INDEX ix_linea_compra_origen
  ON compra_documento_linea (linea_origen_id)
  WHERE linea_origen_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Compras: tipo y enlace
-- -----------------------------------------------------------------------------
-- `DEFAULT 'FACTURA'` no es comodidad: las 129 compras que ya existen son
-- facturas de proveedor, y así quedan marcadas sin un UPDATE aparte.
ALTER TABLE compra_documento
  ADD COLUMN tipo text NOT NULL DEFAULT 'FACTURA',
  ADD COLUMN documento_origen_id uuid;

ALTER TABLE compra_documento ADD CONSTRAINT ck_compra_tipo CHECK (
  tipo IN ('FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO')
);

ALTER TABLE compra_documento
  ADD CONSTRAINT fk_compra_origen
  FOREIGN KEY (documento_origen_id, empresa_id)
  REFERENCES compra_documento (id, empresa_id) ON DELETE RESTRICT;

ALTER TABLE compra_documento ADD CONSTRAINT ck_compra_origen CHECK (
  (tipo IN ('NOTA_CREDITO', 'NOTA_DEBITO') AND documento_origen_id IS NOT NULL)
  OR (tipo = 'FACTURA' AND documento_origen_id IS NULL)
);

-- El número del proveedor es único por proveedor... pero su nota crédito llega
-- con su propia numeración, que puede coincidir con la de una factura suya.
-- Sin el tipo acá, registrar la nota chocaría con la factura que corrige.
ALTER TABLE compra_documento DROP CONSTRAINT uq_compra_numero_proveedor;
ALTER TABLE compra_documento
  ADD CONSTRAINT uq_compra_numero_proveedor
  UNIQUE (empresa_id, tercero_id, tipo, numero_factura_proveedor);

CREATE INDEX ix_compra_origen
  ON compra_documento (documento_origen_id)
  WHERE documento_origen_id IS NOT NULL;

COMMENT ON COLUMN compra_documento.tipo IS
  'FACTURA (lo que el proveedor factura), NOTA_CREDITO (nos acredita: devolucion, descuento posterior, menor valor) o NOTA_DEBITO (nos cobra mas: flete, interes, mayor valor).';
COMMENT ON COLUMN compra_documento.documento_origen_id IS
  'En las dos notas: la compra que corrigen (obligatorio). NULL en una FACTURA.';
