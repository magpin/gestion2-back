#!/usr/bin/env bash
# Crea el `.env` de un entorno con todos sus secretos generados ahí mismo, en el
# servidor. Los secretos no pasan por ningún chat, correo ni repositorio.
#
#   generar-env.sh prod contable.computintasdigital.com archivos.contable.computintasdigital.com
#   generar-env.sh qa   qa.contable.computintasdigital.com archivos-qa.contable.computintasdigital.com
#
# Deja el archivo en /opt/contable/<entorno>/.env con permisos 600. Si ya existe,
# no lo toca: regenerar CLAVE_CIFRADO dejaría ilegibles los certificados y PIN
# de la DIAN ya guardados, y regenerar JWT_SECRET cerraría todas las sesiones.
#
# Lo único que queda por llenar a mano es ANTHROPIC_API_KEY (ver al final).
set -euo pipefail

ENTORNO="${1:-}"
DOMINIO="${2:-}"
DOMINIO_ARCHIVOS="${3:-}"
BASE="${CONTABLE_BASE:-/opt/contable}"

if [[ "$ENTORNO" != "prod" && "$ENTORNO" != "qa" ]] || [[ -z "$DOMINIO" || -z "$DOMINIO_ARCHIVOS" ]]; then
  echo "Uso: $0 <prod|qa> <dominio> <dominio-archivos>" >&2
  exit 1
fi

DESTINO="$BASE/$ENTORNO/.env"
if [[ -e "$DESTINO" ]]; then
  echo "Ya existe $DESTINO: no se sobrescribe." >&2
  exit 1
fi
mkdir -p "$BASE/$ENTORNO"

# Hex y no base64 para las contraseñas: sin `/`, `+` ni `=`, que se vuelven un
# problema en URLs de conexión y en el propio `.env`.
clave() { openssl rand -hex "${1:-24}"; }

if [[ "$ENTORNO" == "prod" ]]; then
  PUERTOS=(3100 8100 9100 9101 5433)
  MEM=(512m 512m 512m 768m 256m 256m)
else
  PUERTOS=(3200 8200 9200 9201 5434)
  MEM=(256m 384m 384m 512m 192m 128m)
fi

umask 077
cat > "$DESTINO" <<EOF
# Contable — entorno $ENTORNO. Generado el $(date -u +%Y-%m-%dT%H:%MZ) por generar-env.sh.
# Permisos 600: solo root. Guardar una copia en el gestor de contraseñas del
# equipo. CLAVE_CIFRADO, además, aparte de los respaldos de la base.

COMPOSE_PROJECT_NAME=contable-$ENTORNO
COMPOSE_FILE=docker-compose.yml

# ── Qué versión corre. Lo cambia desplegar.sh en cada despliegue.
TAG_API=
TAG_WEB=

# ── Puertos, todos en 127.0.0.1. Nginx apunta a web, api y s3.
PUERTO_WEB=${PUERTOS[0]}
PUERTO_API=${PUERTOS[1]}
PUERTO_S3=${PUERTOS[2]}
PUERTO_S3_CONSOLA=${PUERTOS[3]}
PUERTO_DB=${PUERTOS[4]}

# ── Límites de memoria.
MEM_DB=${MEM[0]}
MEM_API=${MEM[1]}
MEM_WEB=${MEM[2]}
MEM_GOTENBERG=${MEM[3]}
MEM_MINIO=${MEM[4]}
MEM_QUICKCHART=${MEM[5]}

# ── Base de datos. El dueño solo lo usan las migraciones; la API entra como
#    gestion_app (sujeto a RLS). Los nombres de los roles los fijan las
#    migraciones: no cambiarlos.
DB_NAME=contable_$ENTORNO
DB_USERNAME=contable_duenio
DB_PASSWORD=$(clave)
DB_APP_USERNAME=gestion_app
DB_APP_PASSWORD=$(clave)
DB_PROVISION_USERNAME=gestion_provision
DB_PROVISION_PASSWORD=$(clave)

# ── Sesiones. Si cambia, se cierran todas las sesiones abiertas.
JWT_SECRET=$(clave 32)
JWT_EXPIRES_IN=8h

# ── Cifra los certificados y el PIN de la DIAN de cada cliente.
#    SI SE PIERDE, ESOS DATOS NO SE RECUPERAN, aunque haya respaldo de la base.
#    No cambiarla nunca sin un plan de recifrado.
CLAVE_CIFRADO=$(openssl rand -base64 32)

CLAVE_PROVISION=$(clave 32)
CLAVE_CONSUMO_IA=$(clave 32)

# ── Archivos. La root solo la usa minio-init; la app entra con su propia llave,
#    que solo alcanza el bucket.
MINIO_ROOT_USER=contable-root
MINIO_ROOT_PASSWORD=$(clave)
S3_ACCESS_KEY=contable-app
S3_SECRET_KEY=$(clave)
S3_BUCKET=gestion
S3_REGION=us-east-1
S3_ENDPOINT_PUBLICO=https://$DOMINIO_ARCHIVOS

API_URL_PUBLICA=https://$DOMINIO/api/v1

# ── María. Se llena a mano con editar-secreto.sh, sin pegarla en ningún chat.
ANTHROPIC_API_KEY=
EOF
chmod 600 "$DESTINO"

echo "Listo: $DESTINO (600)."
echo "Falta: ANTHROPIC_API_KEY  →  $BASE/scripts/editar-secreto.sh $ENTORNO ANTHROPIC_API_KEY"
