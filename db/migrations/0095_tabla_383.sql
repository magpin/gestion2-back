-- =============================================================================
-- 0095 — Honorarios y servicios de persona natural por la tabla del art. 383
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 8 (§8.14, R-D16).
--
-- Art. 383 par. 2 ET: a la persona natural que cobra honorarios o compensación
-- por servicios personales y **no** contrató dos o más trabajadores para esa
-- actividad se le retiene con la tabla de rentas de trabajo, después de la
-- depuración (aportes obligatorios, renta exenta del 25 % con su tope). Si
-- contrató dos o más, sigue con la tarifa del art. 392 (10 % / 11 %).
--
-- Todo con vigencia y en la base (R1): la tabla, los topes y qué conceptos la
-- usan. Decidido por Claude con el ET el 26-09-2026, pendiente de Yeris.

-- 1. El perfil del proveedor dice si contrató dos o más trabajadores.
ALTER TABLE tercero_perfil_tributario
  ADD COLUMN contrato_dos_o_mas_trabajadores boolean NOT NULL DEFAULT false;

-- 2. Qué conceptos van por la tabla cuando el beneficiario es persona natural.
ALTER TABLE retencion_concepto_nacional
  ADD COLUMN usa_tabla_383 boolean NOT NULL DEFAULT false;
UPDATE retencion_concepto_nacional
   SET usa_tabla_383 = true
 WHERE codigo IN ('HONORARIOS', 'COMISIONES', 'SERVICIOS_GENERALES');

-- 3. La tabla, en UVT y mensual: sobre lo gravado después de la depuración.
CREATE TABLE retencion_tabla_383 (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  desde_uvt        numeric(10,2) NOT NULL CHECK (desde_uvt >= 0),
  hasta_uvt        numeric(10,2) CHECK (hasta_uvt IS NULL OR hasta_uvt > desde_uvt),
  -- Sobre el exceso de `desde_uvt`.
  tarifa_marginal  numeric(6,4)  NOT NULL CHECK (tarifa_marginal >= 0 AND tarifa_marginal < 1),
  uvt_adicionales  numeric(10,2) NOT NULL DEFAULT 0,
  vigencia_desde   date          NOT NULL,
  vigencia_hasta   date,
  norma            text          NOT NULL,
  validado_por     text          NOT NULL,
  validado_en      date          NOT NULL
);
GRANT SELECT ON retencion_tabla_383 TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON retencion_tabla_383 TO gestion_provision;

INSERT INTO retencion_tabla_383
  (desde_uvt, hasta_uvt, tarifa_marginal, uvt_adicionales, vigencia_desde, norma, validado_por, validado_en)
VALUES
  (0,    95,   0,    0,   '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  (95,   150,  0.19, 0,   '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  (150,  360,  0.28, 10,  '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  (360,  640,  0.33, 69,  '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  (640,  945,  0.35, 162, '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  (945,  2300, 0.37, 268, '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  (2300, NULL, 0.39, 770, '2019-01-01', 'ET art. 383 (Ley 2010 de 2019)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26');

-- 4. Los topes de la depuración, con vigencia.
CREATE TABLE retencion_parametro_ley (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clave            text          NOT NULL CHECK (clave ~ '^[A-Z0-9_]+$'),
  valor            numeric(14,4) NOT NULL,
  vigencia_desde   date          NOT NULL,
  vigencia_hasta   date,
  norma            text          NOT NULL,
  validado_por     text          NOT NULL,
  validado_en      date          NOT NULL,
  CONSTRAINT ex_parametro_ley_sin_solape EXCLUDE USING gist (
    clave WITH =,
    daterange(vigencia_desde, COALESCE(vigencia_hasta, 'infinity'::date), '[]') WITH &&
  )
);
GRANT SELECT ON retencion_parametro_ley TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON retencion_parametro_ley TO gestion_provision;

INSERT INTO retencion_parametro_ley (clave, valor, vigencia_desde, norma, validado_por, validado_en) VALUES
  ('RENTA_EXENTA_TRABAJO_PORCENTAJE', 0.25, '2023-01-01', 'ET art. 206 num. 10 (Ley 2277 de 2022)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  ('RENTA_EXENTA_TRABAJO_TOPE_UVT_ANUAL', 790, '2023-01-01', 'ET art. 206 num. 10 (Ley 2277 de 2022)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  ('DEPURACION_TOPE_PORCENTAJE', 0.40, '2023-01-01', 'ET art. 336 (Ley 2277 de 2022)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26'),
  ('DEPURACION_TOPE_UVT_ANUAL', 1340, '2023-01-01', 'ET art. 336 (Ley 2277 de 2022)', 'Claude, con el ET (pendiente de ratificar Yeris)', '2026-09-26');
