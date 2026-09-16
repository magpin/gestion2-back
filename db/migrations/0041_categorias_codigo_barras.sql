-- 0041 — Categorías de producto y código de barras.
--
-- Dos cosas del mismo maestro, en una sola migración porque tocan la misma
-- tabla y llegan juntas: el catálogo deja de ser una lista plana de 1.634
-- nombres y pasa a poder agruparse y a poder leerse con un lector.

-- ── Categorías ───────────────────────────────────────────────────────────────
-- Un árbol no: una lista. "Categoría de producto" en una ferretería es
-- "Portátiles", "Cables", "Tóner" — un nivel alcanza, y el día que no alcance
-- se agrega `padre_id` sin romper nada de lo que ya esté clasificado.
CREATE TABLE producto_categoria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nombre      text NOT NULL CHECK (length(btrim(nombre)) > 0),
  activa      boolean NOT NULL DEFAULT true,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  creado_por  uuid NOT NULL,
  -- La misma llave compuesta que el resto del esquema, para que `producto`
  -- pueda apuntarle sin poder cruzarse de empresa.
  CONSTRAINT uq_categoria_id_empresa UNIQUE (id, empresa_id)
);

-- Dos categorías con el mismo nombre en la misma empresa no: se buscan por
-- nombre y dos "Cables" son una sola cosa mal cargada dos veces. Normalizado,
-- igual que `ix_producto_nombre`, para que "cables" y "Cables" choquen.
CREATE UNIQUE INDEX uq_categoria_nombre
  ON producto_categoria (empresa_id, fn_normalizar(nombre));

-- Mismo aislamiento que el resto: `app_empresa_id()`, no un `current_setting`
-- escrito a mano en cada tabla.
-- La aplicación se conecta como `gestion_app`: sin esto, la tabla existe y
-- nadie puede leerla. Nunca `DELETE`: acá nada se borra, se archiva.
GRANT SELECT, INSERT, UPDATE ON producto_categoria TO gestion_app, gestion_provision;

ALTER TABLE producto_categoria ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_producto_categoria_aislado ON producto_categoria
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Opcional a propósito: 1.634 productos ya importados no tienen ninguna, y no
-- se puede exigir lo que no existe. `ON DELETE RESTRICT` implícito: una
-- categoría con productos adentro no se borra, se desactiva.
ALTER TABLE producto
  ADD COLUMN categoria_id uuid,
  ADD CONSTRAINT fk_producto_categoria
    FOREIGN KEY (categoria_id, empresa_id)
    REFERENCES producto_categoria (id, empresa_id);

CREATE INDEX ix_producto_categoria ON producto (empresa_id, categoria_id)
  WHERE categoria_id IS NOT NULL;

-- ── Código de barras ─────────────────────────────────────────────────────────
-- Nulo permitido —los 1.634 importados no lo traen— y único cuando existe: dos
-- productos con el mismo código de barras harían que el lector eligiera al azar,
-- que es peor que no tenerlo. El índice parcial es lo que permite las dos cosas
-- a la vez.
ALTER TABLE producto ADD COLUMN codigo_barras text
  CHECK (codigo_barras IS NULL OR length(btrim(codigo_barras)) BETWEEN 6 AND 48);

CREATE UNIQUE INDEX uq_producto_codigo_barras
  ON producto (empresa_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL;

COMMENT ON COLUMN producto.codigo_barras IS
  'EAN-13, UPC, Code128 o lo que traiga el empaque. Se guarda tal cual: normalizarlo rompería el cruce con lo que lee el lector.';
