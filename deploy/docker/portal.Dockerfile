# syntax=docker/dockerfile:1
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/portal/package.json apps/portal/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @openestate/portal... --filter @openestate/shared

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY apps/portal/src apps/portal/src
COPY apps/portal/tsconfig.json apps/portal/tsconfig.json
COPY apps/portal/vite.config.ts apps/portal/vite.config.ts
COPY apps/portal/index.html apps/portal/index.html
COPY apps/portal/postcss.config.js apps/portal/postcss.config.js
COPY apps/portal/tailwind.config.js apps/portal/tailwind.config.js
# Empty: nginx forwards /api/ through unchanged, and the app code already
# hardcodes /api/v1/... on top of this — see deploy/.env.example.
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @openestate/portal build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
COPY --from=build /app/apps/portal/dist /usr/share/nginx/html
COPY deploy/nginx/static-spa.conf /etc/nginx/conf.d/default.conf
RUN sed -i 's#/run/nginx.pid#/tmp/nginx.pid#' /etc/nginx/nginx.conf \
  && touch /tmp/nginx.pid \
  && chown -R nginx:nginx /usr/share/nginx/html /tmp/nginx.pid /var/cache/nginx
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q -O- http://127.0.0.1:8080/ || exit 1
