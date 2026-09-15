-- =============================================================================
-- 0036_secuencia_movimientos — el orden de los saldos corridos
-- =============================================================================
-- Kardex, libro de caja y libro de banco calculan cada saldo a partir del
-- "último movimiento", y hasta ahora el último se elegía por `creado_en`.
-- En Postgres `now()` es la hora de INICIO de la transacción: dos ventas que
-- arrancan a la vez toman el candado del producto una detrás de la otra, pero
-- la que confirma segunda puede llevar un `creado_en` anterior. La tercera ya
-- no sabe cuál es la última y parte de un saldo equivocado. Con treinta
-- facturas simultáneas el kardex quedó con seis eslabones rotos; en caja, el
-- saldo corrido terminó mil pesos arriba de la realidad.
--
-- La cura es una secuencia asignada al insertar —es decir, DENTRO del
-- candado—, que sí sigue el orden en que las cosas ocurrieron. Los saldos que
-- ya estaban se recalculan desde cero en ese orden.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. La columna, con los que ya existen numerados por el mejor orden conocido
-- -----------------------------------------------------------------------------
CREATE SEQUENCE producto_movimiento_secuencia_seq AS bigint;
CREATE SEQUENCE caja_movimiento_secuencia_seq      AS bigint;
CREATE SEQUENCE banco_movimiento_secuencia_seq     AS bigint;

ALTER TABLE producto_movimiento ADD COLUMN secuencia bigint;
ALTER TABLE caja_movimiento      ADD COLUMN secuencia bigint;
ALTER TABLE banco_movimiento     ADD COLUMN secuencia bigint;

-- Los triggers de inmutabilidad hacen su trabajo con la operación del día a
-- día; acá se numera y se recalcula una sola vez, y se vuelven a encender.
ALTER TABLE producto_movimiento DISABLE TRIGGER tg_movimiento_inmutable;
ALTER TABLE caja_movimiento     DISABLE TRIGGER tg_caja_mov_inmutable;
ALTER TABLE banco_movimiento    DISABLE TRIGGER tg_banco_mov_inmutable;

UPDATE producto_movimiento m
   SET secuencia = n.numero
  FROM (SELECT id, row_number() OVER (ORDER BY creado_en, id) AS numero
          FROM producto_movimiento) n
 WHERE n.id = m.id;
UPDATE caja_movimiento m
   SET secuencia = n.numero
  FROM (SELECT id, row_number() OVER (ORDER BY creado_en, id) AS numero
          FROM caja_movimiento) n
 WHERE n.id = m.id;
UPDATE banco_movimiento m
   SET secuencia = n.numero
  FROM (SELECT id, row_number() OVER (ORDER BY creado_en, id) AS numero
          FROM banco_movimiento) n
 WHERE n.id = m.id;

SELECT setval('producto_movimiento_secuencia_seq', coalesce((SELECT max(secuencia) FROM producto_movimiento), 0) + 1, false);
SELECT setval('caja_movimiento_secuencia_seq',     coalesce((SELECT max(secuencia) FROM caja_movimiento), 0) + 1, false);
SELECT setval('banco_movimiento_secuencia_seq',    coalesce((SELECT max(secuencia) FROM banco_movimiento), 0) + 1, false);

ALTER TABLE producto_movimiento
  ALTER COLUMN secuencia SET DEFAULT nextval('producto_movimiento_secuencia_seq'),
  ALTER COLUMN secuencia SET NOT NULL;
ALTER TABLE caja_movimiento
  ALTER COLUMN secuencia SET DEFAULT nextval('caja_movimiento_secuencia_seq'),
  ALTER COLUMN secuencia SET NOT NULL;
ALTER TABLE banco_movimiento
  ALTER COLUMN secuencia SET DEFAULT nextval('banco_movimiento_secuencia_seq'),
  ALTER COLUMN secuencia SET NOT NULL;

ALTER SEQUENCE producto_movimiento_secuencia_seq OWNED BY producto_movimiento.secuencia;
ALTER SEQUENCE caja_movimiento_secuencia_seq      OWNED BY caja_movimiento.secuencia;
ALTER SEQUENCE banco_movimiento_secuencia_seq     OWNED BY banco_movimiento.secuencia;

CREATE UNIQUE INDEX ux_producto_movimiento_secuencia ON producto_movimiento (secuencia);
CREATE UNIQUE INDEX ux_caja_movimiento_secuencia      ON caja_movimiento (secuencia);
CREATE UNIQUE INDEX ux_banco_movimiento_secuencia     ON banco_movimiento (secuencia);

-- El "último de este producto/caja/cuenta" es la consulta de cada movimiento.
CREATE INDEX ix_producto_movimiento_ultimo ON producto_movimiento (producto_id, secuencia DESC);
CREATE INDEX ix_caja_movimiento_ultimo      ON caja_movimiento (caja_id, secuencia DESC);
CREATE INDEX ix_banco_movimiento_ultimo     ON banco_movimiento (cuenta_bancaria_id, secuencia DESC);

-- La app inserta con el DEFAULT; la secuencia la usa Postgres por ella.
GRANT USAGE ON SEQUENCE producto_movimiento_secuencia_seq, caja_movimiento_secuencia_seq, banco_movimiento_secuencia_seq
  TO gestion_app, gestion_provision;

-- -----------------------------------------------------------------------------
-- 2. Recalcular los saldos corridos en el orden nuevo
-- -----------------------------------------------------------------------------
-- Kardex: promedio ponderado, con los mismos redondeos que kardex.reglas.ts —
-- la cantidad a `decimales_cantidad` y el costo promedio a `decimales_valor`
-- de la configuración contable de la empresa; el valor siempre a 2.
DO $$
DECLARE
  m               RECORD;
  v_producto      uuid := NULL;
  v_cantidad      numeric := 0;
  v_promedio      numeric := 0;
  v_dec_cantidad  int := 2;
  v_dec_costo     int := 2;
BEGIN
  FOR m IN
    SELECT pm.id, pm.producto_id, pm.tipo, pm.cantidad, pm.costo_unitario,
           coalesce(c.decimales_cantidad, 2) AS dec_cantidad,
           coalesce(c.decimales_valor, 2)    AS dec_costo
      FROM producto_movimiento pm
      LEFT JOIN empresa_configuracion_contable c ON c.empresa_id = pm.empresa_id
     ORDER BY pm.producto_id, pm.secuencia
  LOOP
    IF v_producto IS DISTINCT FROM m.producto_id THEN
      v_producto := m.producto_id;
      v_cantidad := 0;
      v_promedio := 0;
      v_dec_cantidad := m.dec_cantidad;
      v_dec_costo := m.dec_costo;
    END IF;

    IF m.tipo LIKE 'ENTRADA%' THEN
      v_promedio := round(
        (v_cantidad * v_promedio + m.cantidad * m.costo_unitario)
          / round(v_cantidad + m.cantidad, v_dec_cantidad),
        v_dec_costo);
      v_cantidad := round(v_cantidad + m.cantidad, v_dec_cantidad);
    ELSE
      v_cantidad := round(v_cantidad - m.cantidad, v_dec_cantidad);
      IF v_cantidad < 0 THEN
        RAISE EXCEPTION 'El kardex del producto % queda en negativo al recalcular (movimiento %)', m.producto_id, m.id;
      END IF;
    END IF;

    UPDATE producto_movimiento
       SET saldo_cantidad       = v_cantidad,
           saldo_costo_promedio = v_promedio,
           saldo_valor          = round(v_cantidad * v_promedio, 2)
     WHERE id = m.id;
  END LOOP;
END $$;

-- Caja: entra o sale, y el saldo inicial arranca la cuenta.
UPDATE caja_movimiento m
   SET saldo_valor = s.saldo
  FROM (SELECT id,
               sum(CASE WHEN tipo = 'EGRESO' THEN -valor ELSE valor END)
                 OVER (PARTITION BY caja_id ORDER BY secuencia) AS saldo
          FROM caja_movimiento) s
 WHERE s.id = m.id;

-- Banco: mismo criterio, con la dirección de cada tipo de banco-movimiento.service.ts.
UPDATE banco_movimiento m
   SET saldo_valor = s.saldo
  FROM (SELECT id,
               sum(CASE WHEN tipo IN ('RETIRO', 'TRANSFERENCIA_SALIENTE', 'NOTA_DEBITO', 'CHEQUE')
                        THEN -valor ELSE valor END)
                 OVER (PARTITION BY cuenta_bancaria_id ORDER BY secuencia) AS saldo
          FROM banco_movimiento) s
 WHERE s.id = m.id;

ALTER TABLE producto_movimiento ENABLE TRIGGER tg_movimiento_inmutable;
ALTER TABLE caja_movimiento     ENABLE TRIGGER tg_caja_mov_inmutable;
ALTER TABLE banco_movimiento    ENABLE TRIGGER tg_banco_mov_inmutable;

COMMENT ON COLUMN producto_movimiento.secuencia IS
  'Orden real de los movimientos: se asigna al insertar, dentro del candado del producto. Es lo que ordena el saldo corrido; creado_en no sirve porque es la hora de inicio de la transacción.';
COMMENT ON COLUMN caja_movimiento.secuencia IS
  'Orden real de los movimientos de la caja. Ver producto_movimiento.secuencia.';
COMMENT ON COLUMN banco_movimiento.secuencia IS
  'Orden real de los movimientos de la cuenta. Ver producto_movimiento.secuencia.';
