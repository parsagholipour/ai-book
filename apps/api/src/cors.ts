import type { FastifyCorsOptions } from "@fastify/cors";

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
