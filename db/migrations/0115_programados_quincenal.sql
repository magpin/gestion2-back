-- Pagos programados: quincenales y con la cuenta de la que salen
-- (Fase 5 de docs/planes/plan-pantallas-complementarias.md, PC18 y E27).
--
-- 1. La nómina se paga cada quincena: el 15 y el último día del mes. Al
--    marcar uno pagado, queda programado el de la quincena siguiente.
-- 2. `cuenta_bancaria_id`: de qué banco va a salir, para proyectar cómo queda
--    cada cuenta con su 4×1000. Opcional: sin ella, el pago cuenta en el total
--    pero no mueve ninguna cuenta en la proyección.
--
-- Recuerda, no paga: no hay aprobación ni débito automático (D6, E26).

ALTER TABLE pago_programado
  DROP CONSTRAINT pago_programado_recurrencia_check,
  ADD CONSTRAINT pago_programado_recurrencia_check
    CHECK (recurrencia IN ('UNA_VEZ', 'QUINCENAL', 'MENSUAL')),
  ADD COLUMN cuenta_bancaria_id uuid,
  ADD CONSTRAINT fk_programado_cuenta FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT;
