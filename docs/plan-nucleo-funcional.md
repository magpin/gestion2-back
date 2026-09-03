# Plan · dejar el núcleo funcional

> Objetivo: un director entra, elige empresa y configura los seis pasos guardando
> de verdad contra la base, con la identidad visual del reglamento de color.
>
> Estado al 25 de agosto de 2026.

---

## Fase 1 · Base operativa — **hecha**

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Contraseñas de `gestion_app` y `gestion_provision`, `.env`, aislamiento verificado | hecho |
| 1.2 | Catálogo DANE: 33 departamentos, 1.122 municipios (migración `0010`) | hecho |
| 1.3 | Prueba de punta a punta por HTTP | hecho · 33/33 |

Entregado: `scripts/asignar-roles.js`, `scripts/verificar-aislamiento.js`,
`scripts/generar-seed-geografia.js`, `scripts/prueba-punta-a-punta.js`.

Tres bugs corregidos en el camino:

- **Crear empresa era imposible.** La política RLS de `empresa_configuracion_contable`
  exige `app.empresa_id`, y al crear la empresa ese contexto todavía no existía.
  Resuelto con `TxService.fijarEmpresa()`.
- **Dos errores distintos decían lo mismo.** Postgres usa `42501` para "falta
  privilegio" y para "la fila viola RLS". El filtro ahora los distingue.
- **El alta de cuenta enseñaba su esquema.** Sin la clave de aprovisionamiento
  devolvía los errores de validación del DTO. Ahora la clave se valida en un
  guard, antes que el cuerpo.

---

## Fase 2 · Estado de configuración — **hecha**

| # | Tarea | Estado |
|---|---|---|
| 2.1 | `GET /empresas/actual/estado-configuracion`: los 6 pasos, cuáles están listos, qué campo exacto falta y cuáles están bloqueados | hecho |
| 2.2 | Tests de las reglas de completitud | hecho · 24 |

Es la pieza de la que cuelga toda la pantalla del asistente. Sin ella el frontend
tendría que pegarle a seis endpoints y deducir el estado.

Los seis pasos y su regla de completitud:

| Paso | Listo cuando |
|---|---|
| Empresa | existe con configuración contable |
| Sedes | hay al menos una sede activa marcada como principal |
| Situación legal | hay régimen vigente, representante vigente y actividad principal con tarifa de ICA |
| Resoluciones | hay resolución activa y vigente para factura de venta |
| Usuarios | al menos un usuario más del director · **no obligatorio** |
| Terceros | al menos un tercero · **no obligatorio** |

Terceros queda bloqueado hasta que situación legal esté completa: sin saber si la
empresa cobra IVA no se puede facturar a nadie.

Usuarios y terceros no son obligatorios: un comerciante que lleva su propia
contabilidad no tiene a quién invitar. El porcentaje se calcula sobre los cuatro
pasos obligatorios.

Entregado: `estado-configuracion.reglas.ts` (las reglas, sin base),
`estado-configuracion.service.ts` (los hechos, una transacción) y el endpoint.
La prueba de punta a punta pasó de 33 a **48 verificaciones**.

---

## Fase 3 · Contrato del frontend — **hecha**

| # | Tarea | Estado |
|---|---|---|
| 3.1 | Archivar en `src/_pendiente/` lo que el backend ya no sirve | hecho · 26 carpetas + el armazón de navegación |
| 3.2 | Tipos de auth nuevos: roles vigentes, tenant, lista de empresas | hecho |
| 3.3 | `authStore` en dos etapas y proxy con tres niveles de acceso | hecho |
| 3.4 | Login en dos pasos: credenciales y elección de empresa | hecho |

El frontend actual está construido contra un backend que ya no existe: 26 de 28
rutas apuntan a módulos —ventas, compras, PUC, asientos, caja, facturación,
productos, cotizaciones, períodos— que se reconstruirán en sus propios módulos.
`RolCodigo` listaba `JEFE_TECNICO` y `TECNICO`, que ya no existen, y le faltaban
`ADMIN_TENANT` y `CONSULTA`.

Decisiones tomadas al ejecutarla:

- **El armazón de navegación también se archivó.** `ProcesoNav`, `TransversalesPanel`
  y `nav.config` estaban construidos alrededor de los módulos que se fueron. Un
  menú con seis puertas cerradas es peor que no tenerlo. Queda `BarraSuperior`,
  que muestra en qué contabilidad se está parado.
- **Tres niveles de acceso, no dos.** Sin token, solo `/login`. Con token de
  sesión, el selector de empresa. Con empresa elegida, todo lo demás. El nivel
  intermedio existe porque el token de sesión no puede leer datos contables: sin
  empresa las consultas vuelven vacías, y el dashboard mostraría tablas en blanco
  en vez de decir qué falta.
- **Con una sola empresa el login entra directo.** Obligar a elegir en una lista
  de uno es un clic que no decide nada.
- **El login devuelve los roles de cuenta.** Se agregó al backend: el cliente los
  necesita antes de elegir empresa, para saber si a alguien sin ninguna se le
  ofrece crear la primera o se le dice que pida acceso.
- **Un 403 por falta de empresa no cierra sesión.** Manda al selector. Cerrar
  sesión sería castigar a la persona por un estado intermedio legítimo.

Rutas vivas: `/login`, `/empresa`, `/dashboard`. El dashboard ya lee
`GET /empresas/actual/estado-configuracion` y muestra los seis pasos con su
estado; los enlaces a `/configuracion/*` esperan a la Fase 4.

---

## Fase 4 · El asistente — **hecha**

| # | Tarea | Estado |
|---|---|---|
| 4.1 | Armazón React del prototipo F: riel de resumen, zona del paso, barra inferior | hecho |
| 4.2 | Los seis pasos con formularios reales (React Hook Form + Zod contra los DTO) | hecho |
| 4.3 | Enrutamiento y creación de la primera empresa | hecho |

El prototipo aprobado es `docs/prototipos/asistente-configuracion.html`, ya con la
paleta del reglamento aplicada.

Rutas: `/configuracion/{empresa,sedes,situacion_legal,resoluciones,usuarios,terceros}`
y `/configuracion/empresa-nueva` para el acto anterior, cuando la empresa todavía
no existe.

Decisiones tomadas al ejecutarla:

- **Una ruta por paso, no un asistente con estado interno.** El director entra
  directo a corregir la tarifa de ICA desde el tablero sin recorrer los seis.
- **Situación legal se parte en tres bloques con su propio botón de guardar.** Un
  formulario único obligaría a llenarlo entero para registrar lo que ya se tiene a
  mano, y en la práctica el representante y el CIIU salen de papeles distintos.
- **El municipio se busca, no se elige de una lista.** Son 1.122 y la búsqueda va
  al servidor, donde ignora tildes.
- **El botón principal dice «Omitir» cuando el paso no está completo.** Prometer
  «Continuar» y no dejar avanzar sería mentir; el asistente permite volver.
- **Guardar cualquier cosa invalida el estado de configuración.** Completar la
  tarifa de ICA desbloquea terceros, y dejar el estado viejo haría que la persona
  termine un paso y lo siga viendo en ámbar.
- **Las reglas de completitud no se duplican en el cliente.** Son contables y
  viven en el backend; el frontend solo pinta lo que le dicen.

Verificado con `scripts/verificar-rutas-frontend.js`: las 30 rutas que consume el
frontend responden, y el recorrido completo deja la empresa en 100 % con los seis
pasos en LISTO.

---

## Decisiones tomadas

| Decisión | Qué se eligió | Por qué |
|---|---|---|
| Contraseñas de los roles | generadas, solo en `.env` | `.env` está en `.gitignore`; ningún secreto entra al repositorio |
| Alta de cuenta | sin registro público | las cuentas se crean con la clave de aprovisionamiento; abrir registro público es una decisión de producto, no técnica |
| Rutas huérfanas | archivar, no borrar | sus módulos vuelven; el código sirve de referencia |
| `warning` como texto | texto neutro, color en fondo y borde | `#B26A00` da 4.2:1 sobre blanco y el reglamento exige 4.5:1 |

## Pendiente de definir

- **Tono de `warning` para texto.** El reglamento resolvió lo mismo para el naranja
  con un token aparte (`accent-text`, más oscuro que el relleno). Falta el
  equivalente para `warning`, o se queda en neutro.
- **`docs/identidad-visual.md`** describe la paleta verde anterior y quedó
  desactualizado con el reglamento de color.
- **La ilustración del login** conserva nueve hex propios (tonos de piel, ropa).
  Es un asset ilustrado, no interfaz.
