#!/usr/bin/env bash
# Copia los datos de una base a otra. Pensado para mudarse de un Postgres local
# a uno administrado (Neon), pero sirve para cualquier par.
#
#   ./scripts/migrar-datos.sh
#
# El origen se pregunta; el destino sale del `.env`, que ya apunta a donde se
# quiere llegar.
#
# Cómo funciona y por qué así:
#
#   - Vuelca **esquema y datos juntos**, no solo datos. `pg_dump` emite las
#     tablas, después las filas y **al final las llaves foráneas**: así el orden
#     de carga deja de importar. Un `--data-only` obligaría a desactivar
#     disparadores, que en un Postgres administrado no se puede.
#   - `--no-owner`: en el destino el dueño es otro (`neondb_owner`, no
#     `postgres`) y los `ALTER ... OWNER TO postgres` fallarían. Los `GRANT` sí
#     viajan: los roles `gestion_app` y `gestion_provision` tienen que existir
#     antes, y los crea la migración `0001`.
#   - `--single-transaction`: si algo falla, no queda media base cargada.
#
# Antes de correrlo, el destino tiene que tener el esquema:
#
#   yarn migration:run
#
# y este script lo borra y lo vuelve a crear desde el volcado. Correrlo contra
# una base con datos que importan es perderlos.

set -euo pipefail

cd "$(dirname "$0")/.."

leer_env() { grep "^$1=" .env | cut -d= -f2-; }

DESTINO_HOST=$(leer_env DB_HOST)
DESTINO_USER=$(leer_env DB_USERNAME)
DESTINO_DB=$(leer_env DB_NAME)
DESTINO_PASS=$(leer_env DB_PASSWORD)
DESTINO_PUERTO=$(leer_env DB_PORT)

echo "Destino (del .env): $DESTINO_USER@$DESTINO_HOST/$DESTINO_DB"
echo

read -rp "Host del origen [localhost]: " ORIGEN_HOST
ORIGEN_HOST=${ORIGEN_HOST:-localhost}
read -rp "Base del origen [db_gestion]: " ORIGEN_DB
ORIGEN_DB=${ORIGEN_DB:-db_gestion}
read -rp "Usuario del origen [postgres]: " ORIGEN_USER
ORIGEN_USER=${ORIGEN_USER:-postgres}
read -rsp "Clave del origen: " ORIGEN_PASS
echo
echo

VOLCADO=$(mktemp /tmp/volcado-XXXXXX.sql)
trap 'rm -f "$VOLCADO"' EXIT

echo "→ Volcando $ORIGEN_DB…"
PGPASSWORD="$ORIGEN_PASS" pg_dump \
  --host="$ORIGEN_HOST" --username="$ORIGEN_USER" --dbname="$ORIGEN_DB" \
  --no-owner --clean --if-exists \
  --file="$VOLCADO"

echo "   $(wc -l < "$VOLCADO") líneas, $(du -h "$VOLCADO" | cut -f1)"

echo "→ Cargando en $DESTINO_DB…"
PGPASSWORD="$DESTINO_PASS" psql \
  "host=$DESTINO_HOST port=${DESTINO_PUERTO:-5432} user=$DESTINO_USER dbname=$DESTINO_DB sslmode=require" \
  --single-transaction --quiet --set ON_ERROR_STOP=on \
  --file="$VOLCADO"

echo "→ Comparando…"
for tabla in empresa tercero producto producto_movimiento venta_documento compra_documento asiento; do
  origen=$(PGPASSWORD="$ORIGEN_PASS" psql -tAX --host="$ORIGEN_HOST" --username="$ORIGEN_USER" \
    --dbname="$ORIGEN_DB" -c "SELECT count(*) FROM $tabla")
  destino=$(PGPASSWORD="$DESTINO_PASS" psql -tAX \
    "host=$DESTINO_HOST port=${DESTINO_PUERTO:-5432} user=$DESTINO_USER dbname=$DESTINO_DB sslmode=require" \
    -c "SELECT count(*) FROM $tabla")
  estado=$([ "$origen" = "$destino" ] && echo "ok" || echo "DISTINTO")
  printf '   %-22s %8s → %-8s %s\n' "$tabla" "$origen" "$destino" "$estado"
done

echo
echo "Listo."
