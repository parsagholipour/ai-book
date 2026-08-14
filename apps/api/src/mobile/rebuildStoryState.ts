import { casRebuildProjectStoryState } from "@book-maker/db";

/** Rebuild Project.storyState from page deltas after an in-app undo. */
export async function rebuildStoryStateAfterUndo(
  projectId: string,
  seedPromises: readonly string[] = []
): Promise<void> {
  await casRebuildProjectStoryState(projectId, seedPromises);
}
