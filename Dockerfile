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
# tini is the reaper. Chromium is pooled rather than launched per render, so a
# renderer that dies badly stays a zombie for the process lifetime instead of
# milliseconds — and PID 1 in production is `scripts/start-production.sh`, a
# shell that does not reap. The dev services get the same thing from compose's
# `init: true`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation fonts-noto-core fonts-noto-color-emoji tini poppler-utils \
  && rm -rf /var/lib/apt/lists/*

FROM base AS dev

ENV NODE_ENV=development

# Shared by api, worker and web. Compose supplies each service's
# `pnpm --filter @book-maker/<svc> dev`. Do not default to root `pnpm
# dev` — that script starts all three workspaces in one container.

# The dependency layers are built from manifests alone, or every deploy ships a
# new gigabyte. Copying apps/ and packages/ before `pnpm install` made any source
# edit re-run the install, so each release carried a fresh ~1 GB node_modules
# layer that the 20 GiB production disk had to pull and keep (docs/deployment.md).
# This stage reduces the tree to the workspace package.json files; the installs
# below copy its output, and BuildKit keys a copy on content, so they rerun only
# when the lockfile or a manifest changes. The globs are pnpm-workspace.yaml's,
# so a new workspace is picked up without editing this file.
FROM base AS manifests
WORKDIR /src
COPY apps ./apps
COPY packages ./packages
RUN mkdir /manifests && cp --parents apps/*/package.json packages/*/package.json /manifests/

# Everything, dev dependencies included: the typecheck, Prisma generate and the
# Vite build need them. Nothing from this stage's node_modules ships.
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --from=manifests /manifests ./
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm db:generate
RUN pnpm build

FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# Built by scripts/build-flutter-web.sh before building this target.
COPY deploy/flutter-web /usr/share/nginx/flutter

# What the api, worker and migrate services load: their dependencies and their
# workspace packages', without web's or anyone's devDependencies. tsx (every
# process runs TypeScript through it; `pnpm build` only typechecks) and the
# Prisma CLI (`migrate` runs `prisma migrate deploy`) are therefore
# `dependencies` of the packages that run them, not devDependencies.
# `prisma migrate deploy` also needs Prisma's schema engine, which pnpm does not
# download (it skips @prisma/engines' install script). `prisma version` fetches
# it into node_modules, as `prisma generate` did when this image was the build
# stage; without it every migrate run would fetch 22 MB from binaries.prisma.sh.
FROM base AS runtime-deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --from=manifests /manifests ./
RUN pnpm install --frozen-lockfile --prod --filter "@book-maker/api..." --filter "@book-maker/worker..." \
  && pnpm --filter @book-maker/db exec prisma version \
  && rm -rf /root/.cache/prisma

# Keep the combined app as the default target for existing deployments.
FROM runtime-deps AS app

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    BOOK_STORAGE_DIR=/app/storage/books \
    IMAGE_STORAGE_DIR=/app/storage/images

# Only these layers change with an ordinary commit: a few tens of MB.
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# Built in `build` rather than here: the generated Prisma client (.dockerignore
# keeps src/generated out of the context), and the console the API serves
# itself when nothing sits in front of it (findWebDistDir, the Railway path).
# Copying them also keeps this image behind the build's typecheck.
COPY --from=build /app/packages/db/src/generated ./packages/db/src/generated
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh", "scripts/start-production.sh"]
