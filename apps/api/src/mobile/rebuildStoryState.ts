import {
  parseStoryDelta,
  rebuildStoryState,
  seedStoryStateFromPromises
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";

/** Rebuild Project.storyState from page deltas after an in-app undo. */
export async function rebuildStoryStateAfterUndo(
  projectId: string,
  seedPromises: readonly string[] = []
): Promise<void> {
  const pages = await prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    select: { index: true, storyDelta: true }
  });
  const deltas = pages.flatMap((page) => {
    const delta = parseStoryDelta(page.storyDelta);
    return delta ? [{ pageIndex: page.index, delta }] : [];
  });
  const next = rebuildStoryState(deltas, seedStoryStateFromPromises(seedPromises));
  await prisma.project.update({
    where: { id: projectId },
    data: { storyState: next as Prisma.InputJsonValue }
  });
}
