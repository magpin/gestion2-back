-- =============================================================================
-- 0020_hecho_operativo — los hechos que ningún documento declara
-- =============================================================================
-- El plan de cuentas de una empresa se deriva de sus documentos: el RUT dice si
-- cobra IVA, la CIIU dice de qué son sus ingresos, la forma jurídica dice cómo
-- es su patrimonio. Pero hay cuentas que no salen de ningún papel.
--
-- Ningún documento dice si la empresa tiene empleados. El RUT no lo trae, la
-- Cámara de Comercio tampoco, y sin saberlo no se puede decidir si el plan lleva
-- las cinco cuentas de prestaciones o ninguna. Lo mismo con el crédito bancario,
-- los activos fijos y el fondo de caja menor: son hechos de la operación, y la
-- única fuente posible es preguntarle a quien configura.
--
-- SIN VIGENCIA, igual que `empresa_sector` y por la misma razón: no es un hecho
-- fiscal. A la DIAN nunca le va a interesar si la empresa tenía empleados en
-- marzo — eso lo responde la nómina, que sí es histórica. Acá solo se guarda
-- qué cuentas hay que ofrecerle hoy.
--
-- Y por eso también se puede borrar: desmarcar "tiene empleados" no deja
-- huérfano a nadie. Las cuentas que el hecho ya justificó NO se tocan —una
-- cuenta con movimiento no se quita— pero el hecho en sí se quita y se repone.

CREATE TABLE empresa_hecho_operativo (
  empresa_id uuid        NOT NULL REFERENCES empresa (id),
  hecho      text        NOT NULL CHECK (hecho IN (
               'TIENE_EMPLEADOS',
               'TIENE_ACTIVOS_FIJOS',
               'TIENE_CREDITO_BANCARIO',
               'MANEJA_CAJA_MENOR')),
  creado_en  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (empresa_id, hecho)
);

COMMENT ON TABLE empresa_hecho_operativo IS
  'Hechos de la operacion que ningun documento legal declara y que deciden que cuentas preactivar: empleados, activos fijos, credito bancario, caja menor. Sin vigencia: no es un hecho fiscal.';
COMMENT ON COLUMN empresa_hecho_operativo.hecho IS
  'Cada valor enciende un bloque del plan sugerido. Agregar uno nuevo es ampliar este CHECK y agregar su bloque en plan-cuentas.reglas.ts.';

CREATE INDEX ix_hecho_operativo_empresa ON empresa_hecho_operativo (empresa_id);

ALTER TABLE empresa_hecho_operativo ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa_hecho_operativo FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_hecho_operativo_aislada ON empresa_hecho_operativo
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, DELETE ON empresa_hecho_operativo TO gestion_app, gestion_provision;
