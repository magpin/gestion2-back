-- =============================================================================
-- Plan de cuentas de ejemplo — la empresa de docs/bddCaja
-- =============================================================================
-- NO es una migración: es un script de carga para UNA empresa concreta. Sirve
-- como ejemplo de cómo se llena empresa_cuenta y como semilla si vas a migrar
-- esa contabilidad.
--
-- Trae 148 cuentas:
--   18 de 6 dígitos que la empresa eligió dentro de los rangos libres del
--      Decreto 2650 (ver docs/puc_exclusiones.md sección 2)
--   130 auxiliares de 8 dígitos: bancos, cajas, empleados, líneas de negocio
--
-- CÓMO CORRERLO
--   1. Aplica primero las migraciones hasta 0016.
--   2. Cambia el NIT de abajo por el de la empresa destino.
--   3. Córrelo como superusuario (postgres). Con gestion_app no pasa: RLS está
--      en FORCE y la sesión tendría que fijar app.empresa_id primero.
--
-- La naturaleza no se pasa: el trigger tg_empresa_cuenta_naturaleza la hereda de
-- cuenta_puc. Los auxiliares de naturaleza contraria hay que corregirlos aparte.

-- <<< CAMBIAR el NIT por el de la empresa destino.
-- Sin comentario al final de la linea: psql se lo tragaria dentro del valor
-- (\set nit '900'  -- x  deja la variable en "900--x") y el WHERE no casaria
-- con nada. El script correria sin error y cargaria cero cuentas.
\set nit '900000000'

BEGIN;

-- -----------------------------------------------------------------------------
-- Centros de costo
-- -----------------------------------------------------------------------------
INSERT INTO empresa_centro_costo (empresa_id, codigo, nombre)
SELECT e.id, v.codigo, v.nombre
  FROM empresa e
  CROSS JOIN (VALUES
    ('1', 'Almacén'),
    ('2', 'Taller')
  ) AS v(codigo, nombre)
 WHERE e.nit = :'nit';

-- -----------------------------------------------------------------------------
-- Cuentas
-- -----------------------------------------------------------------------------
-- La FK del padre se valida al cerrar el INSERT, no fila por fila, así que las
-- 18 cuentas de 6 dígitos y sus auxiliares pueden ir en la misma sentencia.
INSERT INTO empresa_cuenta
       (empresa_id, codigo, nombre, codigo_puc, codigo_padre, es_auxiliar, exige_tercero, naturaleza)
SELECT e.id, v.codigo, v.nombre, v.codigo_puc, v.codigo_padre, v.es_auxiliar, v.exige_tercero, NULL
  FROM empresa e
  CROSS JOIN (VALUES
    ('143505',    'Inventarios - Computadores', '1435'    , NULL    , false, false),
    ('169905',    'Amortización Acum - Provisiones intangibles', '1699'    , NULL    , false, false),
    ('210501',    'Cuentas por pagar a Bancos (prestamos)', '2105'    , NULL    , false, false),
    ('220505',    'Cuentas por pagar a Proveedores', '2205'    , NULL    , false, true ),
    ('236805',    'Impuestos por Pagar - ICA', '2368'    , NULL    , false, true ),
    ('240400',    'Impuestos de renta por pagar', '2404'    , NULL    , false, false),
    ('413501',    'Ingresos x FE del Almacen', '4135'    , NULL    , false, false),
    ('413502',    'Ingresos x FV del Almacen', '4135'    , NULL    , false, false),
    ('413503',    'Ingresos x SD del Almacen', '4135'    , NULL    , false, false),
    ('413504',    'Ingresos x FE de Contratos', '4135'    , NULL    , false, false),
    ('417505',    'Descuentos sobre Ventas', '4175'    , NULL    , false, false),
    ('420501',    'Ingresos a Caja x FE del Taller', '4205'    , NULL    , false, false),
    ('420502',    'Ingresos a Banco x FE del Taller', '4205'    , NULL    , true , false),
    ('510507',    'Pago por prestacion de servicios', '5105'    , NULL    , false, false),
    ('510574',    'Pago Aporte ARL de Administrador, secretaria, técnico de recarga', '5105'    , NULL    , false, false),
    ('540510',    'Pago de IVA', '5405'    , NULL    , false, false),
    ('540515',    'Pago de retencion en la fuente', '5405'    , NULL    , false, false),
    ('540520',    'Pago ICA', '5405'    , NULL    , false, false),
    ('11050501',  'Caja Efectivo  - Computintas', '110505'  , NULL    , true , false),
    ('11050502',  'Caja Efectivo  - Technology', '110505'  , NULL    , true , false),
    ('11050503',  'Caja Efectivo  - Temporal (Anticipos, abonos y otros)', '110505'  , NULL    , true , false),
    ('11051000',  'Venta en Efectivo', '110510'  , NULL    , true , false),
    ('11100501',  'Banco ZOMAC  - Cuenta Ahorros Bancolombia', '111005'  , NULL    , true , false),
    ('11100502',  'Banco Carmen  - Cuenta de Ahorros Bancolombia', '111005'  , NULL    , true , false),
    ('11100503',  'Banco Technology  - Cuenta de Ahorros Bancolombia', '111005'  , NULL    , true , false),
    ('13050501',  'Clientes Nacionales (CxC)', '130505'  , NULL    , true , true ),
    ('13050502',  'Clientes - Servicios de Reparación', '130505'  , NULL    , true , true ),
    ('13550501',  'Anticipos y préstamos Wildeman', '135505'  , NULL    , true , true ),
    ('13550502',  'Anticipos y préstamos Jhon Jairo', '135505'  , NULL    , true , true ),
    ('13550503',  'Anticipos y préstamos Robert Alejandro', '135505'  , NULL    , true , true ),
    ('13550504',  'Anticipos y préstamos Elvis Yoscar', '135505'  , NULL    , true , true ),
    ('13550505',  'Anticipos y préstamos Rey', '135505'  , NULL    , true , true ),
    ('13550506',  'Anticipos y préstamos Emanuel', '135505'  , NULL    , true , true ),
    ('13550507',  'Anticipos y préstamos Ayda Luz', '135505'  , NULL    , true , true ),
    ('13550508',  'Anticipos y préstamos Mateo', '135505'  , NULL    , true , true ),
    ('13550509',  'Anticipos y préstamos Diomedes', '135505'  , NULL    , true , true ),
    ('13550510',  'Anticipos y préstamos Miguel Ángel', '135505'  , NULL    , true , true ),
    ('13800501',  'Anticipo / Préstamo Empleado 1', '138005'  , NULL    , true , true ),
    ('13800502',  'Anticipo / Préstamo Empleado 2', '138005'  , NULL    , true , true ),
    ('13800503',  'Anticipo / Préstamo Empleado 3', '138005'  , NULL    , true , true ),
    ('13990501',  'Deterioro de Cuentas por Cobrar', '139905'  , NULL    , true , true ),
    ('14350501',  'Inventarios - Computadores', '1435'    , '143505', true , false),
    ('14350502',  'Inventarios - Repuestos', '1435'    , '143505', true , false),
    ('15240500',  'Muebles y Enseres', '152405'  , NULL    , true , false),
    ('15241000',  'Equipos de Oficina', '152410'  , NULL    , true , false),
    ('15280500',  'Computadores e impresoras (Equipos de  Procesamiento de datos)', '152805'  , NULL    , true , false),
    ('15281000',  'Equipos de telecomunicaciones (Celulares )', '152810'  , NULL    , true , false),
    ('15403000',  'Motocicletas', '154030'  , NULL    , true , false),
    ('15920501',  'Depreciación Acum - Equipos', '159205'  , NULL    , true , false),
    ('16990501',  'Amortización Acum - Intangibles', '1699'    , '169905', true , false),
    ('21050100',  'Cuentas por pagar a Bancos (prestamos)', '2105'    , '210501', true , false),
    ('21050501',  'Obligaciones Bancarias', '210505'  , NULL    , true , false),
    ('21050502',  'Obligaciones ME', '210505'  , NULL    , true , false),
    ('22050501',  'Cuentas por pagar a Proveedores', '2205'    , '220505', true , true ),
    ('23650501',  'Retención en la Fuente por Pagar', '236505'  , NULL    , true , true ),
    ('23680501',  'Impuestos por Pagar - ICA', '2368'    , '236805', true , true ),
    ('23800500',  'DEPOSITARIOS Cuentas por pagar Acreedores', '238005'  , NULL    , true , true ),
    ('24040000',  'Impuestos de renta por pagar', '2404'    , '240400', true , false),
    ('27050501',  'Ingresos Recibidos por Anticipado (Contra Caja Temporal)', '270505'  , NULL    , true , false),
    ('41350100',  'Ingresos x FE del Almacen', '4135'    , '413501', true , false),
    ('41350200',  'Ingresos x FV del Almacen', '4135'    , '413502', true , false),
    ('41350300',  'Ingresos x SD del Almacen', '4135'    , '413503', true , false),
    ('41350400',  'Ingresos x FE de Contratos', '4135'    , '413504', true , false),
    ('41355400',  'VENTA DE EQUIPO DE OFICINA Y PROGRAMAS DE COMPUTADOR', '413554'  , NULL    , true , false),
    ('41355401',  'VENTA DE MERCANCIA', '413554'  , NULL    , true , false),
    ('41355402',  'VENTA DE SERVICIOS DE RECARGA', '413554'  , NULL    , true , false),
    ('41355403',  'VENTA POR CONTRATOS', '413554'  , NULL    , true , false),
    ('41400501',  'Ingresos por Servicios de Reparación', '414005'  , NULL    , true , false),
    ('41750501',  'Descuentos sobre Ventas', '4175'    , '417505', true , false),
    ('42050100',  'Ingresos x FE del Taller', '4205'    , '420501', true , false),
    ('42100501',  'Ingresos por Dif. en Cambio', '421005'  , NULL    , true , false),
    ('42353000',  'DE COMPUTACION', '423530'  , NULL    , true , false),
    ('51050600',  'SUELDOS', '510506'  , NULL    , true , false),
    ('51050601',  'Sueldos - Wildeman', '510506'  , NULL    , true , false),
    ('51050602',  'Sueldos - Jhon Jairo', '510506'  , NULL    , true , false),
    ('51050603',  'Sueldos - Robert Alejandro', '510506'  , NULL    , true , false),
    ('51050604',  'Sueldos - Elvis Yoscar', '510506'  , NULL    , true , false),
    ('51050605',  'Sueldos - Rey', '510506'  , NULL    , true , false),
    ('51050606',  'Sueldos - Emanuel', '510506'  , NULL    , true , false),
    ('51050607',  'Sueldos - Ayda Luz', '510506'  , NULL    , true , false),
    ('51050608',  'Sueldos - Mateo', '510506'  , NULL    , true , false),
    ('51050609',  'Sueldos - Diomedes', '510506'  , NULL    , true , false),
    ('51050610',  'Sueldos - Miguel Ángel', '510506'  , NULL    , true , false),
    ('51050700',  'Pago por prestacion de servicios', '5105'    , '510507', true , false),
    ('51051500',  'HORAS EXTRAS Y RECARGOS', '510515'  , NULL    , true , false),
    ('51051800',  'COMISIONES', '510518'  , NULL    , true , false),
    ('51052100',  'VIATICOS', '510521'  , NULL    , true , false),
    ('51052700',  'AUXILIO DE TRANSPORTE', '510527'  , NULL    , true , false),
    ('51053000',  'CESANTIAS', '510530'  , NULL    , true , false),
    ('51053300',  'INTERESES SOBRE CESANTIAS', '510533'  , NULL    , true , false),
    ('51053600',  'PRIMA DE SERVICIOS', '510536'  , NULL    , true , false),
    ('51053900',  'VACACIONES', '510539'  , NULL    , true , false),
    ('51054800',  'Bonificaciones x GASTOS DE PERSONAL', '510548'  , NULL    , true , false),
    ('51055100',  'DOTACION Y SUMINISTRO A TRABAJADORES', '510551'  , NULL    , true , false),
    ('51056600',  'Gastos deportivos y de recreacion', '510566'  , NULL    , true , false),
    ('51056900',  'APORTES AL I.S.S', '510569'  , NULL    , true , false),
    ('51057000',  'Pago Aportes fondos de pension de Administrador, secretaria, técnico de recarga', '510570'  , NULL    , true , false),
    ('51057200',  'APORTES CAJAS DE COMPENSACION FAMILIAR', '510572'  , NULL    , true , false),
    ('51057400',  'Pago Aporte ARL de Administrador, secretaria, técnico de recarga', '5105'    , '510574', true , false),
    ('51057500',  'APORTES I.C.B.F.', '510575'  , NULL    , true , false),
    ('51057800',  'SENA', '510578'  , NULL    , true , false),
    ('51301000',  'CUMPLIMIENTO', '513010'  , NULL    , true , false),
    ('51350500',  'ASEO Y VIGILANCIA', '513505'  , NULL    , true , false),
    ('51352000',  'PROCESAMIENTO ELECTRONICO DE DATOS', '513520'  , NULL    , true , false),
    ('51352500',  'ACUEDUCTO Y ALCANTARILLADO', '513525'  , NULL    , true , false),
    ('51353000',  'ENERGIA ELECTRICA', '513530'  , NULL    , true , false),
    ('51353500',  'TELEFONO', '513535'  , NULL    , true , false),
    ('51354000',  'Servicios públicos Internet', '513540'  , NULL    , true , false),
    ('51354500',  'Servicios públicos otras entidades', '513545'  , NULL    , true , false),
    ('51355000',  'TRANSPORTE, FLETES Y ACARREOS', '513550'  , NULL    , true , false),
    ('51401000',  'REGISTRO MERCANTIL', '514010'  , NULL    , true , false),
    ('51452000',  'EQUIPO DE OFICINA', '514520'  , NULL    , true , false),
    ('51501500',  'REPARACIONES LOCATIVAS', '515015'  , NULL    , true , false),
    ('51552000',  'PASAJES TERRESTRES', '515520'  , NULL    , true , false),
    ('51950500',  'COMISIONES', '519505'  , NULL    , true , false),
    ('51952500',  'ELEMENTOS DE ASEO Y CAFETERIA', '519525'  , NULL    , true , false),
    ('51953000',  'UTILES, PAPELERIA Y FOTOCOPIAS', '519530'  , NULL    , true , false),
    ('51953500',  'COMBUSTIBLES Y LUBRICANTES', '519535'  , NULL    , true , false),
    ('51954000',  'ENVASES Y EMPAQUES', '519540'  , NULL    , true , false),
    ('51954500',  'TAXIS Y BUSES', '519545'  , NULL    , true , false),
    ('51956000',  'CASINO Y RESTAURANTE', '519560'  , NULL    , true , false),
    ('52050600',  'SUELDOS', '520506'  , NULL    , true , false),
    ('52051500',  'HORAS EXTRAS Y RECARGOS', '520515'  , NULL    , true , false),
    ('52051800',  'COMISIONES', '520518'  , NULL    , true , false),
    ('52052100',  'VIATICOS', '520521'  , NULL    , true , false),
    ('52052700',  'AUXILIO DE TRANSPORTE', '520527'  , NULL    , true , false),
    ('52053000',  'CESANTIAS', '520530'  , NULL    , true , false),
    ('52053300',  'INTERESES SOBRE CESANTIAS', '520533'  , NULL    , true , false),
    ('52053600',  'PRIMA DE SERVICIOS', '520536'  , NULL    , true , false),
    ('52053900',  'VACACIONES', '520539'  , NULL    , true , false),
    ('52055100',  'DOTACION Y SUMINISTRO A TRABAJADORES', '520551'  , NULL    , true , false),
    ('52056300',  'CAPACITACION AL PERSONAL', '520563'  , NULL    , true , false),
    ('52056900',  'APORTES AL I.S.S', '520569'  , NULL    , true , false),
    ('52057000',  'Pago aportes fondo de pension asesor de ventas', '520570'  , NULL    , true , false),
    ('52057200',  'APORTES CAJAS DE COMPENSACION FAMILIAR', '520572'  , NULL    , true , false),
    ('52057500',  'APORTES I.C.B.F.', '520575'  , NULL    , true , false),
    ('52057800',  'SENA', '520578'  , NULL    , true , false),
    ('53050500',  'GASTOS BANCARIOS', '530505'  , NULL    , true , false),
    ('53051500',  'Pago comisiones Redeban', '530515'  , NULL    , true , false),
    ('53052000',  'Pago cuota banco - INTERESES', '530520'  , NULL    , true , false),
    ('54050500',  'Pago de impuesto de industria y comercio', '540505'  , NULL    , true , false),
    ('54051000',  'Pago de IVA', '5405'    , '540510', true , false),
    ('54051500',  'Pago de retencion en la fuente', '5405'    , '540515', true , false),
    ('54052000',  'Pago ICA', '5405'    , '540520', true , false),
    ('61350100',  'COSTO DE SERVICIO DE TALLER DE CAJA', '613501'  , NULL    , true , false),
    ('61350200',  'COSTO DE SERVICIO DE TALLER BANCO', '613502'  , NULL    , true , false),
    ('61350500',  'COMISIONES CONTRATOS', '613505'  , NULL    , true , false),
    ('61350600',  'COSTOS OTROS TECNICOS', '613506'  , NULL    , true , false)
  ) AS v(codigo, nombre, codigo_puc, codigo_padre, es_auxiliar, exige_tercero)
 WHERE e.nit = :'nit';

COMMIT;

-- -----------------------------------------------------------------------------
-- Verificación
-- -----------------------------------------------------------------------------
-- Cuántas quedaron y colgando de qué clase:
--   SELECT left(ec.codigo,1) AS clase, count(*)
--     FROM empresa_cuenta ec JOIN empresa e ON e.id = ec.empresa_id
--    WHERE e.nit = :'nit' GROUP BY 1 ORDER BY 1;
--
-- Auxiliares que quedaron con naturaleza heredada distinta de la esperada:
--   SELECT ec.codigo, ec.nombre, ec.naturaleza, cp.codigo, cp.naturaleza
--     FROM empresa_cuenta ec JOIN cuenta_puc cp ON cp.codigo = ec.codigo_puc
--     JOIN empresa e ON e.id = ec.empresa_id
--    WHERE e.nit = :'nit' AND ec.naturaleza <> cp.naturaleza;
