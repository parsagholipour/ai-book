import { prisma } from "@book-maker/db";
import type { AdminWindow } from "./metrics.js";

/**
 * The book-sharing funnel on the Overview: shares made in the window (by
 * current mode), the PDF views those shares have had, the chats their "Make a
 * book like this" button started, and how many of those chats became a book.
 *
 * Views are a running count on the share row, not an event log, so they are
 * summed over the shares *created* in the window — the funnel follows one
 * cohort from share to book rather than mixing a window's views with older
 * shares. A remix draft is a `MobileCreationDraft` whose `originShareId` is set
 * (a column, because every chat turn rebuilds the draft's payload), and a book
 * built from one is that draft's `createdProjectId`.
 */
export type ShareFunnel = {
  sharesCreated: number;
  previewShares: number;
  fullShares: number;
  pdfViews: number;
  remixDrafts: number;
  remixBooks: number;
};

export async function loadShareFunnel(window: AdminWindow): Promise<ShareFunnel> {
  const inWindow = { gte: window.since, lte: window.until };
  const [byMode, views, remixDrafts, remixBooks] = await Promise.all([
    prisma.bookShare.groupBy({ by: ["mode"], where: { createdAt: inWindow }, _count: { _all: true } }),
    prisma.bookShare.aggregate({ where: { createdAt: inWindow }, _sum: { viewCount: true } }),
    prisma.mobileCreationDraft.count({ where: { originShareId: { not: null }, createdAt: inWindow } }),
    prisma.mobileCreationDraft.count({
      where: { originShareId: { not: null }, createdAt: inWindow, createdProjectId: { not: null } }
    })
  ]);
  const count = (mode: "PREVIEW" | "FULL") => byMode.find((row) => row.mode === mode)?._count._all ?? 0;
  const previewShares = count("PREVIEW");
  const fullShares = count("FULL");
  return {
    sharesCreated: previewShares + fullShares,
    previewShares,
    fullShares,
    pdfViews: views._sum.viewCount ?? 0,
    remixDrafts,
    remixBooks
  };
}
