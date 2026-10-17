import { prisma } from "@book-maker/db";
import type { FastifyInstance } from "fastify";
import { requireMobileAuth, sendProjectNotFound } from "../httpErrors.js";
import { loadMakingOf, type MobileMakingOfDto } from "../makingOf.js";
import { idParamsSchema, mobileAuthError } from "../schemas.js";

/**
 * `GET /api/mobile/projects/:id/making-of` — the "Behind the book" section of
 * a finished book's card (`../makingOf.ts`). Free, read-only, the owner's only.
 */
export async function registerMobileMakingOfRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/mobile/projects/:id/making-of",
    { schema: { tags: ["mobile"], response: { 401: mobileAuthError, 404: mobileAuthError } } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      const { id } = idParamsSchema.parse(request.params);
      const project = await prisma.project.findFirst({
        where: { id, userId: auth.user.id },
        select: { id: true, status: true, contentRevision: true, pdfPageMap: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }
      return (await loadMakingOf(project)) satisfies MobileMakingOfDto;
    }
  );
}
