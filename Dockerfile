FROM node:22-bookworm-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
RUN corepack enable

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dev

ENV NODE_ENV=development

CMD ["pnpm", "dev"]

FROM base AS app

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --prod=false
RUN pnpm db:generate
RUN pnpm build

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    BOOK_STORAGE_DIR=/app/storage/books \
    IMAGE_STORAGE_DIR=/app/storage/images

CMD ["sh", "scripts/start-production.sh"]
