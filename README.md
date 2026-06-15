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

## Auth Behavior

`WEB_PASSWORD` is still the optional local/operator password for the existing web console. It sets an HTTP-only cookie through `/api/auth/login` and protects the legacy `/api/*`, `/docs`, and generated asset routes when configured.

Mobile user auth is separate and database-backed under `/api/mobile/auth/*`:

- `POST /api/mobile/auth/signup`
- `POST /api/mobile/auth/signin`
- `POST /api/mobile/auth/refresh`
- `POST /api/mobile/auth/logout`
- `GET /api/mobile/auth/me`

The mobile flow uses email/password accounts, short-lived bearer access tokens, and refresh tokens. Only token hashes are stored in `MobileSession`; logout revokes session state. No additional auth env vars are required for local development.

## Ports

Docker maps Postgres to host port `55432` to avoid colliding with existing local Postgres installs. Inside Docker, services still use `postgres:5432`.

## Docker (full stack)

The [Local Run](#local-run) flow above only starts Postgres and Redis in Docker; you run the Node apps on the host with `pnpm`.

If you run the API, worker, or web services with `docker compose up` (or `pnpm docker:up`), Compose bind-mounts the repo into the container. On Windows, pnpm creates junctions under each package `node_modules`, which Linux in the container cannot follow. The compose file therefore uses anonymous volumes for the repo root and for every workspace package `node_modules` (`apps/*`, `packages/*`) so the image’s Linux install is preserved. After changing `pnpm-lock.yaml` or dependencies, rebuild images (`docker compose build`) or recreate those containers so the anonymous volumes pick up the new install layer.

## Real Providers

Add these to `.env`:

```bash
DEEPSEEK_API_KEY=...
DEEPINFRA_API_KEY=...
GEMINI_API_KEY=...
```

Then run without `MOCK_AI=true`. Provider models are configurable with:

```bash
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_FAST_MODEL=deepseek-v4-flash
DEEPINFRA_MODEL=deepseek-ai/DeepSeek-V4-Pro
DEEPINFRA_FAST_MODEL=deepseek-ai/DeepSeek-V4-Flash
GEMINI_TEXT_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
```

Use a reference-capable image model, such as `gemini-2.5-flash-image`, `qwen-image-2.0`, or `qwen-image-2.0-pro`, for books with recurring characters. Character reference sheets are attached to later cover and page image calls, which Imagen text-to-image models and older prompt-only Qwen image models cannot consume.
The web UI can choose an image model per project when images or cover generation are enabled; `GEMINI_IMAGE_MODEL` remains the default selection.

## Voice Chat Reliability

Voice character calls can use either OpenAI Realtime WebRTC or Gemini Live. The web UI lets you choose the provider for the next call, and `VOICE_CHAT_PROVIDER` only sets the initial default.

```bash
OPENAI_API_KEY=...
GEMINI_API_KEY=...
VOICE_CHAT_PROVIDER=gemini_live
OPENAI_REALTIME_MODEL=gpt-realtime-2
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
VOICE_STORAGE_DIR=./storage/voice
```

`OPENAI_REALTIME_MODEL` sets the default OpenAI Realtime model. The web UI also exposes `gpt-realtime-2` and `gpt-realtime-mini` for each OpenAI voice call, so you can switch to mini when cost matters.

OpenAI Realtime uses WebRTC, so for production OpenAI calls configure TURN relay credentials to survive restrictive NAT, mobile networks, and corporate Wi-Fi. Gemini Live uses browser WebSockets with short-lived Gemini ephemeral tokens created by the API.

Character Chat can also generate saved, non-live voice conversations. The web UI takes a user prompt plus exactly two ready characters, creates a short transcript, synthesizes it with Gemini TTS, stores a WAV under `VOICE_STORAGE_DIR`, and serves it from `/assets/voice/`.

```bash
VOICE_RTC_STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
VOICE_RTC_TURN_TTL_SECONDS=3600
CLOUDFLARE_TURN_TOKEN=...
CLOUDFLARE_API_TOKEN=...
```

Set `CLOUDFLARE_TURN_TOKEN` to the Cloudflare TURN key ID from the credentials URL path, and set `CLOUDFLARE_API_TOKEN` to the bearer token used to generate credentials. When both are present, the API generates short-lived Cloudflare TURN credentials server-side and returns only the resulting ICE servers to the browser.

For other TURN providers, set `VOICE_RTC_TURN_URLS` with `VOICE_RTC_TURN_SHARED_SECRET`, or set `VOICE_RTC_TURN_USERNAME` and `VOICE_RTC_TURN_CREDENTIAL` for static credentials. The API stores sanitized voice-call health events, including ICE state, candidate type, RTT, packet loss, and reconnect phases, without SDP, IP addresses, audio, or transcripts.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The core tests include Markdown compilation, context-budget behavior, and a deterministic 320-page dry-run plan.
