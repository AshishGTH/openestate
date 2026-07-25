# syntax=docker/dockerfile:1
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @openestate/web... --filter @openestate/shared

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY apps/web/src apps/web/src
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/vite.config.ts apps/web/vite.config.ts
COPY apps/web/index.html apps/web/index.html
COPY apps/web/postcss.config.js apps/web/postcss.config.js
COPY apps/web/tailwind.config.js apps/web/tailwind.config.js
# Empty: nginx forwards /api/ through unchanged, and the app code already
# hardcodes /api/v1/... on top of this — see deploy/.env.example.
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @openestate/web build

FROM nginx:1.31-alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx/static-spa.conf /etc/nginx/conf.d/default.conf
RUN sed -i 's#/run/nginx.pid#/tmp/nginx.pid#' /etc/nginx/nginx.conf \
  && touch /tmp/nginx.pid \
  && chown -R nginx:nginx /usr/share/nginx/html /tmp/nginx.pid /var/cache/nginx
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q -O- http://127.0.0.1:8080/ || exit 1
