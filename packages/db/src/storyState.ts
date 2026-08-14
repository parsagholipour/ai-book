import {
  parseStoryDelta,
  parseStoryState,
  rebuildStoryState,
  seedStoryStateFromPromises,
  type StoryState
} from "@book-maker/core";
import { Prisma, prisma } from "./client.ts";

/** Parallel page waves are hotter than a single entity-state write; 8 covers a default wave of 4. */
const STORY_STATE_CAS_ATTEMPTS = 8;

/** Read-only rebuild from persisted page deltas in index order. Does not write. */
export async function rebuildStoryStateFromPages(
  projectId: string,
  seedPromises: readonly string[] = []
): Promise<StoryState> {
  const pages = await prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    select: { index: true, storyDelta: true }
  });
  const deltas = pages.flatMap((page) => {
    const delta = parseStoryDelta(page.storyDelta);
    return delta ? [{ pageIndex: page.index, delta }] : [];
  });
  return rebuildStoryState(deltas, seedStoryStateFromPromises(seedPromises));
}

/**
 * Rebuild Project.storyState from page deltas and CAS-write it.
 * Returns the rebuilt pack, or the last observed pack if every CAS attempt lost.
 */
export async function casRebuildProjectStoryState(
  projectId: string,
  seedPromises: readonly string[] = []
): Promise<StoryState | null> {
  let expected: unknown = undefined;
  for (let attempt = 0; attempt < STORY_STATE_CAS_ATTEMPTS; attempt += 1) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { storyState: true }
    });
    if (!project) {
      return null;
    }
    expected = project.storyState;
    const next = await rebuildStoryStateFromPages(projectId, seedPromises);
    const claimed = await prisma.project.updateMany({
      where: {
        id: projectId,
        storyState: storyStateCasEquals(expected)
      },
      data: { storyState: next as Prisma.InputJsonValue }
    });
    if (claimed.count === 1) {
      return next;
    }
  }
  console.warn(`Story state rebuild for ${projectId} lost the CAS race ${STORY_STATE_CAS_ATTEMPTS} times in a row`);
  return parseStoryState(expected);
}

function storyStateCasEquals(expected: unknown) {
  return expected == null
    ? { equals: Prisma.DbNull }
    : { equals: expected as Prisma.InputJsonValue };
}
