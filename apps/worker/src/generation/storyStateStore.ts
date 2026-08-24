import {
  applyStoryDelta,
  bookPlanSchema,
  parseStoryState,
  seedStoryStateFromPromises,
  type StoryDelta,
  type StoryState
} from "@book-maker/core";
import {
  Prisma,
  casRebuildProjectStoryState,
  prisma,
  rebuildStoryStateFromPages
} from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";

/** Parallel page waves are hotter than a single entity-state write; 8 covers a default wave of 4. */
const STORY_STATE_CAS_ATTEMPTS = 8;

export { rebuildStoryStateFromPages };

type StoryDeltaWriteClient = Pick<Prisma.TransactionClient, "page" | "project">;

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

/**
 * Write this page's delta, then fold it into `Project.storyState` in O(1).
 * Out-of-order finishes can diverge from index-order rebuild; that is fine for
 * the live pack. Undo, applyBookEdit, and compile call `rebuildProjectStoryState`.
 */
export async function persistPageStoryDelta(options: {
  projectId: string;
  pageIndex: number;
  delta: StoryDelta;
  seedPromises: readonly string[];
}, client: StoryDeltaWriteClient = prisma): Promise<StoryState | null> {
  try {
    await client.page.updateMany({
      where: { projectId: options.projectId, index: options.pageIndex },
      data: { storyDelta: options.delta as Prisma.InputJsonValue }
    });
    return await applyPersistedPageStoryDelta(options, client);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Story delta persist failed for project ${options.projectId} page ${options.pageIndex}`, error);
    return null;
  }
}

async function applyPersistedPageStoryDelta(options: {
  projectId: string;
  pageIndex: number;
  delta: StoryDelta;
  seedPromises: readonly string[];
}, client: StoryDeltaWriteClient): Promise<StoryState | null> {
  let expected: unknown = undefined;
  for (let attempt = 0; attempt < STORY_STATE_CAS_ATTEMPTS; attempt += 1) {
    const project = await client.project.findUnique({
      where: { id: options.projectId },
      select: { storyState: true }
    });
    if (!project) {
      return null;
    }
    expected = project.storyState;
    const current =
      expected == null
        ? seedStoryStateFromPromises(options.seedPromises)
        : parseStoryState(expected);
    const next = applyStoryDelta(current, options.delta, options.pageIndex);
    const claimed = await casWriteProjectStoryState(options.projectId, expected, next, client);
    if (claimed === 1) {
      return next;
    }
  }
  console.warn(
    `Story state persist for ${options.projectId} lost the CAS race ${STORY_STATE_CAS_ATTEMPTS} times; falling back to index-order rebuild`
  );
  // A transaction-scoped publication cannot fall through to the global client:
  // that would commit memory outside the page/revision claim it belongs to.
  // The caller may rebuild later; this best-effort incremental fold simply
  // declines after the same bounded CAS budget.
  return client === prisma ? await rebuildProjectStoryState(options.projectId, options.seedPromises) : null;
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

function storyStateCasEquals(expected: unknown) {
  return expected == null
    ? { equals: Prisma.DbNull }
    : { equals: expected as Prisma.InputJsonValue };
}

async function casWriteProjectStoryState(
  projectId: string,
  expected: unknown,
  next: StoryState,
  client: StoryDeltaWriteClient = prisma
): Promise<number> {
  const claimed = await client.project.updateMany({
    where: {
      id: projectId,
      storyState: storyStateCasEquals(expected)
    },
    data: { storyState: next as Prisma.InputJsonValue }
  });
  return claimed.count;
}
