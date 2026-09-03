-- =============================================================================
-- 0002_tenant — la cuenta que paga la suscripción
-- =============================================================================
-- tenant != empresa. Un contador con 15 clientes es UN tenant con 15 empresas.
-- La facturación del SaaS (planes, cobros, vencimientos) es un módulo aparte;
-- acá solo vive lo que el resto del sistema necesita saber: quién es y si puede operar.

CREATE TABLE tenant (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        text        NOT NULL,
  slug          citext      NOT NULL UNIQUE
                            CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  plan          text        NOT NULL DEFAULT 'BASICO'
                            CHECK (plan IN ('BASICO','PROFESIONAL','CONTADOR','EMPRESARIAL')),
  estado        text        NOT NULL DEFAULT 'ACTIVO'
                            CHECK (estado IN ('ACTIVO','SUSPENDIDO','MOROSO','CANCELADO')),
  max_empresas  integer     NOT NULL DEFAULT 1 CHECK (max_empresas > 0),
  max_usuarios  integer     NOT NULL DEFAULT 3 CHECK (max_usuarios > 0),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz
);

COMMENT ON COLUMN tenant.estado IS
  'SUSPENDIDO y MOROSO permiten leer pero no emitir documentos. CANCELADO no permite entrar.';

CREATE TRIGGER tg_tenant_actualizado
  BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION fn_marcar_actualizado();

-- RLS: la sesión solo ve su propio tenant.
-- FORCE hace que la política aplique también al dueño de la tabla; sin eso, la API
-- conectada como owner vería todo.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_tenant_aislado ON tenant
  USING (id = app_tenant_id())
  WITH CHECK (id = app_tenant_id());

-- Sin DELETE: un tenant se marca CANCELADO, no se borra.
-- El alta de tenant la hace gestion_provision, que no pasa por RLS.
GRANT SELECT, UPDATE ON tenant TO gestion_app;
GRANT SELECT, INSERT, UPDATE ON tenant TO gestion_provision;

