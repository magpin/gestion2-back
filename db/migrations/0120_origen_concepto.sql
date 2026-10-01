-- PC23: la retención que sugiere el concepto entra al motor como una fuente
-- más de clasificación (revisión de pantallas complementarias, tanda C).
-- Es una deducción: una persona la acepta o la cambia antes de registrar, y
-- compite con el CIIU igual que las palabras del renglón.

ALTER TABLE retencion_calculada
  DROP CONSTRAINT retencion_calculada_origen_clasificacion_check,
  ADD CONSTRAINT retencion_calculada_origen_clasificacion_check CHECK (origen_clasificacion IN
    ('CONFIRMADO', 'PRODUCTO', 'CIIU', 'PALABRAS', 'IA', 'MANUAL', 'CONCEPTO'));

ALTER TABLE retencion_clasificacion_uso
  DROP CONSTRAINT retencion_clasificacion_uso_origen_propuesto_check,
  ADD CONSTRAINT retencion_clasificacion_uso_origen_propuesto_check CHECK (origen_propuesto IS NULL OR origen_propuesto IN
    ('CONFIRMADO', 'PRODUCTO', 'CIIU', 'PALABRAS', 'IA', 'CONCEPTO'));
