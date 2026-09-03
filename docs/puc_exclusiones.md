# PUC — qué se excluyó del catálogo normativo y por qué

Fuente: `docs/bddCaja - copia1.accdb`, tabla `cnfPUCSubcuentas` (2 138 filas de
nivel 6). Esa tabla tenía el Decreto 2650 mezclado con las cuentas propias de la
empresa, porque el sistema anterior era monoempresa y no tenía dónde separarlas.

| Destino | Filas |
|---|---|
| `cuenta_puc` (catálogo normativo) | 2084 |
| `empresa_cuenta` (cuentas de esa empresa) | 18 |
| Descartadas (no son cuentas) | 36 |

## 1. Recuperadas con su nombre oficial

Códigos reales del decreto que la empresa había renombrado. Entran al catálogo
con el nombre oficial, no con el que traía la Access.

**Cinco de estas revelan un problema contable en la empresa de origen**, no de
migración: no le cambiaron el nombre a una cuenta para aclararlo, la usaron para
otra cosa. `513540 CORREO, PORTES Y TELEGRAMAS` estaba registrando el Internet, y
`510570`/`520570 APORTES A ENTIDADES PROMOTORAS DE SALUD EPS` estaba recibiendo
los aportes a fondos de **pensión**. Salud y pensión en la misma cuenta hace
imposible cuadrar la planilla PILA contra la contabilidad. Antes de migrar esos
saldos hay que decidir a qué cuenta van de verdad.

| Código | Nombre en el catálogo | Nombre que traía la Access |
|---|---|---|
| `138005` | DEPOSITARIOS | Anticipos y préstamos a trabajadores |
| `152410` | EQUIPOS | EQUIPOS de oficina |
| `238005` | DEPOSITARIOS | DEPOSITARIOS Cuentas por pagar Acreedores |
| `330525` | RESERVA LEY 7a. DE 1990 | RESERVA LEY 7a. DE 1990 |
| `330535` | RESERVA LEY 4a DE 1980 | RESERVA LEY 4a DE 1980 |
| `510566` | GASTOS DEPORTIVOS Y DE RECREACION | Gastos deportivos y de recreacion |
| `510570` | APORTES A ENTIDADES PROMOTORAS DE SALUD EPS | Pago Aportes fondos de pension de Administrador, secretaria, técnico de recarga |
| `513540` | CORREO, PORTES Y TELEGRAMAS | Servicios públicos Internet |
| `513545` | FAX Y TELEX | Servicios públicos otras entidades |
| `520570` | APORTES A ENTIDADES PROMOTORAS DE SALUD EPS | Pago aportes fondo de pension asesor de ventas |
| `939530` | RESERVA ARTICULO 3o. LEY 4/80 | RESERVA ARTICULO 3o. LEY 4/80 |

## 2. Movidas a `empresa_cuenta` (18)

El Decreto 2650 fija las subcuentas de unas cuentas y deja **rango libre** en
otras (`2205` proveedores, `4135` comercio, `1435` inventarios…): ahí el código de
6 dígitos lo elige la empresa. Todas estas caen en ese caso, o directamente no
existen en el decreto. Van al plan de cuentas de la empresa, no al catálogo.

| Código | Nombre en la Access | Cuenta padre (4 díg) |
|---|---|---|
| `143505` | Inventarios - Computadores | `1435` MERCANCIAS NO FABRICADAS POR LA EMPRESA |
| `169905` | Amortización Acum - Provisiones intangibles | `1699` PROVISIONES |
| `210501` | Cuentas por pagar a Bancos (prestamos) | `2105` BANCOS NACIONALES |
| `220505` | Cuentas por pagar a Proveedores | `2205` NACIONALES |
| `236805` | Impuestos por Pagar - ICA | `2368` IMPUESTO DE INDUSTRIA Y COMERCIO RETENIDO |
| `240400` | Impuestos de renta por pagar | `2404` DE RENTA Y COMPLEMENTARIOS |
| `413501` | Ingresos x FE del Almacen | `4135` COMERCIO AL POR MAYOR Y AL POR MENOR |
| `413502` | Ingresos x FV del Almacen | `4135` COMERCIO AL POR MAYOR Y AL POR MENOR |
| `413503` | Ingresos x SD del Almacen | `4135` COMERCIO AL POR MAYOR Y AL POR MENOR |
| `413504` | Ingresos x FE de Contratos | `4135` COMERCIO AL POR MAYOR Y AL POR MENOR |
| `417505` | Descuentos sobre Ventas | `4175` DEVOLUCIONES, REBAJAS Y DESCUENTOS EN VENTAS (DB) |
| `420501` | Ingresos a Caja x FE del Taller | `4205` OTRAS VENTAS |
| `420502` | Ingresos a Banco x FE del Taller | `4205` OTRAS VENTAS |
| `510507` | Pago por prestacion de servicios | `5105` GASTOS DE PERSONAL |
| `510574` | Pago Aporte ARL de Administrador, secretaria, técnico de recarga | `5105` GASTOS DE PERSONAL |
| `540510` | Pago de IVA | `5405` IMPUESTO DE RENTA Y COMPLEMENTARIOS |
| `540515` | Pago de retencion en la fuente | `5405` IMPUESTO DE RENTA Y COMPLEMENTARIOS |
| `540520` | Pago ICA | `5405` IMPUESTO DE RENTA Y COMPLEMENTARIOS |

### Tres que además están mal clasificadas contablemente

No es un problema de migración sino de la contabilidad de origen. Se traen tal
cual para no alterar los saldos históricos, pero conviene reclasificarlas:

- `540510 Pago de IVA`, `540515 Pago de retención en la fuente` y `540520 Pago ICA`
  cuelgan de `5405 IMPUESTO DE RENTA Y COMPLEMENTARIOS`. El IVA y la retención no
  son gasto de renta: son pasivos que se cancelan contra `2408` y `2365`. El ICA
  sí es gasto, pero va en `5115` / `5215`, no en `5405`.
- `240400 Impuestos de renta por pagar` no es un código válido: las subcuentas de
  `2404` son `240405` (vigencia fiscal corriente) y `240410` (anteriores).
- `169905 Amortización Acum - Provisiones intangibles` cuelga de `1699 PROVISIONES`.
  La amortización acumulada de intangibles es `1698`.

## 3. Descartadas (36)

Filas con nombre `"... (rango NNNNNN a NNNNNN)"`. No son cuentas: son la marca que
el sistema anterior usaba para señalar dónde el decreto deja numeración libre. Esa
información ya no hace falta — el rango libre se deduce de que la cuenta de 4
dígitos no tenga subcuentas fijas.

| Código | Nombre |
|---|---|
| `126001` | Cuentas en participación (rango 126001 a 126098) |
| `132301` | Cuentas por cobrar a directores (rango 132301 a 132398) |
| `132801` | Aportes por cobrar (rango 132801 a 132898) |
| `133201` | Cuentas de operación conjunta (rango 133201 a 133298) |
| `138501` | Derechos de recompra de cartera negociada (rango 138501 a 138598) |
| `139001` | Deudas de difícil cobro (rango 139001 a 139098) |
| `140501` | Materias primas (rango 140501 a 140598) |
| `141001` | Productos en proceso (rango 141001 a 141098) |
| `141501` | Obras de construcción en curso (rango 141501 a 141598) |
| `141701` | Obras de urbanismo (rango 141701 a 141798) |
| `142001` | Contratos en ejecución (rango 142001 a 142098) |
| `142501` | Cultivos en desarrollo (rango 142501 a 142598) |
| `142801` | Plantaciones agrícolas (rango 142801 a 142898) |
| `143501` | Mercancías no fabricadas por la empresa (rango 143501 a 143598) |
| `144001` | Bienes raíces para la venta (rango 144001 a 144098) |
| `144501` | Semovientes (rango 144501 a 144598) |
| `145501` | Materiales, repuestos y accesorios (rango 145501 a 145598) |
| `146001` | Envases y empaques (rango 146001 a 146098) |
| `146501` | Inventarios en tránsito (rango 146501 a 146598) |
| `152001` | Maquinaria y equipo (rango 152001 a 152098) |
| `156001` | Armamento de vigilancia (rango 156001 a 156098) |
| `156201` | Envases y empaques (rango 156201 a 156298) |
| `157601` | Pozos artesianos (rango 157601 a 157698) |
| `158001` | Yacimientos (rango 158001 a 158098) |
| `158401` | Semovientes (rango 158401 a 158498) |
| `163001` | Know How (rango 163001 a 163098) |
| `163501` | Licencias (rango 163501 a 163598) |
| `169901` | Provisiones intangibles (rango 169901 a 169998) |
| `173001` | Cargos por corrección monetaria diferida (rango 173001 a 173098) |
| `213001` | Entidades financieras del exterior (rango 213001 a 213098) |
| `214001` | Compromisos de recompra de cartera negociada (rango 214001 a 214098) |
| `220501` | Proveedores nacionales (rango 220501 a 220598) |
| `221001` | Proveedores del exterior (rango 221001 a 221098) |
| `221501` | Cuentas corrientes comerciales (rango 221501 a 221598) |
| `222001` | Casa matriz (rango 222001 a 222098) |
| `222501` | Compañías vinculadas (rango 222501 a 222598) |

## 4. Rango libre: lo que parece faltar y no falta

El Decreto 2650 no numera todo. En 111 nodos dice literalmente `"7101 a 7199"` o
`"220501 a 220598"` y deja que cada empresa numere sus hijas. Un nodo así, sin
hijas en el catálogo, **está completo**.

Por eso `cuenta_puc` tiene la columna `rango_libre`: sin ella no hay forma de
distinguir "acá numerás vos" de "esto está incompleto", y la aplicación mostraría
una rama vacía como si fuera un error de carga.

### Grupos cuyas CUENTAS son libres (12)

```
71 72 73 74 82 84 85 86 92 94 95 96
```

`71` a `74` es **toda la clase 7, costos de producción**: el decreto no fija ni
una cuenta de 4 dígitos ahí. Una empresa manufacturera numera las suyas dentro de
`7101`-`7199`. `82`, `84`, `85`, `86`, `92`, `94`, `95` y `96` son las cuentas de
orden fiscales, de control y por contra, igual de libres.

### Cuentas cuyas SUBCUENTAS son libres (99)

```
1260 1323 1328 1332 1385 1390 1405 1410 1415 1417 1420 1425 1428 1435 1440 1445 1455 1460 1465 1520 1560 1562 1576 1580 1584 1630 1635 1699 1730 2130 2140 2205 2210 2215 2220 2225 2305 2310 2315 2320 2330 2340 2345 2350 2368 2375 2408 2416 2420 2428 2432 2440 2448 2452 2456 2460 2468 2472 2495 2505 2515 2520 2525 2532 2535 2540 2640 2715 2720 2820 2840 2910 2915 3120 3125 3130 3135 3140 3215 3410 3415 3705 3710 4175 4260 4265 4275 5270 6205 6210 6215 6220 6225 8125 8335 9125 9130 9135 9195
```

Acá caen `2205` proveedores, `2408` IVA por pagar, `1435` inventarios y las 23
cuentas de la sección 2: la empresa de origen ya había elegido códigos dentro de
esos rangos, que es exactamente lo que el decreto manda hacer.

**`2368` y `2540` van marcadas a mano.** El decreto sí las declara libres, pero el
texto no se puede leer con una expresión regular: en `2368` mete la anotación
`"ADICIONADA D.R.2116/96"` entre los dos extremos del rango, y en `2540` el PDF
trae una errata (`"254001 a 244098"`, donde el segundo debería ser `254098`).

### Comprobación

Con `rango_libre` aplicado, **ningún** grupo ni cuenta del catálogo queda sin
explicar: o tiene hijas, o el decreto delega su numeración. Cotejado contra dos
ediciones distintas del PDF del decreto y contra las filas `"(rango N a M)"` que
traía la propia Access, que son evidencia independiente del mismo hecho.

## 5. Si falta algo

Este filtro es mecánico: separa por el nombre, no por el decreto en la mano. Si
encuentras una subcuenta oficial que quedó en la sección 2, se promueve al
catálogo con:

```sql
INSERT INTO cuenta_puc (codigo, nivel, codigo_padre, nombre, naturaleza, es_imputable)
SELECT '220505', 6, '2205', 'NACIONALES', naturaleza, true
  FROM cuenta_puc WHERE codigo = '2205';
```
