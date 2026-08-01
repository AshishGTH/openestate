# syntax=docker/dockerfile:1
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY plugins/generic-sales/package.json plugins/generic-sales/package.json
RUN pnpm install --frozen-lockfile --filter @openestate/api... --filter @openestate/db --filter @openestate/shared --filter @openestate/plugin-sdk --filter @openestate/generic-sales

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/tsconfig.json
COPY packages/db/prisma packages/db/prisma
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/plugin-sdk/src packages/plugin-sdk/src
COPY packages/plugin-sdk/tsconfig.json packages/plugin-sdk/tsconfig.json
COPY plugins/generic-sales/src plugins/generic-sales/src
COPY plugins/generic-sales/tsconfig.json plugins/generic-sales/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/nest-cli.json apps/api/nest-cli.json
RUN pnpm --filter @openestate/db generate
RUN pnpm --filter @openestate/shared build
RUN pnpm --filter @openestate/db build
RUN pnpm --filter @openestate/plugin-sdk build
RUN pnpm --filter @openestate/generic-sales build
RUN pnpm --filter @openestate/api build
RUN pnpm --filter @openestate/api deploy --prod /app/deployed
RUN PRISMA_SRC=$(ls -d node_modules/.pnpm/@prisma+client*/node_modules/.prisma) && \
    PRISMA_DST=$(ls -d /app/deployed/node_modules/.pnpm/@prisma+client*/node_modules/) && \
    cp -r "$PRISMA_SRC" "$PRISMA_DST"

FROM base AS runtime
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# -m (create + own a home dir) is required, not cosmetic: `pnpm --filter
# @openestate/db migrate:deploy`/`seed` (install.sh's own documented
# first-run flow, run via `docker compose exec` as this user) invokes
# corepack's pnpm shim, which writes a version cache under
# $HOME/.cache/node/corepack on first use. A `-r` system account with no
# home directory (the prior state here) makes that write fail with EACCES
# — the installer's documented migrate/seed step has never actually
# completed against this image. Found while verifying `docker compose up`
# end-to-end for Phase 8's digest-pinning change.
RUN groupadd -r openestate && useradd -r -m -g openestate openestate
COPY --from=build /app/deployed /app
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/db/prisma packages/db/prisma
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/plugin-sdk/dist packages/plugin-sdk/dist
COPY --from=build /app/packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY --from=build /app/plugins/generic-sales/dist plugins/generic-sales/dist
COPY --from=build /app/plugins/generic-sales/package.json plugins/generic-sales/package.json
USER openestate
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
