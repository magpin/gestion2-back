-- =============================================================================
-- 0101 — Paso «Impuestos»: el «No» que contestó la persona queda guardado
-- =============================================================================
--
-- Bug #18 de la revisión del 27-09 (docs/planes/prueba-qa-motor-retenciones.md).
--
-- Un «No» a Régimen Simple, gran contribuyente, agente de retención o
-- autorretenedora es la ausencia de un código en la casilla 53: no deja
-- rastro. Hasta «Todo correcto» no había cómo distinguir «dijo que no» de
-- «nadie contestó», y el botón «No» quedaba sin marcar aunque la pantalla
-- dijera «Respuesta guardada».
--
-- Ahora el «No» se anota por pregunta. Un «Sí» (o el código abierto por el
-- RUT) manda sobre esta lista: la casilla 53 sigue siendo la fuente.

ALTER TABLE empresa
  ADD COLUMN impuestos_dijo_no text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN empresa.impuestos_dijo_no IS
  'Preguntas del paso Impuestos que la persona contestó con «No» (las que no tienen código de «no» en la casilla 53).';
