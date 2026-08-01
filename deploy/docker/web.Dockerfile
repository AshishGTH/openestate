# syntax=docker/dockerfile:1
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS base
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

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx/static-spa.conf /etc/nginx/conf.d/default.conf
RUN sed -i 's#/run/nginx.pid#/tmp/nginx.pid#' /etc/nginx/nginx.conf \
  && touch /tmp/nginx.pid \
  && chown -R nginx:nginx /usr/share/nginx/html /tmp/nginx.pid /var/cache/nginx
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q -O- http://127.0.0.1:8080/ || exit 1
