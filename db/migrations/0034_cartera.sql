-- =============================================================================
-- 0034_cartera — cuánto se ha cobrado/pagado de una factura o una compra
-- =============================================================================
-- Paso 12 de Caja y Bancos (docs/planes/caja-cartera.md): conectar
-- "Cobrar/Pagar en efectivo" desde Ventas y Compras a `TesoreriaApi` exige
-- saber cuánto queda pendiente de un documento — hoy ninguno de los dos lo
-- sabe, solo `EMITIDA`/`ANULADA`.
--
-- `monto_pagado` es un acumulador en la cabecera, no una tabla nueva de
-- "pagos": el detalle de cada cobro/pago ya vive en `caja_movimiento`
-- (`origen_tipo='FACTURA_VENTA'`/`'COMPRA'`, `origen_id` apuntando acá,
-- desde 0033). `saldo_pendiente` no se guarda aparte —es `total -
-- monto_pagado` (`neto_a_pagar - monto_pagado` en compras)—: una columna
-- calculada que se guarda es una columna que se puede desincronizar.

ALTER TABLE venta_documento
  ADD COLUMN monto_pagado numeric(18,2) NOT NULL DEFAULT 0 CHECK (monto_pagado >= 0);
ALTER TABLE venta_documento
  ADD CONSTRAINT ck_venta_monto_pagado CHECK (monto_pagado <= total);

COMMENT ON COLUMN venta_documento.monto_pagado IS
  'Cuánto se ha cobrado de esta FACTURA. Siempre 0 en COTIZACION/NOTA_CREDITO — nadie cobra esas. saldo_pendiente = total - monto_pagado, no se guarda aparte.';

ALTER TABLE compra_documento
  ADD COLUMN monto_pagado numeric(18,2) NOT NULL DEFAULT 0 CHECK (monto_pagado >= 0);
ALTER TABLE compra_documento
  ADD CONSTRAINT ck_compra_monto_pagado CHECK (monto_pagado <= neto_a_pagar);

COMMENT ON COLUMN compra_documento.monto_pagado IS
  'Cuánto se le ha pagado al proveedor de esta compra. saldo_pendiente = neto_a_pagar - monto_pagado, no se guarda aparte.';
