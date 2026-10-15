import {
  coverRetypesetSource,
  coverTypesetFor,
  isRecord,
  sameCoverTypeset,
  storedCoverTypeset,
  type CoverTypeset
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { coverMetadataFromProject } from "./bookHelpers.js";

/**
 * The words the book's cover carries (`stored`) and the words it should carry
 * (`target`), when they differ *and* it can be set again for free — otherwise
 * `undefined`. The cover id and stored words come from the same read so a
 * re-typeset's dedupe key names the exact cover and change it compared.
 *
 * The cover is queued the moment drafting starts and is usually finished
 * minutes before the book is, so a pen name or a title typed in between — the
 * one-time "put your name on it" card asks exactly then — lands after the cover
 * was typeset. Asked at the last fan-in before the book's first compile, this
 * is what lets the cover catch up instead of disagreeing with the title page.
 *
 * A cover that could be set again but recorded no words (`stored` undefined) —
 * a design typeset before covers recorded them, on a book being written across
 * that deploy — is drift: nobody can say what is in its pixels, and the API has
 * already told a reader who gave a pen name that the cover takes it. Setting it
 * again from the row is free and never draws, and its new row records its
 * words, so it is asked once per cover. The callers ask only while a book is
 * GENERATING, so a finished book's old cover is never re-set by this question.
 */
export async function coverTypesetDrift(
  projectId: string,
  project: { title: string; subtitle?: string | null; authorName?: string | null; coverTagline?: string | null },
  planningPackage: unknown
): Promise<{ coverId: string; stored: CoverTypeset | undefined; target: CoverTypeset } | undefined> {
  const cover = await prisma.imageAsset.findFirst({
    where: { projectId, type: "COVER" },
    orderBy: { createdAt: "desc" },
    select: { id: true, metadata: true }
  });
  if (!cover || !coverRetypesetSource(cover.metadata)) return undefined;
  const stored = storedCoverTypeset(cover.metadata);
  const plan = isRecord(planningPackage) ? planningPackage : {};
  const current = coverTypesetFor(
    coverMetadataFromProject(project, {
      title: typeof plan.title === "string" ? plan.title : "",
      ...(typeof plan.subtitle === "string" ? { subtitle: plan.subtitle } : {})
    })
  );
  return stored && sameCoverTypeset(stored, current) ? undefined : { coverId: cover.id, stored, target: current };
}
