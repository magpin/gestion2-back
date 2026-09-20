-- 0048 — Lo que se leyó de un documento, antes de que alguien lo confirme.
--
-- Paso 6a de `docs/planes/lectura-documentos.md`: el contrato del módulo
-- `lectura-documentos`, que es el único que escribe esta tabla.
--
-- Podría no existir. El progreso de una lectura cabe en memoria y el código
-- sería más corto. Se guarda por dos razones, y la segunda es la que manda:
--
--   1. El progreso sobrevive a un F5 y a que el servidor se reinicie.
--   2. Trazabilidad. En un sistema contable, poder decir «la razón social salió
--      de este RUT que subiste el 20 de septiembre» es parte del expediente, no
--      una comodidad.
--
-- Lo que esta tabla **no** es: la configuración de la empresa. Nada de
-- `extraido` vale hasta que una persona lo confirma, y cuando lo confirma lo
-- aplican los mismos servicios del asistente manual. Si la IA tuviera un camino
-- propio a la base habría dos verdades sobre cuándo un paso está completo, y la
-- que manda tiene que seguir siendo el backend.

CREATE TABLE documento_leido (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,

  -- Los tres que el asistente pide tener a mano (§7.3 de la guía). No es un
  -- catálogo: son tres, los fija la pantalla y no una norma que cambie.
  tipo                 text        NOT NULL CHECK (tipo IN (
                                     'RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN'
                                   )),

  -- La llave del objeto en el bucket, no la URL: la URL lleva el host y la
  -- firma, caduca y cambia con el entorno. Mismo criterio que
  -- `producto.imagen_clave` (0042). El archivo no pasa por la API: el navegador
  -- lo sube directo con URL firmada y el backend lo baja una sola vez.
  clave_almacenamiento text        NOT NULL CHECK (length(btrim(clave_almacenamiento)) > 0),

  estado               text        NOT NULL DEFAULT 'EN_COLA' CHECK (estado IN (
                                     'EN_COLA', 'LEYENDO', 'LEIDO', 'FALLO'
                                   )),

  -- Los `DatoExtraido`, tal como los devolvió el modelo y **sin aplicar**. La
  -- base no mira adentro: la forma la impone el esquema de la llamada y la
  -- valida el módulo. Una columna por campo ataría esta tabla a los pasos del
  -- asistente, que cambian; el jsonb no.
  --
  -- Puede tener contenido con la lectura todavía en curso: la respuesta se
  -- consume en streaming, así que los datos llegan de a poco.
  extraido             jsonb       CHECK (extraido IS NULL OR jsonb_typeof(extraido) = 'array'),

  -- Por qué no se pudo leer, en palabras que le sirvan a quien subió el
  -- archivo: «esto no parece un RUT», «no pude leer el documento ahora».
  -- Nunca la traza del error.
  error                text        CHECK (error IS NULL OR length(btrim(error)) > 0),

  creado_en            timestamptz NOT NULL DEFAULT now(),
  creado_por           uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  -- Cuándo terminó el intento, haya salido bien o mal.
  leido_en             timestamptz,

  -- El estado y las columnas que dependen de él no pueden contradecirse: un
  -- LEIDO sin datos, o un FALLO sin motivo, son filas que la pantalla no sabe
  -- mostrar. «Detener» (§7.7) cae acá como FALLO con su razón.
  CONSTRAINT ck_documento_leido_estado CHECK (
    CASE estado
      WHEN 'LEIDO' THEN extraido IS NOT NULL AND leido_en IS NOT NULL AND error IS NULL
      WHEN 'FALLO' THEN error    IS NOT NULL AND leido_en IS NOT NULL
      ELSE               error    IS NULL     AND leido_en IS NULL
    END
  )
);

-- Un tipo de documento no se lee dos veces a la vez en la misma empresa: la
-- tarjeta tiene una fila por tipo, y dos lecturas en curso sobre esa fila son
-- un doble clic, no una intención.
--
-- Los intentos terminados —LEIDO o FALLO— sí se acumulan: son el historial, y
-- volver a subir el RUT porque el primero salió mal es justamente lo que la
-- guía ofrece. La pantalla muestra el más reciente de cada tipo.
CREATE UNIQUE INDEX uq_documento_leido_en_curso
  ON documento_leido (empresa_id, tipo)
  WHERE estado IN ('EN_COLA', 'LEYENDO');

-- «Lo leído hasta ahora»: el último intento de cada tipo, por empresa.
CREATE INDEX ix_documento_leido_empresa
  ON documento_leido (empresa_id, tipo, creado_en DESC);

COMMENT ON TABLE documento_leido IS
  'Un archivo que el asistente leyó —RUT, Cámara de Comercio, resolución DIAN— y los hechos que propuso a partir de él. Propone; nada se aplica hasta que una persona confirma, y lo aplican los servicios del asistente manual. Se guarda para que el progreso sobreviva a un F5 y para poder decir de qué documento salió cada dato.';

COMMENT ON COLUMN documento_leido.clave_almacenamiento IS
  'La llave del objeto en el bucket (p. ej. documentos/<empresa>/<uuid>.pdf). La URL se firma al leer, no se guarda.';

COMMENT ON COLUMN documento_leido.extraido IS
  'Arreglo de DatoExtraido: paso, campo, valor, etiqueta, fuente y confianza. Sin aplicar. Lo marcado DUDOSA no se aplica nunca: se pregunta.';

ALTER TABLE documento_leido ENABLE ROW LEVEL SECURITY;
ALTER TABLE documento_leido FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_documento_leido_aislado ON documento_leido
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Sin DELETE, como todo el esquema: el intento fallido es historial, no basura.
GRANT SELECT, INSERT, UPDATE ON documento_leido TO gestion_app, gestion_provision;
