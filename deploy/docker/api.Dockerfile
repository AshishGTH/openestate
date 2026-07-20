# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @openestate/api... --filter @openestate/db --filter @openestate/shared

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @openestate/db generate
RUN pnpm --filter @openestate/shared build
RUN pnpm --filter @openestate/api build

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S openestate && adduser -S openestate -G openestate
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/packages/db packages/db
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
USER openestate
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
