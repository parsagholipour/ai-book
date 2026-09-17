import type { FastifyRequest } from "fastify";
import type { AppConfig } from "@book-maker/core";
import { objectKey, objectStore } from "@book-maker/storage";

export async function deleteProjectStorage(_appConfig: AppConfig, projectId: string, request: FastifyRequest) {
  const targets = {
    book: `${objectKey("books", projectId)}/`,
    images: `${objectKey("images", projectId)}/`,
    voice: `${objectKey("voice", projectId)}/`,
    audio: `${objectKey("audio", projectId)}/`
  };
  const results: Record<keyof typeof targets, boolean> = {
    book: false,
    images: false,
    voice: false,
    audio: false
  };

  for (const [key, path] of Object.entries(targets) as Array<[keyof typeof targets, string]>) {
    try {
      await objectStore().deletePrefix(path);
      results[key] = true;
    } catch (error) {
      request.log.warn({ err: error, projectId, path }, "Project asset cleanup failed");
    }
  }

  return results;
}
