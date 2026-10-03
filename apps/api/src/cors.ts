import type { FastifyCorsOptions } from "@fastify/cors";
import type { AppConfig } from "@book-maker/core";

/**
 * The operator console at :5173 talks to the API at :4001, so every cookieed
 * save is a CORS request. @fastify/cors v11 defaults `methods` to the
 * CORS-safelisted set — GET, HEAD, POST — and a PATCH or PUT preflight that
 * is answered without those verbs is the browser blocking the save before the
 * handler runs. Generation-quality, safety, moderation and pricing all write
 * that way; leaving the list implicit is how those screens fail after a
 * plugin bump that narrowed the default.
 */
export const CORS_OPTIONS = {
  origin: true,
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"]
} satisfies FastifyCorsOptions;

/**
 * In production the console is served from the API's own origin through the
 * edge, and the app is not a browser, so no other origin needs credentialed
 * access. `origin: true` reflected any origin with the operator cookie allowed.
 */
export function corsOptionsFor(config: Pick<AppConfig, "NODE_ENV" | "PUBLIC_API_URL">): FastifyCorsOptions {
  if (config.NODE_ENV !== "production") {
    return CORS_OPTIONS;
  }
  return { ...CORS_OPTIONS, origin: [new URL(config.PUBLIC_API_URL).origin] };
}
