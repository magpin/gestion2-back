-- 0063 — Lo que una persona contestó sobre un renglón de factura, para no
-- volver a preguntarlo.
--
-- Fase 3 de `docs/planes/maria-facturas-y-errores.md`, la parte de aprender. La
-- mercancía cruza sola por código; **el gasto pregunta siempre**, porque una
-- cuenta de cobro no imprime el código del PUC. Sin esto, el arriendo del mismo
-- proveedor pregunta lo mismo doce veces al año.
--
-- Cuatro decisiones que esta tabla sostiene, y la primera es la que importa:
--
--   1. **Aprende de personas, nunca de sí misma.** Solo entra lo que alguien
--      contestó al registrar. Lo que el cruce encontró solo —«era el único que
--      se parecía»— no se guarda: se grabaría un error para siempre y se
--      confirmaría solo cada mes.
--   2. **Aprende al registrar, no al contestar.** La fila se escribe en la misma
--      transacción que la compra: si la compra no entra, no se aprende nada.
--   3. **La llave es proveedor + texto.** «TORNILLO 1/2» de dos proveedores
--      pueden ser dos productos distintos.
--   4. **Guarda el destino, nunca el monto.** La cantidad y el precio salen del
--      papel de cada factura.
--
-- Y lo que no hace: registrar. Lo recordado llena el renglón; la compra la
-- sigue registrando una persona.

CREATE TABLE renglon_aprendido (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  tercero_id          uuid        NOT NULL REFERENCES tercero (id),

  -- Lo que el modelo dijo que era el renglón. Va en la llave porque el texto se
  -- normaliza distinto según la clase: en un gasto se le quitan meses y
  -- números —«ARRIENDO OCTUBRE 2026» es el mismo que el de noviembre—; en un
  -- producto no, porque ahí «1/2» y «3/8» son dos tornillos.
  clase               text        NOT NULL CHECK (clase IN ('PRODUCTO', 'GASTO')),
  -- El texto ya normalizado: es contra esto que se busca.
  texto               text        NOT NULL CHECK (length(btrim(texto)) > 0),
  -- Cómo venía escrito la última vez, para poder mostrarlo.
  ejemplo             text        NOT NULL,

  -- Adónde fue. Uno de los dos y no los dos: igual que una línea de compra.
  producto_id         uuid        REFERENCES producto (id),
  cuenta_id           uuid        REFERENCES empresa_cuenta (id),

  -- Quién lo contestó y en qué compra. Sin esto «María lo recordó» no se puede
  -- rastrear hasta una persona, que es la única que decide.
  aprendido_por       uuid        NOT NULL REFERENCES usuario (id),
  compra_documento_id uuid        NOT NULL REFERENCES compra_documento (id),

  -- Cuántas compras se registraron con esta respuesta. Vuelve a 1 cuando
  -- alguien la cambia: es la respuesta nueva la que se está usando.
  veces_usado         integer     NOT NULL DEFAULT 1 CHECK (veces_usado > 0),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  usado_en            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_renglon_aprendido_destino CHECK (
    (producto_id IS NULL) <> (cuenta_id IS NULL)
  )
);

-- Una sola respuesta por proveedor y texto: si alguien contesta distinto, la
-- nueva reemplaza a la anterior. Es también el índice con que se busca.
CREATE UNIQUE INDEX uq_renglon_aprendido
  ON renglon_aprendido (empresa_id, tercero_id, clase, texto);

COMMENT ON TABLE renglon_aprendido IS
  'Lo que una persona contesto sobre un renglon de una factura de compra leida —que producto es, o contra que cuenta va el gasto—, para no preguntarlo la proxima vez que el mismo proveedor mande el mismo texto. Se escribe solo al registrar la compra, y solo con respuestas de personas: nunca con lo que el cruce encontro solo. Guarda el destino, nunca el monto.';

COMMENT ON COLUMN renglon_aprendido.texto IS
  'La descripcion del renglon normalizada: sin tildes, en mayusculas, y en los gastos sin meses ni palabras con digitos. Es la llave de busqueda junto con el proveedor y la clase.';

ALTER TABLE renglon_aprendido ENABLE ROW LEVEL SECURITY;
ALTER TABLE renglon_aprendido FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_renglon_aprendido_aislado ON renglon_aprendido
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Sin DELETE, como todo el esquema: una respuesta se corrige con otra.
GRANT SELECT, INSERT, UPDATE ON renglon_aprendido TO gestion_app, gestion_provision;
