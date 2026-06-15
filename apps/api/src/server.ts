import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { registerAuth } from "./auth.js";
import { mobileAuthRoutes } from "./mobileAuth.js";
import { mobileProjectRoutes } from "./mobileProjects.js";
import { mobileSafetyRoutes } from "./mobileSafety.js";
import { closeQueue } from "./queue.js";
import { projectRoutes } from "./routes/projects.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
      "body.password",
      "body.refreshToken",
      "body.purchaseToken",
      "body.comment",
      "body.reason",
      "body.reviewNotes"
    ]
  }
});

await mkdir(config.BOOK_STORAGE_DIR, { recursive: true });
await mkdir(config.IMAGE_STORAGE_DIR, { recursive: true });
await mkdir(config.VOICE_STORAGE_DIR, { recursive: true });

await app.register(cors, { origin: true, credentials: true });
await registerAuth(app, config);
await app.register(swagger, {
  openapi: {
    info: {
      title: "AI Book Maker API",
      version: "0.1.0"
    }
  }
});
await app.register(swaggerUi, { routePrefix: "/docs" });
await app.register(mobileAuthRoutes);
await app.register(mobileProjectRoutes);
await app.register(mobileSafetyRoutes);
await app.register(projectRoutes);

const webDistDir = findWebDistDir();
if (webDistDir) {
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: "/",
    decorateReply: false
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (shouldReturnNotFound(request.url)) {
      return reply.code(404).send({ error: "Not found" });
    }
    const indexHtml = await readFile(resolve(webDistDir, "index.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(indexHtml);
  });
}

const shutdown = async () => {
  await app.close();
  await closeQueue();
  await prisma.$disconnect();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });

function findWebDistDir(start = process.cwd()): string | undefined {
  let current = start;
  while (true) {
    const candidate = resolve(current, "apps/web/dist");
    if (existsSync(resolve(candidate, "index.html"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function shouldReturnNotFound(requestUrl: string): boolean {
  const pathname = new URL(requestUrl, "http://localhost").pathname;
  return (
    pathname.startsWith("/api") ||
    pathname.startsWith("/docs") ||
    pathname.startsWith("/assets/images/") ||
    pathname.startsWith("/assets/voice/") ||
    pathname.includes(".")
  );
}
