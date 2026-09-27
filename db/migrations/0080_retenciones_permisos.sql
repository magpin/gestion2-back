-- =============================================================================
-- 0080 — Retenciones: permisos que 0044 abrió de más
-- =============================================================================
--
-- La 0044 deja `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE` para
-- toda tabla nueva, como red por si una migración olvida su GRANT. Pero en las
-- tablas de la ley eso es un agujero: son de todas las empresas, no tienen RLS,
-- y con INSERT/UPDATE la aplicación podía cambiarle la tarifa a todo el mundo.
-- El GRANT SELECT de 0074 no alcanzaba: los privilegios por defecto ya habían
-- sumado los otros.
--
-- 1. La ley (0074): la aplicación solo lee. Escribe la consola de plataforma,
--    con la conexión de provisión.
-- 2. `retencion_calculada` (0079): solo inserción, para todos. Además del
--    REVOKE, un trigger lo sostiene aunque alguien vuelva a dar el permiso.

REVOKE INSERT, UPDATE, DELETE ON
  retencion_concepto_nacional,
  retencion_tarifa,
  retencion_zomac_factor,
  retencion_migracion_registro
FROM gestion_app;

REVOKE UPDATE, DELETE ON retencion_calculada FROM gestion_app, gestion_provision;

CREATE FUNCTION fn_retencion_calculada_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Una retención calculada no se edita ni se borra: se anula con una fila nueva (anula_a).'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER tg_retencion_calculada_inmutable
  BEFORE UPDATE OR DELETE ON retencion_calculada
  FOR EACH ROW EXECUTE FUNCTION fn_retencion_calculada_inmutable();
