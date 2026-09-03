-- =============================================================================
-- 0014_ficha_empresa_catalogos — enganchar la ficha a los catálogos normativos
-- =============================================================================
-- Hasta 0013 la ficha de empresa guardaba códigos sueltos validados con CHECK y
-- descripciones que digitaba el usuario. Esto los amarra a los catálogos: un CIIU
-- inexistente, un tipo de documento inventado o una responsabilidad fuera del
-- anexo técnico dejan de ser posibles a nivel de motor.
--
-- ORDEN DE APLICACIÓN: exige 0012 (CIIU) y 0013 (catálogos RUT) ya aplicadas.
--
-- SI ALGUNA DE ESTAS FK FALLA es porque hay filas con códigos que no existen en
-- el catálogo. No aflojes la restricción: corrige el dato. Para ver qué estorba:
--   SELECT DISTINCT codigo_ciiu FROM empresa_actividad_economica
--     WHERE codigo_ciiu NOT IN (SELECT codigo FROM ciiu_clase);
--   SELECT DISTINCT tipo_documento FROM tercero
--     WHERE tipo_documento NOT IN (SELECT codigo FROM tipo_documento_identidad);

-- -----------------------------------------------------------------------------
-- Actividad económica -> ciiu_clase
-- -----------------------------------------------------------------------------
-- La columna era varchar(6) con un CHECK de 4 dígitos: dos reglas que decían lo
-- mismo a medias. Ahora el tipo y el catálogo dicen lo mismo entero.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname AS restriccion
      FROM pg_constraint con
      JOIN pg_class     cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = 'public'
       AND con.contype = 'c'
       AND cl.relname = 'empresa_actividad_economica'
       AND pg_get_constraintdef(con.oid) LIKE '%codigo_ciiu ~%'
  LOOP
    EXECUTE format('ALTER TABLE empresa_actividad_economica DROP CONSTRAINT %I', r.restriccion);
  END LOOP;
END
$$;

ALTER TABLE empresa_actividad_economica
  ALTER COLUMN codigo_ciiu TYPE char(4) USING btrim(codigo_ciiu);

ALTER TABLE empresa_actividad_economica
  ADD CONSTRAINT fk_actividad_ciiu FOREIGN KEY (codigo_ciiu) REFERENCES ciiu_clase (codigo);

-- La descripción sigue siendo obligatoria y NO se reemplaza por un JOIN a propósito:
-- el CIIU cambia de versión (7110 se partió en 7111/7112 en 2020) y la actividad
-- declarada en el RUT de hace tres años tiene que seguir leyéndose como se declaró.
-- La aplicación la copia de ciiu_clase al momento de abrir la fila y ahí se queda.
COMMENT ON COLUMN empresa_actividad_economica.descripcion IS
  'Descripcion congelada al momento de registrar la actividad. No se refresca desde ciiu_clase: el catalogo CIIU cambia de version y el RUT historico no.';

-- -----------------------------------------------------------------------------
-- Empresa -> forma_asociativa (RUT casilla 63)
-- -----------------------------------------------------------------------------
-- Faltaba por completo. Sin esto no se puede imprimir "S.A.S." en ningún lado ni
-- llenar la casilla 63 al renovar el RUT.
ALTER TABLE empresa
  ADD COLUMN forma_asociativa_codigo char(2) REFERENCES forma_asociativa (codigo);

-- Una persona natural no tiene forma asociativa. Una jurídica puede no tenerla
-- cargada todavía, así que se permite NULL en ambas — lo que se prohíbe es el
-- absurdo de una natural con tipo societario.
ALTER TABLE empresa
  ADD CONSTRAINT ck_empresa_forma_asociativa CHECK (
    tipo_persona = 'JURIDICA' OR forma_asociativa_codigo IS NULL
  );

COMMENT ON COLUMN empresa.forma_asociativa_codigo IS
  'RUT casilla 63. Solo personas juridicas. 12 = S.A.S.';

-- -----------------------------------------------------------------------------
-- Tipos de documento -> tipo_documento_identidad
-- -----------------------------------------------------------------------------
-- El mismo enum estaba escrito a mano en dos CHECK distintos y con listas
-- distintas: 'tercero' aceptaba once valores y 'empresa_representante' cinco.
-- Ahora los dos apuntan al mismo catálogo.
--
-- Los CHECK se crearon sin nombre, así que los bautizó Postgres. Se buscan por su
-- definición y no por el nombre que uno supone: si el nombre no coincidiera, un
-- 'DROP CONSTRAINT IF EXISTS' no haría nada y la lista vieja seguiría rechazando
-- los tipos nuevos ('TE', 'PATRIMONIO_AUTONOMO') sin que nadie se entere.
-- El filtro '= ANY' acota a los CHECK de lista y deja quieto 'ck_tercero_dv',
-- que también menciona la columna.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT cl.relname AS tabla, con.conname AS restriccion
      FROM pg_constraint con
      JOIN pg_class     cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = 'public'
       AND con.contype = 'c'
       AND cl.relname IN ('tercero', 'empresa_representante')
       AND pg_get_constraintdef(con.oid) LIKE '%tipo_documento = ANY%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tabla, r.restriccion);
  END LOOP;
END
$$;

ALTER TABLE tercero
  ADD CONSTRAINT fk_tercero_tipo_documento
    FOREIGN KEY (tipo_documento) REFERENCES tipo_documento_identidad (codigo);

ALTER TABLE empresa_representante
  ADD CONSTRAINT fk_representante_tipo_documento
    FOREIGN KEY (tipo_documento) REFERENCES tipo_documento_identidad (codigo);

-- -----------------------------------------------------------------------------
-- Responsabilidad fiscal del tercero -> responsabilidad_fiscal_fe
-- -----------------------------------------------------------------------------
-- El CHECK solo verificaba la FORMA del código ('^[A-Z]-[0-9]{2}...'), así que
-- 'X-99' pasaba y llegaba al XML de la DIAN a que lo rechazaran allá.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname AS restriccion
      FROM pg_constraint con
      JOIN pg_class     cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = 'public'
       AND con.contype = 'c'
       AND cl.relname = 'tercero_responsabilidad_fiscal'
       AND pg_get_constraintdef(con.oid) LIKE '%codigo ~%'
  LOOP
    EXECUTE format('ALTER TABLE tercero_responsabilidad_fiscal DROP CONSTRAINT %I', r.restriccion);
  END LOOP;
END
$$;

ALTER TABLE tercero_responsabilidad_fiscal
  ADD CONSTRAINT fk_responsabilidad_fe
    FOREIGN KEY (codigo) REFERENCES responsabilidad_fiscal_fe (codigo);

-- -----------------------------------------------------------------------------
-- Responsabilidades del RUT de la empresa (casilla 53) — histórica
-- -----------------------------------------------------------------------------
-- 'empresa_regimen_tributario' guarda la condición en el vocabulario del software
-- ('RESPONSABLE_IVA', 'GRAN_CONTRIBUYENTE'). Esto guarda el RUT literal: los
-- códigos tal como los imprime la DIAN en la casilla 53. Son dos cosas distintas y
-- las dos hacen falta — una la lee el motor de impuestos, la otra la exige un
-- requerimiento cuando pregunta qué decía el RUT en una fecha.
CREATE TABLE empresa_responsabilidad_rut (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid        NOT NULL REFERENCES empresa (id),
  codigo       smallint    NOT NULL REFERENCES responsabilidad_tributaria (codigo),
  fecha_inicio date        NOT NULL,
  fecha_fin    date,
  creado_en    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_responsabilidad_rut_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

-- Una misma responsabilidad no puede estar abierta dos veces a la vez.
CREATE UNIQUE INDEX ux_responsabilidad_rut_vigente
  ON empresa_responsabilidad_rut (empresa_id, codigo)
  WHERE fecha_fin IS NULL;

CREATE INDEX ix_responsabilidad_rut_empresa ON empresa_responsabilidad_rut (empresa_id);

COMMENT ON TABLE empresa_responsabilidad_rut IS
  'Casilla 53 del RUT de la empresa, con vigencia. Historica: no se edita, se cierra con fecha_fin y se abre otra fila.';

ALTER TABLE empresa_responsabilidad_rut ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_responsabilidad_rut FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_responsabilidad_rut_aislada ON empresa_responsabilidad_rut
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, UPDATE ON empresa_responsabilidad_rut TO gestion_app, gestion_provision;
