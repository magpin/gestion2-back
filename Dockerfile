# Dos etapas con el mismo Dockerfile: `desarrollo` monta el código y recompila
# al guardar; `produccion` deja solo lo construido y las dependencias que hacen
# falta para correrlo.
#
# La versión de Node es la misma que la del equipo (24). Cambiarla acá y no en
# la máquina de cada uno es justamente el punto de tener esto.

FROM node:24-alpine AS base
WORKDIR /app
# Las dependencias se instalan en su propia capa: mientras `yarn.lock` no
# cambie, Docker no vuelve a bajarlas aunque cambie todo el código.
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile

FROM base AS desarrollo
COPY . .
EXPOSE 3001
CMD ["yarn", "start:dev"]

FROM base AS construccion
COPY . .
RUN yarn build

FROM node:24-alpine AS produccion
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=construccion /app/dist ./dist
# El DDL viaja con la imagen: las migraciones lo leen en tiempo de ejecución
# con `leerSql`, así que sin esto `migration:run` falla en producción.
COPY --from=construccion /app/db ./db
# Los scripts de instalación que se corren en el servidor con
# `docker compose run --rm migrar node scripts/<script>.js`. Solo estos: `sembrar.js`
# y los de prueba no tienen nada que hacer en una base de producción.
COPY scripts/preparar-roles.js scripts/crear-super-admin.js \
     scripts/crear-cuenta.js scripts/verificar-aislamiento.js ./scripts/
USER node
EXPOSE 3001
CMD ["node", "dist/main"]
