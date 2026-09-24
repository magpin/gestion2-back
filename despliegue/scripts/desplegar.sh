#!/usr/bin/env bash
# Despliega una versión de la API o del frontend en un entorno, y si no queda
# sana, vuelve sola a la que estaba.
#
#   desplegar.sh <prod|qa> <api|web> <tag>
#
# Lo llama GitHub Actions por SSH después de subir la imagen a GHCR. También se
# puede correr a mano, por ejemplo para volver a un tag anterior.
#
# Pasos:
#   1. Si llegó un compose nuevo (docker-compose.yml.nuevo), lo valida y lo usa.
#   2. Anota qué tag corre ahora, para poder volver.
#   3. Si es la API: respaldo de la base antes de migrar.
#   4. Baja la imagen nueva y la levanta. La API arrastra `migrar`: si una
#      migración falla, la API nueva no arranca.
#   5. Espera a que responda sana. Si no, vuelve al tag anterior y falla.
#   6. Borra imágenes viejas de contable (nunca las de Sine).
#
# Solo toca /opt/contable/<entorno> y los contenedores de ese proyecto compose.
set -euo pipefail

ENTORNO="${1:-}"
SERVICIO="${2:-}"
TAG="${3:-}"
BASE="${CONTABLE_BASE:-/opt/contable}"
DIR="$BASE/$ENTORNO"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

if [[ "$ENTORNO" != "prod" && "$ENTORNO" != "qa" ]] \
  || [[ "$SERVICIO" != "api" && "$SERVICIO" != "web" ]] \
  || [[ ! "$TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Uso: $0 <prod|qa> <api|web> <tag>" >&2
  exit 1
fi
[[ -f "$DIR/.env" && -f "$DIR/docker-compose.yml" ]] || {
  echo "Falta $DIR/.env o $DIR/docker-compose.yml" >&2; exit 1; }

cd "$DIR"
VAR="TAG_$(echo "$SERVICIO" | tr a-z A-Z)"
log() { echo "[$(date +%H:%M:%S)] $*"; }

# Dos despliegues a la vez sobre el mismo entorno se pisan el `.env`.
if command -v flock >/dev/null; then
  exec 9>"$DIR/.desplegando.lock"
  flock -w 600 9 || { echo "Otro despliegue de $ENTORNO lleva más de 10 minutos." >&2; exit 1; }
fi

leer_tag() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
fijar_tag() {
  local tmp; tmp="$(mktemp .env.XXXX)"; chmod 600 "$tmp"
  awk -v var="$1" -v val="$2" '
    BEGIN { hecho = 0 }
    $0 ~ "^" var "=" { print var "=" val; hecho = 1; next }
    { print }
    END { if (!hecho) print var "=" val }' .env > "$tmp"
  mv "$tmp" .env
}

# ── 1. Compose nuevo ────────────────────────────────────────────────────────
if [[ -f docker-compose.yml.nuevo ]]; then
  # Se valida con el tag que se va a desplegar: en el primer despliegue el
  # `.env` todavía no tiene ninguno y el compose exige los dos.
  if env "$VAR=$TAG" docker compose -f docker-compose.yml.nuevo config --quiet; then
    cp docker-compose.yml docker-compose.yml.anterior
    mv docker-compose.yml.nuevo docker-compose.yml
    log "Compose actualizado (el anterior quedó en docker-compose.yml.anterior)."
  else
    echo "El compose nuevo no es válido: se sigue con el actual." >&2
    rm -f docker-compose.yml.nuevo
    exit 1
  fi
fi

# ── 2. Lo que corre ahora ───────────────────────────────────────────────────
ANTERIOR="$(leer_tag "$VAR")"
log "$ENTORNO/$SERVICIO: ${ANTERIOR:-(nada)} → $TAG"

# ── 3. Respaldo ─────────────────────────────────────────────────────────────
# Solo si ya hay una base con datos que cuidar: el primer despliegue no tiene.
if [[ "$SERVICIO" == "api" && -n "$ANTERIOR" ]]; then
  "$SCRIPTS/respaldar.sh" "$ENTORNO" "antes-de-$TAG"
fi

# ── 4. Bajar y levantar ─────────────────────────────────────────────────────
fijar_tag "$VAR" "$TAG"

sano() {
  local puerto url
  if [[ "$SERVICIO" == "api" ]]; then
    puerto="$(leer_tag PUERTO_API)"
    # Sana es: responde, está conectada a la base y RLS está protegiendo.
    curl -fsS --max-time 5 "http://127.0.0.1:$puerto/api/v1/salud" 2>/dev/null \
      | grep -q '"aislamientoActivo":true'
  else
    puerto="$(leer_tag PUERTO_WEB)"
    url="http://127.0.0.1:$puerto/"
    [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")" =~ ^(2|3) ]]
  fi
}

volver() {
  echo "✗ $1" >&2
  if [[ -n "$ANTERIOR" ]]; then
    log "Volviendo a $ANTERIOR…"
    fijar_tag "$VAR" "$ANTERIOR"
    # --no-deps: volver no tiene que migrar. Las migraciones son solo hacia
    # adelante; si la nueva ya migró, la versión anterior convive con el
    # esquema nuevo (por eso borrar columnas va en dos despliegues).
    docker compose up -d --no-deps "$SERVICIO" || true
  else
    fijar_tag "$VAR" ""
  fi
  exit 1
}

servicios=("$SERVICIO")
[[ "$SERVICIO" == "api" ]] && servicios=(migrar api)
REPO="ghcr.io/magpin/gestion2-$([[ "$SERVICIO" == "api" ]] && echo back || echo front)"
if ! docker compose pull --quiet "${servicios[@]}"; then
  # Sin GHCR todavía se puede volver a un tag que ya está en el servidor.
  docker image inspect "$REPO:$TAG" >/dev/null 2>&1 \
    || volver "No se pudo bajar la imagen $REPO:$TAG"
  log "No se pudo bajar de GHCR; se usa la copia local de $TAG."
fi
docker compose up -d "$SERVICIO" || {
  docker compose logs --no-color --tail 60 migrar 2>/dev/null || true
  volver "No levantó (¿falló una migración?)"
}

# ── 5. ¿Quedó sana? ─────────────────────────────────────────────────────────
for _ in $(seq 1 30); do
  if sano; then
    log "✓ $ENTORNO/$SERVICIO sano con $TAG"
    break
  fi
  sleep 3
done
sano || {
  docker compose logs --no-color --tail 60 "$SERVICIO" || true
  volver "$SERVICIO no respondió sano en 90 s"
}

# ── 6. Limpieza ─────────────────────────────────────────────────────────────
# Solo las imágenes de contable, dejando las 8 más nuevas (QA y PROD comparten
# repositorio). `docker rmi` se niega a borrar una imagen en uso: está bien.
docker image ls "$REPO" --format '{{.Repository}}:{{.Tag}}' \
  | grep -v ':<none>$' | tail -n +9 \
  | xargs -r docker rmi >/dev/null 2>&1 || true

log "Listo."
