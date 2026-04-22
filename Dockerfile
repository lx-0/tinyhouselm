# syntax=docker/dockerfile:1.7
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# -- deps: install workspace dependencies from the lockfile --
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

# -- runtime: copy source + node_modules, run with tsx --
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/sim/node_modules ./packages/sim/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json biome.json ./
COPY packages ./packages
COPY world ./world
EXPOSE 8080
CMD ["pnpm", "--filter", "@tina/web", "start"]
