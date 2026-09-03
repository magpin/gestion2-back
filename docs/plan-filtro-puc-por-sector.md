# Plan — filtro del PUC por sector y cuentas propias

Estado: aprobado, sin implementar.
Punto de partida: `nucleo-catalogos-plan-cuentas` · backend `481dd5c` · frontend `4a6a431`

## Qué se quiere

Que la empresa vea del PUC solo lo que tiene que ver con lo que hace, elija de ahí
sus cuentas, y pueda colgarles auxiliares propios — el equivalente de
`cnfPUCSubcuentas8` de la base Access de la que salió el catálogo.

## Los dos datos que sostienen el diagnóstico

**Solo un tercio del PUC es sectorial.**

| Bloque | Cuentas |
|---|---|
| Clase 4 · ingresos (por actividad) | 496 |
| Clase 6 · costo de ventas (por actividad) | 280 |
| Grupo 14 · inventarios | 57 |
| Clase 7 · costos de producción | 5 |
| **Resto — igual para todos** | **1 654** |

Caja, bancos, cartera, proveedores, impuestos, patrimonio y cuentas de orden son
iguales para una panadería y para un bufete. Filtrar por sector recorta los
ingresos y costos de 776 a 83 (−89 %), pero el catálogo completo solo baja de
2 492 a 2 019 (−19 %).

**El sistema anterior ya intentó esto y quedó vacío.** `cnfPUCSubcuentas` de la
Access trae las columnas `Activa`, `ActivaEmpresaServicio`,
`ActivaEmpresaComercial`, `ActivaEmpresaMixta`. De 2 139 filas: 100 activas,
**0 servicio, 0 comercial**, 100 mixta. No falló la idea — falló que nadie tenía
de dónde sacar el mapa de cuáles cuentas son "de servicios".

## De dónde sale el mapa, sin inventarlo

El decreto ya lo trae para la parte que importa:

- **Las cuentas `41xx` y `61xx` SON las secciones de la CIIU.** `4135 COMERCIO AL
  POR MAYOR Y AL POR MENOR`, `4140 HOTELES Y RESTAURANTES`, `4160 ENSEÑANZA`. El
  mapeo ya está implementado en `plan-cuentas.reglas.ts` (`INGRESO_POR_SECCION`).
- **Clase 7 y grupo 14** se infieren del tipo de operación, pero la inferencia es
  débil: el grupo `74` es "contratos de servicios" y lo usa cualquiera que costee
  por contrato, no solo una fábrica.

Fuera de eso el decreto no clasifica nada por sector, y no hay criterio honesto
para recortarlo.

## Decisiones tomadas

**1 · Las dos fuentes suman, no se cruzan.** Una cuenta es pertinente si la señala
la actividad CIIU **o** el sector marcado.

```
sector marcado  = {COMERCIO, MANUFACTURA}
actividades RUT = 4741 → sección G

pertinentes = cuentas de comercio ∪ cuentas de manufactura
```

Con unión no hay contradicción que resolver: ninguna fuente puede vetar a la otra,
y el sector solo puede *agregar* cuentas, nunca esconder las que el RUT respalda.

La intersección se descartó porque escondería cuentas declaradas en el RUT si el
usuario no marcó una casilla, y en contabilidad no encontrar la cuenta correcta
termina en asentar en la equivocada.

**2 · Se pliega, no se esconde.** El backend marca `pertinente: false` con un
motivo; la UI colapsa, y "ver el catálogo completo" está siempre a un clic. Si la
inferencia se equivoca, el costo es un clic y no una cuenta mal usada.

**3 · Cambiar de sector no toca las cuentas ya elegidas.** Tienen movimiento.

**4 · Desaparece `MIXTO`.** Un valor que significa "varios" sin decir cuáles no
puede filtrar nada, y era justo el caso que más importaba. El sector pasa a ser
multivaluado.

**5 · La redundancia se aprovecha como alerta.** Si el sector marcado no tiene
respaldo en ninguna actividad del RUT, el sistema lo dice:

> Marcaste **Manufactura**, pero ninguna de tus 2 actividades del RUT es de
> producción. ¿Falta registrar una actividad, o sobra el sector?

Eso convierte la duplicación en algo que el sistema puede detectar: que el RUT
está incompleto frente a lo que la empresa realmente hace.

## Implementación

### 1 · Sector multivaluado, de punta a punta

Backend y frontend en el mismo paso, y va primero. No es orden por capas: es que
`sector_economico` lo leen seis archivos del frontend —`CrearEmpresaView`,
`PasoEmpresa`, `nucleo.service`, `plataforma.types`, `DetalleCuentaView`— y si se
borra la columna sin tocarlos, la aplicación queda rota en el medio: el alta de
empresa manda un campo que ya no existe y la consola de plataforma lee una
columna borrada.

**`0019_sector_economico.sql`**

- Tabla `empresa_sector (empresa_id, sector)`, PK compuesta, RLS por empresa.
  Tres valores: `COMERCIO`, `SERVICIOS`, `MANUFACTURA`. Misma forma que
  `tercero_responsabilidad_fiscal`, que resuelve el mismo problema de N valores
  de un catálogo corto.
- Migra lo existente: `COMERCIO → {COMERCIO}`; `MIXTO → {}` (no se sabe cuáles
  eran, queda vacío y el usuario marca).
- **`DROP COLUMN empresa.sector_economico`.** Es destructivo y toca 6 archivos
  del backend y 6 del frontend, incluida el alta desde plataforma, que crea
  empresas antes de que exista CIIU.

**Frontend, en el mismo paso:** `CrearEmpresaView` y `PasoEmpresa` pasan de un
`Select` de cuatro valores a marcar varios de tres. En `PasoEmpresa`, además, los
sectores derivados de las actividades se muestran como chips junto a los
marcados, distinguiendo cuál viene de dónde.

### 2 · Derivación de secciones y endpoint filtrado

Extraer `INGRESO_POR_SECCION` de `plan-cuentas.reglas.ts` a un módulo propio —lo
van a usar la sugerencia y el filtro— y agregar la traducción inversa:

```
secciones(MANUFACTURA) = {C}
secciones(COMERCIO)    = {G}
secciones(SERVICIOS)   = {H … U}

pertinentes = secciones(actividades CIIU vigentes) ∪ secciones(sectores marcados)
```

Es función pura y se prueba sin base, igual que `estado-configuracion.reglas`.

**`GET /catalogos/puc/para-empresa`** — ruta aparte de `/catalogos/puc`, porque esta sí exige empresa elegida. Devuelve
las mismas cuentas más dos campos:

```jsonc
{ "codigo": "4140", "nombre": "HOTELES Y RESTAURANTES",
  "pertinente": false,
  "motivo": "Tus actividades son G (comercio) y S (servicios)" }
```

Reglas, en orden de confianza:

| Bloque | Regla | Fuerza |
|---|---|---|
| Clases 4 y 6 | pertinente solo si la cuenta corresponde a una sección declarada | fuerte — sale del decreto |
| Clase 7, grupo 14 | no pertinente si ninguna actividad es de producción (secciones A–F) | débil — solo pliega |
| Todo lo demás | siempre pertinente | 66 % del catálogo |

Sin CIIU ni sectores cargados, todo es pertinente: no hay con qué filtrar y
mostrar de menos sería peor.

### 3 · `SelectorCuentaPuc` (frontend)

Buscador del catálogo con lo no pertinente plegado, el motivo a la vista y "ver el
catálogo completo" siempre presente.

### 4 · Pantalla de cuentas propias

El equivalente de `cnfPUCSubcuentas8`:

```
110505  CAJA GENERAL                          [+ auxiliar]
   11050501  Caja Efectivo - Computintas
   11050502  Caja Efectivo - Technology
111005  BANCOS MONEDA NACIONAL                [+ auxiliar]
   11100501  Bancolombia ahorros ZOMAC
```

Se elige la cuenta madre, el sistema propone el consecutivo siguiente y el usuario
escribe el nombre. **La base ya lo soporta entero**: `empresa_cuenta` acepta 20
dígitos, se ancla sola a la cuenta del decreto que le corresponda y cuelga del
padre correcto. Los 130 auxiliares de la Access ya se cargaron así. Falta solo la
pantalla.

### 5 · Alerta de descuadre

Sector marcado sin respaldo en ninguna actividad del RUT. Es lo más fácil de
agregar y lo que menos bloquea, por eso va al final.

## Orden y por qué

El criterio no es "primero el backend": es que **cada paso deje el sistema
entero**. Un paso que compila pero deja el alta de empresa rota no sirve de corte.

| # | Paso | Dónde | Verificación |
|---|---|---|---|
| 1 | Sector multivaluado, de punta a punta | back + front | `jest`, `next build`, alta de empresa funcionando |
| 2 | Derivación + endpoint filtrado | backend | pruebas de la función pura |
| 3 | `SelectorCuentaPuc` | frontend | en pantalla |
| 4 | Pantalla de cuentas propias | frontend | en pantalla |
| 5 | Alerta de descuadre | ambos | en pantalla |

Del paso 2 en adelante todo es agregado: nada se rompe si el trabajo se corta a
la mitad. El paso 1 es el único que no se puede partir, y por eso va primero y
completo.

## Riesgo principal

El `DROP COLUMN` del paso 1. Con el punto de retorno ya creado en ambos repos, es
reversible en código; en la base hay que volver a correr las migraciones o
restaurar. La alternativa —dejar la columna muerta, sin uso y sin CHECK— evita el
riesgo a cambio de una columna huérfana.
