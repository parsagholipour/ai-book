FROM node:22-bookworm-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
RUN corepack enable

# fonts-noto-core is not a fallback for the scripts the exporters know about —
# those embed their own faces with a unicode-range, so a system font is never
# consulted. It is the only coverage for a language the registry has no entry
# for (Amharic, Bengali, Tamil, Khmer…), which `Project.language` can hold
# because it is free-form, and for non-Latin text inside a monospace code span.
# fonts-noto-cjk is deliberately absent: CJK is embedded, and the package is
# 200 MB.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation fonts-noto-core fonts-noto-color-emoji \
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
