type CoverCandidate = { id: string; type: string; createdAt: Date };

/**
 * Which COVER row is the book's cover, among rows of any type.
 *
 * Nothing in the schema holds a project to one COVER row, and a race between two
 * delete-then-create cover writes can leave two. The compile picks the cover it
 * renders from its project snapshot, and `publishCompiledExports` re-reads it under
 * the project lock to prove the cover did not change during the render, so both
 * reads have to pick the same row. An unordered `find` on the snapshot against the
 * newest row under the lock disagreed on every compile of such a book: publication
 * called the older row a changed cover, and the successor it queued met the same
 * mismatch, looping full compiles that never published. Both reads ask here: the
 * newest row, with the id breaking a `createdAt` tie, which is a total order no
 * query plan or collation can reshuffle.
 */
export function currentCoverAsset<T extends CoverCandidate>(images: readonly T[]): T | undefined {
  let current: T | undefined;
  for (const image of images) {
    if (image.type !== "COVER") continue;
    if (!current || newerCover(image, current)) current = image;
  }
  return current;
}

function newerCover(candidate: CoverCandidate, current: CoverCandidate): boolean {
  const delta = candidate.createdAt.getTime() - current.createdAt.getTime();
  return delta === 0 ? candidate.id > current.id : delta > 0;
}
