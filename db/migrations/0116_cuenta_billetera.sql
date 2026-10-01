-- Billeteras digitales como cuenta (Fase 6 de docs/planes/plan-pantallas-complementarias.md, PC29).
--
-- Nequi y Daviplata se manejan como una cuenta más: tienen saldo, reciben y
-- pagan, y el 4×1000 aplica igual que en un banco (salvo la cuenta marcada
-- exenta). Se agregan como tipo BILLETERA de `cuenta_bancaria`.

ALTER TABLE cuenta_bancaria
  DROP CONSTRAINT cuenta_bancaria_tipo_cuenta_check,
  ADD CONSTRAINT cuenta_bancaria_tipo_cuenta_check
    CHECK (tipo_cuenta IN ('AHORROS', 'CORRIENTE', 'BILLETERA'));
