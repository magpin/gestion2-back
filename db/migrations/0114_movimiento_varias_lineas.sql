-- «Sin factura» con varias líneas y los conceptos de socios
-- (Fase 5 de docs/planes/plan-pantallas-complementarias.md, PC14, PC15, PC16).
--
-- 1. `movimiento_concepto_linea`: un solo comprobante puede llevar varios
--    conceptos. La cuota de un préstamo es el ejemplo: el capital baja la deuda
--    (210510) y los intereses son gasto (530520), y sale un solo valor del
--    banco. El movimiento guarda el primero en `concepto_id` y el total en
--    `valor_concepto`; aquí van todas las líneas, en orden. Con una sola línea
--    no se escribe nada aquí.
--
-- 2. «Pago de IVA» y «Pago de ICA» dejan de ofrecerse a mano (PC15): se pagan
--    desde Impuestos, contra su declaración. Quedan como conceptos del sistema.

CREATE TABLE movimiento_concepto_linea (
  movimiento_id  uuid          NOT NULL,
  empresa_id     uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  orden          smallint      NOT NULL CHECK (orden >= 1),
  concepto_id    uuid          NOT NULL,
  valor          numeric(18,2) NOT NULL CHECK (valor > 0),
  PRIMARY KEY (movimiento_id, orden),
  CONSTRAINT fk_mc_linea_movimiento FOREIGN KEY (movimiento_id, empresa_id)
    REFERENCES movimiento_concepto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mc_linea_concepto FOREIGN KEY (concepto_id, empresa_id)
    REFERENCES concepto_movimiento (id, empresa_id) ON DELETE RESTRICT
);

ALTER TABLE movimiento_concepto_linea ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimiento_concepto_linea FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_mc_linea_aislado ON movimiento_concepto_linea
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());
GRANT SELECT, INSERT ON movimiento_concepto_linea TO gestion_app, gestion_provision;

UPDATE concepto_movimiento
   SET automatico = true, actualizado_en = now()
 WHERE es_sistema AND codigo IN ('NG-PAGO-IVA', 'NG-PAGO-ICA');
