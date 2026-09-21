-- 0049 — Los reportes: cuándo se corrió cada uno, y los que alguien guardó.
--
-- Pasos 7 y 9 de `docs/planes/reportes.md`. Las dos tablas son del módulo
-- `reportes`, que es el único que las escribe.
--
-- Hasta acá el módulo no guardaba nada: un reporte es una consulta que se
-- corre y se tira. Estas dos tablas no cambian eso para los datos —ninguna
-- guarda filas de un reporte— sino para dos cosas que alrededor sí hay que
-- recordar.

-- ─────────────────────────────────────────────────────────────────────────────
-- reporte_corrida — quién sacó qué, y cuándo.
--
-- La pantalla la necesita para decir en cada tarjeta «la última vez que se
-- corrió». Pero se guarda sobre todo por lo otro: en un sistema contable,
-- **poder decir quién sacó la cartera de un cliente y en qué fecha** es parte
-- del rastro, igual que saber quién anuló una factura. Un reporte no escribe
-- datos, pero sí los muestra, y mostrar también deja huella.
--
-- Lo que no guarda: el resultado. Ni una fila, ni un total. Guardar la hoja
-- sería guardar una foto que envejece en silencio y que alguien leería en
-- diciembre creyendo que es de diciembre.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reporte_corrida (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,

  -- Qué se corrió: la clave de uno de los reportes fijos, o `GUARDADO` y
  -- entonces `guardado_id` dice cuál. Los fijos son pocos y los define el
  -- código —`reglas/reportes.ts`—, no una tabla: el día que se agregue uno, se
  -- amplía este CHECK en la misma migración que lo trae.
  reporte       text        NOT NULL CHECK (reporte IN (
                              'VENTAS_POR_CLIENTE', 'ANTIGUEDAD_CARTERA', 'GUARDADO'
                            )),
  guardado_id   uuid,

  -- Con qué parámetros: el rango o el corte, tal como se resolvieron. Sirve
  -- para responder «qué vio» sin tener que reconstruir qué quería decir «este
  -- mes» el día que lo corrió.
  parametros    jsonb       NOT NULL CHECK (jsonb_typeof(parametros) = 'object'),

  -- Adónde fue: a la pantalla, a un PDF o a un Excel. Un PDF es algo que se
  -- entregó; una mirada en pantalla, no. Es la diferencia que un auditor
  -- pregunta.
  formato       text        NOT NULL CHECK (formato IN ('HTML', 'PDF', 'XLSX')),

  corrido_en    timestamptz NOT NULL DEFAULT now(),
  corrido_por   uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  -- Un GUARDADO sin cuál no se entiende; un fijo con uno, tampoco.
  CONSTRAINT ck_reporte_corrida_guardado CHECK (
    (reporte = 'GUARDADO') = (guardado_id IS NOT NULL)
  )
);

-- «La última vez que se corrió»: por empresa y reporte, la más reciente.
CREATE INDEX ix_reporte_corrida_ultima
  ON reporte_corrida (empresa_id, reporte, corrido_en DESC);

COMMENT ON TABLE reporte_corrida IS
  'Cada vez que alguien sacó un reporte: cuál, con qué parámetros, en qué formato y quién. No guarda el resultado. Alimenta «la última vez que se corrió» de la pantalla y es parte del rastro: mostrar datos también deja huella.';

-- ─────────────────────────────────────────────────────────────────────────────
-- reporte_guardado — un reporte armado por alguien, con nombre propio.
--
-- Paso 9: el armador. Se parte de uno de los seis orígenes del catálogo
-- —`reglas/catalogo.ts`— y se eligen columnas, filtros, agrupación y orden.
-- Esto guarda **la pregunta, no la respuesta**: la definición, sin una sola
-- fila. Cada vez que se abre, se vuelve a correr sobre los datos de ese día.
--
-- Es de la empresa y no de quien lo armó. Un contador arma «la cartera como la
-- reviso yo» y el director la vuelve a correr: que fuera privado sería
-- inventar una restricción que nadie pidió. Pero **correrlo usa los permisos
-- de quien lo corre, no los de quien lo guardó**: eso no lo decide esta tabla,
-- lo decide el servicio contra el catálogo, cada vez.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reporte_guardado (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid        NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,

  nombre         text        NOT NULL CHECK (length(btrim(nombre)) BETWEEN 1 AND 120),

  -- Uno de los seis orígenes del catálogo. Como con los reportes fijos, la
  -- lista es del código y el CHECK la acompaña.
  origen         text        NOT NULL CHECK (origen IN (
                               'VENTAS', 'COMPRAS', 'CARTERA',
                               'INVENTARIO', 'TESORERIA', 'CONTABILIDAD'
                             )),

  -- Columnas, filtros, agrupación, orden y rango. La base no mira adentro: la
  -- forma la valida el módulo contra el catálogo **cada vez que se corre**, y
  -- no solo al guardar. Una columna que el catálogo dejó de exponer tiene que
  -- rebotar aunque haya estado en una definición vieja.
  definicion     jsonb       NOT NULL CHECK (jsonb_typeof(definicion) = 'object'),

  creado_en      timestamptz NOT NULL DEFAULT now(),
  creado_por     uuid        NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  actualizado_en timestamptz NOT NULL DEFAULT now(),

  -- Archivar y no borrar, como todo el esquema. Un reporte guardado que alguien
  -- usaba y desapareció es una pregunta que nadie sabe contestar; archivado,
  -- se sabe quién lo sacó y cuándo.
  archivado_en   timestamptz,
  archivado_por  uuid        REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT ck_reporte_guardado_archivo CHECK (
    (archivado_en IS NULL) = (archivado_por IS NULL)
  )
);

-- Dos reportes vivos con el mismo nombre en la misma empresa son uno de los
-- dos equivocado, y en la lista no se distinguen. Sin mayúsculas ni espacios
-- de más: «Cartera vencida» y «cartera vencida » son el mismo nombre para
-- quien los lee. Los archivados no cuentan: se puede volver a usar el nombre.
CREATE UNIQUE INDEX uq_reporte_guardado_nombre
  ON reporte_guardado (empresa_id, lower(btrim(nombre)))
  WHERE archivado_en IS NULL;

CREATE INDEX ix_reporte_guardado_empresa
  ON reporte_guardado (empresa_id, actualizado_en DESC)
  WHERE archivado_en IS NULL;

COMMENT ON TABLE reporte_guardado IS
  'Un reporte armado sobre uno de los seis orígenes del catálogo, con nombre propio. Guarda la definición —columnas, filtros, agrupación, orden, rango—, nunca las filas. Es de la empresa; correrlo usa los permisos de quien lo corre. Se archiva, no se borra.';

COMMENT ON COLUMN reporte_guardado.definicion IS
  'Claves del catálogo, nunca SQL. Se valida contra reglas/catalogo.ts cada vez que se corre, no solo al guardar.';

-- La corrida de un guardado apunta a él. Va acá, después de crear las dos
-- tablas, porque la de corridas se creó primero.
ALTER TABLE reporte_corrida
  ADD CONSTRAINT fk_reporte_corrida_guardado
  FOREIGN KEY (guardado_id) REFERENCES reporte_guardado (id) ON DELETE RESTRICT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Aislamiento, como todo el esquema.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE reporte_corrida ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporte_corrida FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_reporte_corrida_aislado ON reporte_corrida
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

ALTER TABLE reporte_guardado ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporte_guardado FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_reporte_guardado_aislado ON reporte_guardado
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

-- Las corridas no se editan: son un rastro. Solo se agregan y se leen.
GRANT SELECT, INSERT ON reporte_corrida TO gestion_app, gestion_provision;

-- **Y hay que quitar el UPDATE a mano.** Desde la 0044, toda tabla nueva nace
-- con SELECT, INSERT y UPDATE por los privilegios por defecto del esquema —la
-- red que se puso para que ninguna tabla saliera sin permisos—. Para esta, que
-- es un rastro, esa red otorga justo lo que no debe: un rastro que se puede
-- editar no es un rastro. Lo encontró el ensayo con ROLLBACK, no la lectura.
REVOKE UPDATE ON reporte_corrida FROM gestion_app, gestion_provision;

-- Los guardados sí se editan —renombrar, cambiar columnas, archivar—, pero no
-- se borran.
GRANT SELECT, INSERT, UPDATE ON reporte_guardado TO gestion_app, gestion_provision;
