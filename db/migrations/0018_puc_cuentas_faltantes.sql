-- =============================================================================
-- 0018_puc_cuentas_faltantes — ocho cuentas del decreto que el origen no traía
-- =============================================================================
-- El catálogo de 0015 salió de una base Access que era la contabilidad de una
-- empresa comercial. Lo que esa empresa nunca usó, nunca se cargó. Cotejando el
-- texto del Decreto 2650 contra lo cargado aparecieron cuentas ausentes.
--
-- Se agregan las ocho cuyo nombre está confirmado en el texto y cuyo grupo ya
-- existe. La que fuerza esta migración es `2367 IMPUESTO A LAS VENTAS RETENIDO`:
-- sin ella una empresa agente de retención de IVA no tiene dónde registrar lo
-- que retiene, y la sugerencia de plan de cuentas no puede proponérsela.
--
-- QUEDAN PENDIENTES, y por eso no se inventan:
--   3220 y 5275 — existen, pero el maquetado del PDF dejó su nombre en otra
--                 columna y no se puede leer con certeza.
--   3505 y 3510 — dividendos y participaciones decretados. Cuelgan del grupo 35,
--                 que tampoco está en el catálogo: agregarlas exige agregar
--                 primero el grupo, y el nombre del grupo tiene el mismo
--                 problema de maquetado.
-- Están anotadas en docs/puc_exclusiones.md. Completarlas exige el decreto en
-- limpio, no una deducción.

INSERT INTO cuenta_puc (codigo, nivel, codigo_padre, nombre, naturaleza, es_imputable, rango_libre) VALUES
  -- Grupo 23 — cuentas por pagar
  ('2357', 4, '23', 'DEUDAS CON DIRECTORES',                             'CREDITO', false, true),
  ('2367', 4, '23', 'IMPUESTO A LAS VENTAS RETENIDO',                    'CREDITO', false, true),
  -- Grupo 24 — impuestos, gravámenes y tasas
  ('2476', 4, '24', 'GRAVAMENES Y REGALIAS POR UTILIZACION DEL SUELO',   'CREDITO', false, true),
  -- Grupo 29 — bonos y papeles comerciales
  ('2920', 4, '29', 'BONOS PENSIONALES',                                 'CREDITO', false, false),
  ('2925', 4, '29', 'TITULOS PENSIONALES',                               'CREDITO', false, false),
  -- Grupo 32 — superávit de capital
  ('3225', 4, '32', 'SUPERAVIT METODO DE PARTICIPACION',                 'CREDITO', false, false),
  -- Grupo 42 — ingresos no operacionales
  ('4218', 4, '42', 'INGRESOS METODO DE PARTICIPACION',                  'CREDITO', false, false),
  -- Grupo 53 — gastos no operacionales
  ('5313', 4, '53', 'PERDIDAS METODO DE PARTICIPACION',                  'DEBITO',  false, false);

-- Subcuentas fijas de las cuatro que sí las tienen enumeradas en el decreto.
-- `(DB)` es del propio decreto: dentro de un pasivo, lo que está por amortizar
-- se mueve al débito.
INSERT INTO cuenta_puc (codigo, nivel, codigo_padre, nombre, naturaleza, es_imputable, rango_libre) VALUES
  ('292005', 6, '2920', 'VALOR BONOS PENSIONALES',                       'CREDITO', true, false),
  ('292010', 6, '2920', 'BONOS PENSIONALES POR AMORTIZAR (DB)',          'DEBITO',  true, false),
  ('292015', 6, '2920', 'INTERESES CAUSADOS SOBRE BONOS PENSIONALES',    'CREDITO', true, false),
  ('292505', 6, '2925', 'VALOR TITULOS PENSIONALES',                     'CREDITO', true, false),
  ('292510', 6, '2925', 'TITULOS PENSIONALES POR AMORTIZAR (DB)',        'DEBITO',  true, false),
  ('292515', 6, '2925', 'INTERESES CAUSADOS SOBRE TITULOS PENSIONALES',  'CREDITO', true, false),
  ('322510', 6, '3225', 'DE CUOTAS O PARTES DE INTERES SOCIAL',          'CREDITO', true, false),
  ('421805', 6, '4218', 'DE SOCIEDADES ANONIMAS Y/O ASIMILADAS',         'CREDITO', true, false),
  ('421810', 6, '4218', 'DE SOCIEDADES LIMITADAS Y/O ASIMILADAS',        'CREDITO', true, false),
  ('531305', 6, '5313', 'DE SOCIEDADES ANONIMAS Y/O ASIMILADAS',         'DEBITO',  true, false),
  ('531310', 6, '5313', 'DE SOCIEDADES LIMITADAS Y/O ASIMILADAS',        'DEBITO',  true, false);

-- Comprobación: ningún nodo sin hijas puede quedar sin explicar. Un grupo o una
-- cuenta sin descendencia y sin `rango_libre` es data faltante, no un final de
-- rama. Si esto falla, la migración agregó un padre y se olvidó de sus hijas.
DO $$
DECLARE
  v_huecos text;
BEGIN
  SELECT string_agg(p.codigo, ', ' ORDER BY p.codigo)
    INTO v_huecos
    FROM cuenta_puc p
   WHERE p.nivel < 6
     AND NOT p.rango_libre
     AND NOT EXISTS (SELECT 1 FROM cuenta_puc h WHERE h.codigo_padre = p.codigo);

  IF v_huecos IS NOT NULL THEN
    RAISE EXCEPTION 'Cuentas sin hijas y sin rango libre: %', v_huecos;
  END IF;
END
$$;
