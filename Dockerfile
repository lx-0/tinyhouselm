# syntax=docker/dockerfile:1.7
FROM node:20-slim
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info \
    NODE_OPTIONS=--max-old-space-size=6144
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json biome.json ./
COPY packages ./packages
COPY world ./world
RUN pnpm install --frozen-lockfile --prod=false

EXPOSE 8080
CMD ["pnpm", "--filter", "@tina/web", "start"]
