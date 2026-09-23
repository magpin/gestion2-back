-- 0065 — Facturas de venta históricas: las que se emitieron antes de usar el
-- sistema.
--
-- Fase 10 de `docs/planes/maria-facturas-y-errores.md`. Tres decisiones del
-- dueño, del 23 de septiembre de 2026:
--
--   1. **Con su número y su fecha originales, sin tocar la resolución.** Ya
--      tienen número —se lo dio el sistema anterior o el talonario—; cargarlas
--      por el camino normal les daría números nuevos y quemaría consecutivos
--      que la DIAN espera para facturas futuras.
--   2. **Sin asiento y sin kardex: solo registro y cartera.** Lo que vendieron
--      ya está en los saldos iniciales; asentarlas duplicaría ingresos e
--      inventario. Sirven para consultarlas y, si quedaron sin pagar, para
--      cobrarlas: el cobro sí asienta, contra la cartera inicial.
--   3. **Salen del Excel del sistema anterior**, con un script de importación.

ALTER TABLE venta_documento
  ADD COLUMN historica boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN venta_documento.historica IS
  'Una factura emitida antes de usar el sistema, cargada con su numero y su fecha originales. No tiene resolucion ni asiento ni kardex: lo que vendio ya esta en los saldos iniciales. Sirve para consultar y para cobrar lo que quedo pendiente.';

-- ── La regla fiscal, con la histórica adentro ────────────────────────────────
-- 0027 exige resolución y asiento a todo lo que no sea cotización. La
-- histórica es la única excepción, y solo para facturas: una nota o una
-- cotización histórica no tienen sentido.
ALTER TABLE venta_documento DROP CONSTRAINT ck_venta_fiscal;
ALTER TABLE venta_documento ADD CONSTRAINT ck_venta_fiscal CHECK (
  (tipo = 'COTIZACION' AND NOT historica
     AND resolucion_id IS NULL AND asiento_id IS NULL)
  OR
  (historica AND tipo = 'FACTURA'
     AND resolucion_id IS NULL AND asiento_id IS NULL)
  OR
  (tipo <> 'COTIZACION' AND NOT historica
     AND resolucion_id IS NOT NULL AND asiento_id IS NOT NULL)
);

-- ── El número, una sola vez ──────────────────────────────────────────────────
-- Es lo que responde «¿qué pasa si alguien carga dos veces la misma?»: se
-- rechaza por el número. Dos cambios sobre el índice de 0027:
--
--   - `coalesce(prefijo, '')`: con el prefijo nulo, Postgres trata dos NULL
--     como distintos, y dos facturas sin prefijo con el mismo consecutivo
--     entraban las dos. Un talonario viejo casi nunca tiene prefijo.
--   - Una histórica **anulada** libera su número: se anuló porque se cargó mal,
--     y la forma de corregirla es volver a cargarla bien.
DROP INDEX ux_venta_numero;
CREATE UNIQUE INDEX ux_venta_numero
  ON venta_documento (empresa_id, coalesce(prefijo, ''), consecutivo)
  WHERE NOT (historica AND estado = 'ANULADA');
