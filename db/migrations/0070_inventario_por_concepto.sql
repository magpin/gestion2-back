-- =============================================================================
-- 0070 — Inventario sin configuración: cuentas por concepto
-- =============================================================================
--
-- Mismo cambio que 0069 hizo con caja. Hasta acá inventario tenía UNA cuenta
-- de ajuste para sobrantes y faltantes, cada producto exigía que alguien le
-- eligiera sus cuentas, y «vender sin existencia» era un interruptor escondido
-- en una pantalla de configuración.
--
-- Ahora cada concepto tiene su cuenta, la pone el sistema, y el producto nuevo
-- toma las de la empresa:
--
--   Inventario de mercancías          1435 (143501)
--   Ingreso por venta                 4135 (la subcuenta de la actividad, o 413595)
--   Costo de venta                    6135 (su pareja, o 613595)
--   Sobrante de inventario            429505  aprovechamientos
--   Faltante asumido por la empresa   529595  gasto diverso
--   Faltante cobrable al responsable  136530  cuenta por cobrar, con tercero

-- -----------------------------------------------------------------------------
-- 1. Una cuenta por concepto
-- -----------------------------------------------------------------------------

ALTER TABLE inventario_configuracion
  ADD COLUMN cuenta_inventario_id         uuid,
  ADD COLUMN cuenta_ingreso_id            uuid,
  ADD COLUMN cuenta_costo_venta_id        uuid,
  ADD COLUMN cuenta_sobrante_id           uuid,
  ADD COLUMN cuenta_faltante_asumido_id   uuid,
  ADD COLUMN cuenta_faltante_cobrable_id  uuid,
  ADD CONSTRAINT fk_inv_config_inventario
    FOREIGN KEY (cuenta_inventario_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_inv_config_ingreso
    FOREIGN KEY (cuenta_ingreso_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_inv_config_costo_venta
    FOREIGN KEY (cuenta_costo_venta_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_inv_config_sobrante
    FOREIGN KEY (cuenta_sobrante_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_inv_config_faltante_asumido
    FOREIGN KEY (cuenta_faltante_asumido_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_inv_config_faltante_cobrable
    FOREIGN KEY (cuenta_faltante_cobrable_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT;

-- Quien ya había elegido la cuenta de ajuste la conserva para sobrante y
-- faltante asumido: el comportamiento no cambia hasta que alguien los separe.
UPDATE inventario_configuracion
   SET cuenta_sobrante_id         = cuenta_ajuste_id,
       cuenta_faltante_asumido_id = cuenta_ajuste_id
 WHERE cuenta_ajuste_id IS NOT NULL;

ALTER TABLE inventario_configuracion DROP COLUMN cuenta_ajuste_id;

-- -----------------------------------------------------------------------------
-- 2. Vender sin existencia: de interruptor a hecho de la operación
-- -----------------------------------------------------------------------------
-- Es una respuesta sobre cómo trabaja la empresa, como «¿maneja caja menor?»:
-- se contesta en el asistente. Una sola fuente de verdad: el hecho.

ALTER TABLE empresa_hecho_operativo DROP CONSTRAINT empresa_hecho_operativo_hecho_check;
ALTER TABLE empresa_hecho_operativo ADD CONSTRAINT empresa_hecho_operativo_hecho_check
  CHECK (hecho IN (
    'TIENE_EMPLEADOS',
    'TIENE_ACTIVOS_FIJOS',
    'TIENE_CREDITO_BANCARIO',
    'MANEJA_CAJA_MENOR',
    'VENDE_SIN_EXISTENCIA'));

INSERT INTO empresa_hecho_operativo (empresa_id, hecho)
SELECT empresa_id, 'VENDE_SIN_EXISTENCIA'
  FROM inventario_configuracion
 WHERE permite_existencia_negativa
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION fn_saldo_negativo_permitido() RETURNS trigger AS $$
BEGIN
  IF NEW.saldo_cantidad >= 0 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM empresa_hecho_operativo
              WHERE empresa_id = NEW.empresa_id AND hecho = 'VENDE_SIN_EXISTENCIA') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    -- «existencia negativa» se queda en el texto: ventas reconoce este error
    -- por esas palabras (`esDescubiertoImposible` en el frontend).
    'El movimiento deja la existencia del producto % en %, y esta empresa no permite existencia negativa.',
    NEW.producto_id, NEW.saldo_cantidad
    USING HINT = 'Registrá primero la entrada de la mercancía, o contestá que sí a «¿Vendes productos sin tenerlos en existencia?» en la configuración de la empresa.';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_saldo_negativo_permitido() IS
  'Reemplaza al CHECK (saldo_cantidad >= 0): permite saldo negativo solo si la empresa declaró el hecho VENDE_SIN_EXISTENCIA.';

ALTER TABLE inventario_configuracion DROP COLUMN permite_existencia_negativa;

COMMENT ON TABLE inventario_configuracion IS
  'Una fila por empresa: las cuentas automáticas de inventario. Por defecto 1435, 4135, 6135, 429505 (sobrante), 529595 (faltante asumido) y 136530 (faltante cobrable, con tercero); si la empresa abrió auxiliares, se elige uno.';

-- -----------------------------------------------------------------------------
-- 3. Qué se decidió sobre un faltante de inventario
-- -----------------------------------------------------------------------------

ALTER TABLE producto_movimiento
  ADD COLUMN tratamiento_faltante   text CHECK (tratamiento_faltante IN ('EMPRESA', 'RESPONSABLE')),
  ADD COLUMN responsable_tercero_id uuid,
  ADD CONSTRAINT fk_mov_responsable
    FOREIGN KEY (responsable_tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  -- Solo un faltante (salida por ajuste) tiene tratamiento; cobrarlo exige a quién.
  ADD CONSTRAINT ck_mov_tratamiento CHECK (
    (tratamiento_faltante IS NULL AND responsable_tercero_id IS NULL)
    OR (tipo = 'SALIDA_AJUSTE' AND tratamiento_faltante = 'EMPRESA' AND responsable_tercero_id IS NULL)
    OR (tipo = 'SALIDA_AJUSTE' AND tratamiento_faltante = 'RESPONSABLE' AND responsable_tercero_id IS NOT NULL)
  );

COMMENT ON COLUMN producto_movimiento.tratamiento_faltante IS
  'Solo en SALIDA_AJUSTE: EMPRESA lo lleva a gasto (529595); RESPONSABLE lo cobra a responsable_tercero_id (136530).';
