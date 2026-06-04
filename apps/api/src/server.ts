import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { registerAuth } from "./auth.js";
import { closeQueue } from "./queue.js";
import { projectRoutes } from "./routes/projects.js";

const config = loadConfig();
const app = Fastify({ logger: true });

await mkdir(config.BOOK_STORAGE_DIR, { recursive: true });
await mkdir(config.IMAGE_STORAGE_DIR, { recursive: true });

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
await app.register(fastifyStatic, {
  root: resolve(config.IMAGE_STORAGE_DIR),
  prefix: "/assets/images/"
});
await app.register(projectRoutes);

const shutdown = async () => {
  await app.close();
  await closeQueue();
  await prisma.$disconnect();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
