import { prisma } from "@book-maker/db";
import type { FastifyReply } from "fastify";
import { sendMobileError, sendProjectNotFound } from "../httpErrors.js";
import { manuscriptWireContext } from "../manuscript/manuscriptCover.js";
import { loadManuscriptProject, manuscriptAccessRefusal, type ManuscriptProject } from "../manuscript/manuscriptDerivation.js";
import type { ManuscriptDto } from "../manuscript/manuscriptDto.js";
import { serializeManuscript } from "../manuscript/manuscriptSerializers.js";
import { loadManuscript, type LoadedManuscript } from "../manuscript/manuscriptStore.js";
import { mobileProjectSummaryInclude } from "../projectRecords.js";
import { serializeProjectSummary } from "../projectSummarySerializers.js";
import type { MobileProjectRecord, MobileProjectSummaryDto } from "../dto.js";
import type { MobileRouteContext } from "../routeContext.js";

/**
 * What every Writing Studio route group shares: the owner-and-kind gate, and
 * the two DTOs most of them answer with. One copy, so the groups cannot drift
 * on who may open a book or what a manuscript looks like on the wire.
 */

/** The project, if the caller owns it and it opens in the Studio; the refusal is already sent otherwise. */
export async function authorProjectOrReply(
  reply: FastifyReply,
  userId: string,
  projectId: string
): Promise<ManuscriptProject | null> {
  const project = await loadManuscriptProject(userId, projectId);
  if (!project) {
    sendProjectNotFound(reply);
    return null;
  }
  const refusal = manuscriptAccessRefusal(project);
  if (refusal) {
    sendMobileError(reply, refusal.status, refusal.code, refusal.message);
    return null;
  }
  return project;
}

export async function projectSummaryDto(
  appConfig: MobileRouteContext["appConfig"],
  userId: string,
  projectId: string
): Promise<MobileProjectSummaryDto | null> {
  const record = (await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: mobileProjectSummaryInclude()
  })) as MobileProjectRecord | null;
  return record ? serializeProjectSummary(record, appConfig) : null;
}

/** The manuscript DTO as of now — re-reading the project, whose title or cover a write may have changed. */
export async function manuscriptDto(
  userId: string,
  projectId: string,
  manuscript?: LoadedManuscript
): Promise<ManuscriptDto | null> {
  const project = await loadManuscriptProject(userId, projectId);
  const current = manuscript ?? (await loadManuscript(prisma, projectId));
  if (!project || !current) {
    return null;
  }
  return serializeManuscript(project, current, await manuscriptWireContext(project));
}
