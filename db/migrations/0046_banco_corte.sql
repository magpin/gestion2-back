-- 0046 — El corte diario de una cuenta bancaria.
--
-- Paso 14 de `docs/planes/ajustes-16-sep.md` (punto 19). Qué entró y qué salió
-- un día, contra el saldo con que amaneció, congelado al cerrar. Es el arqueo
-- de la caja sin contar billetes: el saldo del banco no se cuenta, se lee del
-- portal, y por eso `saldo_banco` es opcional.
--
-- No es la conciliación (`banco_extracto`, 0035). La conciliación cruza el
-- libro contra el extracto de un período, renglón por renglón; el corte dice
-- cómo cerró un día, y lo dice el mismo día.
--
-- Un corte NO bloquea el libro. Los cargos que el banco hace solos —el 4×1000,
-- una comisión— aparecen en el extracto con su fecha y se registran después
-- con esa fecha, que es la que permite cruzarlos. Si el corte cerrara el día
-- para escribir, obligaría a registrarlos con otra fecha y la conciliación no
-- los encontraría. En cambio, el corte queda congelado y la pantalla avisa
-- cuando entró algo con fecha de un día ya cortado.

CREATE TABLE banco_corte (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  cuenta_bancaria_id uuid          NOT NULL,

  fecha              date          NOT NULL,

  -- Con cuánto amaneció la cuenta: todo lo de fechas anteriores. Sin CHECK
  -- (>= 0), igual que banco_movimiento.saldo_valor: hay sobregiro.
  saldo_anterior     numeric(18,2) NOT NULL,
  entradas           numeric(18,2) NOT NULL CHECK (entradas >= 0),
  salidas            numeric(18,2) NOT NULL CHECK (salidas >= 0),
  saldo_final        numeric(18,2) NOT NULL,
  -- Cuántos movimientos del día entraron en el corte. Con esto la pantalla
  -- sabe si después llegó alguno más con esta fecha.
  movimientos        integer       NOT NULL CHECK (movimientos >= 0),

  -- Lo que muestra el portal del banco al cerrar, si alguien lo leyó. La
  -- diferencia no genera asiento: la explica la conciliación, no un ajuste.
  saldo_banco        numeric(18,2),
  diferencia         numeric(18,2),

  nota               text,
  cerrado_en         timestamptz   NOT NULL DEFAULT now(),
  cerrado_por        uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT fk_banco_corte_cuenta
    FOREIGN KEY (cuenta_bancaria_id, empresa_id)
    REFERENCES cuenta_bancaria (id, empresa_id) ON DELETE RESTRICT,
  -- Un día se corta una vez. Un corte mal hecho no se rehace: queda, y el
  -- aviso de "cambió después del corte" dice qué pasó.
  CONSTRAINT uq_banco_corte_dia UNIQUE (cuenta_bancaria_id, fecha),

  CONSTRAINT ck_banco_corte_cuadre CHECK (
    saldo_final = saldo_anterior + entradas - salidas
  ),
  -- El `IS NOT NULL` explícito: un CHECK que da NULL se da por cumplido.
  CONSTRAINT ck_banco_corte_diferencia CHECK (
    (saldo_banco IS NULL AND diferencia IS NULL) OR
    (saldo_banco IS NOT NULL AND diferencia IS NOT NULL
       AND diferencia = saldo_banco - saldo_final)
  )
);

CREATE INDEX ix_banco_corte_cuenta ON banco_corte (empresa_id, cuenta_bancaria_id, fecha DESC);

COMMENT ON TABLE banco_corte IS
  'El cierre de un día de una cuenta bancaria: saldo con que amaneció, entradas, salidas y saldo final, congelados. No bloquea el libro; un movimiento registrado después con fecha de un día cortado se muestra como cambio posterior al corte.';

-- Un corte es un hecho: no se edita ni se borra. Mismo trigger que el kardex y
-- el libro de caja.
CREATE TRIGGER tg_banco_corte_inmutable
  BEFORE UPDATE OR DELETE ON banco_corte
  FOR EACH ROW EXECUTE FUNCTION fn_movimiento_inmutable();

ALTER TABLE banco_corte ENABLE ROW LEVEL SECURITY;
ALTER TABLE banco_corte FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_banco_corte_aislado ON banco_corte
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, UPDATE ON banco_corte TO gestion_app, gestion_provision;
