-- El saldo inicial puede llevar su asiento de apertura (CA).
--
-- Desde el arranque de caja y bancos (docs/planes/saldos-iniciales.md, SI1),
-- el saldo inicial se carga con un asiento CA. Los que se cargaron antes, sin
-- asiento, siguen valiendo. El resto de movimientos sigue exigiendo asiento.

ALTER TABLE caja_movimiento
  DROP CONSTRAINT ck_caja_mov_asiento,
  ADD CONSTRAINT ck_caja_mov_asiento CHECK (
    tipo = 'SALDO_INICIAL' OR asiento_id IS NOT NULL
  );

ALTER TABLE banco_movimiento
  DROP CONSTRAINT ck_banco_mov_asiento,
  ADD CONSTRAINT ck_banco_mov_asiento CHECK (
    tipo = 'SALDO_INICIAL' OR asiento_id IS NOT NULL
  );
