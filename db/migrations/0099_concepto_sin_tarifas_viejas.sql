-- =============================================================================
-- 0099 — Los conceptos de la empresa ya no llevan tarifa
-- =============================================================================
--
-- Plan: docs/planes/plan-motor-retenciones.md, Fase 7 (limpieza).
--
-- Las tarifas y las bases mínimas son de la ley (0074): el concepto de la
-- empresa solo enlaza el concepto de la ley con sus cuentas. Las columnas de
-- tarifa quedaban para las filas cargadas a mano antes del motor, como
-- respaldo cuando no había tarifa de ley. Ese respaldo se va con ellas.
--
-- Las filas viejas quedan (las nombran las compras y ventas que las usaron). Lo
-- que tenían en esas columnas queda en `retencion_migracion_registro`, fila por
-- fila, y la vuelta lo devuelve.

INSERT INTO retencion_migracion_registro (migracion, que, detalle)
SELECT '0099', 'TARIFAS_VIEJAS_RETIRADAS',
       jsonb_build_object(
         'concepto_id', id,
         'tarifa', tarifa,
         'tarifa_no_declarante', tarifa_no_declarante,
         'base_minima_uvt', base_minima_uvt)
  FROM retencion_concepto
 WHERE tarifa IS NOT NULL OR tarifa_no_declarante IS NOT NULL
    OR base_minima_uvt IS NOT NULL;

ALTER TABLE retencion_concepto
  DROP COLUMN tarifa,
  DROP COLUMN tarifa_no_declarante,
  DROP COLUMN base_minima_uvt;
