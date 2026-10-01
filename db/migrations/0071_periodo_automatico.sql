-- =============================================================================
-- 0071 — Períodos automáticos
-- =============================================================================
--
-- Los meses ya no se abren ni se cierran a mano. El mes en curso está siempre
-- abierto, y el último día de cada mes se cierra solo. Lo que llegue con fecha
-- de un mes cerrado se asienta en el mes abierto (el primer día), con la fecha
-- del documento anotada en la glosa.
--
-- Solo hace falta distinguir qué cierre hizo el sistema y cuál una persona: el
-- cierre sigue exigiendo quién (ck_periodo_cierre), y en uno automático es el
-- usuario cuya operación lo disparó.

ALTER TABLE periodo_contable
  ADD COLUMN cierre_automatico boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN periodo_contable.cierre_automatico IS
  'true si lo cerró el sistema al terminar el mes; cerrado_por es entonces el usuario cuya operación disparó el cierre.';
