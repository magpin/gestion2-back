-- =============================================================================
-- 0100 — Retenciones: la aplicación solo lee la ley y solo ve sus recálculos
-- =============================================================================
--
-- Bug #2 de la revisión del 27-09 (docs/planes/prueba-qa-motor-retenciones.md).
--
-- La 0080 cerró las tablas de ley de la 0074, pero las que llegaron después
-- (0087, 0095, 0096) solo dieron SELECT a `gestion_app` y olvidaron el REVOKE:
-- los privilegios por defecto de la 0044 ya le habían sumado INSERT y UPDATE.
-- Con eso la aplicación podía cambiar, para todas las empresas, las casillas
-- del 350, la tabla del art. 383, los parámetros de ley y las tarifas de los
-- convenios. Las escribe la consola de plataforma, con la conexión de
-- provisión (`gestion_provision`), que conserva sus permisos.
--
-- `retencion_recalculo` es de la plataforma y no tenía RLS: cualquier empresa
-- leía todas las corridas, con el `resumen` que trae las cifras de las demás
-- (`porEmpresa`). Ahora la aplicación:
--   - no la escribe (la corrida la crea la consola);
--   - solo lee las columnas que muestra (qué norma, cuándo), sin `resumen` ni
--     `creado_por`;
--   - solo ve las corridas de su empresa o de las que salió alguna diferencia
--     suya (la subconsulta pasa por el RLS de `retencion_recalculo_diferencia`).
-- La consola lee con `gestion_provision`, que tiene BYPASSRLS.
--
-- Sin objetos temporales: en QA todas las migraciones corren en una sola
-- sesión y un nombre fijo choca con el de otra migración.

-- -----------------------------------------------------------------------------
-- 1. Tablas de ley: solo lectura para la aplicación
-- -----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  formulario_350_renglon,
  retencion_tabla_383,
  retencion_parametro_ley,
  cdi_tarifa
FROM gestion_app;

-- Las de la 0074, 0075, 0083 y 0084 ya estaban cerradas; se repite por si
-- alguna base quedó con un GRANT de más. REVOKE de lo que no se tiene no falla.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  retencion_concepto_nacional,
  retencion_tarifa,
  retencion_zomac_factor,
  retencion_migracion_registro,
  uvt,
  ica_parametro,
  ica_tarifa,
  ica_matriz_agente,
  retencion_autorretencion_ciiu
FROM gestion_app;

GRANT SELECT ON
  formulario_350_renglon,
  retencion_tabla_383,
  retencion_parametro_ley,
  cdi_tarifa
TO gestion_app;

-- -----------------------------------------------------------------------------
-- 2. retencion_recalculo: la aplicación ve solo lo suyo, y sin el resumen
-- -----------------------------------------------------------------------------
REVOKE ALL ON retencion_recalculo FROM gestion_app;
GRANT SELECT (id, desde, hasta, empresa_id, motivo, creado_en)
  ON retencion_recalculo TO gestion_app;

ALTER TABLE retencion_recalculo ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_recalculo FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_retencion_recalculo_propio ON retencion_recalculo
  USING (
    empresa_id = app_empresa_id()
    OR EXISTS (
      SELECT 1
        FROM retencion_recalculo_diferencia d
       WHERE d.recalculo_id = retencion_recalculo.id
    )
  );
