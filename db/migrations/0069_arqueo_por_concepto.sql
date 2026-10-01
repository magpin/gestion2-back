-- =============================================================================
-- 0069 — Arqueo por concepto, responsable de caja y terceros empleados
-- =============================================================================
--
-- Hasta acá un arqueo con diferencia se ajustaba contra UNA cuenta, fuera
-- sobrante o faltante, y sin decir quién respondía por la plata. Contablemente
-- son tres cosas distintas:
--
--   Sobrante de caja                   429553  ingreso diverso
--   Faltante cobrable al responsable   136530  cuenta por cobrar, con tercero
--   Faltante asumido por la empresa    531595  gasto extraordinario
--
-- Qué faltante es cuál no lo sabe el sistema: lo decide quien cierra el arqueo,
-- y queda escrito en el arqueo (`tratamiento_faltante`).
--
-- El «responsable» es un tercero: el asiento de un faltante cobrable lleva a
-- quién se le cobra. Un cajero no es cliente ni proveedor, y `ck_tercero_rol`
-- exigía una de las dos: por eso nace `tercero.es_empleado`.

-- -----------------------------------------------------------------------------
-- Tercero — el rol de empleado
-- -----------------------------------------------------------------------------

ALTER TABLE tercero ADD COLUMN es_empleado boolean NOT NULL DEFAULT false;

ALTER TABLE tercero DROP CONSTRAINT ck_tercero_rol;
ALTER TABLE tercero ADD CONSTRAINT ck_tercero_rol
  CHECK (es_cliente OR es_proveedor OR es_empleado);

CREATE INDEX ix_tercero_empleado ON tercero (empresa_id) WHERE es_empleado AND activo;

COMMENT ON COLUMN tercero.es_empleado IS
  'Trabaja para la empresa: responde por una caja, y mañana cobra nómina. Un tercero puede ser a la vez cliente, proveedor y empleado.';

-- -----------------------------------------------------------------------------
-- Caja_configuracion — una cuenta por concepto
-- -----------------------------------------------------------------------------

ALTER TABLE caja_configuracion
  ADD COLUMN cuenta_sobrante_id           uuid,
  ADD COLUMN cuenta_faltante_cobrable_id  uuid,
  ADD COLUMN cuenta_faltante_asumido_id   uuid,
  ADD CONSTRAINT fk_caja_config_sobrante
    FOREIGN KEY (cuenta_sobrante_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_caja_config_faltante_cobrable
    FOREIGN KEY (cuenta_faltante_cobrable_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_caja_config_faltante_asumido
    FOREIGN KEY (cuenta_faltante_asumido_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT;

-- Quien ya había elegido una cuenta de diferencia la conserva en los tres
-- conceptos: el comportamiento no cambia hasta que alguien los separe.
UPDATE caja_configuracion
   SET cuenta_sobrante_id          = cuenta_diferencia_id,
       cuenta_faltante_cobrable_id = cuenta_diferencia_id,
       cuenta_faltante_asumido_id  = cuenta_diferencia_id
 WHERE cuenta_diferencia_id IS NOT NULL;

ALTER TABLE caja_configuracion DROP COLUMN cuenta_diferencia_id;

COMMENT ON TABLE caja_configuracion IS
  'Una fila por empresa: contra qué cuenta se ajusta cada diferencia de arqueo. Por defecto 429553 (sobrante), 136530 (faltante cobrable, con tercero) y 531595 (faltante asumido); si la empresa abrió auxiliares de esas cuentas, se elige uno.';

-- -----------------------------------------------------------------------------
-- Caja — quién responde por ella
-- -----------------------------------------------------------------------------

ALTER TABLE caja
  ADD COLUMN responsable_tercero_id uuid,
  ADD CONSTRAINT fk_caja_responsable
    FOREIGN KEY (responsable_tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT;

COMMENT ON COLUMN caja.responsable_tercero_id IS
  'El empleado que responde por la caja. Al cerrar un arqueo con faltante cobrable viene elegido, y se puede cambiar si ese día contó otra persona.';

-- -----------------------------------------------------------------------------
-- Caja_arqueo — qué se decidió sobre el faltante
-- -----------------------------------------------------------------------------

ALTER TABLE caja_arqueo
  ADD COLUMN tratamiento_faltante   text CHECK (tratamiento_faltante IN ('EMPRESA', 'RESPONSABLE')),
  ADD COLUMN responsable_tercero_id uuid,
  ADD CONSTRAINT fk_arqueo_responsable
    FOREIGN KEY (responsable_tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  -- Solo un faltante tiene tratamiento; cobrarlo exige saber a quién.
  ADD CONSTRAINT ck_arqueo_tratamiento CHECK (
    (tratamiento_faltante IS NULL AND responsable_tercero_id IS NULL)
    OR (tratamiento_faltante = 'EMPRESA' AND responsable_tercero_id IS NULL AND diferencia < 0)
    OR (tratamiento_faltante = 'RESPONSABLE' AND responsable_tercero_id IS NOT NULL AND diferencia < 0)
  );

COMMENT ON COLUMN caja_arqueo.asiento_ajuste_id IS
  'Si cerrar deja una diferencia, el asiento que la ajusta contra la cuenta del concepto (sobrante, faltante cobrable o faltante asumido).';
COMMENT ON COLUMN caja_arqueo.tratamiento_faltante IS
  'Solo con faltante: EMPRESA lo lleva a gasto (531595); RESPONSABLE lo cobra a responsable_tercero_id (136530).';
