-- =============================================================================
-- 0089 — Decisiones R-D3, R-D12, R-D13 y R-D14 del motor de retenciones
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, §D. El 26-09-2026 el dueño pidió
-- que Claude las tomara con la norma, porque el contador Yeris no estaba. Cada
-- fila queda firmada «Claude … (pendiente de ratificar Yeris)» para que ella
-- las revise; cambiarlas después es una vigencia nueva desde la consola.
--
-- Fuentes (consultadas el 26-09-2026):
-- * DUR 1625 de 2016 compilado (normograma DIAN, actualizado al 22-09-2026) y
--   Decreto 572 de 2025; Comunicado DIAN 070 del 08-05-2026 (qué regía durante
--   la suspensión).
-- * Concepto DIAN 016207 del 30-08-2026 (base AIU en temporales, aseo y
--   vigilancia, por el parágrafo del art. 462-1 ET).
-- * ET arts. 406, 408, 414-1 y 245 (pagos al exterior, tras las Leyes 1819 de
--   2016, 2010 de 2019 y 2277 de 2022).
-- * Decreto 2650 de 1993, subcuentas 135517 y 135518 adicionadas por el
--   Decreto 2116 de 1996.

CREATE OR REPLACE FUNCTION pg_temp.c(codigo text) RETURNS uuid
  LANGUAGE sql AS $$ SELECT id FROM retencion_concepto_nacional WHERE codigo = $1 $$;

-- -----------------------------------------------------------------------------
-- R-D12 — Lo que nos retienen de IVA y de ICA tiene subcuenta propia en el PUC
-- -----------------------------------------------------------------------------
INSERT INTO cuenta_puc (codigo, nivel, codigo_padre, nombre, naturaleza, es_imputable, rango_libre) VALUES
  ('135517', 6, '1355', 'IMPUESTO A LAS VENTAS RETENIDO', 'DEBITO', true, false),
  ('135518', 6, '1355', 'IMPUESTO DE INDUSTRIA Y COMERCIO RETENIDO', 'DEBITO', true, false)
ON CONFLICT (codigo) DO NOTHING;

-- -----------------------------------------------------------------------------
-- R-D3 — AIU: temporales, aseo y vigilancia retienen sobre el AIU
-- -----------------------------------------------------------------------------
-- Parágrafo del art. 462-1 ET (norma legal) y Concepto DIAN 016207 de 2026: la
-- tarifa se aplica sobre el AIU, que no puede ser menor al 10 % del contrato;
-- la cuantía mínima se compara contra el total. Construcción no: base total.
UPDATE retencion_concepto_nacional
   SET base_es_aiu = true
 WHERE codigo IN ('SERV_TEMPORALES', 'SERV_VIGILANCIA_ASEO');

-- -----------------------------------------------------------------------------
-- R-D13 — Las vigencias anteriores al 1-jul-2026
-- -----------------------------------------------------------------------------
-- El Decreto 572 no cambió tarifas: cambió bases mínimas (art. 1.2.4.4.1,
-- servicios 4 → 2 UVT; art. 1.2.4.9.1 lit. i, compras y otros 27 → 10 UVT;
-- agrícolas 92 → 70; café 160 → 70). Todo lo que toma su base de esos
-- artículos siguió el mismo vaivén que compras y servicios:
--   P0 hasta el 31-may-2025 y P2 del 8-may al 30-jun-2026: base anterior.
--   P1 del 1-jun-2025 al 7-may-2026: base del Decreto 572.
-- Lo que no cambió se extiende desde el 1-ene-2025 (lo que se verificó).
CREATE TEMP TABLE r13 (codigo text, declarante boolean, base_antes numeric, base_572 numeric, tarifa numeric, norma text)
  ON COMMIT DROP;
INSERT INTO r13 VALUES
  ('ARREND_INMUEBLES',         NULL,  27, 10, 0.035, 'DUR 1625 arts. 1.2.4.10.6 y 1.2.4.9.1 lit. i'),
  ('TRANSPORTE_PASAJEROS_TER', NULL,  27, 10, 0.035, 'DUR 1625 arts. 1.2.4.10.6 y 1.2.4.9.1 lit. i'),
  ('HOTELES_RESTAURANTES',     NULL,   4,  2, 0.035, 'DUR 1625 arts. 1.2.4.10.6 y 1.2.4.4.1'),
  ('SERV_TEMPORALES',          NULL,   4,  2, 0.01,  'DUR 1625 arts. 1.2.4.4.10 y 1.2.4.4.1'),
  ('SERV_VIGILANCIA_ASEO',     NULL,   4,  2, 0.02,  'DUR 1625 arts. 1.2.4.4.10 y 1.2.4.4.1'),
  ('SERV_SALUD_IPS',           NULL,   4,  2, 0.02,  'ET art. 392; DUR 1625 art. 1.2.4.4.1'),
  ('TRANSPORTE_CARGA',         NULL,   4,  2, 0.01,  'DUR 1625 arts. 1.2.4.4.8 y 1.2.4.4.1'),
  ('CONSTRUCCION',             NULL,  27, 10, 0.02,  'DUR 1625 art. 1.2.4.9.1'),
  ('OTROS_INGRESOS',           true,  27, 10, 0.025, 'DUR 1625 arts. 1.2.4.9.1 y 1.2.4.9.2'),
  ('OTROS_INGRESOS',           false, 27, 10, 0.035, 'DUR 1625 art. 1.2.4.9.2 par. 3; ET art. 401'),
  ('AGRICOLAS_SIN_PROCESO',    NULL,  92, 70, 0.015, 'DUR 1625 art. 1.2.4.6.7'),
  ('CAFE_PERGAMINO',           NULL, 160, 70, 0.005, 'DUR 1625 art. 1.2.4.6.8'),
  -- La base mínima de ReteIVA es la del concepto de renta (compras / servicios).
  ('RETEIVA_COMPRAS',          NULL,  27, 10, 0.15,  'ET art. 437-1; DUR 1625 art. 1.2.4.9.1'),
  ('RETEIVA_SERVICIOS',        NULL,   4,  2, 0.15,  'ET art. 437-1; DUR 1625 art. 1.2.4.4.1');

INSERT INTO retencion_tarifa
  (concepto_id, tipo_persona, declarante, base_uvt, tarifa, vigencia_desde, vigencia_hasta, norma, validado_por, validado_en)
SELECT pg_temp.c(r.codigo), NULL, r.declarante, v.base, r.tarifa, v.desde, v.hasta,
       r.norma || v.nota,
       'Claude, con el DUR 1625 y el Comunicado DIAN 070 de 2026 (pendiente de ratificar Yeris)',
       '2026-09-26'
  FROM r13 r
 CROSS JOIN LATERAL (VALUES
   (r.base_antes, DATE '2025-01-01', DATE '2025-05-31', ' (texto anterior al Decreto 572)'),
   (r.base_572,   DATE '2025-06-01', DATE '2026-05-07', ' — Decreto 572/2025'),
   (r.base_antes, DATE '2026-05-08', DATE '2026-06-30', ' — suspensión provisional CE 07-05-2026 (Comunicado DIAN 070)')
 ) AS v (base, desde, hasta, nota);

-- Sin cambios en 2025–2026: rige lo mismo desde el 1-ene-2025.
UPDATE retencion_tarifa t
   SET vigencia_desde = '2025-01-01'
  FROM retencion_concepto_nacional n
 WHERE n.id = t.concepto_id
   AND t.vigencia_desde = '2026-07-01'
   AND n.codigo IN ('HONORARIOS', 'COMISIONES', 'ARREND_MUEBLES', 'TRANSPORTE_PASAJEROS_AER',
                    'SOFTWARE_LICENCIAS', 'RENDIMIENTOS_FIN', 'COMPRAS_TARJETA',
                    'COMBUSTIBLES', 'LOTERIAS_RIFAS', 'RETEIVA_EXTERIOR');

-- -----------------------------------------------------------------------------
-- R-D14 — Pagos al exterior (art. 406 y siguientes ET)
-- -----------------------------------------------------------------------------
-- Sin base mínima: la base es el pago bruto (en créditos de 1 año o más y en
-- leasing, solo el interés). Se retiene la tarifa nacional; la del convenio
-- (CDI) exige el certificado de residencia fiscal y queda para después: el
-- motor no la aplica solo. Van al renglón «países sin convenio» del 350.
INSERT INTO retencion_concepto_nacional
  (codigo, nombre, impuesto, usa_declarante, usa_acumulado_anual, umbral_acumulado_uvt,
   base_es_iva, subcuenta_pasivo, subcuenta_activo)
VALUES
  ('EXT_GENERAL',           'Exterior: intereses, comisiones, honorarios, regalías, arrendamientos, servicios y software', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_CONSULTORIA',       'Exterior: consultoría, servicios técnicos y asistencia técnica', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_CREDITOS_LARGO',    'Exterior: intereses de créditos a 1 año o más y leasing', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_LEASING_AERONAVES', 'Exterior: leasing de naves, helicópteros o aerodinos', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_REASEGUROS',        'Exterior: primas cedidas por reaseguros', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_APP',               'Exterior: créditos para proyectos de infraestructura APP', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_ADMIN_CASA_MATRIZ', 'Exterior: administración o dirección de la casa matriz', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_PES',               'Exterior: presencia económica significativa', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_NO_COOPERANTE',     'Exterior: jurisdicciones no cooperantes o regímenes preferenciales', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_TRANSPORTE_INTL',   'Exterior: transporte internacional aéreo o marítimo', 'RENTA', false, false, NULL, false, '236550', '135515'),
  ('EXT_DIVIDENDOS',        'Exterior: dividendos a no residentes', 'RENTA', false, false, NULL, false, '236550', '135515')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO retencion_tarifa
  (concepto_id, tipo_persona, declarante, base_uvt, tarifa, vigencia_desde, norma, validado_por, validado_en)
SELECT pg_temp.c(x.codigo), NULL, NULL, 0, x.tarifa, '2023-01-01', x.norma,
       'Claude, con el Estatuto Tributario (pendiente de ratificar Yeris)', '2026-09-26'
  FROM (VALUES
    ('EXT_GENERAL',           0.20, 'ET art. 408 inc. 1'),
    ('EXT_CONSULTORIA',       0.20, 'ET art. 408 inc. 2'),
    ('EXT_CREDITOS_LARGO',    0.15, 'ET art. 408 inc. 3'),
    ('EXT_LEASING_AERONAVES', 0.01, 'ET art. 408 inc. 4'),
    ('EXT_REASEGUROS',        0.01, 'ET art. 408 inc. 6'),
    ('EXT_APP',               0.05, 'ET art. 408 inc. 5'),
    ('EXT_ADMIN_CASA_MATRIZ', 0.33, 'ET art. 408 inc. 7'),
    ('EXT_PES',               0.10, 'ET art. 408 inc. 8 (Ley 2277 de 2022)'),
    ('EXT_NO_COOPERANTE',     0.35, 'ET art. 408 par. y art. 240'),
    ('EXT_TRANSPORTE_INTL',   0.05, 'ET art. 414-1'),
    ('EXT_DIVIDENDOS',        0.20, 'ET arts. 245 y 407 (Ley 2277 de 2022)')
  ) AS x (codigo, tarifa, norma);

-- Los enlaces a las cuentas de cada empresa (0076): la 236550 si la tiene.
SELECT fn_retencion_enlaza(e.id) FROM empresa e;
