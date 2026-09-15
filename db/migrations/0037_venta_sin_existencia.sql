-- =============================================================================
-- 0037_venta_sin_existencia — vender en descubierto, a sabiendas
-- =============================================================================
-- El kardex rechaza toda salida que deje la existencia negativa, y eso está
-- bien como regla por defecto. Pero pasa de verdad: el cliente está esperando,
-- la mercancía llegó y nadie la registró todavía, o el conteo está mal. Hasta
-- hoy la única salida era no facturar.
--
-- Tres piezas, y ninguna afloja el kardex por sí sola:
--
--   1. `permite_existencia_negativa`: la empresa decide si esto es posible.
--      Por defecto NO. Que un digitador pueda vender lo que no hay no es una
--      decisión suya, es de quien responde por el inventario.
--   2. `venta_faltante`: cada unidad que salió sin estar queda anotada, con
--      qué factura la sacó y a qué costo se valoró. Es la lista de "esto hay
--      que comprar" —lo que en un sistema más grande sería una orden de
--      compra— y, mientras eso no exista, el rastro de por qué el kardex de un
--      producto estuvo en rojo.
--   3. El motor sigue teniendo la última palabra. Los dos `CHECK (>= 0)` de
--      `producto_movimiento` no pueden consultar la configuración de la
--      empresa —un CHECK solo ve su propia fila—, así que se reemplazan por un
--      trigger que sí la consulta: el saldo negativo se rechaza salvo que esa
--      empresa lo haya habilitado. La regla no se debilita, cambia de forma.
--
-- El costo es el punto delicado y se resuelve en el servicio, no acá: una
-- salida en descubierto se valora al último costo promedio conocido del
-- producto, y si el producto NUNCA tuvo una entrada no hay confirmación
-- posible —se rechaza igual—, porque valorarla en cero convertiría el margen
-- del período en una mentira.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. El interruptor de la empresa
-- -----------------------------------------------------------------------------
ALTER TABLE inventario_configuracion
  ADD COLUMN permite_existencia_negativa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN inventario_configuracion.permite_existencia_negativa IS
  'Si la empresa acepta facturar sin existencia. false por defecto: el kardex rechaza la salida. Con true, quien factura todavia tiene que confirmarlo documento por documento, y el faltante queda en venta_faltante.';

-- -----------------------------------------------------------------------------
-- 2. Lo que salió sin estar
-- -----------------------------------------------------------------------------
CREATE TABLE venta_faltante (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  venta_documento_id  uuid          NOT NULL,
  producto_id         uuid          NOT NULL,

  -- Cuántas unidades de esta línea no estaban. No es la cantidad vendida: si
  -- había 3 y se vendieron 10, el faltante es 7.
  cantidad_faltante   numeric(18,6) NOT NULL CHECK (cantidad_faltante > 0),
  -- A qué costo se valoró la salida —el último promedio conocido—. Queda
  -- guardado porque cuando la compra entre, el costo real puede ser otro, y la
  -- diferencia hay que poder explicarla.
  costo_referencia    numeric(18,2) NOT NULL CHECK (costo_referencia >= 0),

  creado_en           timestamptz   NOT NULL DEFAULT now(),
  creado_por          uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT uq_venta_faltante_id_empresa UNIQUE (id, empresa_id),
  -- Una línea de una factura no puede anotar dos faltantes del mismo producto.
  CONSTRAINT uq_venta_faltante_documento_producto
    UNIQUE (venta_documento_id, producto_id),
  CONSTRAINT fk_venta_faltante_documento
    FOREIGN KEY (venta_documento_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_venta_faltante_producto
    FOREIGN KEY (producto_id, empresa_id)
    REFERENCES producto (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_venta_faltante_producto
  ON venta_faltante (empresa_id, producto_id, creado_en DESC);

COMMENT ON TABLE venta_faltante IS
  'Cada linea que salio sin existencia, con la factura que la saco. Es la lista de que hay que comprar; no es una orden de compra (no numera, no tiene estado ni recepcion) y no pretende serlo.';

-- -----------------------------------------------------------------------------
-- 3. El saldo negativo deja de ser imposible y pasa a ser condicional
-- -----------------------------------------------------------------------------
-- `saldo_valor` acompaña a `saldo_cantidad`: con existencia negativa el valor
-- también lo es. `ck_movimiento_saldo_valor` (la identidad
-- `saldo_valor = round(saldo_cantidad * saldo_costo_promedio, 2)`) se queda
-- intacto, y `saldo_costo_promedio >= 0` también: el costo nunca es negativo,
-- lo que queda en rojo es la cantidad.
ALTER TABLE producto_movimiento
  DROP CONSTRAINT producto_movimiento_saldo_cantidad_check,
  DROP CONSTRAINT producto_movimiento_saldo_valor_check;

CREATE OR REPLACE FUNCTION fn_saldo_negativo_permitido() RETURNS trigger AS $$
DECLARE
  v_permite boolean;
BEGIN
  IF NEW.saldo_cantidad >= 0 THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(permite_existencia_negativa, false) INTO v_permite
    FROM inventario_configuracion
   WHERE empresa_id = NEW.empresa_id;

  IF coalesce(v_permite, false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'El movimiento deja la existencia del producto % en %, y esta empresa no permite existencia negativa.',
    NEW.producto_id, NEW.saldo_cantidad
    USING HINT = 'Registrá primero la entrada de la mercancía, o habilitá la existencia negativa en la configuración de inventario.';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_saldo_negativo_permitido() IS
  'Reemplaza al CHECK (saldo_cantidad >= 0): un CHECK no puede consultar inventario_configuracion, un trigger si. El kardex sigue siendo el que decide, no la aplicacion.';

CREATE TRIGGER tg_movimiento_saldo_negativo
  BEFORE INSERT ON producto_movimiento
  FOR EACH ROW EXECUTE FUNCTION fn_saldo_negativo_permitido();

-- -----------------------------------------------------------------------------
-- 4. RLS y privilegios
-- -----------------------------------------------------------------------------
-- Nada se borra ni se corrige: un faltante es un hecho, como un movimiento de
-- kardex. Sin UPDATE y sin DELETE.
ALTER TABLE venta_faltante ENABLE ROW LEVEL SECURITY;
ALTER TABLE venta_faltante FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_venta_faltante_aislado ON venta_faltante
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON venta_faltante TO gestion_app, gestion_provision;
