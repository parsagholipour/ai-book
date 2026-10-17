import {
  bookPlanSchema,
  parseStoryState,
  seedStoryStateFromPromises,
  type StoryState
} from "@book-maker/core";
import {
  Prisma,
  casRebuildProjectStoryState,
  prisma,
  rebuildStoryStateFromPages
} from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";

export { rebuildStoryStateFromPages };

/**
 * The book's story state as its row holds it, or the plan's promises seeded as
 * open. Nothing extracts story state since 2026-10-16 (E6), so a book written
 * since holds exactly that seed; an older Premium or Ultra book still holds the
 * fold of the deltas its pages were extracted with.
 */
export async function loadProjectStoryState(projectId: string, seedPromises: readonly string[] = []): Promise<StoryState> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { storyState: true }
    });
    if (project?.storyState) {
      return parseStoryState(project.storyState);
    }
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Story state load failed for project ${projectId}`, error);
  }
  return seedStoryStateFromPromises(seedPromises);
}

export async function seedProjectStoryState(projectId: string, promises: readonly string[]): Promise<void> {
  const seed = seedStoryStateFromPromises(promises);
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: { storyState: seed as Prisma.InputJsonValue }
    });
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Story state seed failed for project ${projectId}`, error);
  }
}

export async function rebuildProjectStoryState(
  projectId: string,
  seedPromises: readonly string[] = [],
  guard?: { currentPlanId: string | null }
): Promise<StoryState | null> {
  try {
    return guard
      ? await casRebuildProjectStoryState(projectId, seedPromises, guard)
      : await casRebuildProjectStoryState(projectId, seedPromises);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Story state rebuild failed for project ${projectId}`, error);
    return null;
  }
}

/** Rebuilds against the plan a structural rollback actually left current. */
export async function rebuildRolledBackProjectStoryState(
  projectId: string,
  currentPlanId: string | null
): Promise<StoryState | null> {
  const planVersion = currentPlanId
    ? await prisma.planVersion.findUnique({ where: { id: currentPlanId }, select: { planningPackage: true } })
    : null;
  if (currentPlanId && !planVersion) {
    return null;
  }
  const promises = planVersion ? bookPlanSchema.parse(planVersion.planningPackage).promises ?? [] : [];
  return rebuildProjectStoryState(projectId, promises, { currentPlanId });
}
