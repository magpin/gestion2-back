-- =============================================================================
-- 0074 — Retenciones: la ley, cargada y con vigencias
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 0 (§0.2 y §0.5).
-- Cifras: docs/planes/especificacion-motor-retenciones.md §4, validadas por el
-- contador Yeris el 25-09-2026.
--
-- Hasta hoy cada empresa cargaba a mano, año por año, sus conceptos y tarifas
-- (`retencion_concepto`, 0043). Eso tiene dos problemas: una tarifa mal
-- digitada se retiene mal sin que nadie lo note, y la norma cambió tres veces
-- en 2026 —el Decreto 572/2025, su suspensión provisional y su
-- restablecimiento— y un catálogo «por año» no puede decir qué regía el 15 de
-- junio. Acá la ley queda una sola vez, igual para todas las empresas, con
-- fecha de inicio y de fin de cada tarifa.
--
-- Estas tablas **no son de nadie**, como los catálogos de CIIU y PUC
-- (0012–0015): sin `empresa_id` ni RLS. La app solo las lee; las escriben las
-- migraciones y la consola de plataforma (`gestion_provision`).
--
-- Una tarifa vigente nunca se edita: se cierra con `vigencia_hasta` y se abre
-- otra. Por eso las vigencias de un mismo concepto no se pueden cruzar
-- (`EXCLUDE`), y por eso cada fila dice de qué norma sale y quién la validó.

-- La restricción de «no se cruzan» compara rangos de fechas junto con valores
-- comunes; eso pide `btree_gist`.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- UVT: ya era de todos (0043). Suma de dónde sale el valor y quién lo validó.
-- -----------------------------------------------------------------------------
ALTER TABLE uvt
  ADD COLUMN norma        text,
  ADD COLUMN validado_por text,
  ADD COLUMN validado_en  date;

-- Si una empresa había cargado a mano un valor distinto, gana el validado
-- (R-D4). El anterior queda en la tabla de registro de esta migración.
CREATE TABLE retencion_migracion_registro (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  migracion   text        NOT NULL,
  que         text        NOT NULL,
  detalle     jsonb       NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON retencion_migracion_registro TO gestion_provision;

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0074', 'UVT_REEMPLAZADA',
       jsonb_build_object('anio', u.anio, 'valor_anterior', u.valor, 'valor_nuevo', s.valor)
  FROM uvt u
  JOIN (VALUES (2024, 47065.00), (2025, 49799.00), (2026, 52374.00)) AS s (anio, valor)
    ON s.anio = u.anio
 WHERE u.valor <> s.valor;

INSERT INTO uvt (anio, valor, norma, validado_por, validado_en) VALUES
  (2024, 47065.00, 'Resolución DIAN 187 de 2023', 'Yeris', '2026-09-25'),
  (2025, 49799.00, 'Resolución DIAN 193 de 2024', 'Yeris', '2026-09-25'),
  (2026, 52374.00, 'Resolución DIAN 000238 del 15-12-2025', 'Yeris', '2026-09-25')
ON CONFLICT (anio) DO UPDATE
   SET valor = EXCLUDED.valor,
       norma = EXCLUDED.norma,
       validado_por = EXCLUDED.validado_por,
       validado_en = EXCLUDED.validado_en;

GRANT INSERT, UPDATE ON uvt TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Conceptos de la ley
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_concepto_nacional (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo                text        NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z0-9_]+$'),
  nombre                text        NOT NULL CHECK (length(btrim(nombre)) > 0),
  impuesto              text        NOT NULL CHECK (impuesto IN ('RENTA', 'IVA', 'ICA')),
  -- La tarifa depende de si el beneficiario declara renta.
  usa_declarante        boolean     NOT NULL DEFAULT false,
  -- Honorarios de persona natural: cambia la tarifa al cruzar un acumulado anual.
  usa_acumulado_anual   boolean     NOT NULL DEFAULT false,
  umbral_acumulado_uvt  numeric(12,2),
  -- ReteIVA: la base es el IVA, no el subtotal.
  base_es_iva           boolean     NOT NULL DEFAULT false,
  -- Servicios temporales, vigilancia y aseo: la base puede ser solo el AIU.
  -- Lo define el contador (R-D3); arranca en false.
  base_es_aiu           boolean     NOT NULL DEFAULT false,
  -- La subcuenta del PUC donde va lo retenido (agente) y lo que nos retienen
  -- (sujeto). La cuenta real de cada empresa es una auxiliar de esta.
  subcuenta_pasivo      varchar(6)  NOT NULL,
  subcuenta_activo      varchar(6)  NOT NULL,
  -- Desempate cuando dos fuentes proponen conceptos distintos.
  prioridad             smallint    NOT NULL DEFAULT 100,
  activo                boolean     NOT NULL DEFAULT true,
  CONSTRAINT ck_concepto_umbral CHECK (NOT usa_acumulado_anual OR umbral_acumulado_uvt IS NOT NULL)
);

COMMENT ON TABLE retencion_concepto_nacional IS
  'Catálogo de conceptos de retención de la ley. Igual para todas las empresas. Plan motor de retenciones, Fase 0.';

GRANT SELECT ON retencion_concepto_nacional TO gestion_app, gestion_provision;
GRANT INSERT, UPDATE ON retencion_concepto_nacional TO gestion_provision;

-- Subcuentas del PUC (Decreto 2650), verificadas contra `cuenta_puc` (0015):
-- 236515 honorarios, 236520 comisiones, 236525 servicios, 236530
-- arrendamientos, 236535 rendimientos financieros, 236540 compras, 236545
-- loterías, 236570 otras; 2367 IVA retenido; 2368 ICA retenido; 135515
-- retención en la fuente que nos practican.
--
-- OJO (R-D12): lo que nos retienen de IVA y de ICA no tiene subcuenta propia
-- en el PUC oficial (la 1355 solo trae 05, 10, 15, 20, 25, 30 y 95). La
-- especificación usa 135517 y 135518, que muchas empresas crean como
-- auxiliares. Hasta que Yeris decida, quedan así y no se crean cuentas con
-- ellas.
INSERT INTO retencion_concepto_nacional
  (codigo, nombre, impuesto, usa_declarante, usa_acumulado_anual, umbral_acumulado_uvt, base_es_iva, subcuenta_pasivo, subcuenta_activo) VALUES
  ('COMPRAS_GENERALES',        'Compras generales',                             'RENTA', true,  false, NULL, false, '236540', '135515'),
  ('SERVICIOS_GENERALES',      'Servicios generales',                           'RENTA', true,  false, NULL, false, '236525', '135515'),
  ('HONORARIOS',               'Honorarios',                                    'RENTA', true,  true,  3300, false, '236515', '135515'),
  ('COMISIONES',               'Comisiones',                                    'RENTA', true,  true,  3300, false, '236520', '135515'),
  ('ARREND_INMUEBLES',         'Arrendamiento de bienes inmuebles',             'RENTA', false, false, NULL, false, '236530', '135515'),
  ('ARREND_MUEBLES',           'Arrendamiento de bienes muebles',               'RENTA', false, false, NULL, false, '236530', '135515'),
  ('TRANSPORTE_CARGA',         'Servicios de transporte de carga',              'RENTA', false, false, NULL, false, '236525', '135515'),
  ('TRANSPORTE_PASAJEROS_TER', 'Transporte nacional de pasajeros terrestre',    'RENTA', false, false, NULL, false, '236525', '135515'),
  ('TRANSPORTE_PASAJEROS_AER', 'Transporte nacional de pasajeros aéreo o marítimo', 'RENTA', false, false, NULL, false, '236525', '135515'),
  ('SERV_TEMPORALES',          'Empresas de servicios temporales',              'RENTA', false, false, NULL, false, '236525', '135515'),
  ('SERV_VIGILANCIA_ASEO',     'Servicios de vigilancia y aseo',                'RENTA', false, false, NULL, false, '236525', '135515'),
  ('SERV_SALUD_IPS',           'Servicios integrales de salud (IPS)',           'RENTA', false, false, NULL, false, '236525', '135515'),
  ('HOTELES_RESTAURANTES',     'Servicios de hoteles y restaurantes',           'RENTA', false, false, NULL, false, '236525', '135515'),
  ('SOFTWARE_LICENCIAS',       'Licenciamiento o derecho de uso de software',   'RENTA', false, false, NULL, false, '236525', '135515'),
  ('CONSTRUCCION',             'Contratos de construcción y urbanización',      'RENTA', false, false, NULL, false, '236525', '135515'),
  ('OTROS_INGRESOS',           'Otros ingresos tributarios',                    'RENTA', true,  false, NULL, false, '236570', '135515'),
  ('RENDIMIENTOS_FIN',         'Intereses o rendimientos financieros',          'RENTA', false, false, NULL, false, '236535', '135515'),
  ('COMPRAS_TARJETA',          'Compras con tarjeta débito o crédito',          'RENTA', false, false, NULL, false, '236540', '135515'),
  ('AGRICOLAS_SIN_PROCESO',    'Productos agrícolas sin proceso industrial',    'RENTA', false, false, NULL, false, '236540', '135515'),
  ('CAFE_PERGAMINO',           'Compras de café pergamino o cereza',            'RENTA', false, false, NULL, false, '236540', '135515'),
  ('COMBUSTIBLES',             'Compras de combustibles derivados del petróleo', 'RENTA', false, false, NULL, false, '236540', '135515'),
  ('LOTERIAS_RIFAS',           'Loterías, rifas, apuestas y similares',         'RENTA', false, false, NULL, false, '236545', '135515'),
  ('RETEIVA_COMPRAS',          'Retención de IVA en compras',                   'IVA',   false, false, NULL, true,  '2367',   '135517'),
  ('RETEIVA_SERVICIOS',        'Retención de IVA en servicios',                 'IVA',   false, false, NULL, true,  '2367',   '135517'),
  ('RETEIVA_EXTERIOR',         'Retención de IVA en servicios del exterior',    'IVA',   false, false, NULL, true,  '2367',   '135517'),
  ('RETEICA',                  'Retención de industria y comercio',             'ICA',   false, false, NULL, false, '2368',   '135518');

-- -----------------------------------------------------------------------------
-- Tarifas con vigencia — el corazón
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_tarifa (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  concepto_id     uuid          NOT NULL REFERENCES retencion_concepto_nacional (id),
  -- NULL = aplica a los dos tipos de persona.
  tipo_persona    text          CHECK (tipo_persona IS NULL OR tipo_persona IN ('NATURAL', 'JURIDICA')),
  -- NULL = el concepto no distingue declarantes.
  declarante      boolean,
  base_uvt        numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_uvt >= 0),
  -- 0.025 = 2,5 %. Hasta 1 (100 %: ReteIVA de servicios del exterior).
  tarifa          numeric(8,6)  NOT NULL CHECK (tarifa >= 0 AND tarifa <= 1),
  vigencia_desde  date          NOT NULL,
  vigencia_hasta  date,
  norma           text          NOT NULL CHECK (length(btrim(norma)) > 0),
  observacion     text,
  validado_por    text          NOT NULL,
  validado_en     date          NOT NULL,
  creado_en       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_tarifa_vigencia CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  -- Dos vigencias de la misma combinación no se pueden cruzar.
  CONSTRAINT ex_tarifa_sin_solape EXCLUDE USING gist (
    concepto_id WITH =,
    (COALESCE(tipo_persona, '*')) WITH =,
    (COALESCE(declarante::text, '*')) WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);

CREATE INDEX ix_retencion_tarifa_concepto ON retencion_tarifa (concepto_id, vigencia_desde DESC);

COMMENT ON TABLE retencion_tarifa IS
  'Tarifas de retención con vigencia. Nunca se edita una vigente: se cierra (vigencia_hasta) y se abre otra.';

GRANT SELECT ON retencion_tarifa TO gestion_app, gestion_provision;
GRANT INSERT, UPDATE ON retencion_tarifa TO gestion_provision;

-- Atajo para la semilla: el id del concepto por su código.
CREATE OR REPLACE FUNCTION pg_temp.c(codigo text) RETURNS uuid
  LANGUAGE sql AS $$ SELECT id FROM retencion_concepto_nacional WHERE codigo = $1 $$;

-- Compras y servicios generales: las cuatro vigencias (especificación §4.3).
-- El Decreto 572/2025 bajó las bases desde el 1-jun-2025; el Consejo de Estado
-- lo suspendió el 7-may-2026 y restableció el 2-jun-2026 (Auto 30229), con
-- efectos desde el 1-jul-2026.
INSERT INTO retencion_tarifa (concepto_id, declarante, base_uvt, tarifa, vigencia_desde, vigencia_hasta, norma, validado_por, validado_en) VALUES
  (pg_temp.c('COMPRAS_GENERALES'),   true,  27, 0.025, '2016-10-11', '2025-05-31', 'DUR 1625/2016 art. 1.2.4.9.1', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   true,  10, 0.025, '2025-06-01', '2026-05-07', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   true,  27, 0.025, '2026-05-08', '2026-06-30', 'Suspensión provisional Consejo de Estado 07-05-2026', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   true,  10, 0.025, '2026-07-01', NULL,         'Decreto 572/2025 — restablecido por Auto CE 30229 del 02-06-2026', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   false, 27, 0.035, '2016-10-11', '2025-05-31', 'DUR 1625/2016', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   false, 10, 0.035, '2025-06-01', '2026-05-07', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   false, 27, 0.035, '2026-05-08', '2026-06-30', 'Suspensión provisional Consejo de Estado 07-05-2026', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_GENERALES'),   false, 10, 0.035, '2026-07-01', NULL,         'Decreto 572/2025 — restablecido por Auto CE 30229', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), true,   4, 0.04,  '2016-10-11', '2025-05-31', 'DUR 1625/2016', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), true,   2, 0.04,  '2025-06-01', '2026-05-07', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), true,   4, 0.04,  '2026-05-08', '2026-06-30', 'Suspensión provisional Consejo de Estado 07-05-2026', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), true,   2, 0.04,  '2026-07-01', NULL,         'Decreto 572/2025 — restablecido por Auto CE 30229', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), false,  4, 0.06,  '2016-10-11', '2025-05-31', 'DUR 1625/2016', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), false,  2, 0.06,  '2025-06-01', '2026-05-07', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), false,  4, 0.06,  '2026-05-08', '2026-06-30', 'Suspensión provisional Consejo de Estado 07-05-2026', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERVICIOS_GENERALES'), false,  2, 0.06,  '2026-07-01', NULL,         'Decreto 572/2025 — restablecido por Auto CE 30229', 'Yeris', '2026-09-25');

-- El resto: la tabla vigente desde el 1-jul-2026 (especificación §4.3).
--
-- OJO (R-D13): la especificación solo trae el historial completo de compras y
-- servicios. Para los demás conceptos se carga la tabla vigente desde el
-- 1-jul-2026; un documento anterior a esa fecha con uno de estos conceptos no
-- tiene tarifa y el motor **pregunta**, nunca calcula en cero. Yeris completa
-- el historial con nuevas vigencias hacia atrás desde la consola.
INSERT INTO retencion_tarifa (concepto_id, tipo_persona, declarante, base_uvt, tarifa, vigencia_desde, norma, validado_por, validado_en) VALUES
  (pg_temp.c('HONORARIOS'),               'JURIDICA', NULL,  0,  0.11,  '2026-07-01', 'ET art. 392; Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('HONORARIOS'),               'NATURAL',  true,  0,  0.11,  '2026-07-01', 'ET art. 392; Decreto 572/2025 (declarante o acumulado > 3.300 UVT)', 'Yeris', '2026-09-25'),
  (pg_temp.c('HONORARIOS'),               'NATURAL',  false, 0,  0.10,  '2026-07-01', 'ET art. 392; Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMISIONES'),               'JURIDICA', NULL,  0,  0.11,  '2026-07-01', 'ET art. 392; Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMISIONES'),               'NATURAL',  true,  0,  0.11,  '2026-07-01', 'ET art. 392; Decreto 572/2025 (declarante o acumulado > 3.300 UVT)', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMISIONES'),               'NATURAL',  false, 0,  0.10,  '2026-07-01', 'ET art. 392; Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('ARREND_INMUEBLES'),         NULL,       NULL, 10,  0.035, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('ARREND_MUEBLES'),           NULL,       NULL,  0,  0.04,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('TRANSPORTE_CARGA'),         NULL,       NULL,  2,  0.01,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('TRANSPORTE_PASAJEROS_TER'), NULL,       NULL, 10,  0.035, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('TRANSPORTE_PASAJEROS_AER'), NULL,       NULL,  2,  0.01,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERV_TEMPORALES'),          NULL,       NULL,  2,  0.01,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERV_VIGILANCIA_ASEO'),     NULL,       NULL,  2,  0.02,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('SERV_SALUD_IPS'),           NULL,       NULL,  2,  0.02,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('HOTELES_RESTAURANTES'),     NULL,       NULL,  2,  0.035, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('SOFTWARE_LICENCIAS'),       NULL,       NULL,  0,  0.035, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('CONSTRUCCION'),             NULL,       NULL, 10,  0.02,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('OTROS_INGRESOS'),           NULL,       true, 10,  0.025, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('OTROS_INGRESOS'),           NULL,       false,10,  0.035, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('RENDIMIENTOS_FIN'),         NULL,       NULL,  0,  0.07,  '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMPRAS_TARJETA'),          NULL,       NULL,  0,  0.015, '2026-07-01', 'Decreto 572/2025 (la practica la entidad adquirente)', 'Yeris', '2026-09-25'),
  (pg_temp.c('AGRICOLAS_SIN_PROCESO'),    NULL,       NULL, 70,  0.015, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('CAFE_PERGAMINO'),           NULL,       NULL, 70,  0.005, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('COMBUSTIBLES'),             NULL,       NULL,  0,  0.001, '2026-07-01', 'Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('LOTERIAS_RIFAS'),           NULL,       NULL, 48,  0.20,  '2026-07-01', 'ET art. 317', 'Yeris', '2026-09-25'),
  -- ReteIVA: la base mínima se compara contra el subtotal; la tarifa se aplica al IVA.
  (pg_temp.c('RETEIVA_COMPRAS'),          NULL,       NULL, 10,  0.15,  '2026-07-01', 'ET art. 437-1; Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('RETEIVA_SERVICIOS'),        NULL,       NULL,  2,  0.15,  '2026-07-01', 'ET art. 437-1; Decreto 572/2025', 'Yeris', '2026-09-25'),
  (pg_temp.c('RETEIVA_EXTERIOR'),         NULL,       NULL,  0,  1.00,  '2026-07-01', 'ET art. 437-1 par. 1 (servicios desde el exterior)', 'Yeris', '2026-09-25');
-- RETEICA no tiene tarifa nacional: la pone cada municipio (Fase 3).

-- -----------------------------------------------------------------------------
-- Factores ZOMAC (Ley 1819/2016 art. 237; Decreto 1650/2017)
-- -----------------------------------------------------------------------------
CREATE TABLE retencion_zomac_factor (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tamano      text         NOT NULL CHECK (tamano IN ('MICRO', 'PEQUENA', 'MEDIANA', 'GRANDE')),
  anio_desde  smallint     NOT NULL,
  anio_hasta  smallint     NOT NULL,
  -- 0.50 = se retiene la mitad de la tarifa plena.
  factor      numeric(5,4) NOT NULL CHECK (factor >= 0 AND factor <= 1),
  norma       text         NOT NULL,
  CONSTRAINT ck_zomac_anios CHECK (anio_hasta >= anio_desde),
  CONSTRAINT uq_zomac UNIQUE (tamano, anio_desde, anio_hasta)
);

GRANT SELECT ON retencion_zomac_factor TO gestion_app, gestion_provision;
GRANT INSERT, UPDATE ON retencion_zomac_factor TO gestion_provision;

INSERT INTO retencion_zomac_factor (tamano, anio_desde, anio_hasta, factor, norma) VALUES
  ('MICRO',   2017, 2021, 0.00, 'Ley 1819/2016 art. 237 — Decreto 1650/2017'),
  ('MICRO',   2022, 2024, 0.25, 'Ley 1819/2016 art. 237'),
  ('MICRO',   2025, 2027, 0.50, 'Ley 1819/2016 art. 237'),
  ('MICRO',   2028, 9999, 1.00, 'Tarifa general'),
  ('PEQUENA', 2017, 2021, 0.00, 'Ley 1819/2016 art. 237'),
  ('PEQUENA', 2022, 2024, 0.25, 'Ley 1819/2016 art. 237'),
  ('PEQUENA', 2025, 2027, 0.50, 'Ley 1819/2016 art. 237'),
  ('PEQUENA', 2028, 9999, 1.00, 'Tarifa general'),
  ('MEDIANA', 2017, 2021, 0.50, 'Ley 1819/2016 art. 237'),
  ('MEDIANA', 2022, 2027, 0.75, 'Ley 1819/2016 art. 237'),
  ('MEDIANA', 2028, 9999, 1.00, 'Tarifa general'),
  ('GRANDE',  2017, 2021, 0.50, 'Ley 1819/2016 art. 237'),
  ('GRANDE',  2022, 2027, 0.75, 'Ley 1819/2016 art. 237'),
  ('GRANDE',  2028, 9999, 1.00, 'Tarifa general');
