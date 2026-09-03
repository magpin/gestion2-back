# Secuencia de módulos — qué sigue después de configuración

> **Estado al escribir esto:** `nucleo` y `plataforma` en producción. La
> configuración está probada de punta a punta: una empresa se crea, se configura
> en cinco pasos y termina con su plan de cuentas derivado de sus documentos.
>
> **Lo que sigue no es una lista de deseos.** El orden lo decide una sola cosa:
> qué necesita qué para poder existir.

---

## 1. El dato que ordena todo

**Hoy nada puede registrar un movimiento.**

Hay un plan de cuentas con tres banderas —`exige_tercero`, `exige_centro_costo`,
`exige_base_gravable`— que ningún código ha usado todavía. Se sembraron para que
el motor de asientos las respete, y ese motor no existe.

Eso descarta empezar por cualquier módulo que produzca documentos. Una factura
que no se puede asentar es un papel, no contabilidad.

```
Terceros ──┐                        ┌──> Ventas ──┐
           ├──> Contabilidad ───────┤             ├──> DIAN
Productos ─┘        (libro)         └──> Compras ─┘     (XML)
```

Ninguna flecha se puede saltar. Ventas y compras son hermanas: las dos mueven
inventario y las dos producen asientos, y por eso comparten casi todo.

---

## 2. La secuencia

### 1º — Terceros

**Qué es.** Clientes y proveedores: identificación, ubicación, responsabilidades
fiscales para el XML.

**Por qué va primero.** Es el único módulo cuyo backend ya está terminado —tabla,
endpoints, validaciones, dígito de verificación, catálogo de tipos de documento— y
le falta solo la pantalla, que sacamos del asistente porque no era configuración
sino trabajo del día a día.

Lo necesitan los tres módulos siguientes: el libro registra a quién se le debe,
la factura necesita a quién se le emite, las compras a quién se le paga.

**Riesgo.** Bajo. Es el módulo más chico que queda.

**Costo estimado.** Días, no semanas.

---

### 2º — Contabilidad

**Qué es.** Comprobante de diario, asiento con sus líneas, partida doble, cierre
de período, libro diario, libro mayor y balance de prueba.

**Por qué va acá.** Es el corazón, y es lo que convierte esto en software
contable en lugar de un formulario de configuración. Todo lo que viene después
—ventas, compras, nómina— produce asientos: si el motor no existe, cada módulo
inventaría el suyo y terminarían tres reglas distintas de partida doble.

Además es donde el plan de cuentas por fin se usa. Las tres banderas dejan de ser
columnas y empiezan a rechazar movimientos: una cartera sin tercero, un gasto sin
centro de costo, un IVA sin base gravable.

**Riesgo.** El más alto de la lista. Es donde vive la corrección contable, y un
error acá no se corrige editando: se corrige con un asiento de ajuste que queda
en el libro.

**Lo que exige antes de empezar.** Que un contador valide el mapeo de cuentas que
ya construimos. Sigue pendiente y este es el módulo donde deja de ser opcional.

**Costo estimado.** El más grande. Semanas.

---

### 3º — Productos e inventario

**Qué es.** Producto con su código, precio, porcentaje de IVA y unidad. Kardex
por promedio ponderado, que es lo que la configuración contable ya declara.

**Por qué va acá y no antes.** El inventario mueve cuentas —`1435` mercancías,
`6135` costo de ventas— y esos movimientos son asientos. Construirlo antes del
libro obliga a rehacerlo cuando el libro aparezca.

**Riesgo.** Medio. El costeo promedio ponderado es donde se equivocan casi todos
los sistemas pequeños: recalcular el costo con cada entrada y no al cierre.

---

### 4º — Ventas

**Qué es.** Cotización, factura de venta y nota crédito: tercero, líneas de
producto o servicio, impuestos, consecutivo de la resolución, y el asiento que
genera cada documento.

**Por qué es el cuarto y no el primero.** Necesita cuatro cosas que no existen
antes: un tercero a quién emitirle, un producto que vender, una resolución que
numere y un libro donde asentar. Es el módulo con más dependencias del sistema.

**La regla que arrastra.** Si la empresa no es responsable de IVA, el campo de
IVA no aparece —ni en la línea, ni en el producto, ni en el total— y el backend
no liquida nada aunque alguien mande el dato por API. `NucleoApi.esResponsableDeIva`
existe para eso y todavía no lo llama nadie.

---

### 5º — Compras

**Qué es.** Factura del proveedor, su entrada al inventario y el asiento que
produce. Retenciones practicadas al pagar.

**Por qué acá y no al final.** Compras es lo que alimenta el kardex. Sin ella el
inventario solo se puede cargar con un saldo inicial y ajustes a mano, y una
ferretería compra todas las semanas.

**Por qué después de ventas y no antes.** El inventario arranca con un saldo
inicial —que hace falta igual para migrar desde el sistema anterior— y con eso
alcanza para vender. Apenas se venda lo que había, hace falta comprar. Además
compras reusa casi todo lo que ventas deja estabilizado: el documento, sus
líneas, los impuestos y el asiento.

**Riesgo.** Medio, y menor que ventas por ser simétrico.

---

### 6º — DIAN

**Qué es.** El XML del anexo técnico, la firma con el certificado, el cálculo del
CUFE y la transmisión.

**Por qué acá.** No produce información contable: transmite la que ya existe.
Sin factura no hay nada que transmitir.

Va después de ventas y de compras, no entre las dos. Una factura de venta sin
transmitir no es legal en Colombia, pero una factura sin registrar no sirve para
nada: primero que el sistema sepa facturar bien, después que lo transmita.

Va en módulo propio, no dentro de facturación. La resolución se queda en `nucleo`
porque numera; la transmisión es otra cosa y falla por otras razones —el
certificado vencido, el servicio de la DIAN caído— que no deben tumbar la
emisión.

---

### 7º — Nómina

**Qué es.** Empleados, contratos, liquidación mensual, prestaciones, seguridad
social y parafiscales.

**Por qué sola y al final.** No toca inventario ni depende de ventas ni de
compras: es un circuito propio que solo desemboca en el libro. Puede construirse
cuando el resto ya opere, y una empresa puede facturar durante meses sin ella.

Las cuentas ya están sembradas: son las quince que aparecen al responder "sí
tengo empleados" en el plan de cuentas.

---

## 3. La alternativa que descarté

**Saltar el inventario y facturar solo servicios.** Da algo vendible más rápido:
un taller o un consultorio factura sin manejar stock.

No la recomiendo. Las dos empresas de prueba son comercio, y una ferretería sin
inventario no es un caso real: se termina facturando "servicios" a lo que en
realidad es mercancía, y el costo de ventas queda sin respaldo en el kardex.

Si el primer cliente real fuera de servicios puros, la decisión cambia. Hoy no lo
es.

---

## 4. La deuda que crece con cada módulo

**No hay tests de integración.** Los 142 del backend prueban funciones puras: el
motor de reglas sin base de datos. Nada verifica que la derivación de la casilla
53 siga funcionando contra Postgres, ni que el RLS aísle de verdad, ni que
aplicar la sugerencia inserte sin romper restricciones.

Todo eso lo verificamos a mano en el navegador, una vez. El próximo módulo va a
construir encima sin esa red.

**Cuándo pagarla.** Antes de contabilidad, no antes de terceros. Terceros es
chico y de bajo riesgo; contabilidad no perdona.

---

## 5. Lo que no se arrastra

Este es un desarrollo desde cero. El sistema anterior —la base Access, los 185
archivos que vivían en `frontend/src/_pendiente`— queda en el historial de git
como referencia, no como código.

Lo que sí se conserva de él es lo que ya está extraído y validado: el catálogo
PUC, y las lecciones que dejó —las cuatro columnas de "activa por tipo de
empresa" que nunca se llenaron, el `MIXTO` que significaba "varios" sin decir
cuáles—.

---

## 6. Resumen

| # | Módulo | Por qué ahí | Riesgo |
|---|---|---|---|
| 1 | Terceros | Backend listo; lo necesitan los cuatro siguientes | Bajo |
| 2 | Contabilidad | Todo lo demás produce asientos; sin motor, cada módulo inventa el suyo | Alto |
| 3 | Productos e inventario | Sus movimientos son asientos; antes del libro habría que rehacerlo | Medio |
| 4 | Ventas | Depende de los tres anteriores; es el que más piezas junta | Medio |
| 5 | Compras | Alimenta el kardex; reusa lo que ventas estabiliza | Medio |
| 6 | DIAN | Transmite lo que ya existe | Medio |
| 7 | Nómina | Circuito propio; no bloquea nada más | Medio |

Dos condiciones antes del segundo: **un contador valida el mapeo de cuentas**, y
**existen tests de integración sobre `nucleo`**.
