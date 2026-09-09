-- =============================================================================
-- 0027_ventas — cotización, factura de venta y nota crédito
-- =============================================================================
-- Módulo 4 de la secuencia (docs/decisiones/secuencia-modulos.md). El modelo
-- completo, con el porqué de cada decisión, vive en
-- `docs/planes/ventas-backend.md`. Acá solo el resumen que hace falta para
-- leer el DDL:
--
--   1. `venta_documento`       — la cabecera. Un solo `tipo`
--                                (COTIZACION/FACTURA/NOTA_CREDITO), no tres
--                                tablas: comparten cabecera y líneas, lo que
--                                cambia es la regla del servicio.
--   2. `venta_documento_linea` — sus líneas. Este corte solo vende PRODUCTOS
--                                con inventario (sin líneas de servicio libre).
--   3. `venta_cotizacion_consecutivo` — la cotización no es un documento
--                                fiscal, así que no numera con
--                                `NucleoApi.tomarConsecutivo`: tiene su propio
--                                contador mínimo, un prefijo fijo ('COT') y
--                                nada más.
--
-- La decisión de diseño que sostiene todo esto: una FACTURA o NOTA_CREDITO
-- siempre numera con una resolución DIAN y siempre asienta; una COTIZACION
-- nunca hace ninguna de las dos cosas. El motor lo sostiene con
-- `ck_venta_fiscal` para que no exista el estado intermedio roto de "factura
-- sin número" o "cotización con asiento".

-- -----------------------------------------------------------------------------
-- Prerrequisito: dos FK compuestas contra tablas de `nucleo` que hoy no
-- tienen con qué. `tercero` y `empresa_resolucion_dian` solo tienen PK simple
-- (`id`); el resto del esquema exige FK compuesta con `empresa_id` para que
-- una fila de OTRA empresa no pueda colarse por un id sin validar (mismo
-- principio que ya usa `fk_producto_cuenta`, `fk_movimiento_asiento`, etc.).
-- Ningún dato existente cambia: son índices únicos nuevos sobre columnas que
-- ya son, cada una por su lado, únicas.
-- -----------------------------------------------------------------------------
ALTER TABLE tercero ADD CONSTRAINT uq_tercero_id_empresa UNIQUE (id, empresa_id);
ALTER TABLE empresa_resolucion_dian ADD CONSTRAINT uq_resolucion_id_empresa UNIQUE (id, empresa_id);

-- -----------------------------------------------------------------------------
-- Venta_documento — la cabecera
-- -----------------------------------------------------------------------------
CREATE TABLE venta_documento (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,

  tipo                 text          NOT NULL CHECK (tipo IN
                                        ('COTIZACION', 'FACTURA', 'NOTA_CREDITO')),

  tercero_id           uuid          NOT NULL,
  fecha                date          NOT NULL,

  -- BORRADOR solo existe para COTIZACION (se puede archivar sin más trámite).
  -- FACTURA y NOTA_CREDITO nacen EMITIDA: no hay borrador de un documento
  -- fiscal, se numera al crear.
  estado               text          NOT NULL DEFAULT 'EMITIDA'
                                     CHECK (estado IN ('BORRADOR', 'EMITIDA', 'ANULADA')),

  -- Todo documento numera: FACTURA/NOTA_CREDITO contra la resolución DIAN,
  -- COTIZACION con su propio contador (`venta_cotizacion_consecutivo`,
  -- prefijo 'COT' fijo en código). Lo que distingue a COTIZACION no es
  -- carecer de número: es no pasar por una resolución DIAN ni asentar —
  -- ver `resolucion_id`/`asiento_id` más abajo.
  prefijo              text,
  consecutivo          int           NOT NULL,
  -- NULL en COTIZACION: numera con su propio contador, no con una
  -- resolución DIAN. Obligatorio en FACTURA/NOTA_CREDITO.
  resolucion_id        uuid,

  -- Solo NOTA_CREDITO: la factura que corrige. RESTRICT — no se puede borrar
  -- (nada se borra) la factura mientras tenga notas crédito que le apunten.
  documento_origen_id  uuid          REFERENCES venta_documento (id) ON DELETE RESTRICT,

  subtotal             numeric(18,2) NOT NULL CHECK (subtotal >= 0),
  total_iva            numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_iva >= 0),
  total                numeric(18,2) NOT NULL CHECK (total >= 0),

  -- NULL en COTIZACION (no asienta). En FACTURA/NOTA_CREDITO se conoce ANTES
  -- de insertar esta fila: quien vende arma y guarda el asiento primero, y
  -- recién con el id ya resuelto inserta el documento — igual que
  -- `producto_movimiento.asiento_id` en un ajuste de inventario.
  asiento_id           uuid,

  motivo_anulacion     text,
  anulado_en           timestamptz,
  anulado_por          uuid          REFERENCES usuario (id) ON DELETE RESTRICT,

  creado_en            timestamptz   NOT NULL DEFAULT now(),
  creado_por           uuid          NOT NULL REFERENCES usuario (id) ON DELETE RESTRICT,

  CONSTRAINT uq_venta_id_empresa UNIQUE (id, empresa_id),
  CONSTRAINT fk_venta_tercero
    FOREIGN KEY (tercero_id, empresa_id)
    REFERENCES tercero (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_venta_resolucion
    FOREIGN KEY (resolucion_id, empresa_id)
    REFERENCES empresa_resolucion_dian (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_venta_asiento
    FOREIGN KEY (asiento_id, empresa_id)
    REFERENCES asiento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_venta_origen
    FOREIGN KEY (documento_origen_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE RESTRICT,

  -- Todo documento numera (`consecutivo` ya es NOT NULL arriba). Lo que
  -- distingue a un fiscal (FACTURA/NOTA_CREDITO) es que numera CONTRA UNA
  -- RESOLUCIÓN DIAN y siempre asienta; una cotización numera con su propio
  -- contador y nunca hace ninguna de las otras dos cosas. Que el motor lo
  -- sostenga evita el estado intermedio roto de "factura sin resolución".
  -- (`prefijo` no entra acá: una resolución sin prefijo es válida — ver
  -- `resolucion.service.spec.ts`, "funciona sin prefijo" — así que tampoco
  -- se le puede exigir NOT NULL a una FACTURA por ese lado.)
  CONSTRAINT ck_venta_fiscal CHECK (
    (tipo = 'COTIZACION' AND resolucion_id IS NULL AND asiento_id IS NULL)
    OR
    (tipo <> 'COTIZACION' AND resolucion_id IS NOT NULL AND asiento_id IS NOT NULL)
  ),
  CONSTRAINT ck_venta_origen CHECK (
    (tipo = 'NOTA_CREDITO') = (documento_origen_id IS NOT NULL)
  ),
  -- Las cuatro columnas de anulación van juntas o no va ninguna, mismo
  -- principio que `ck_asiento_anulacion`: un documento anulado sin motivo
  -- obliga a preguntarle a quien lo anuló, y para cuando alguien audita esa
  -- persona ya no se acuerda.
  CONSTRAINT ck_venta_anulacion CHECK (
    (estado = 'ANULADA'
      AND motivo_anulacion IS NOT NULL AND length(btrim(motivo_anulacion)) > 0
      AND anulado_en  IS NOT NULL
      AND anulado_por IS NOT NULL)
    OR
    (estado <> 'ANULADA'
      AND motivo_anulacion IS NULL
      AND anulado_en  IS NULL
      AND anulado_por IS NULL)
  )
);

-- Un consecutivo no se repite dentro de su prefijo, en toda la empresa. Sin
-- `WHERE`: aplica igual a COTIZACION (prefijo 'COT') que a FACTURA/NOTA_CREDITO
-- (el prefijo de la resolución) — los dos numeran, solo que con contadores
-- distintos, y sus prefijos nunca chocan entre sí.
CREATE UNIQUE INDEX ux_venta_numero
  ON venta_documento (empresa_id, prefijo, consecutivo);
CREATE INDEX ix_venta_tercero ON venta_documento (empresa_id, tercero_id, fecha);
CREATE INDEX ix_venta_tipo    ON venta_documento (empresa_id, tipo, fecha);

COMMENT ON TABLE venta_documento IS
  'Cotización, factura de venta y nota crédito — un solo tipo de documento, distinguido por `tipo`. Una vez EMITIDA, una FACTURA o NOTA_CREDITO no se edita: se anula (estado=ANULADA, motivo obligatorio) y se corrige con un documento nuevo, igual que `asiento`.';
COMMENT ON COLUMN venta_documento.asiento_id IS
  'NULL solo en COTIZACION. En FACTURA/NOTA_CREDITO ya viene resuelto al insertar: el asiento se arma y se guarda ANTES que el documento, no después.';

-- Sin `actualizado_en` ni trigger genérico a propósito: el único UPDATE que
-- esta tabla recibe es la anulación, y esas cuatro columnas ya llevan su
-- propio `anulado_en` — un timestamp genérico al lado sería una segunda
-- fecha diciendo lo mismo que la primera. Mismo criterio que `asiento`, que
-- tampoco lo lleva.

-- -----------------------------------------------------------------------------
-- Venta_documento_linea — sus líneas (el HECHO, como asiento_linea)
-- -----------------------------------------------------------------------------
CREATE TABLE venta_documento_linea (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  venta_documento_id  uuid          NOT NULL,

  -- El orden en que se imprime la línea. Sin esto, el orden de lectura de una
  -- tabla no está garantizado — mismo motivo que ya resolvió `asiento_linea`.
  orden               smallint      NOT NULL,

  -- Este corte solo vende PRODUCTOS con inventario (ver "Qué NO entra" del
  -- plan): una línea de servicio libre, sin `producto_id`, queda para cuando
  -- el primer cliente real la pida.
  producto_id         uuid          NOT NULL,

  cantidad            numeric(18,6) NOT NULL CHECK (cantidad > 0),
  precio_unitario     numeric(18,2) NOT NULL CHECK (precio_unitario >= 0),
  iva_tarifa           numeric(5,2)  NOT NULL CHECK (iva_tarifa IN (0, 5, 19)),

  subtotal            numeric(18,2) NOT NULL CHECK (subtotal >= 0),
  iva_valor           numeric(18,2) NOT NULL DEFAULT 0 CHECK (iva_valor >= 0),
  total               numeric(18,2) NOT NULL CHECK (total >= 0),

  -- Solo FACTURA/NOTA_CREDITO: el costo que devolvió `InventarioApi.costearSalida`
  -- al momento de vender. NULL en COTIZACION — cotizar no consulta el kardex.
  costo_unitario      numeric(18,6),

  creado_en           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT fk_linea_documento
    FOREIGN KEY (venta_documento_id, empresa_id)
    REFERENCES venta_documento (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT fk_linea_producto
    FOREIGN KEY (producto_id, empresa_id)
    REFERENCES producto (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT uq_linea_venta_orden UNIQUE (venta_documento_id, orden),

  -- El motor no confía en que la aplicación sume bien: lo verifica. Mismo
  -- espíritu que `ck_movimiento_valor_total` en `producto_movimiento`.
  CONSTRAINT ck_linea_subtotal CHECK (subtotal = round(cantidad * precio_unitario, 2)),
  CONSTRAINT ck_linea_iva CHECK (iva_valor = round(subtotal * iva_tarifa / 100, 2)),
  CONSTRAINT ck_linea_total CHECK (total = subtotal + iva_valor)
);

CREATE INDEX ix_linea_documento ON venta_documento_linea (venta_documento_id);
CREATE INDEX ix_linea_producto  ON venta_documento_linea (producto_id);

COMMENT ON TABLE venta_documento_linea IS
  'Las líneas de un documento de venta. Nunca se editan ni se borran: si el documento estaba mal, se anula y se corrige con uno nuevo.';

-- Nunca se edita ni se borra, como asiento_linea y producto_movimiento. La
-- función ya existe (0022) y su mensaje habla de "líneas de un asiento" —
-- se reusa igual que ya hizo `inventario` con `producto_movimiento`, en vez
-- de duplicarla con un texto propio por cuatro palabras de diferencia.
CREATE TRIGGER tg_linea_venta_inmutable BEFORE UPDATE OR DELETE ON venta_documento_linea
  FOR EACH ROW EXECUTE FUNCTION fn_linea_inmutable();

-- -----------------------------------------------------------------------------
-- Venta_cotizacion_consecutivo — el contador de cotizaciones
-- -----------------------------------------------------------------------------
-- Una cotización no es un documento fiscal: no numera contra una resolución
-- DIAN (`NucleoApi.tomarConsecutivo` no aplica). Se numera con este contador
-- mínimo, mismo mecanismo de bloqueo que ya usa `comprobante_tipo` en
-- `contabilidad` (`UPDATE ... RETURNING`, con el candado implícito de la fila).
-- El prefijo ('COT') es fijo en código, no una columna: no es un dato fiscal
-- que alguien necesite personalizar por empresa.

CREATE TABLE venta_cotizacion_consecutivo (
  empresa_id         uuid        PRIMARY KEY REFERENCES empresa (id) ON DELETE RESTRICT,
  consecutivo_actual int         NOT NULL DEFAULT 0 CHECK (consecutivo_actual >= 0),

  creado_en          timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz
);

COMMENT ON TABLE venta_cotizacion_consecutivo IS
  'Una fila por empresa. El consecutivo de las cotizaciones (prefijo COT, fijo en código) — no es un documento fiscal, así que no usa el mecanismo de resoluciones DIAN de nucleo.';

CREATE TRIGGER tg_venta_cotizacion_consecutivo_actualizado
  BEFORE UPDATE ON venta_cotizacion_consecutivo
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- -----------------------------------------------------------------------------
-- RLS y privilegios
-- -----------------------------------------------------------------------------
-- `venta_documento` acepta UPDATE (solo para anular, igual que `asiento`).
-- `venta_documento_linea` no: es un hecho, como `asiento_linea` y
-- `producto_movimiento` — el trigger de arriba es además de la falta de
-- privilegio, no en vez de ella, para dar un mensaje que explique qué hacer
-- en su lugar en vez del genérico "permiso denegado".
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['venta_documento', 'venta_documento_linea', 'venta_cotizacion_consecutivo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%s_aislado ON %I USING (empresa_id = app_empresa_id()) WITH CHECK (empresa_id = app_empresa_id())',
      t, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON venta_documento              TO gestion_app, gestion_provision;
GRANT SELECT, INSERT         ON venta_documento_linea        TO gestion_app, gestion_provision;
GRANT SELECT, INSERT, UPDATE ON venta_cotizacion_consecutivo TO gestion_app, gestion_provision;
