import {
  applyStoryDelta,
  parseStoryDelta,
  parseStoryState,
  rebuildStoryState,
  seedStoryStateFromPromises,
  type StoryDelta,
  type StoryState
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";

/** Parallel page waves are hotter than a single entity-state write; 8 covers a default wave of 4. */
const STORY_STATE_CAS_ATTEMPTS = 8;

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
}): Promise<StoryState | null> {
  try {
    await prisma.page.updateMany({
      where: { projectId: options.projectId, index: options.pageIndex },
      data: { storyDelta: options.delta as Prisma.InputJsonValue }
    });
    return await applyPersistedPageStoryDelta(options);
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
}): Promise<StoryState | null> {
  let expected: unknown = undefined;
  for (let attempt = 0; attempt < STORY_STATE_CAS_ATTEMPTS; attempt += 1) {
    const project = await prisma.project.findUnique({
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
    const claimed = await casWriteProjectStoryState(options.projectId, expected, next);
    if (claimed === 1) {
      return next;
    }
  }
  console.warn(
    `Story state persist for ${options.projectId} lost the CAS race ${STORY_STATE_CAS_ATTEMPTS} times; falling back to index-order rebuild`
  );
  return await rebuildProjectStoryState(options.projectId, options.seedPromises);
}

export async function rebuildProjectStoryState(
  projectId: string,
  seedPromises: readonly string[] = []
): Promise<StoryState | null> {
  try {
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
      const claimed = await casWriteProjectStoryState(projectId, expected, next);
      if (claimed === 1) {
        return next;
      }
    }
    console.warn(`Story state rebuild for ${projectId} lost the CAS race ${STORY_STATE_CAS_ATTEMPTS} times in a row`);
    return parseStoryState(expected);
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    console.warn(`Story state rebuild failed for project ${projectId}`, error);
    return null;
  }
}

async function rebuildStoryStateFromPages(
  projectId: string,
  seedPromises: readonly string[]
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

function storyStateCasEquals(expected: unknown) {
  return expected == null
    ? { equals: Prisma.DbNull }
    : { equals: expected as Prisma.InputJsonValue };
}

async function casWriteProjectStoryState(
  projectId: string,
  expected: unknown,
  next: StoryState
): Promise<number> {
  const claimed = await prisma.project.updateMany({
    where: {
      id: projectId,
      storyState: storyStateCasEquals(expected)
    },
    data: { storyState: next as Prisma.InputJsonValue }
  });
  return claimed.count;
}
