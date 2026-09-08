import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkSourceSection, creationAttachmentSchema } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { config } from "./config.js";

let afterId = "";
/** A bounded background backfill; the source table is its restart checkpoint. */
export async function backfillLegacySources() {
  const drafts = await prisma.$queryRaw<Array<{ id: string; userId: string; payload: Prisma.JsonValue }>>`
    SELECT "id", "userId", "payload" FROM "MobileCreationDraft" d
    WHERE d."id" > ${afterId} AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d."payload"->'attachments') = 'array' THEN d."payload"->'attachments' ELSE '[]'::jsonb END) a
      WHERE NOT EXISTS (SELECT 1 FROM "SourceDocument" s WHERE s."id" = a->>'id')
    ) ORDER BY "id" LIMIT 5`;
  afterId = drafts.at(-1)?.id ?? "";
  for (const draft of drafts) {
    const payload = draft.payload as { attachments?: unknown[] };
    for (const entry of payload.attachments ?? []) {
      const parsed = creationAttachmentSchema.safeParse(entry);
      if (!parsed.success) continue;
      const attachment = parsed.data;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(attachment.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(draft.id)) continue;
      const existing = await prisma.sourceDocument.findUnique({ where: { id: attachment.id } });
      if (existing) continue;
      let original: Buffer | undefined;
      try { original = await readFile(join(config.ATTACHMENT_STORAGE_DIR, draft.id, attachment.id)); } catch { /* Original retention has expired. */ }
      const limited = !original;
      const chunks = limited ? chunkSourceSection({ section: 0, locator: "Legacy digest (limited coverage)", content: attachment.content }) : [];
      await prisma.sourceDocument.upsert({ where: { id: attachment.id }, update: {}, create: {
        id: attachment.id, draftId: draft.id, storageDraftId: draft.id, userId: draft.userId, uploadKey: `legacy:${attachment.id}`, contentHash: createHash("sha256").update(original ?? attachment.content).digest("hex"),
        name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind, sizeBytes: attachment.sizeBytes,
        extractions: { create: { version: 1, status: limited ? "limited" : "queued", extractionComplete: limited, fullContent: limited ? attachment.content : "", summary: limited ? attachment.summary : "",
          totalSections: limited ? 1 : 0, progress: limited ? 100 : 0,
          unreadable: limited ? ["The original file has expired. Only the earlier limited digest could be recovered."] : [],
          chunks: { create: chunks.map((chunk) => ({ ...chunk, summary: attachment.summary })) } } }
      } });
    }
  }
}
