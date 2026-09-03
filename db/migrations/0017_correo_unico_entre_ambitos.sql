-- =============================================================================
-- 0017_correo_unico_entre_ambitos — un correo no puede vivir en los dos lados
-- =============================================================================
-- Desde que el login es uno solo (`POST /auth/login`), el correo es lo que decide
-- si la sesión se abre contra `usuario` o contra `plataforma_admin`. Si el mismo
-- correo estuviera en las dos tablas, la rama de plataforma gana y ese usuario
-- cliente no podría entrar nunca — sin ningún mensaje que explique por qué.
--
-- No es escalada de privilegios: la contraseña se verifica contra el hash del
-- administrador, así que nadie entra con credenciales ajenas. Es un usuario que
-- queda encerrado afuera, y eso se depura muy mal.
--
-- Cada tabla tiene su UNIQUE, pero un UNIQUE no cruza tablas. Un trigger sí, y va
-- en el motor y no en el servicio porque hay dos caminos que crean usuarios —el
-- alta desde `nucleo` y el alta desde `plataforma`— y la regla tiene que valer en
-- los dos aunque mañana aparezca un tercero.

CREATE OR REPLACE FUNCTION fn_correo_libre_en_el_otro_ambito() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_otra text := TG_ARGV[0];
  v_existe boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE email = $1)', v_otra)
    INTO v_existe
    USING NEW.email;

  IF v_existe THEN
    RAISE EXCEPTION
      'El correo % ya esta registrado en %', NEW.email, v_otra
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_correo_libre_en_el_otro_ambito() IS
  'Impide que un mismo correo exista a la vez en usuario y en plataforma_admin. El login es uno solo y el correo decide la rama.';

-- Solo al insertar o al cambiar el correo: un UPDATE de nombre o de contraseña no
-- tiene por qué pagar la consulta.
CREATE TRIGGER tg_usuario_correo_libre
  BEFORE INSERT OR UPDATE OF email ON usuario
  FOR EACH ROW EXECUTE FUNCTION fn_correo_libre_en_el_otro_ambito('plataforma_admin');

CREATE TRIGGER tg_plataforma_admin_correo_libre
  BEFORE INSERT OR UPDATE OF email ON plataforma_admin
  FOR EACH ROW EXECUTE FUNCTION fn_correo_libre_en_el_otro_ambito('usuario');

GRANT EXECUTE ON FUNCTION fn_correo_libre_en_el_otro_ambito() TO gestion_app, gestion_provision;

-- Si esta migración falla acá, ya hay un correo repetido y hay que resolverlo a
-- mano antes de seguir. Para verlo:
--   SELECT u.email FROM usuario u JOIN plataforma_admin a ON a.email = u.email;
DO $$
DECLARE
  v_repetidos text;
BEGIN
  SELECT string_agg(u.email::text, ', ')
    INTO v_repetidos
    FROM usuario u JOIN plataforma_admin a ON a.email = u.email;

  IF v_repetidos IS NOT NULL THEN
    RAISE EXCEPTION 'Hay correos en usuario y en plataforma_admin a la vez: %', v_repetidos;
  END IF;
END
$$;
