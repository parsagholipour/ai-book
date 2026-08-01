import type { FastifyRequest } from "fastify";
import type { AppConfig } from "@book-maker/core";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export async function deleteProjectStorage(appConfig: AppConfig, projectId: string, request: FastifyRequest) {
  const targets = {
    book: join(appConfig.BOOK_STORAGE_DIR, projectId),
    images: join(appConfig.IMAGE_STORAGE_DIR, projectId),
    voice: join(appConfig.VOICE_STORAGE_DIR, projectId),
    audio: join(appConfig.AUDIO_STORAGE_DIR, projectId)
  };
  const results: Record<keyof typeof targets, boolean> = {
    book: false,
    images: false,
    voice: false,
    audio: false
  };

  for (const [key, path] of Object.entries(targets) as Array<[keyof typeof targets, string]>) {
    try {
      await rm(path, { recursive: true, force: true });
      results[key] = true;
    } catch (error) {
      request.log.warn({ err: error, projectId, path }, "Project asset cleanup failed");
    }
  }

  return results;
}
