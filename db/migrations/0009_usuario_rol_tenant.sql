-- =============================================================================
-- 0009_usuario_rol_tenant — los roles que no se ejercen dentro de una contabilidad
-- =============================================================================
-- `usuario_empresa_rol` exige empresa, y hay permisos que existen antes de que la
-- primera empresa exista: quién puede crear empresas, invitar usuarios y manejar
-- la suscripción. Ese es el ámbito TENANT del catálogo `rol`.
--
-- Sin esta tabla, el primer usuario de una cuenta recién creada no tendría forma
-- de crear su primera empresa: no hay empresa donde asignarle un rol.

CREATE TABLE usuario_rol_tenant (
  usuario_id      uuid        NOT NULL,
  rol_codigo      text        NOT NULL REFERENCES rol (codigo),
  tenant_id       uuid        NOT NULL REFERENCES tenant (id),
  asignado_por_id uuid        REFERENCES usuario (id),
  asignado_en     timestamptz NOT NULL DEFAULT now(),
  revocado_en     timestamptz,

  PRIMARY KEY (usuario_id, rol_codigo),
  -- Misma defensa que en usuario_empresa_rol: imposible asignarle a un usuario
  -- un rol sobre un tenant que no es el suyo.
  FOREIGN KEY (usuario_id, tenant_id) REFERENCES usuario (id, tenant_id)
);

COMMENT ON TABLE usuario_rol_tenant IS
  'Roles de ambito TENANT (ADMIN_TENANT). Los de ambito EMPRESA viven en usuario_empresa_rol.';

CREATE INDEX ix_urt_usuario ON usuario_rol_tenant (usuario_id) WHERE revocado_en IS NULL;

-- Solo aceptar roles cuyo ambito sea TENANT. Un DIRECTOR no se asigna acá: se
-- ejerce dentro de una contabilidad concreta.
CREATE OR REPLACE FUNCTION fn_validar_rol_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ambito text;
BEGIN
  SELECT ambito INTO v_ambito FROM rol WHERE codigo = NEW.rol_codigo;
  IF v_ambito IS DISTINCT FROM 'TENANT' THEN
    RAISE EXCEPTION 'El rol % no es de ambito TENANT', NEW.rol_codigo
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_validar_rol_tenant
  BEFORE INSERT OR UPDATE ON usuario_rol_tenant
  FOR EACH ROW EXECUTE FUNCTION fn_validar_rol_tenant();

-- Lo inverso en usuario_empresa_rol: ahí solo entran roles de ámbito EMPRESA.
CREATE OR REPLACE FUNCTION fn_validar_rol_empresa() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ambito text;
BEGIN
  SELECT ambito INTO v_ambito FROM rol WHERE codigo = NEW.rol_codigo;
  IF v_ambito IS DISTINCT FROM 'EMPRESA' THEN
    RAISE EXCEPTION 'El rol % no es de ambito EMPRESA', NEW.rol_codigo
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_validar_rol_empresa
  BEFORE INSERT OR UPDATE ON usuario_empresa_rol
  FOR EACH ROW EXECUTE FUNCTION fn_validar_rol_empresa();

ALTER TABLE usuario_rol_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_rol_tenant FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_urt_aislado ON usuario_rol_tenant
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE ON usuario_rol_tenant TO gestion_app, gestion_provision;
