# AI Book Maker

Local single-user AI book generation service with planning, long-book job orchestration, template-specific style rules, continuity memory, Markdown export, and illustrations.

## Stack

- Node.js 22, TypeScript, `tsx`
- Fastify API, BullMQ worker, Vite React web UI
- PostgreSQL with Prisma 7 and pgvector
- Redis for generation jobs
- DeepSeek text adapter by default
- Gemini adapters for grounded research, embeddings, and image generation

## Cover Fonts

Cover typography is rendered locally with Fontsource packages that ship SIL Open Font License 1.1 fonts only: Inter, Source Serif 4, Playfair Display, Nunito, Bebas Neue, and Noto Sans. Do not replace these with proprietary, paid, system-only, or unclear-license fonts.

Cover PNG rendering and PDF export use Puppeteer/Chromium. If a local machine has dependencies installed but no browser in Puppeteer’s cache, run:

```bash
corepack pnpm --filter @book-maker/core exec puppeteer browsers install chrome
```

## Local Run

```bash
pnpm install
pnpm db:generate
docker compose up -d postgres redis
pnpm db:deploy
pnpm db:seed
```

For a no-token local dry run:

```bash
# terminal 1
MOCK_AI=true pnpm dev:api

# terminal 2
MOCK_AI=true pnpm dev:worker

# terminal 3
pnpm dev:web
```

Open `http://localhost:5173`.

The API runs on `http://localhost:4001`, with OpenAPI docs at `http://localhost:4001/docs`.

## Ports

Docker maps Postgres to host port `55432` to avoid colliding with existing local Postgres installs. Inside Docker, services still use `postgres:5432`.

## Docker (full stack)

The [Local Run](#local-run) flow above only starts Postgres and Redis in Docker; you run the Node apps on the host with `pnpm`.

If you run the API, worker, or web services with `docker compose up` (or `pnpm docker:up`), Compose bind-mounts the repo into the container. On Windows, pnpm creates junctions under each package `node_modules`, which Linux in the container cannot follow. The compose file therefore uses anonymous volumes for the repo root and for every workspace package `node_modules` (`apps/*`, `packages/*`) so the image’s Linux install is preserved. After changing `pnpm-lock.yaml` or dependencies, rebuild images (`docker compose build`) or recreate those containers so the anonymous volumes pick up the new install layer.

## Real Providers

Add these to `.env`:

```bash
DEEPSEEK_API_KEY=...
GEMINI_API_KEY=...
```

Then run without `MOCK_AI=true`. Provider models are configurable with:

```bash
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_FAST_MODEL=deepseek-v4-flash
GEMINI_TEXT_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
```

Use a native Gemini image model, such as `gemini-2.5-flash-image`, for books with recurring characters. Character reference sheets are attached to later cover and page image calls, which Imagen text-to-image models cannot consume.
The web UI can choose an image model per project when images or cover generation are enabled; `GEMINI_IMAGE_MODEL` remains the default selection.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The core tests include Markdown compilation, context-budget behavior, and a deterministic 320-page dry-run plan.
