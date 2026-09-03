-- =============================================================================
-- 0001_base — extensiones, funciones comunes y roles de conexión
-- Base: db_gestion5
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Funciones comunes
-- -----------------------------------------------------------------------------

-- Marca actualizado_en en cada UPDATE. Las tablas históricas NO la usan:
-- una fila histórica no se edita, se cierra con fecha_fin y se abre otra.
CREATE OR REPLACE FUNCTION fn_marcar_actualizado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

-- Contexto de la sesión. Lo fija la aplicación al abrir la transacción con
--   SET LOCAL app.tenant_id  = '...';
--   SET LOCAL app.empresa_id = '...';
-- Si no está fijado devuelve NULL, y las políticas RLS no dejan pasar ninguna fila.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_empresa_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.empresa_id', true), '')::uuid;
$$;

-- Normaliza texto para buscar: sin tildes y en minúsculas.
-- unaccent() es STABLE porque depende del diccionario que tenga cargado la sesión,
-- y Postgres no acepta funciones STABLE en expresiones de índice. Fijar el
-- diccionario por nombre la vuelve determinista, y eso permite declararla IMMUTABLE
-- y usarla para indexar.
CREATE OR REPLACE FUNCTION fn_normalizar(p_texto text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(public.unaccent('public.unaccent'::regdictionary, p_texto));
$$;

-- Dígito de verificación del NIT (algoritmo DIAN).
-- Pesos aplicados de derecha a izquierda; residuo 0 o 1 devuelve el residuo.
CREATE OR REPLACE FUNCTION fn_dv_nit(p_nit text) RETURNS char(1)
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  v_pesos  int[] := ARRAY[3,7,13,17,19,23,29,37,41,43,47,53,59,67,71];
  v_limpio text  := regexp_replace(p_nit, '[^0-9]', '', 'g');
  v_len    int;
  v_suma   bigint := 0;
  v_resto  int;
BEGIN
  v_len := length(v_limpio);
  IF v_len = 0 OR v_len > 15 THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..v_len LOOP
    v_suma := v_suma + substr(v_limpio, v_len - i + 1, 1)::int * v_pesos[i];
  END LOOP;
  v_resto := (v_suma % 11)::int;
  IF v_resto <= 1 THEN
    RETURN v_resto::text;
  END IF;
  RETURN (11 - v_resto)::text;
END;
$$;

-- -----------------------------------------------------------------------------
-- Roles de conexión
-- -----------------------------------------------------------------------------
-- gestion_app       : conexión normal de la API. Sujeta a RLS. SIN privilegio DELETE
--                     en ninguna tabla — "nada se borra, todo se anula" lo sostiene
--                     el motor, no el código.
-- gestion_provision : solo el alta de tenant y tareas de administración. BYPASSRLS.
--                     Nunca se usa para atender peticiones de usuarios finales.
--
-- Ambos quedan NOLOGIN. Asignar contraseña manualmente, fuera del repositorio:
--   ALTER ROLE gestion_app       WITH LOGIN PASSWORD '...';
--   ALTER ROLE gestion_provision WITH LOGIN PASSWORD '...';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gestion_app') THEN
    CREATE ROLE gestion_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gestion_provision') THEN
    CREATE ROLE gestion_provision NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO gestion_app, gestion_provision;

GRANT EXECUTE ON FUNCTION app_tenant_id()      TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION app_empresa_id()     TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_dv_nit(text)      TO gestion_app, gestion_provision;
GRANT EXECUTE ON FUNCTION fn_normalizar(text)  TO gestion_app, gestion_provision;

