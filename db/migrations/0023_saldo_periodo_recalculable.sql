-- =============================================================================
-- 0023_saldo_periodo_recalculable — reabrir un período borra sus saldos
-- =============================================================================
-- `0022` dejó `saldo_cuenta_periodo` sin DELETE, por la regla de que nada se
-- borra. Al escribir `periodo.service.reabrir()` quedó claro que ahí la regla no
-- aplica.
--
-- La diferencia: un asiento es un HECHO —pasó, y borrarlo esconde que pasó—.
-- Un saldo congelado es un CÁLCULO: se derivó de los asientos del mes al
-- cerrarlo, y no aporta ninguna información que no esté en las líneas. Reabrir
-- un período es deshacer ese cálculo, y volver a cerrarlo lo rehace igual.
--
-- Dejarlos sería peor que borrarlos: la fila vieja seguiría ahí después de
-- reabrir y el balance del mes siguiente arrancaría de un saldo inicial que ya
-- nadie recalculó.
--
-- Los asientos del período reabierto no se tocan. Son el hecho, y siguen ahí.

GRANT DELETE ON saldo_cuenta_periodo TO gestion_app;

COMMENT ON TABLE saldo_cuenta_periodo IS
  'Saldos congelados al cerrar el periodo. Existe por rendimiento: el balance no puede recorrer el ano entero en cada consulta. Es un calculo, no un hecho: reabrir el periodo los borra y volver a cerrarlo los rehace.';
