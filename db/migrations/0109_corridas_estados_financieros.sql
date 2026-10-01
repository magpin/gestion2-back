-- =============================================================================
-- 0109 — Los estados financieros quedan en el rastro de corridas
-- =============================================================================
--
-- Plan: docs/planes/plan-integracion-menu-nuevo.md, Fase 7. Sacar un estado de
-- resultados, un balance o un flujo de caja en PDF o Excel deja huella como
-- cualquier reporte (0049). El CHECK se amplía en la migración que los trae,
-- como pide su comentario.

ALTER TABLE reporte_corrida DROP CONSTRAINT reporte_corrida_reporte_check;
ALTER TABLE reporte_corrida ADD CONSTRAINT reporte_corrida_reporte_check CHECK (reporte IN (
  'VENTAS_POR_CLIENTE', 'ANTIGUEDAD_CARTERA', 'GUARDADO',
  'RETENCIONES_350', 'RETEICA', 'CERTIFICADOS_RETENCION',
  'ESTADO_RESULTADOS', 'BALANCE_GENERAL', 'FLUJO_CAJA'
));
