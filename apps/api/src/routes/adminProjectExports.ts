/**
 * Operator dashboard downloads for any book, regardless of owner.
 *
 * The operator export routes under `/api/projects/:id/export/*` scope to
 * `actor.userId` — the local admin user — so they can only serve books the
 * console generated itself. The dashboard's generated-books list is mostly
 * app users' books, so these routes take the operator cookie alone (the
 * `/api/admin/` prefix is already the exact operator-only surface) and reuse
 * the same inline-rendering senders, which publish a rebuild exactly the way
 * a compile does.
 */

import type { FastifyPluginAsync } from "fastify";
import { loadConfig } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { z } from "zod";
import { markOperatorRequest } from "../requestAuth.js";
import { sendProjectEpubExport, sendProjectPdfExport } from "./projectExports.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

export const adminProjectExportRoutes: FastifyPluginAsync = async (fastify) => {
  const appConfig = loadConfig();

  fastify.get("/api/admin/projects/:id/export/pdf", { schema: { tags: ["admin"] } }, async (request, reply) => {
    await markOperatorRequest(request);
    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        title: true,
        language: true,
        status: true,
        currentPlanId: true,
        mediaSettings: true,
        contentRevision: true
      }
    });
    if (!project) {
      return reply.code(404).send({ error: "Book not found" });
    }
    return sendProjectPdfExport({ request, reply, appConfig, projectId: id, project });
  });

  fastify.get("/api/admin/projects/:id/export/epub", { schema: { tags: ["admin"] } }, async (request, reply) => {
    await markOperatorRequest(request);
    const { id } = idParamsSchema.parse(request.params);
    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        title: true,
        authorName: true,
        language: true,
        status: true,
        currentPlanId: true,
        contentRevision: true
      }
    });
    if (!project) {
      return reply.code(404).send({ error: "Book not found" });
    }
    return sendProjectEpubExport({ request, reply, appConfig, projectId: id, project });
  });
};
