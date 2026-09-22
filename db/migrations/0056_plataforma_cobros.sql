-- 0056 — La consola de plataforma, fase 2: lo que el cliente paga y lo que
-- administra el producto.
--
-- Entregas de la fase 2 de `docs/planes/plataforma-consola.md`:
--
--   - **Precios.** El catálogo recibe los precios del diseño como punto de
--     partida: se cambian en la consola. Una cuenta puede tener un precio
--     pactado distinto.
--   - **Cobros.** Cada período genera un cargo; los pagos se registran a mano.
--     El saldo y la mora salen de comparar los dos. Nada se edita ni se
--     borra: un pago mal registrado se compensa, no se reescribe.
--   - **Mora automática.** A los 15 días sin pagar, la cuenta pasa sola a
--     `MOROSO`, y vuelve a `ACTIVO` cuando se pone al día. Lo hace el sistema,
--     así que la bitácora admite filas sin administrador.
--   - **Pausas de la IA**, **anuncios** a los clientes e **intentos de
--     ingreso**, que la consola muestra en Sistema y en Administradores.
--
-- Los topes de IA del catálogo son **de ejemplo**: se muestran, pero todavía
-- no frenan nada (`docs/planes/ia-restricciones.md` §1).

-- -----------------------------------------------------------------------------
-- Precios y topes del catálogo
-- -----------------------------------------------------------------------------
UPDATE plan_catalogo SET precio_mensual = 129000, tope_ia_usd = 15, al_llegar_tope = 'FRENAR' WHERE clave = 'BASICO';
UPDATE plan_catalogo SET precio_mensual = 249000, tope_ia_usd = 30, al_llegar_tope = 'FRENAR' WHERE clave = 'PROFESIONAL';
UPDATE plan_catalogo SET precio_mensual = 349000, tope_ia_usd = 60, al_llegar_tope = 'FRENAR' WHERE clave = 'CONTADOR';
UPDATE plan_catalogo SET precio_mensual = 489000, tope_ia_usd = 80, al_llegar_tope = 'FRENAR' WHERE clave = 'EMPRESARIAL';

-- -----------------------------------------------------------------------------
-- Suscripción de cada cuenta
-- -----------------------------------------------------------------------------
-- `dia_corte` va de 1 a 28 para que exista en todos los meses. `cobro_desde`
-- es el primer día que se cobra: a las cuentas que ya existen se les empieza a
-- cobrar hoy, no retroactivamente.
ALTER TABLE tenant
  ADD COLUMN precio_pactado numeric(14,0)
    CHECK (precio_pactado IS NULL OR precio_pactado >= 0),
  ADD COLUMN dia_corte smallint NOT NULL
    DEFAULT least(28, extract(day FROM (now() AT TIME ZONE 'America/Bogota'))::int)
    CHECK (dia_corte BETWEEN 1 AND 28),
  ADD COLUMN cobro_desde date NOT NULL
    DEFAULT (now() AT TIME ZONE 'America/Bogota')::date;

COMMENT ON COLUMN tenant.precio_pactado IS
  'Lo que paga esta cuenta si se le pactó distinto del plan. NULL: el precio del plan.';

-- Un cargo por cuenta y período. Lo genera la revisión de cobros, que es
-- idempotente: correrla dos veces no duplica nada.
CREATE TABLE suscripcion_cargo (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid          NOT NULL REFERENCES tenant (id),
  periodo    char(7)       NOT NULL CHECK (periodo ~ '^\d{4}-\d{2}$'),
  plan       text          NOT NULL,
  monto      numeric(14,0) NOT NULL CHECK (monto >= 0),
  vence_en   date          NOT NULL,
  creado_en  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, periodo)
);

CREATE INDEX ix_cargo_vence ON suscripcion_cargo (vence_en);

CREATE TABLE suscripcion_pago (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid          NOT NULL REFERENCES tenant (id),
  fecha       date          NOT NULL,
  monto       numeric(14,0) NOT NULL CHECK (monto > 0),
  medio       text          NOT NULL
              CHECK (medio IN ('TRANSFERENCIA','PSE','TARJETA','EFECTIVO','CONSIGNACION','OTRO')),
  referencia  text          CHECK (referencia IS NULL OR length(referencia) <= 120),
  admin_id    uuid          NOT NULL REFERENCES plataforma_admin (id),
  creado_en   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX ix_pago_tenant ON suscripcion_pago (tenant_id, fecha DESC);

-- Solo la plataforma cobra. Cargos y pagos solo se agregan.
GRANT SELECT, INSERT ON suscripcion_cargo, suscripcion_pago TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Bitácora: lo que hace el sistema solo, y las acciones nuevas
-- -----------------------------------------------------------------------------
ALTER TABLE plataforma_bitacora ALTER COLUMN admin_id DROP NOT NULL;

COMMENT ON COLUMN plataforma_bitacora.admin_id IS
  'Quién hizo el cambio. NULL: lo hizo el sistema (la mora automática).';

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
    'EDITAR_PLAN',
    'CAMBIAR_SUSCRIPCION',
    'REGISTRAR_PAGO',
    'PAUSAR_IA',
    'REANUDAR_IA',
    'PUBLICAR_ANUNCIO',
    'RETIRAR_ANUNCIO',
    'DESACTIVAR_ADMIN',
    'REACTIVAR_ADMIN',
    'RESTABLECER_ADMIN'));

GRANT UPDATE ON plan_catalogo TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Pausas de la IA
-- -----------------------------------------------------------------------------
-- Una pausa apaga el asistente para todas las cuentas (`tenant_id` NULL) o
-- para una. Vigente mientras `levantada_en` sea NULL. El chat y la lectura
-- de documentos la consultan antes de llamar al modelo.
CREATE TABLE ia_pausa (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        REFERENCES tenant (id),
  usos          text[]      NOT NULL
                CHECK (usos <@ ARRAY['CHAT','LECTURA']::text[] AND cardinality(usos) > 0),
  motivo        text        NOT NULL CHECK (length(motivo) BETWEEN 3 AND 300),
  admin_id      uuid        NOT NULL REFERENCES plataforma_admin (id),
  desde         timestamptz NOT NULL DEFAULT now(),
  levantada_en  timestamptz,
  levantada_por uuid        REFERENCES plataforma_admin (id)
);

CREATE INDEX ix_ia_pausa_vigente ON ia_pausa (tenant_id) WHERE levantada_en IS NULL;

-- La aplicación solo necesita saber si hay una pausa vigente para su cuenta.
GRANT SELECT ON ia_pausa TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON ia_pausa TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Anuncios a los clientes
-- -----------------------------------------------------------------------------
-- `cuentas` NULL es para todas. Se ven entre `desde` y `hasta`, y se retiran,
-- no se borran.
CREATE TABLE anuncio (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo       text        NOT NULL CHECK (length(titulo) BETWEEN 3 AND 120),
  cuerpo       text        NOT NULL CHECK (length(cuerpo) BETWEEN 3 AND 600),
  tono         text        NOT NULL CHECK (tono IN ('INFORMATIVO','MANTENIMIENTO')),
  cuentas      uuid[],
  desde        timestamptz NOT NULL,
  hasta        timestamptz NOT NULL,
  admin_id     uuid        NOT NULL REFERENCES plataforma_admin (id),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  retirado_en  timestamptz,
  CHECK (hasta > desde)
);

CREATE INDEX ix_anuncio_vigente ON anuncio (desde, hasta) WHERE retirado_en IS NULL;

GRANT SELECT ON anuncio TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON anuncio TO gestion_provision;

-- -----------------------------------------------------------------------------
-- Intentos de ingreso
-- -----------------------------------------------------------------------------
-- Solo los fallidos y solo de administradores de la plataforma: es lo que la
-- consola muestra, y guardar cada ingreso de cada cliente sería otra cosa. No
-- guarda la contraseña probada, ni un pedazo de ella.
CREATE TABLE login_fallido (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid        NOT NULL REFERENCES plataforma_admin (id),
  ip          text,
  ocurrido_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_login_fallido_admin ON login_fallido (admin_id, ocurrido_en DESC);

GRANT INSERT ON login_fallido TO gestion_app;
GRANT SELECT ON login_fallido TO gestion_provision;
GRANT UPDATE ON plataforma_admin TO gestion_provision;
