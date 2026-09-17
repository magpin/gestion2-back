-- 0045 — Contar la caja de verdad, y poder corregir un movimiento mal cargado.
--
-- Paso 13 de `docs/planes/ajustes-16-sep.md` (punto 18b). Dos cosas del
-- efectivo que hasta acá no tenían dónde vivir:
--
--   1. `caja_arqueo_denominacion` — cuántos billetes de 100.000, cuántas
--      monedas de 500. El arqueo guardaba solo el total que alguien sumó a
--      mano, y un total no deja ver dónde estuvo el error de conteo.
--   2. `caja_movimiento.reversa_de` — el movimiento contrario de uno mal
--      cargado, con su motivo. El libro sigue sin editarse ni borrarse: la
--      corrección es un hecho nuevo que apunta al que corrige.

-- ── Las denominaciones de un arqueo ─────────────────────────────────────────
-- La FK compuesta necesita la pareja (id, empresa_id) única en el padre, igual
-- que en el resto del esquema: así una fila no puede apuntar al arqueo de otra
-- empresa aunque alguien adivine el id.
ALTER TABLE caja_arqueo
  ADD CONSTRAINT uq_arqueo_id_empresa UNIQUE (id, empresa_id);

CREATE TABLE caja_arqueo_denominacion (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid          NOT NULL REFERENCES empresa (id) ON DELETE RESTRICT,
  arqueo_id     uuid          NOT NULL,

  -- El billete de 1.000 y la moneda de 1.000 existen los dos: el tipo es parte
  -- de la identidad, no un adorno.
  tipo          text          NOT NULL CHECK (tipo IN ('BILLETE', 'MONEDA')),
  denominacion  numeric(18,2) NOT NULL CHECK (denominacion > 0),
  -- Solo lo que se contó. Una denominación en cero no se guarda: no aporta al
  -- total y ensucia el detalle, mismo criterio que una línea de asiento en cero.
  cantidad      integer       NOT NULL CHECK (cantidad > 0),
  subtotal      numeric(18,2) GENERATED ALWAYS AS (denominacion * cantidad) STORED,

  creado_en     timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT fk_arqueo_denominacion_arqueo
    FOREIGN KEY (arqueo_id, empresa_id)
    REFERENCES caja_arqueo (id, empresa_id) ON DELETE RESTRICT,
  CONSTRAINT uq_arqueo_denominacion UNIQUE (arqueo_id, tipo, denominacion)
);

COMMENT ON TABLE caja_arqueo_denominacion IS
  'El conteo de un arqueo, billete por billete. Qué denominaciones valen lo sabe el código (caja.reglas.ts); la base solo sostiene que el subtotal sea cantidad por denominación. La suma contra saldo_contado la verifica el servicio al cerrar, en la misma transacción.';

ALTER TABLE caja_arqueo_denominacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE caja_arqueo_denominacion FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_caja_arqueo_denominacion_aislado ON caja_arqueo_denominacion
  USING (empresa_id = app_empresa_id())
  WITH CHECK (empresa_id = app_empresa_id());

GRANT SELECT, INSERT, UPDATE ON caja_arqueo_denominacion TO gestion_app, gestion_provision;

-- ── La reversa de un movimiento ─────────────────────────────────────────────
ALTER TABLE caja_movimiento
  ADD CONSTRAINT uq_caja_mov_id_empresa UNIQUE (id, empresa_id);

ALTER TABLE caja_movimiento
  ADD COLUMN reversa_de     uuid,
  ADD COLUMN motivo_reversa text,
  ADD CONSTRAINT fk_caja_mov_reversa
    FOREIGN KEY (reversa_de, empresa_id)
    REFERENCES caja_movimiento (id, empresa_id) ON DELETE RESTRICT,
  -- Una reversa sin motivo es un movimiento que nadie sabe explicar. El
  -- `IS NOT NULL` explícito no sobra: `length(NULL) >= 3` da NULL, y un CHECK
  -- que da NULL se da por cumplido.
  ADD CONSTRAINT ck_caja_mov_reversa CHECK (
    (reversa_de IS NULL AND motivo_reversa IS NULL) OR
    (reversa_de IS NOT NULL AND motivo_reversa IS NOT NULL
       AND length(btrim(motivo_reversa)) >= 3)
  );

-- Un movimiento se reversa una sola vez. Dos reversas del mismo error dejarían
-- el libro corregido de más.
CREATE UNIQUE INDEX ux_caja_mov_reversa
  ON caja_movimiento (reversa_de) WHERE reversa_de IS NOT NULL;

COMMENT ON COLUMN caja_movimiento.reversa_de IS
  'El movimiento que este corrige. La reversa es del tipo contrario, por el mismo valor, en la misma caja, y su asiento invierte las líneas del original. No se reversa una reversa, ni el ajuste de un arqueo, ni un cobro o pago de documento: esos se corrigen devolviendo el cobro o el pago.';

-- La forma de una reversa la sostiene la base y no solo el servicio: es la
-- diferencia entre corregir un error y tapar un faltante con un ingreso que
-- dice "corrección".
CREATE OR REPLACE FUNCTION fn_caja_reversa_valida() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original caja_movimiento%ROWTYPE;
BEGIN
  IF NEW.reversa_de IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO original FROM caja_movimiento WHERE id = NEW.reversa_de;

  IF original.reversa_de IS NOT NULL THEN
    RAISE EXCEPTION 'Una reversa no se reversa: se registra el movimiento de nuevo.';
  END IF;
  IF original.tipo NOT IN ('INGRESO', 'EGRESO') OR original.origen_tipo IS NOT NULL THEN
    RAISE EXCEPTION 'Solo se reversa un ingreso o egreso manual.';
  END IF;
  -- El ajuste de un arqueo tampoco: es lo que se contó, y se corrige con otro
  -- arqueo, no borrando la diferencia.
  IF EXISTS (SELECT 1 FROM caja_arqueo WHERE asiento_ajuste_id = original.asiento_id) THEN
    RAISE EXCEPTION 'El ajuste de un arqueo no se reversa: se corrige con otro arqueo.';
  END IF;
  IF NEW.caja_id <> original.caja_id
     OR NEW.valor <> original.valor
     OR NEW.tipo = original.tipo THEN
    RAISE EXCEPTION 'La reversa va en la misma caja, por el mismo valor y en sentido contrario.';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER tg_caja_reversa_valida
  BEFORE INSERT ON caja_movimiento
  FOR EACH ROW EXECUTE FUNCTION fn_caja_reversa_valida();

GRANT EXECUTE ON FUNCTION fn_caja_reversa_valida() TO gestion_app, gestion_provision;
