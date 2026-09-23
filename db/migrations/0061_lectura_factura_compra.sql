-- 0061 — Que `documento_leido` pueda guardar una factura de compra leída.
--
-- Fase 6 de `docs/planes/maria-facturas-y-errores.md`. La tabla 0048 se diseñó
-- para los tres documentos con los que se configura una empresa, y una factura
-- rompe tres supuestos de esa forma. Los tres se corrigen acá y ninguno es
-- cosmético.
--
-- Lo que NO cambia, y es lo que hace que esto sea una ampliación y no otra
-- tabla: el ciclo de vida (`EN_COLA → LEYENDO → LEIDO | FALLO`), el archivo que
-- vive en el bucket y no en la base, la medición del costo, el aislamiento por
-- empresa, y sobre todo que **nada de `extraido` vale hasta que una persona lo
-- confirma**. Una factura leída no es una compra: es una propuesta de compra.

-- ── 1. El tipo ───────────────────────────────────────────────────────────────
-- El CHECK de 0048 nombra los tres documentos de configuración. No es un
-- catálogo —siguen siendo pocos y fijos—, así que se reescribe la lista.
ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_tipo_check;
ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_tipo_check
  CHECK (tipo IN ('RUT', 'CAMARA_COMERCIO', 'RESOLUCION_DIAN', 'FACTURA_COMPRA'));

-- ── 2. La forma de lo extraído ───────────────────────────────────────────────
-- 0048 exige `jsonb_typeof(extraido) = 'array'` porque un RUT devuelve una
-- lista de `campo · valor`. Una factura no es una lista de campos: es una
-- cabecera —proveedor, número, fecha, totales— con renglones adentro. Es un
-- objeto.
--
-- Se admiten las dos formas y la base sigue sin mirar adentro, que es lo que
-- 0048 dejó dicho: «la forma la impone el esquema de la llamada y la valida el
-- módulo». Lo que la base sí garantiza es que no llegue un número ni una
-- cadena suelta donde el código va a iterar.
ALTER TABLE documento_leido DROP CONSTRAINT documento_leido_extraido_check;
ALTER TABLE documento_leido ADD CONSTRAINT documento_leido_extraido_check
  CHECK (extraido IS NULL OR jsonb_typeof(extraido) IN ('array', 'object'));

-- ── 3. Cuántas se pueden leer a la vez ───────────────────────────────────────
-- Este es el cambio que importa. El índice de 0048 es `(empresa_id, tipo)` para
-- las lecturas en curso, con este razonamiento:
--
--   «Un tipo de documento no se lee dos veces a la vez en la misma empresa: la
--    tarjeta tiene una fila por tipo, y dos lecturas en curso sobre esa fila
--    son un doble clic, no una intención.»
--
-- Para el RUT sigue siendo cierto: hay un RUT. Para las facturas es falso y
-- además bloquea el caso normal —llegan varias el mismo día, y subir la segunda
-- mientras corre la primera **es** la intención—. Así que la factura queda
-- afuera del índice, y las otras tres se protegen igual que antes.
DROP INDEX uq_documento_leido_en_curso;
CREATE UNIQUE INDEX uq_documento_leido_en_curso
  ON documento_leido (empresa_id, tipo)
  WHERE estado IN ('EN_COLA', 'LEYENDO') AND tipo <> 'FACTURA_COMPRA';

-- El tope de facturas leyéndose a la vez no es una restricción de la base: es
-- una cuestión de cuánto se gasta por minuto, y eso lo decide el módulo, que
-- sabe del saldo y de la pausa de IA. Un índice no sabe eso.

COMMENT ON COLUMN documento_leido.extraido IS
  'Sin aplicar. En los tres documentos de configuración, un arreglo de DatoExtraido —paso, campo, valor, etiqueta, fuente, confianza—; lo marcado DUDOSA no se aplica nunca: se pregunta. En FACTURA_COMPRA, un objeto con la cabecera de la factura y sus renglones. La base no mira adentro: la forma la impone el esquema de la llamada y la valida el modulo.';

COMMENT ON TABLE documento_leido IS
  'Un archivo que el asistente leyo —el RUT, la Camara de Comercio, la resolucion DIAN o una factura de compra— y lo que propuso a partir de el. Propone; nada se aplica hasta que una persona confirma, y lo aplican los servicios que usan los endpoints manuales. Se guarda para que el progreso sobreviva a un F5 y para poder decir de que documento salio cada dato.';
