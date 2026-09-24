#!/usr/bin/env bash
# Restaura un respaldo en un Postgres de usar y tirar y cuenta lo que hay.
# Un respaldo que nunca se restauró no está probado.
#
#   probar-restauracion.sh <prod|qa> [archivo.dump]
#
# Sin archivo, usa el más reciente. No toca la base del entorno: levanta un
# contenedor aparte, sin puertos publicados, y lo borra al terminar.
set -euo pipefail

ENTORNO="${1:-}"
BASE="${CONTABLE_BASE:-/opt/contable}"
DIR="$BASE/$ENTORNO"
[[ "$ENTORNO" == "prod" || "$ENTORNO" == "qa" ]] || { echo "Uso: $0 <prod|qa> [archivo.dump]" >&2; exit 1; }

ARCHIVO="${2:-$(ls -1t "$DIR"/respaldos/db-*.dump 2>/dev/null | head -1)}"
[[ -f "$ARCHIVO" ]] || { echo "No hay respaldo para probar." >&2; exit 1; }

# El superusuario del Postgres temporal se llama igual que el dueño de la base
# del entorno: el respaldo trae privilegios a nombre de ese rol.
DUENIO="$(grep -E '^DB_USERNAME=' "$DIR/.env" | cut -d= -f2-)"
NOMBRE="contable-prueba-restauracion-$$"
CLAVE="$(openssl rand -hex 16)"
trap 'docker rm -f "$NOMBRE" >/dev/null 2>&1 || true' EXIT

echo "Restaurando $(basename "$ARCHIVO") en un Postgres temporal…"
docker run -d --name "$NOMBRE" -e POSTGRES_USER="$DUENIO" -e POSTGRES_PASSWORD="$CLAVE" -e POSTGRES_DB=restaurada \
  --memory 512m postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$NOMBRE" pg_isready -U "$DUENIO" -d restaurada >/dev/null 2>&1 && break
  sleep 2
done

# Los roles son globales y pg_dump no los lleva: se crean antes para que los
# GRANT del respaldo no fallen.
docker exec "$NOMBRE" psql -q -U "$DUENIO" -d restaurada -c \
  "CREATE ROLE gestion_app NOLOGIN; CREATE ROLE gestion_provision NOLOGIN BYPASSRLS;"
docker exec -i "$NOMBRE" pg_restore -U "$DUENIO" -d restaurada --exit-on-error < "$ARCHIVO"

docker exec "$NOMBRE" psql -U "$DUENIO" -d restaurada -At -F ' ' -c "
  SELECT 'tablas', count(*) FROM information_schema.tables WHERE table_schema = 'public'
  UNION ALL SELECT 'migraciones', count(*) FROM migraciones
  UNION ALL SELECT 'cuentas', count(*) FROM tenant
  UNION ALL SELECT 'usuarios', count(*) FROM usuario;"
echo "✓ El respaldo se restauró completo."
