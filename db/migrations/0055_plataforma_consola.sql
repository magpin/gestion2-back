-- 0055 — Lo que necesita la consola de plataforma, fase 1.
--
-- Entrega E1 de `docs/planes/plataforma-consola.md`. Tres cosas, ninguna
-- contable:
--
--   - **La bitácora dice qué pasó.** Hasta acá un ajuste de cupos quedaba como
--     `CAMBIAR_PLAN`, porque no había otra acción que ponerle. Ahora cada
--     cambio tiene la suya, y las acciones nuevas de la consola también.
--   - **El catálogo de planes.** Los cupos por defecto de cada plan vivían en
--     la cabeza de quien daba de alta. Precio y tope de IA quedan nulos: se
--     llenan con los cobros (fase 2), y mientras tanto la consola dice «sin
--     configurar».
--   - **Un acceso por usuario y día.** `usuario.ultimo_acceso_en` solo guarda el
--     último, así que no alcanza para decir cuántos entraron ayer o esta
--     semana.

-- -----------------------------------------------------------------------------
-- Bitácora
-- -----------------------------------------------------------------------------
ALTER TABLE plataforma_bitacora DROP CONSTRAINT plataforma_bitacora_accion_check;
ALTER TABLE plataforma_bitacora ADD CONSTRAINT plataforma_bitacora_accion_check
  CHECK (accion IN (
    'CREAR_CUENTA',
    'CREAR_EMPRESA',
    'CREAR_USUARIO',
    'CAMBIAR_ESTADO',
    'CAMBIAR_PLAN',
    'AJUSTAR_CUPOS',
    'RENOMBRAR_CUENTA',
    'RESTABLECER_PASSWORD',
    'DESACTIVAR_USUARIO',
    'REACTIVAR_USUARIO',
    'EDITAR_PLAN'));

-- La bitácora global se filtra por acción y por fecha, sin cuenta.
CREATE INDEX ix_bitacora_ocurrido ON plataforma_bitacora (ocurrido_en DESC);

-- -----------------------------------------------------------------------------
-- Catálogo de planes
-- -----------------------------------------------------------------------------
-- Los cupos del catálogo son los que recibe una cuenta **al nacer**. Después
-- son suyos: cambiar el catálogo no toca a las cuentas que ya existen, porque
-- a varias se les pactó algo distinto.
CREATE TABLE plan_catalogo (
  clave           text          PRIMARY KEY
                                CHECK (clave IN ('BASICO','PROFESIONAL','CONTADOR','EMPRESARIAL')),
  nombre          text          NOT NULL,
  orden           smallint      NOT NULL,
  max_empresas    integer       NOT NULL CHECK (max_empresas > 0),
  max_usuarios    integer       NOT NULL CHECK (max_usuarios > 0),
  precio_mensual  numeric(14,0) CHECK (precio_mensual IS NULL OR precio_mensual >= 0),
  tope_ia_usd     numeric(10,2) CHECK (tope_ia_usd IS NULL OR tope_ia_usd >= 0),
  al_llegar_tope  text          CHECK (al_llegar_tope IS NULL OR al_llegar_tope IN ('AVISAR','FRENAR')),
  actualizado_en  timestamptz
);

COMMENT ON TABLE plan_catalogo IS
  'Los planes que se venden. Los cupos son los de una cuenta nueva; precio y tope de IA se llenan con los cobros (fase 2).';

CREATE TRIGGER tg_plan_catalogo_actualizado
  BEFORE UPDATE ON plan_catalogo
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

INSERT INTO plan_catalogo (clave, nombre, orden, max_empresas, max_usuarios) VALUES
  ('BASICO',      'Básico',      1,  1,  3),
  ('PROFESIONAL', 'Profesional', 2,  3,  8),
  ('CONTADOR',    'Contador',    3, 15, 10),
  ('EMPRESARIAL', 'Empresarial', 4,  5, 25);

-- Sin RLS: no es de ningún cliente. Solo la plataforma lo edita.
GRANT SELECT ON plan_catalogo TO gestion_app;
GRANT SELECT, UPDATE ON plan_catalogo TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Accesos por día
-- -----------------------------------------------------------------------------
-- Una fila por usuario y día de Colombia, la primera vez que entra. No guarda
-- la hora, ni la IP, ni desde dónde: solo que entró, que es lo que la consola
-- cuenta.
CREATE TABLE usuario_acceso_dia (
  usuario_id uuid NOT NULL REFERENCES usuario (id),
  tenant_id  uuid NOT NULL REFERENCES tenant (id),
  dia        date NOT NULL,
  PRIMARY KEY (usuario_id, dia)
);

CREATE INDEX ix_acceso_dia_tenant ON usuario_acceso_dia (tenant_id, dia DESC);
CREATE INDEX ix_acceso_dia_dia ON usuario_acceso_dia (dia DESC);

ALTER TABLE usuario_acceso_dia ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_acceso_dia FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_acceso_dia_aislado ON usuario_acceso_dia
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- La aplicación solo agrega (y lee lo suyo, que `ON CONFLICT` necesita). La
-- plataforma lee todo, por BYPASSRLS.
GRANT SELECT, INSERT ON usuario_acceso_dia TO gestion_app;
GRANT SELECT ON usuario_acceso_dia TO gestion_provision;
