#!/usr/bin/env bash
# Cambia una variable del `.env` de un entorno pidiendo el valor sin mostrarlo:
# no queda en la pantalla, ni en el historial de la terminal, ni en ningún chat.
#
#   editar-secreto.sh prod ANTHROPIC_API_KEY
#
# Para que el cambio llegue a la API: `docker compose up -d api` en la carpeta
# del entorno.
set -euo pipefail

ENTORNO="${1:-}"
VARIABLE="${2:-}"
BASE="${CONTABLE_BASE:-/opt/contable}"
ARCHIVO="$BASE/$ENTORNO/.env"

if [[ "$ENTORNO" != "prod" && "$ENTORNO" != "qa" ]] || [[ ! "$VARIABLE" =~ ^[A-Z0-9_]+$ ]]; then
  echo "Uso: $0 <prod|qa> <VARIABLE>" >&2
  exit 1
fi
[[ -f "$ARCHIVO" ]] || { echo "No existe $ARCHIVO" >&2; exit 1; }

case "$VARIABLE" in
  CLAVE_CIFRADO)
    echo "CLAVE_CIFRADO no se cambia así: los certificados guardados quedarían ilegibles." >&2
    exit 1 ;;
esac

read -rsp "Valor de $VARIABLE ($ENTORNO): " VALOR; echo
[[ -n "$VALOR" ]] || { echo "Vacío: no se cambia nada." >&2; exit 1; }
[[ "$VALOR" != *$'\n'* ]] || { echo "El valor no puede tener saltos de línea." >&2; exit 1; }

TMP="$(mktemp "$ARCHIVO.XXXX")"
chmod 600 "$TMP"
# awk y no sed: el valor puede traer `/`, `&` o `|`, que sed interpretaría.
VALOR="$VALOR" awk -v var="$VARIABLE" '
  BEGIN { hecho = 0 }
  $0 ~ "^" var "=" { print var "=" ENVIRON["VALOR"]; hecho = 1; next }
  { print }
  END { if (!hecho) print var "=" ENVIRON["VALOR"] }
' "$ARCHIVO" > "$TMP"
mv "$TMP" "$ARCHIVO"
echo "$VARIABLE actualizada en $ARCHIVO."
