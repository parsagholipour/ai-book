import { prisma } from "@book-maker/db";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppConfig } from "@book-maker/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveProjectActor, sendProjectNotFound } from "../requestAuth.js";
import { ownedProjectWhere } from "./projectExports.js";

/**
 * A project's illustrations and voice clips, served straight off disk.
 *
 * These live apart from `projects.ts` because they are the one part of that
 * surface both actor kinds reach: the mobile serializers hand the app URLs under
 * `/assets/images/` and `/assets/voice/`, and it fetches them with the same
 * bearer it uses for `/api/mobile/*`. Everything left in `projects.ts` is the
 * operator console's and takes an operator — see `allowsMobileBearer`, which
 * names exactly these two prefixes.
 *
 * Ownership is still the authorization: an actor only ever reads the assets of a
 * project it owns, which is what the file transport in the PDF renderer stands
 * in for with its own allowlist.
 */

const assetParamsSchema = z.object({
  projectId: z.string().min(1),
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/)
});

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg"
};

export function registerProjectAssetRoutes(fastify: FastifyInstance, appConfig: AppConfig): void {
  fastify.get("/assets/images/:projectId/:filename", async (request, reply) => {
    const { projectId, filename } = assetParamsSchema.parse(request.params);
    return sendOwnedProjectAsset(request, reply, {
      projectId,
      filename,
      storageDir: appConfig.IMAGE_STORAGE_DIR,
      missingLabel: "Image not found"
    });
  });

  fastify.get("/assets/voice/:projectId/:filename", async (request, reply) => {
    const { projectId, filename } = assetParamsSchema.parse(request.params);
    return sendOwnedProjectAsset(request, reply, {
      projectId,
      filename,
      storageDir: appConfig.VOICE_STORAGE_DIR,
      missingLabel: "Voice file not found"
    });
  });
}

async function sendOwnedProjectAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    projectId: string;
    filename: string;
    storageDir: string;
    missingLabel: string;
  }
) {
  const actor = await resolveProjectActor(request, reply);
  if (!actor) {
    return;
  }
  const project = await prisma.project.findFirst({
    where: ownedProjectWhere(options.projectId, actor),
    select: { id: true }
  });
  if (!project) {
    return sendProjectNotFound(reply, options.missingLabel);
  }

  const filePath = join(options.storageDir, options.projectId, options.filename);
  try {
    const file = await readFile(filePath);
    reply.type(mimeTypeForPath(filePath));
    reply.header("Cache-Control", "private, max-age=300");
    return file;
  } catch {
    return sendProjectNotFound(reply, options.missingLabel);
  }
}

function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
