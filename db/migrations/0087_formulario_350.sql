-- =============================================================================
-- 0087 — Renglones del formulario 350
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 6 (§6.2).
--
-- El 350 no se declara por concepto sino por **renglón**: agrupa conceptos,
-- separa a quién se le retuvo (persona jurídica o natural) y tiene renglones
-- propios para las autorretenciones, el IVA y lo que se descuenta por
-- retenciones practicadas en exceso o por operaciones anuladas. El formulario
-- cambia de versión, así que la tabla tiene vigencia, como las tarifas.
--
-- Es de la ley: sin `empresa_id` ni RLS, igual para todas; la app solo la lee.
--
-- **Versión vigente:** Resolución DIAN 000031 del 29-feb-2024, para lo que se
-- declara desde el 1-ago-2024; el PDF que la DIAN publica para 2026 es el
-- mismo. Las casillas salen del formulario oficial. R-D15 lo decidió Claude
-- con esa resolución el 26-09-2026, pendiente de que Yeris lo ratifique.

CREATE TABLE formulario_350_renglon (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             text        NOT NULL CHECK (codigo ~ '^[A-Z0-9_]+$'),
  seccion            text        NOT NULL CHECK (seccion IN
                       ('RENTA', 'RENTA_EXTERIOR', 'AUTORRETENCION', 'RENTA_MENOS', 'IVA', 'IVA_MENOS')),
  orden              smallint    NOT NULL,
  nombre             text        NOT NULL CHECK (length(btrim(nombre)) > 0),
  -- Base y retención a personas jurídicas y a naturales por separado (renta,
  -- pagos al exterior y autorretenciones); en IVA y en «menos», una cifra.
  -- En las autorretenciones, la persona es la empresa, no el tercero.
  por_tipo_persona   boolean     NOT NULL DEFAULT false,
  -- Los conceptos de la ley que suma (retencion_concepto_nacional.codigo).
  -- En AUTORRETENCION, los de las filas con `es_autorretencion`; en las
  -- secciones «MENOS», vacío: ahí van las reversas de meses anteriores.
  conceptos          text[]      NOT NULL DEFAULT '{}',
  -- Los números de casilla, en orden: {base PJ, retención PJ, base PN,
  -- retención PN} si distingue persona; si no, {base, valor}. NULL donde el
  -- formulario no trae casilla.
  casillas           smallint[]  NOT NULL,
  vigencia_desde     date        NOT NULL,
  vigencia_hasta     date,
  norma              text        NOT NULL,
  validado_por       text        NOT NULL,
  validado_en        date        NOT NULL,
  CONSTRAINT ck_350_vigencia CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT ck_350_casillas CHECK (
    cardinality(casillas) = CASE WHEN por_tipo_persona THEN 4 ELSE 2 END),
  CONSTRAINT ex_350_sin_solape EXCLUDE USING gist (
    codigo WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);

COMMENT ON TABLE formulario_350_renglon IS
  'Renglones del formulario 350 (Res. DIAN 000031 de 2024), qué conceptos suma cada uno y sus casillas, con vigencia.';

GRANT SELECT ON formulario_350_renglon TO gestion_app, gestion_provision;
GRANT INSERT, UPDATE ON formulario_350_renglon TO gestion_provision;

INSERT INTO formulario_350_renglon
  (codigo, seccion, orden, nombre, por_tipo_persona, conceptos, casillas,
   vigencia_desde, norma, validado_por, validado_en)
SELECT codigo, seccion, orden, nombre, por_tipo_persona, conceptos, casillas,
       '2024-08-01', 'Resolución DIAN 000031 de 2024',
       'Claude, con la Resolución DIAN 000031 de 2024 (pendiente de ratificar Yeris)',
       '2026-09-26'
  FROM (VALUES
  ('HONORARIOS',     'RENTA', 10, 'Honorarios', true, '{HONORARIOS}'::text[], '{29,42,79,95}'::smallint[]),
  ('COMISIONES',     'RENTA', 20, 'Comisiones', true, '{COMISIONES}', '{30,43,80,96}'),
  ('SERVICIOS',      'RENTA', 30, 'Servicios', true,
     '{SERVICIOS_GENERALES,TRANSPORTE_CARGA,TRANSPORTE_PASAJEROS_TER,TRANSPORTE_PASAJEROS_AER,SERV_TEMPORALES,SERV_VIGILANCIA_ASEO,SERV_SALUD_IPS,HOTELES_RESTAURANTES}',
     '{31,44,81,97}'),
  ('RENDIMIENTOS',   'RENTA', 40, 'Rendimientos financieros e intereses', true, '{RENDIMIENTOS_FIN}', '{32,45,82,98}'),
  ('ARRENDAMIENTOS', 'RENTA', 50, 'Arrendamientos (muebles e inmuebles)', true, '{ARREND_INMUEBLES,ARREND_MUEBLES}', '{33,46,83,99}'),
  -- El licenciamiento de software es explotación de propiedad intelectual.
  ('REGALIAS',       'RENTA', 60, 'Regalías y explotación de la propiedad intelectual', true, '{SOFTWARE_LICENCIAS}', '{34,47,84,100}'),
  ('COMPRAS',        'RENTA', 70, 'Compras', true,
     '{COMPRAS_GENERALES,AGRICOLAS_SIN_PROCESO,CAFE_PERGAMINO,COMBUSTIBLES}', '{36,49,86,102}'),
  ('TARJETAS',       'RENTA', 80, 'Transacciones con tarjetas débito y crédito', true, '{COMPRAS_TARJETA}', '{37,50,87,103}'),
  ('CONSTRUCCION',   'RENTA', 90, 'Contratos de construcción', true, '{CONSTRUCCION}', '{38,51,88,104}'),
  ('LOTERIAS',       'RENTA', 100, 'Loterías, rifas, apuestas y similares', true, '{LOTERIAS_RIFAS}', '{39,52,90,106}'),
  ('OTROS_PAGOS',    'RENTA', 110, 'Otros pagos sujetos a retención', true, '{OTROS_INGRESOS}', '{41,54,92,108}'),
  ('EXTERIOR_SIN_CONVENIO', 'RENTA_EXTERIOR', 120, 'Pagos o abonos en cuenta al exterior a países sin convenio', true,
     '{EXT_GENERAL,EXT_CONSULTORIA,EXT_CREDITOS_LARGO,EXT_LEASING_AERONAVES,EXT_REASEGUROS,EXT_APP,EXT_ADMIN_CASA_MATRIZ,EXT_PES,EXT_NO_COOPERANTE,EXT_TRANSPORTE_INTL,EXT_DIVIDENDOS}',
     '{55,57,109,111}'),
  ('EXTERIOR_CON_CONVENIO', 'RENTA_EXTERIOR', 130, 'Pagos o abonos en cuenta al exterior a países con convenio vigente', true, '{}', '{56,58,110,112}'),
  ('AUTO_EXONERADOS',  'AUTORRETENCION', 140, 'Contribuyentes exonerados de aportes (art. 114-1 ET)', true, '{AUTORRETENCION_ESPECIAL}', '{59,68,NULL,NULL}'),
  ('AUTO_VENTAS',      'AUTORRETENCION', 150, 'Autorretenciones por ventas', true, '{COMPRAS_GENERALES}', '{60,69,113,121}'),
  ('RENTA_MENOS',      'RENTA_MENOS', 160, 'Menos: retenciones practicadas en exceso o indebidas, o por operaciones anuladas, rescindidas o resueltas', false, '{}', '{NULL,129}'),
  ('IVA_RESPONSABLES', 'IVA', 170, 'Retención de IVA a responsables del impuesto sobre las ventas', false, '{RETEIVA_COMPRAS,RETEIVA_SERVICIOS}', '{NULL,131}'),
  ('IVA_EXTERIOR',     'IVA', 180, 'Retención de IVA por servicios a no residentes o no domiciliados', false, '{RETEIVA_EXTERIOR}', '{NULL,132}'),
  ('IVA_MENOS',        'IVA_MENOS', 190, 'Menos: retenciones de IVA practicadas en exceso o indebidas, o por operaciones anuladas, rescindidas o resueltas', false, '{}', '{NULL,133}')
  ) AS r (codigo, seccion, orden, nombre, por_tipo_persona, conceptos, casillas);

-- -----------------------------------------------------------------------------
-- Los tres reportes nuevos quedan en el rastro de corridas (0049): el CHECK se
-- amplía en la migración que los trae, como pide su comentario.
-- -----------------------------------------------------------------------------
ALTER TABLE reporte_corrida DROP CONSTRAINT reporte_corrida_reporte_check;
ALTER TABLE reporte_corrida ADD CONSTRAINT reporte_corrida_reporte_check CHECK (reporte IN (
  'VENTAS_POR_CLIENTE', 'ANTIGUEDAD_CARTERA', 'GUARDADO',
  'RETENCIONES_350', 'RETEICA', 'CERTIFICADOS_RETENCION'
));
