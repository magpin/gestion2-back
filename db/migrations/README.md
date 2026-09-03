# Migraciones — `db_gestion5`

El DDL vive acá, en archivos `.sql` numerados y escritos a mano. Las clases de
`src/database/migrations/` son solo el envoltorio que TypeORM necesita para
llevar la cuenta de lo aplicado: cada una lee su `.sql` y lo ejecuta. **Una sola
copia del esquema** — si el DDL se duplicara en TypeScript, tarde o temprano las
dos copias se separan.

## Orden

| TypeORM | Archivo SQL | Qué crea |
|---|---|---|
| `Base1787000001000` | `0001_base.sql` | Extensiones, funciones comunes, roles `gestion_app` y `gestion_provision` |
| `Tenant1787000002000` | `0002_tenant.sql` | `tenant` |
| `Geografia1787000003000` | `0003_geografia.sql` | `departamento`, `municipio` (catálogo DANE, sin datos aún) |
| `Empresa1787000004000` | `0004_empresa.sql` | `empresa`, `empresa_sede` |
| `EmpresaLegal1787000005000` | `0005_empresa_legal.sql` | Actividad CIIU, régimen tributario, representante, matrícula, configuración contable |
| `EmpresaDian1787000006000` | `0006_empresa_dian.sql` | `empresa_resolucion_dian`, `empresa_credencial_dian` |
| `UsuarioRol1787000007000` | `0007_usuario_rol.sql` | `usuario`, `rol` (+8 roles sembrados), `usuario_empresa_rol`, `fn_usuario_para_login()` |
| `Tercero1787000008000` | `0008_tercero.sql` | `tercero`, `tercero_responsabilidad_fiscal` |
| `UsuarioRolTenant1787000009000` | `0009_usuario_rol_tenant.sql` | `usuario_rol_tenant` |
| `GeografiaDatos1787000010000` | `0010_geografia_datos.sql` | 33 departamentos y 1 122 municipios DANE (DIVIPOLA, corte 30-dic-2024) |
| `Plataforma1787000011000` | `0011_plataforma.sql` | `plataforma_admin`, `plataforma_bitacora` |
| `CatalogoCiiu1787000012000` | `0012_catalogo_ciiu.sql` | `ciiu_seccion/division/grupo/clase` — CIIU Rev. 4 A.C., 504 clases |
| `CatalogoRut1787000013000` | `0013_catalogo_rut.sql` | `tipo_contribuyente`, `tipo_documento_identidad`, `forma_asociativa`, `responsabilidad_tributaria`, `responsabilidad_fiscal_fe` |
| `FichaEmpresaCatalogos1787000014000` | `0014_ficha_empresa_catalogos.sql` | Amarra la ficha a los catálogos (FK de CIIU, tipo de documento, responsabilidad) + `empresa_responsabilidad_rut` |
| `CatalogoPuc1787000015000` | `0015_catalogo_puc.sql` | `cuenta_puc` — PUC Decreto 2650, 2 473 filas (111 nodos de rango libre) |
| `EmpresaCuenta1787000016000` | `0016_empresa_cuenta.sql` | `empresa_cuenta`, `empresa_centro_costo` |
| `CorreoUnicoEntreAmbitos1787000017000` | `0017_correo_unico_entre_ambitos.sql` | Un correo no puede ser usuario y admin de plataforma a la vez |
| `PucCuentasFaltantes1787000018000` | `0018_puc_cuentas_faltantes.sql` | Cuentas del decreto que el extracto de la Access no traía |
| `SectorEconomico1787000019000` | `0019_sector_economico.sql` | `empresa_sector` — el sector deja de ser uno y pasa a ser varios |
| `HechoOperativo1787000020000` | `0020_hecho_operativo.sql` | `empresa_hecho_operativo` — empleados, activos fijos, crédito, caja menor |

## Los catálogos normativos y de dónde salieron

Cinco tablas no llevan `empresa_id` ni RLS porque no son de nadie: las define el
Estado y todos los tenants leen las mismas filas. Solo `gestion_provision` puede
escribirlas.

| Catálogo | Fuente | Nota |
|---|---|---|
| DIVIPOLA (`departamento`, `municipio`) | datos.gov.co, corte 30-dic-2024 | Regenerable con `scripts/generar-seed-geografia.js` |
| CIIU | DANE Rev. 4 A.C. / Resolución DIAN 000114 de 2020 | **No** la versión de 2012: esa no tiene 7111/7112 ni 8891/8899 |
| RUT (casillas 24, 25, 53, 63) | DIAN, Instructivo IN-CAC-0237 v3 | Los códigos suprimidos se conservan con `vigente = false` |
| Responsabilidades de FE | Anexo técnico DIAN | Solo seis del RUT llegan al XML, más `R-99-PN` que en el RUT no existe |
| PUC (`cuenta_puc`) | Decreto 2650 de 1993, extraído de `docs/bddCaja` | Cotejado contra el texto del decreto: el nivel 6 venía mezclado con cuentas de la empresa origen. Filtro y rangos libres en `docs/puc_exclusiones.md` |

Dos cosas que conviene verificar antes de transmitir a producción, marcadas
`VERIFICAR` dentro del SQL: los `codigo_dian_fe` de `tipo_documento_identidad` y
los códigos de `responsabilidad_fiscal_fe`, ambos contra el anexo técnico vigente.

## Cómo correrlas

La base tiene que existir primero — TypeORM crea tablas, no bases:

```powershell
createdb -U postgres db_gestion5
```

Después, desde `backend/`:

```bash
yarn migration:show    # cuáles están aplicadas y cuáles no
yarn migration:run     # aplica las pendientes, en orden
yarn migration:revert   # deshace la última
```

`yarn migration:show` marca con `[X]` las aplicadas y con `[ ]` las pendientes.
El registro lo lleva TypeORM en la tabla `migraciones`.

La conexión sale de `.env` (`DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`,
`DB_NAME`). Las migraciones corren con el usuario dueño de la base — `postgres` —
porque crear extensiones y roles exige superusuario.

Verificar el resultado:

```sql
SELECT * FROM migraciones ORDER BY timestamp;
\dt
\d empresa
```

## Después de aplicar: darle contraseña a los roles

Las migraciones crean `gestion_app` y `gestion_provision` como `NOLOGIN` a
propósito — ninguna contraseña vive en el repositorio. Fuera de git:

```sql
ALTER ROLE gestion_app       WITH LOGIN PASSWORD 'la-que-elijas';
ALTER ROLE gestion_provision WITH LOGIN PASSWORD 'otra-distinta';
```

`gestion_app` es la conexión de la API y está sujeta a RLS.
`gestion_provision` tiene `BYPASSRLS` y **solo** se usa para el alta de tenants y
tareas de administración. Nunca para atender peticiones de usuarios finales.

## Las tres reglas que sostiene el motor, no el código

**1. Aislamiento por RLS.** Toda tabla con datos de cliente lleva
`ENABLE` + `FORCE ROW LEVEL SECURITY`. La aplicación fija el contexto al abrir la
transacción:

```sql
SET LOCAL app.tenant_id  = '...';
SET LOCAL app.empresa_id = '...';
```

Una consulta que se olvide del `WHERE empresa_id = ...` devuelve cero filas, no
las de otro cliente. `FORCE` es lo que hace que la política también aplique al
dueño de la tabla.

**2. Nada se borra.** `gestion_app` no tiene privilegio `DELETE` en ninguna tabla
salvo `tercero_responsabilidad_fiscal`, que es un atributo y no un hecho contable.
Los documentos se anulan; los usuarios se desactivan; los permisos se revocan.

**3. No se cruzan tenants.** `usuario_empresa_rol` referencia `usuario (id, tenant_id)`
y `empresa (id, tenant_id)` con FK compuestas. Asignarle a un usuario una empresa
de otro tenant es imposible a nivel de motor — no hay validación de aplicación que
se pueda olvidar.

## Notas de diseño

- **Tablas históricas** (actividad económica, régimen tributario, representante,
  matrícula): no se editan. La fila vigente se cierra con `fecha_fin` y se abre
  otra. "Un solo vigente" lo garantiza un índice único parcial sobre
  `WHERE fecha_fin IS NULL`. Por eso no llevan `actualizado_en` ni trigger.
- **El consecutivo fiscal vive en la resolución**, no en una tabla de configuración
  aparte: el rango autorizado y el número que avanza dentro de él son el mismo
  hecho. `ck_resolucion_consecutivo` impide que se salga del rango.
- **El DV del NIT se verifica, no se captura**: `fn_dv_nit()` es `IMMUTABLE` y entra
  en un `CHECK` de `empresa` y de `tercero`.
- **Secretos en columnas `_enc`**, cifrados en la aplicación. `certificado_vence_en`
  queda sin cifrar a propósito, para poder avisar del vencimiento sin descifrar nada.
- **El login atraviesa RLS por una sola puerta**: `fn_usuario_para_login()`,
  `SECURITY DEFINER`, de solo lectura, devuelve exactamente lo que el login necesita.
  Es la alternativa a darle `BYPASSRLS` a la conexión de la API.

## Los `down()` son destructivos

Cada `down()` hace `DROP TABLE` de lo que su `up()` creó: revertir borra los datos
de esas tablas. Sirve mientras el esquema se está armando; en producción, un cambio
se corrige con una migración nueva hacia adelante, no revirtiendo.

`Base1787000001000.down()` no elimina las extensiones (`citext`, `unaccent`,
`pgcrypto`): pueden estar en uso por otros objetos y volver a crearlas es gratis.
