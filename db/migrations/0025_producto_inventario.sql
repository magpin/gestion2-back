-- =============================================================================
-- 0025_producto_inventario — productos, su precio y el kardex
-- =============================================================================
-- Modulo 3 de la secuencia (docs/decisiones/secuencia-modulos.md). El terreno
-- ya estaba preparado desde antes, sin que nadie lo usara todavia:
-- `empresa_configuracion_contable.metodo_valoracion_inventario` (0005), el rol
-- `INVENTARIO` (0007) y `asiento.origen_tipo` con `AJUSTE_INVENTARIO` ya
-- reservado (0022). Esta es la primera migracion que de verdad los consume.
--
-- Cuatro tablas, dos historias que no se mezclan:
--
--   1. `producto`           — el maestro. Sin precio: ver la 2.
--   2. `producto_precio`    — historia COMERCIAL. A cuanto se ofrecia, sin que
--                             importe si se vendio algo. Tabla historica, mismo
--                             patron que 0005 (fecha_inicio/fecha_fin, nunca se
--                             edita, "un solo vigente" por indice unico parcial).
--   3. `producto_movimiento`— historia DE EXISTENCIAS Y COSTO. El kardex: cada
--                             entrada y salida, con el promedio ponderado
--                             recalculado en el momento, no al cierre.
--   4. `inventario_configuracion` — la cuenta contra la que se asienta un
--                             ajuste de existencias, elegida una sola vez.
--
-- No hay una quinta tabla de "saldo actual": el saldo vigente de un producto
-- ES la ultima fila de su propio kardex (consulta indexada, no un recorrido
-- caro como si lo seria el balance de un ano completo -por eso
-- saldo_cuenta_periodo si existe aparte-). Cachearlo aparte repetiria el bug
-- que este proyecto ya corrigio una vez (0022->0024): dos lugares que dicen la
-- verdad y pueden dejar de coincidir.
--
-- Las dos decisiones de diseno que quedaron resueltas, no abiertas:
--
--   - El SALDO INICIAL de existencias no genera asiento automatico. La
--     contrapartida de esa carga (aportes, utilidades acumuladas, cuenta
--     puente de conversion) no tiene una regla contable unica -a diferencia
--     de un ajuste rutinario, que si la tiene-, asi que el contador la
--     asienta a mano si su migracion lo requiere. Automatizarla seria
--     inventar la regla que secuencia-modulos.md marca como pendiente ("un
--     contador valida el mapeo de cuentas").
--   - Un movimiento de kardex NO se anula. Se corrige con un contra-
--     movimiento, nunca editando ni anulando uno existente: el promedio
--     ponderado es sensible al orden, y dar de baja una fila de en medio
--     obligaria a recalcular todo lo posterior.

-- -----------------------------------------------------------------------------
-- Producto — el maestro
-- -----------------------------------------------------------------------------
CREATE TABLE producto (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  codigo               varchar(30)   NOT NULL CHECK (length(btrim(codigo)) > 0),
  nombre               text          NOT NULL CHECK (length(btrim(nombre)) > 0),

  -- Enum cerrado y no catalogo: el catalogo oficial DIAN/UBL de unidades es
  -- trabajo del modulo DIAN (0006 de la secuencia), que todavia no existe.
  -- Esto alcanza para vender y comprar.
  unidad_medida        text          NOT NULL DEFAULT 'UND'
                                     CHECK (unidad_medida IN
                                       ('UND','KG','LB','LT','GAL','MT','M2','M3','CAJA','PAR','DOC')),

  -- Colombia solo tiene tres tarifas reales de IVA para bienes. Un producto
  -- al 21% es un error de captura, no una tarifa que exista. (Exento y
  -- excluido caen los dos en 0: esa distincion le importa al modulo DIAN, no
  -- a este.)
  iva_tarifa           numeric(5,2)  NOT NULL DEFAULT 0 CHECK (iva_tarifa IN (0, 5, 19)),

  -- La cuenta del plan (1435 / 1405 / 143005 segun el giro) donde vive ESTE
  -- producto. Por producto y no unica por empresa: una manufactura tiene
  -- varias cuentas de inventario a la vez. No se edita despues de creada:
  -- cambiarla dejaria el kardex viejo apuntando a una cuenta que el producto
  -- ya no dice usar.
  cuenta_inventario_id uuid          NOT NULL,

  activo               boolean       NOT NULL DEFAULT true,
  creado_en            timestamptz   NOT NULL DEFAULT now(),
  creado_por           uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,
  actualizado_en       timestamptz,

  CONSTRAINT uq_producto_codigo UNIQUE (empresa_id, codigo),
  CONSTRAINT uq_producto_id_empresa UNIQUE (id, empresa_id),

  -- Compuesta con empresa_id, como ya hace asiento con comprobante_tipo_id:
  -- una cuenta de OTRA empresa no puede colarse por un id sin validar.
  CONSTRAINT fk_producto_cuenta
    FOREIGN KEY (cuenta_inventario_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

CREATE INDEX ix_producto_empresa_activo ON producto (empresa_id, activo);
CREATE INDEX ix_producto_nombre ON producto (empresa_id, fn_normalizar(nombre));

COMMENT ON TABLE producto IS
  'El maestro de productos. Sin precio de venta: vive en producto_precio, que es historico. No se borra: se desactiva, igual que cuenta, tercero, centro de costo.';
COMMENT ON COLUMN producto.cuenta_inventario_id IS
  'La cuenta del plan donde vive el inventario de ESTE producto. Inmutable: cambiarla dejaria el kardex viejo apuntando a una cuenta que el producto ya no dice usar.';

CREATE TRIGGER tg_producto_actualizado
  BEFORE UPDATE ON producto
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- Producto_precio — historial del precio de lista (para gestion)
-- -----------------------------------------------------------------------------
-- Para ver que precio tenia un producto en una fecha pasada, independiente de
-- si se vendio algo -eso lo va a resolver Ventas a su manera, copiando el
-- precio dentro de cada factura, pero eso es historia de LO VENDIDO, no de LO
-- OFRECIDO-. Mismo patron que las tablas historicas de 0005: la fila vigente
-- no se edita, se cierra con fecha_fin y se abre una nueva. Por eso no lleva
-- actualizado_en ni trigger de actualizacion.

CREATE TABLE producto_precio (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  producto_id  uuid          NOT NULL,

  precio_venta numeric(18,2) NOT NULL CHECK (precio_venta >= 0),
  -- Por que cambio. Opcional: a veces no hay nada que explicar, y forzarlo
  -- invita a poner basura ("ajuste") solo para pasar el formulario.
  nota         text,

  fecha_inicio date          NOT NULL,
  fecha_fin    date,

  creado_en    timestamptz   NOT NULL DEFAULT now(),
  creado_por   uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT fk_precio_producto
    FOREIGN KEY (producto_id, empresa_id)
    REFERENCES producto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT ck_precio_vigencia CHECK (fecha_fin IS NULL OR fecha_fin >= fecha_inicio)
);

-- "Un solo vigente" por producto, igual que ux_regimen_vigente en 0005. El
-- motor lo sostiene: no hay forma de que el codigo lo olvide.
CREATE UNIQUE INDEX ux_producto_precio_vigente
  ON producto_precio (producto_id)
  WHERE fecha_fin IS NULL;

CREATE INDEX ix_precio_producto ON producto_precio (empresa_id, producto_id, fecha_inicio);

COMMENT ON TABLE producto_precio IS
  'Historial del precio de lista, con vigencia. No se edita: cambiar el precio cierra la fila vigente (fecha_fin) e inserta una nueva. Existe para auditar cuando cambio un precio y por que, no para saber a que precio se vendio algo -eso lo copia cada factura, cuando exista Ventas-.';

-- -----------------------------------------------------------------------------
-- Producto_movimiento — el kardex (el HECHO)
-- -----------------------------------------------------------------------------
-- Es un hecho, como asiento_linea: se inserta y no se toca. Corregir un
-- movimiento mal hecho no es editarlo -eso obligaria a recalcular el promedio
-- de todo lo que vino despues, que es exactamente el error que
-- secuencia-modulos.md advierte ("recalcular el costo con cada entrada y no
-- al cierre")-, es registrar un contra-movimiento, igual que un asiento se
-- corrige con otro asiento.
--
-- Los tres `saldo_*` no se derivan: son el balance DESPUES de este
-- movimiento, calculado una vez y congelado. Sin esto, pintar el kardex
-- obligaria a sumar todo el historial en cada consulta.
--
-- El orden que manda para el promedio es el de DIGITACION (creado_en, id), no
-- el de `fecha`. Un movimiento con fecha atrasada, registrado despues de
-- otros mas recientes, no reordena el promedio: se apila al final.

CREATE TABLE producto_movimiento (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  producto_id           uuid          NOT NULL,

  -- La fecha del hecho, para el reporte. No decide el orden del promedio:
  -- eso lo decide creado_en. Ver el comentario de arriba.
  fecha                 date          NOT NULL,

  tipo                  text          NOT NULL CHECK (tipo IN
                                        ('ENTRADA_INICIAL', 'ENTRADA_AJUSTE', 'SALIDA_AJUSTE')),

  -- Siempre positiva. El sentido lo da `tipo`, igual que asiento_linea usa
  -- debito/credito en vez de un signo.
  cantidad              numeric(18,6) NOT NULL CHECK (cantidad > 0),
  costo_unitario        numeric(18,6) NOT NULL CHECK (costo_unitario >= 0),
  valor_total           numeric(18,2) NOT NULL CHECK (valor_total >= 0),

  -- El balance DESPUES de este movimiento. Es un hecho congelado, no un
  -- calculo: ver comentario de la tabla.
  saldo_cantidad        numeric(18,6) NOT NULL CHECK (saldo_cantidad >= 0),
  saldo_costo_promedio  numeric(18,6) NOT NULL CHECK (saldo_costo_promedio >= 0),
  saldo_valor           numeric(18,2) NOT NULL CHECK (saldo_valor >= 0),

  motivo                text          NOT NULL CHECK (length(btrim(motivo)) > 0),

  -- NULL solo en ENTRADA_INICIAL: la carga inicial no genera asiento (ver el
  -- porque en la cabecera de este archivo). Los ajustes SIEMPRE llevan uno:
  -- 0022 reservo AJUSTE_INVENTARIO para esto.
  asiento_id            uuid,

  creado_en             timestamptz   NOT NULL DEFAULT now(),
  creado_por            uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT fk_movimiento_producto
    FOREIGN KEY (producto_id, empresa_id)
    REFERENCES producto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_movimiento_asiento
    FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,

  CONSTRAINT ck_movimiento_asiento CHECK (
    (tipo = 'ENTRADA_INICIAL' AND asiento_id IS NULL) OR
    (tipo <> 'ENTRADA_INICIAL' AND asiento_id IS NOT NULL)
  ),

  -- El motor no confia en que la aplicacion sume bien: lo verifica. Mismo
  -- espiritu que fn_cuadre_asiento, pero como CHECK porque es aritmetica de
  -- una sola fila y no exige mirar las demas.
  CONSTRAINT ck_movimiento_valor_total
    CHECK (valor_total = round(cantidad * costo_unitario, 2)),
  CONSTRAINT ck_movimiento_saldo_valor
    CHECK (saldo_valor = round(saldo_cantidad * saldo_costo_promedio, 2))
);

CREATE INDEX ix_movimiento_producto ON producto_movimiento (empresa_id, producto_id, creado_en, id);
CREATE INDEX ix_movimiento_asiento  ON producto_movimiento (asiento_id) WHERE asiento_id IS NOT NULL;

COMMENT ON TABLE producto_movimiento IS
  'El kardex. Nunca se edita ni se borra: un movimiento mal hecho se corrige con un contra-movimiento, no editandolo, porque editar uno viejo obligaria a recalcular el promedio de todo lo que vino despues.';
COMMENT ON COLUMN producto_movimiento.asiento_id IS
  'NULL solo en la carga inicial: esa no genera asiento porque su contrapartida -aportes, utilidades acumuladas, cuenta puente de conversion- es una decision de migracion que un contador valida caso por caso, no una regla que este modulo pueda adivinar.';

CREATE OR REPLACE FUNCTION fn_movimiento_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Un movimiento de kardex no se edita ni se borra. Corregilo con el movimiento contrario.'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER tg_movimiento_inmutable
  BEFORE UPDATE OR DELETE ON producto_movimiento
  FOR EACH ROW EXECUTE FUNCTION fn_movimiento_inmutable();

-- -----------------------------------------------------------------------------
-- Inventario_configuracion — la cuenta de ajuste, elegida una sola vez
-- -----------------------------------------------------------------------------
-- Mismo principio que las cuentas `requiereEleccion` del giro (61xx, 41xx):
-- alguien con criterio contable la fija una vez, y el sistema la reusa sin
-- volver a preguntar. Sin esto, quien hace un ajuste de existencias podria
-- elegir cualquier cuenta del plan, y eso es literalmente lo que hoy solo
-- puede hacer CONTADOR al digitar un asiento manual.

CREATE TABLE inventario_configuracion (
  empresa_id       uuid        PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  cuenta_ajuste_id uuid,

  creado_en        timestamptz NOT NULL DEFAULT now(),
  actualizado_en   timestamptz,

  CONSTRAINT fk_config_cuenta_ajuste
    FOREIGN KEY (cuenta_ajuste_id, empresa_id)
    REFERENCES empresa_cuenta (id, empresa_id) ON DELETE RESTRICT
);

COMMENT ON TABLE inventario_configuracion IS
  'Una fila por empresa. cuenta_ajuste_id es contra que cuenta se asienta un ajuste de existencias (candidatas tipicas: 529915 gasto diverso, 1499 provision). Nula hasta que CONTADOR o DIRECTOR la elija: sin ella, los ajustes de existencias se rechazan.';

CREATE TRIGGER tg_inventario_configuracion_actualizado
  BEFORE UPDATE ON inventario_configuracion
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- Ningun DELETE en producto, producto_precio ni producto_movimiento: nada se
-- borra. producto_movimiento tampoco lleva UPDATE -es un hecho, como
-- asiento_linea-; el trigger de arriba es ademas de la falta de privilegio,
-- no en vez de ella, para dar un mensaje que explique que hacer en su lugar
-- en vez del generico "permiso denegado".
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['producto', 'producto_precio', 'producto_movimiento', 'inventario_configuracion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON producto                 TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON producto_precio           TO gestion_app, gestion_provision;
GRANT SELECT, INSERT         ON producto_movimiento       TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON inventario_configuracion  TO gestion_app, gestion_provision;

GRANT EXECUTE ON FUNCTION fn_movimiento_inmutable() TO gestion_app, gestion_provision;
