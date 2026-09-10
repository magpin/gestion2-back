-- =============================================================================
-- 0032_tesoreria_prerrequisitos — lo que Caja y Bancos necesitan de tablas ya existentes
-- =============================================================================
-- Módulo 7 de la secuencia (docs/decisiones/secuencia-modulos.md), Fase 0 del
-- plan (docs/planes/caja-bancos-backend.md). Dos ajustes chicos a tablas de
-- otros módulos, ninguna tabla nueva todavía:
--
--   1. `empresa_sede` no tenía `UNIQUE (id, empresa_id)` — solo PK simple.
--      Es la única tabla de `nucleo` sin esa pareja, porque hasta ahora nada
--      la referenciaba con una FK compuesta. `caja.sede_id` va a ser la
--      primera, y sin este índice esa FK no puede existir.
--
--   2. `asiento.origen_tipo` suma `'MOVIMIENTO_CAJA'` y `'MOVIMIENTO_BANCO'`
--      a su `CHECK`. Van separados y no como un solo `'TESORERIA'` a
--      propósito: Caja y Bancos son dos cuadres distintos (arqueo físico
--      diario contra conciliación periódica de extracto), y el libro mayor
--      tiene que poder filtrar el uno sin el otro.
--
-- De paso se nombra el CHECK de origen_tipo, que en 0022 quedó sin nombre
-- propio a diferencia de sus hermanos en la misma tabla (ck_asiento_cuadra,
-- ck_asiento_origen, ck_asiento_anulacion) — mismo criterio que ya aplicó
-- 0026 al corregir ck_movimiento_tipo de paso.

ALTER TABLE empresa_sede ADD CONSTRAINT uq_sede_id_empresa UNIQUE (id, empresa_id);

ALTER TABLE asiento DROP CONSTRAINT asiento_origen_tipo_check;

ALTER TABLE asiento ADD CONSTRAINT ck_asiento_origen_tipo
  CHECK (origen_tipo IN (
    'VENTA', 'COMPRA', 'NOMINA', 'AJUSTE_INVENTARIO',
    'MOVIMIENTO_CAJA', 'MOVIMIENTO_BANCO'
  ));
