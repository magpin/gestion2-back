#!/usr/bin/env bash
# Respalda la base y los archivos de un entorno.
#
#   respaldar.sh <prod|qa> [motivo]
#
#   motivo = diario            lo que corre cron cada noche (por defecto)
#   motivo = antes-de-<tag>    lo que corre desplegar.sh antes de migrar
#
# Deja en /opt/contable/<entorno>/respaldos/:
#   db-<fecha>-<motivo>.dump   pg_dump en formato custom (se restaura con pg_restore)
#   archivos/                  espejo del bucket (solo en el diario)
#
# Guarda los últimos 7 diarios y los últimos 10 de antes de desplegar.
#
# Fuera del VPS: si /opt/contable/respaldo-remoto.sh existe, se le pasa cada
# archivo nuevo para que lo cifre y lo suba. Queda aparte porque depende de
# dónde se decida guardar (R2, B2, …) y todavía no está decidido.
set -euo pipefail

ENTORNO="${1:-}"
MOTIVO="${2:-diario}"
BASE="${CONTABLE_BASE:-/opt/contable}"
DIR="$BASE/$ENTORNO"

if [[ "$ENTORNO" != "prod" && "$ENTORNO" != "qa" ]] || [[ ! "$MOTIVO" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Uso: $0 <prod|qa> [motivo]" >&2
  exit 1
fi
cd "$DIR"
set -a; . ./.env; set +a

mkdir -p respaldos
chmod 700 respaldos
FECHA="$(date +%Y%m%d-%H%M%S)"
ARCHIVO="respaldos/db-$FECHA-$MOTIVO.dump"

echo "[$(date +%H:%M:%S)] Respaldando la base de $ENTORNO → $ARCHIVO"
umask 077
docker compose exec -T db pg_dump -U "$DB_USERNAME" -d "$DB_NAME" -Fc > "$ARCHIVO.tmp"

# Un volcado a medias no sirve y engaña: se verifica que pg_restore lo pueda
# leer antes de darlo por bueno.
if ! docker compose exec -T db pg_restore -l < "$ARCHIVO.tmp" > /dev/null; then
  rm -f "$ARCHIVO.tmp"
  echo "✗ El respaldo no se puede leer." >&2
  exit 1
fi
mv "$ARCHIVO.tmp" "$ARCHIVO"
echo "[$(date +%H:%M:%S)] ✓ $(du -h "$ARCHIVO" | cut -f1)"

if [[ "$MOTIVO" == "diario" ]]; then
  echo "[$(date +%H:%M:%S)] Espejo de archivos → respaldos/archivos/"
  mkdir -p respaldos/archivos
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" \
    -e MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000" \
    -v "$DIR/respaldos/archivos:/respaldo" \
    quay.io/minio/mc:latest mirror --quiet --overwrite "local/$S3_BUCKET" /respaldo
fi

# Rotación.
ls -1t respaldos/db-*-diario.dump 2>/dev/null | tail -n +8 | xargs -r rm -f || true
ls -1t respaldos/db-*-antes-de-*.dump 2>/dev/null | tail -n +11 | xargs -r rm -f || true

if [[ -x "$BASE/respaldo-remoto.sh" ]]; then
  "$BASE/respaldo-remoto.sh" "$ENTORNO" "$DIR/$ARCHIVO"
  if [[ "$MOTIVO" == "diario" ]]; then
    "$BASE/respaldo-remoto.sh" "$ENTORNO" "$DIR/respaldos/archivos"
  fi
else
  echo "Aviso: sin respaldo-remoto.sh, el respaldo queda solo en este servidor." >&2
fi
