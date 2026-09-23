-- 0067 — Varios documentos de una vez: el lote.
--
-- Tanda 3 del diseño de María (`docs/planes/maria.md` §11, prototipos
-- `Main.dc.html` y `Procesando.dc.html`). Hasta acá un archivo era un POST y
-- una fila suelta, y la pantalla adivinaba qué se había subido junto mirando
-- la hora (dos minutos de ventana). Con veinte facturas soltadas de una eso
-- deja de alcanzar: hace falta la llave que las agrupe, y un orden.
--
-- Dos tablas y no una columna en `documento_leido`, porque **no todo archivo
-- del lote termina siendo una lectura**: un extracto, un Excel o una factura
-- de venta se reconocen y se dicen, pero no se leen. Esos archivos existieron
-- igual —la persona los soltó— y el lote tiene que poder decir qué pasó con
-- cada uno.
--
-- Y una decisión nueva sobre las lecturas: **se pueden descartar**. «Es la
-- misma, descartala» sobre un posible duplicado tiene que quedar escrito —quién,
-- cuándo y por qué—, y la lectura tiene que dejar de contar como pendiente.
-- Es un estado y no una marca aparte para que todo lo que ya pregunta por
-- `estado = 'LEIDO'` —los pendientes, la revisión— la deje afuera sin cambiar
-- una línea.

CREATE TABLE lote_lectura (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  creado_por    uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  -- Cuándo terminó de pasar por todos, bien o mal. NULL = sigue.
  terminado_en  timestamptz,
  -- Alguien apretó «Detener»: lo que quedaba en cola no se lee.
  detenido      boolean     NOT NULL DEFAULT false,

  CONSTRAINT uq_lote_lectura_id_empresa UNIQUE (id, empresa_id)
);

CREATE INDEX ix_lote_lectura_empresa ON lote_lectura (empresa_id, creado_en DESC);

CREATE TABLE lote_archivo (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid        NOT NULL,
  lote_id               uuid        NOT NULL,
  -- El orden en que se soltaron: es el orden en que se leen.
  orden                 smallint    NOT NULL CHECK (orden >= 0),
  -- Como lo llamó el navegador («FC-0231.pdf»). Es lo que la persona reconoce.
  nombre                text        NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 255),
  clave_almacenamiento  text        NOT NULL CHECK (length(btrim(clave_almacenamiento)) > 0),

  --   EN_COLA   esperando su turno
  --   MIRANDO   María está diciendo qué es
  --   DERIVADO  es algo que ella lee: el resto lo cuenta `documento_leido`
  --   NO_SE_LEE se reconoció y no es algo que ella lea (o no le toca a quien lo subió)
  --   DETENIDO  alguien paró el lote antes de que le tocara
  estado                text        NOT NULL DEFAULT 'EN_COLA' CHECK (estado IN (
                                      'EN_COLA', 'MIRANDO', 'DERIVADO', 'NO_SE_LEE', 'DETENIDO'
                                    )),
  -- Lo que dijo al mirarlo: «Factura de compra», y dos frases.
  clase                 text,
  resumen               text,
  -- Por qué no se lee, en palabras de quien lo va a leer.
  motivo                text,
  documento_leido_id    uuid        REFERENCES documento_leido (id) ON DELETE SET NULL,

  CONSTRAINT uq_lote_archivo_orden UNIQUE (lote_id, orden),
  CONSTRAINT fk_lote_archivo_lote
    FOREIGN KEY (lote_id, empresa_id)
    REFERENCES lote_lectura (id, empresa_id) ON DELETE CASCADE,
  -- Derivado = tiene su lectura; no se lee = dice por qué.
  CONSTRAINT ck_lote_archivo_estado CHECK (
    CASE estado
      WHEN 'DERIVADO'  THEN documento_leido_id IS NOT NULL
      WHEN 'NO_SE_LEE' THEN motivo IS NOT NULL
      ELSE true
    END
  )
);

CREATE INDEX ix_lote_archivo_documento
  ON lote_archivo (documento_leido_id) WHERE documento_leido_id IS NOT NULL;

COMMENT ON TABLE lote_lectura IS
  'Varios archivos soltados juntos en el chat de Maria. Se leen de a uno, en orden, y cada uno queda en lote_archivo con lo que paso: se leyo, no era algo que ella lea, o se detuvo antes.';
COMMENT ON TABLE lote_archivo IS
  'Un archivo de un lote. Si era algo que Maria lee, apunta a su documento_leido y el estado de la lectura es el de esa fila; si no, dice por que.';

ALTER TABLE lote_lectura ENABLE ROW LEVEL SECURITY;
ALTER TABLE lote_lectura FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_lote_lectura_aislado ON lote_lectura
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

ALTER TABLE lote_archivo ENABLE ROW LEVEL SECURITY;
ALTER TABLE lote_archivo FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_lote_archivo_aislado ON lote_archivo
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Sin DELETE, como todo el esquema.
GRANT SELECT, INSERT, UPDATE ON lote_lectura, lote_archivo TO gestion_app, gestion_provision;

-- ─── Descartar una lectura ──────────────────────────────────────────────────

ALTER TABLE documento_leido
  ADD COLUMN descartado_en    timestamptz,
  ADD COLUMN descartado_por   uuid REFERENCES usuario (id) ON DELETE RESTRICT,
  ADD COLUMN motivo_descarte  text CHECK (motivo_descarte IS NULL OR length(btrim(motivo_descarte)) > 0);

ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_estado_check;
ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_estado_check
  CHECK (estado IN ('EN_COLA', 'LEYENDO', 'LEIDO', 'FALLO', 'DESCARTADO'));

-- Descartada = se había leído, y alguien dijo quién, cuándo y por qué la dejó.
ALTER TABLE documento_leido DROP CONSTRAINT ck_documento_leido_estado;
ALTER TABLE documento_leido ADD CONSTRAINT ck_documento_leido_estado CHECK (
  CASE estado
    WHEN 'LEIDO'      THEN extraido IS NOT NULL AND leido_en IS NOT NULL AND error IS NULL
    WHEN 'FALLO'      THEN error    IS NOT NULL AND leido_en IS NOT NULL
    WHEN 'DESCARTADO' THEN extraido IS NOT NULL AND leido_en IS NOT NULL AND error IS NULL
                           AND descartado_en IS NOT NULL AND descartado_por IS NOT NULL
                           AND motivo_descarte IS NOT NULL
    ELSE                   error    IS NULL     AND leido_en IS NULL
  END
);

ALTER TABLE documento_leido ADD CONSTRAINT ck_documento_leido_descarte CHECK (
  (estado = 'DESCARTADO') = (descartado_en IS NOT NULL)
);

COMMENT ON COLUMN documento_leido.motivo_descarte IS
  'Por que una persona dejo esta lectura sin registrar: «es la misma que CC-0924». Se escribe al descartar y no cambia.';
