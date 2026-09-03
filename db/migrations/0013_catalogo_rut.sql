-- =============================================================================
-- 0013_catalogo_rut — catálogos normativos del RUT (DIAN IN-CAC-0237 v3)
-- =============================================================================
-- Cinco catálogos NORMATIVOS: los define la DIAN, no se editan por empresa.
-- Sin empresa_id, sin RLS, solo lectura para la API.
--
--   Casilla 24 -> tipo_contribuyente
--   Casilla 25 -> tipo_documento_identidad
--   Casilla 53 -> responsabilidad_tributaria  (Responsabilidades, Calidades y Atributos)
--   Casilla 63 -> forma_asociativa
--   Anexo FE   -> responsabilidad_fiscal_fe
--
-- Los códigos NO son consecutivos: la DIAN suprime códigos y nunca los reutiliza.
-- Por eso nada se borra — se marca vigente = false y se enlaza codigo_reemplazo.
-- Un RUT de 2017 con el código 11 tiene que seguir siendo legible en 2030.
--
-- OJO — el RUT y la facturación electrónica son dos numeraciones distintas:
--   * El RUT numera con enteros (13 = gran contribuyente, 48 = responsable de IVA).
--   * El anexo técnico de FE numera con texto (O-13, O-48) y solo cubre seis de las
--     48 responsabilidades, más un R-99-PN que en el RUT no existe.
-- La fuente es el RUT; el código de FE se deriva al armar el XML. Por eso son dos
-- tablas enlazadas y no una columna extra: la relación no es uno a uno.

-- -----------------------------------------------------------------------------
-- Casilla 24 — Tipo de contribuyente
-- -----------------------------------------------------------------------------
CREATE TABLE tipo_contribuyente (
  codigo       smallint PRIMARY KEY,
  descripcion  text     NOT NULL,
  -- Equivalencia con empresa.tipo_persona / tercero.tipo_persona.
  tipo_persona text     NOT NULL CHECK (tipo_persona IN ('JURIDICA', 'NATURAL'))
);

COMMENT ON TABLE tipo_contribuyente IS
  'RUT casilla 24. Fuente: DIAN IN-CAC-0237 v3.';

INSERT INTO tipo_contribuyente (codigo, descripcion, tipo_persona) VALUES
  (1, 'Persona jurídica y asimiladas',        'JURIDICA'),
  (2, 'Persona natural o sucesión ilíquida',  'NATURAL');

-- -----------------------------------------------------------------------------
-- Casilla 25 — Tipo de documento de identificación
-- -----------------------------------------------------------------------------
-- La clave primaria es el código corto de texto ('CC', 'NIT', ...) porque es el que
-- usa el código de la aplicación y el que ya estaba escrito en los CHECK de
-- 'tercero' y 'empresa_representante'. Las dos numeraciones oficiales cuelgan de él.
CREATE TABLE tipo_documento_identidad (
  codigo          text     PRIMARY KEY CHECK (codigo ~ '^[A-Z_]{2,20}$'),
  descripcion     text     NOT NULL,
  -- Casilla 25 del RUT. NULL = el RUT no tiene un código propio para este tipo.
  codigo_rut      smallint UNIQUE,
  -- Anexo técnico de facturación electrónica DIAN. Va en el XML del receptor.
  codigo_dian_fe  smallint,
  aplica_persona  text     NOT NULL DEFAULT 'AMBAS'
                           CHECK (aplica_persona IN ('NATURAL', 'JURIDICA', 'AMBAS')),
  vigente         boolean  NOT NULL DEFAULT true
);

COMMENT ON TABLE tipo_documento_identidad IS
  'RUT casilla 25 + anexo tecnico de facturacion electronica. Fuente: DIAN IN-CAC-0237 v3.';
COMMENT ON COLUMN tipo_documento_identidad.codigo_dian_fe IS
  'Codigo del anexo tecnico de FE. VERIFICAR contra el anexo vigente antes de transmitir: los marcados abajo no coinciden con la casilla 25 del RUT.';

INSERT INTO tipo_documento_identidad (codigo, descripcion, codigo_rut, codigo_dian_fe, aplica_persona) VALUES
  -- Estos siete coinciden en las dos numeraciones.
  ('RC',              'Registro civil de nacimiento',                                 11, 11, 'NATURAL'),
  ('TI',              'Tarjeta de identidad',                                         12, 12, 'NATURAL'),
  ('CC',              'Cédula de ciudadanía',                                         13, 13, 'NATURAL'),
  ('CE',              'Cédula de extranjería',                                        22, 22, 'NATURAL'),
  ('NIT',             'NIT',                                                          31, 31, 'AMBAS'),
  ('PA',              'Pasaporte',                                                    41, 41, 'NATURAL'),
  ('DOC_EXTRANJERO',  'Documento de identificación de extranjero',                    42, 42, 'NATURAL'),
  -- VERIFICAR: solo existen en una de las dos numeraciones, o difieren entre ellas.
  ('CERT_REGISTRADURIA', 'Certificado Registraduría sin identificación',              14, NULL, 'NATURAL'),
  ('ID_EXTRANJERO_DIAN', 'Identificación de extranjeros diferente a NIT (DIAN)',      33, NULL, 'AMBAS'),
  ('SIN_ID_EXTERIOR', 'Sin identificación del exterior o para uso definido DIAN',     43, NULL, 'AMBAS'),
  ('PPT',             'Permiso por Protección Temporal',                              48, 48, 'NATURAL'),
  ('PATRIMONIO_AUTONOMO', 'Patrimonio autónomo',                                      61, NULL, 'JURIDICA'),
  ('TE',              'Tarjeta de extranjería',                                     NULL, 21, 'NATURAL'),
  ('PEP',             'Permiso Especial de Permanencia',                            NULL, 47, 'NATURAL'),
  ('NIT_EXTRANJERO',  'NIT de otro país',                                           NULL, 50, 'AMBAS'),
  ('NUIP',            'NUIP',                                                       NULL, 91, 'NATURAL');

-- -----------------------------------------------------------------------------
-- Casilla 63 — Formas asociativas (tipo societario)
-- -----------------------------------------------------------------------------
-- Solo aplica a personas jurídicas. La S.A.S. es el código 12.
CREATE TABLE forma_asociativa (
  codigo       char(2) PRIMARY KEY CHECK (codigo ~ '^[0-9]{2}$'),
  descripcion  text    NOT NULL
);

COMMENT ON TABLE forma_asociativa IS
  'RUT casilla 63. Fuente: DIAN IN-CAC-0237 v3. Solo personas juridicas.';

INSERT INTO forma_asociativa (codigo, descripcion) VALUES
  ('01', 'Comunidad organizada asimilada a una limitada'),
  ('02', 'Empresa unipersonal'),
  ('03', 'Sociedad anónima'),
  ('04', 'Sociedad colectiva'),
  ('05', 'Sociedad de gestión colectiva de derechos de autor o conexos'),
  ('06', 'Sociedad de hecho'),
  ('07', 'Sociedad en comandita simple'),
  ('08', 'Sociedad en comandita por acciones'),
  ('09', 'Sociedad civil'),
  ('10', 'Sociedad limitada'),
  ('11', 'Sociedad ordinaria de minas'),
  ('12', 'Sociedad por acciones simplificada');

-- -----------------------------------------------------------------------------
-- Casilla 53 — Responsabilidades, Calidades y Atributos
-- -----------------------------------------------------------------------------
CREATE TABLE responsabilidad_tributaria (
  codigo            smallint PRIMARY KEY,
  descripcion       text     NOT NULL,
  vigente           boolean  NOT NULL DEFAULT true,
  codigo_reemplazo  smallint REFERENCES responsabilidad_tributaria (codigo),
  observacion       text,
  fuente            text     NOT NULL DEFAULT 'DIAN IN-CAC-0237 v3'
);

COMMENT ON TABLE  responsabilidad_tributaria IS
  'Catalogo casilla 53 del RUT (Responsabilidades, Calidades y Atributos). Fuente: DIAN IN-CAC-0237 v3.';
COMMENT ON COLUMN responsabilidad_tributaria.vigente IS
  'false = codigo suprimido o reemplazado. Se conserva para poder leer RUT historicos.';
COMMENT ON COLUMN responsabilidad_tributaria.codigo_reemplazo IS
  'Codigo vigente que sustituyo a este, cuando aplica.';

-- Códigos VIGENTES (Instructivo v3, sección 31).
INSERT INTO responsabilidad_tributaria (codigo, descripcion) VALUES
  ( 1, 'Aporte especial para la administración de justicia'),
  ( 2, 'Gravamen a los movimientos financieros'),
  ( 3, 'Impuesto al patrimonio'),
  ( 4, 'Impuesto sobre la renta y complementario régimen tributario especial'),
  ( 5, 'Impuesto sobre la renta y complementario régimen ordinario'),
  ( 6, 'Declaración de ingresos y patrimonio'),
  ( 7, 'Retención en la fuente a título de renta'),
  ( 8, 'Retención impuesto de timbre nacional'),
  ( 9, 'Retención en la fuente en el impuesto sobre las ventas'),
  (10, 'Obligado aduanero'),
  (13, 'Gran contribuyente'),
  (14, 'Informante de exógena'),
  (15, 'Autorretenedor'),
  (16, 'Obligación facturar por ingresos bienes y/o servicios excluidos'),
  (17, 'Profesionales de compra y venta de divisas'),
  (18, 'Precios de transferencia'),
  (19, 'Productor de bienes y/o servicios exentos (incluye exportadores)'),
  (20, 'Obtención NIT'),
  (21, 'Declarar ingreso o salida del país de divisas o moneda legal'),
  (22, 'Obligado a cumplir deberes formales a nombre de terceros'),
  (23, 'Agente de retención en ventas'),
  (26, 'Declaración individual precios de transferencia'),
  (32, 'Impuesto nacional a la gasolina y al ACPM'),
  (33, 'Impuesto nacional al consumo'),
  (36, 'Establecimiento permanente'),
  (39, 'Proveedor de servicios tecnológicos PST'),
  (41, 'Declaración anual de activos en el exterior'),
  (42, 'Obligado a llevar contabilidad'),
  (45, 'Autorretenedor de rendimientos financieros'),
  (46, 'IVA prestadores de servicios desde el exterior'),
  (47, 'Régimen simple de tributación – SIMPLE'),
  (48, 'Impuesto sobre las ventas – IVA'),
  (49, 'No responsable de IVA'),
  (50, 'No responsable de consumo restaurantes y bares'),
  (52, 'Facturador electrónico'),
  (53, 'Persona jurídica no responsable de IVA'),
  (54, 'Intercambio automático de información CRS'),
  (55, 'Informante de beneficiarios finales'),
  (56, 'Impuesto nacional al carbono'),
  (58, 'Intercambio automático de información FATCA'),
  (59, 'Autorretención especial renta'),
  (60, 'Autorretención intereses y rendimientos financieros (entidades vigiladas Superfinanciera)'),
  (61, 'Autorretención comisiones (entidades vigiladas Superfinanciera)'),
  (62, 'Impuesto nacional productos plásticos de un solo uso para envasar/embalar/empacar'),
  (63, 'Impuesto a las bebidas ultraprocesadas azucaradas'),
  (64, 'Impuesto a los comestibles ultraprocesados / alto contenido de azúcar, sodio o grasas'),
  (65, 'Renta – Presencia económica significativa en Colombia (PES)'),
  (66, 'Intercambio automático de información DPI');

-- Códigos SUPRIMIDOS. Se insertan como no vigentes para poder leer RUT antiguos.
INSERT INTO responsabilidad_tributaria (codigo, descripcion, vigente, codigo_reemplazo, observacion) VALUES
  (11, 'Ventas régimen común',        false, 48, 'Suprimido con la reestructuración del IVA (Ley 1943/2018, 2010/2019).'),
  (12, 'Ventas régimen simplificado', false, 49, 'Suprimido con la reestructuración del IVA (Ley 1943/2018, 2010/2019).');

-- Suprimidos confirmados por la DIAN pero sin descripción oficial publicada.
-- Existen solo para no romper la integridad al leer un RUT antiguo.
-- Completar 'descripcion' si aparece en un RUT real. No inventar.
INSERT INTO responsabilidad_tributaria (codigo, descripcion, vigente, observacion) VALUES
  (24, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (25, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (27, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (28, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (29, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (30, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (31, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (34, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.'),
  (35, '(código histórico suprimido - descripción no publicada por DIAN)', false, 'Obsoleto. Completar al hallarlo en un RUT original.');

-- Los números 37, 38, 40, 43, 44, 51, 57 no se insertan: no hay evidencia de que
-- hayan sido responsabilidades válidas. Si llega uno, se revisa el RUT antes de crearlo.

-- -----------------------------------------------------------------------------
-- Responsabilidades que viajan en el XML de facturación electrónica
-- -----------------------------------------------------------------------------
-- Catálogo aparte y no una columna de la tabla de arriba porque no hay
-- correspondencia uno a uno: de las 48 responsabilidades del RUT solo seis llegan
-- al XML, y R-99-PN ('no aplica') no es una responsabilidad del RUT en absoluto —
-- es el relleno que exige el anexo cuando el receptor no tiene ninguna.
--
-- Es la tabla contra la que valida tercero_responsabilidad_fiscal.codigo (ver 0014).
CREATE TABLE responsabilidad_fiscal_fe (
  codigo       text     PRIMARY KEY CHECK (codigo ~ '^[A-Z]-[0-9]{2}(-[A-Z]{2})?$'),
  descripcion  text     NOT NULL,
  -- Responsabilidad del RUT de la que se deriva. NULL = no nace del RUT.
  codigo_rut   smallint REFERENCES responsabilidad_tributaria (codigo)
);

COMMENT ON TABLE responsabilidad_fiscal_fe IS
  'Responsabilidades fiscales del anexo tecnico de facturacion electronica DIAN. VERIFICAR contra el anexo vigente antes de transmitir a produccion.';

INSERT INTO responsabilidad_fiscal_fe (codigo, descripcion, codigo_rut) VALUES
  ('O-13',    'Gran contribuyente',                                 13),
  ('O-15',    'Autorretenedor',                                     15),
  ('O-23',    'Agente de retención en el impuesto sobre las ventas', 23),
  ('O-47',    'Régimen simple de tributación',                      47),
  ('O-48',    'Impuesto sobre las ventas – IVA',                    48),
  ('O-49',    'No responsable de IVA',                              49),
  ('R-99-PN', 'No aplica – otros',                                NULL);

-- -----------------------------------------------------------------------------
-- Privilegios — cinco catálogos compartidos, sin RLS
-- -----------------------------------------------------------------------------
GRANT SELECT ON tipo_contribuyente, tipo_documento_identidad, forma_asociativa,
                responsabilidad_tributaria, responsabilidad_fiscal_fe
  TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON tipo_contribuyente, tipo_documento_identidad, forma_asociativa,
                                responsabilidad_tributaria, responsabilidad_fiscal_fe
  TO gestion_provision;
