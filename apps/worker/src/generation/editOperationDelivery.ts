import { prisma, type BookEditOperationModel as BookEditOperation } from "@book-maker/db";

export type EditOperationDeliveryClaim =
  | { outcome: "claimed"; stored: BookEditOperation | null }
  | { outcome: "replay"; stored: BookEditOperation }
  | { outcome: "settled"; stored: BookEditOperation | null };

/**
 * A pre-flight, not a fence, and the same shape `applyImageInsertion` opens
 * with. `markEditOperationActive` has usually moved this row already — QUEUED
 * only, so this is also what re-activates a FAILED one: `apply-book-edit`'s
 * BullMQ attempt budget (`retryJobOptions`) replays a delivered tail and never a
 * failed handler, and the two resume doors that
 * do bring it back — the mobile paid retry and the operator requeue — replay
 * the payload against the FAILED operation row without resetting it. What the
 * count is really for is standing down before any of the work below when
 * another actor settled the operation between the entry check and here. It
 * cannot fence a *concurrent* delivery — ACTIVE matches ACTIVE, so both would
 * win it — and the fence that can is the claim inside the shift's own
 * transaction, which is the only place "has the shift landed" can be asked and
 * answered without a window between. Each image handler likewise owns its
 * binding claim at the write it protects.
 *
 * Conditional, so a stalled redelivery can never regress APPLIED back to
 * ACTIVE or revive a CANCELED operation. FAILED must still re-activate: the
 * paid /resume retry lane reuses the FAILED operation row. Always reading after
 * the claim answers both what the row was settled as and what its freshest
 * classifier holds; in particular, it is the first read that can see an undo
 * which landed during the claim.
 *
 * Unlike the export-repair fence, this fence needs no third, unreadable answer:
 * it runs before any work, so a failed update or read throws and the existing
 * `markFailed` path settles the delivery exactly as it does today.
 */
export async function claimEditOperationForDelivery(
  operationId: string
): Promise<EditOperationDeliveryClaim> {
  const activated = await prisma.bookEditOperation.updateMany({
    where: { id: operationId, status: { notIn: ["APPLIED", "CANCELED"] } },
    data: { status: "ACTIVE" }
  });
  const stored = await prisma.bookEditOperation.findUnique({ where: { id: operationId } });

  if (activated.count !== 0) {
    return { outcome: "claimed", stored };
  }
  if (stored?.status === "APPLIED") {
    return { outcome: "replay", stored };
  }
  return { outcome: "settled", stored };
}
