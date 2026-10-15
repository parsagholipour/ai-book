import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", () => ({ prisma: {} }));
vi.mock("@book-maker/db/billing", () => ({ hasActiveSubscriptionEntitlement: vi.fn() }));

import type { BookEditIntent } from "../bookEditIntent.js";
import { aiWorkKindForMediaSettings, proposalRunsModel } from "./aiCapacity.js";

function card(kind: BookEditIntent["kind"], extra: Record<string, unknown> = {}, credits?: number) {
  return {
    intent: { kind, ...extra } as unknown as BookEditIntent,
    ...(credits !== undefined ? { credits } : {})
  };
}

describe("proposalRunsModel", () => {
  it("lets the free cards through and asks for every card that drafts, draws or replans", () => {
    expect(proposalRunsModel(card("move_image", {}, 0))).toBe(false);
    expect(proposalRunsModel(card("remove_image", {}, 0))).toBe(false);
    expect(proposalRunsModel(card("restructure_pages", { structuralEdit: { action: "delete" } }, 0))).toBe(false);
    expect(proposalRunsModel(card("restructure_pages", { structuralEdit: { action: "move" } }, 0))).toBe(false);
    expect(proposalRunsModel(card("restructure_pages", { structuralEdit: { action: "insert" } }, 60))).toBe(true);
    // A verified exact replacement quotes 0; an unverified patch is a rewrite.
    expect(proposalRunsModel(card("local_patch", {}, 0))).toBe(false);
    expect(proposalRunsModel(card("local_patch", {}, 25))).toBe(true);
    // A title over a designed cover is a retypeset; over an AI cover it redraws.
    expect(proposalRunsModel(card("book_title", {}, 0))).toBe(false);
    expect(proposalRunsModel(card("book_title", {}, 120))).toBe(true);
    for (const kind of ["page_rewrite", "chapter_regenerate", "add_image", "continue_book", "book_replan", "plan_revision"] as const) {
      expect(proposalRunsModel(card(kind, {}, 40)), kind).toBe(true);
    }
  });

  it("reads the stored card plan before the intent for a structural edit", () => {
    expect(
      proposalRunsModel({
        ...card("restructure_pages", { structuralEdit: { action: "delete" } }),
        structuralPlan: { action: "insert", pageCount: 2, totalPages: 12, insertAfterIndex: 3 }
      })
    ).toBe(true);
  });

  it("has nothing to ask about a card with no intent", () => {
    expect(proposalRunsModel({})).toBe(false);
  });
});

describe("aiWorkKindForMediaSettings", () => {
  it("is ultra only for a book recorded at the ultra tier", () => {
    expect(aiWorkKindForMediaSettings({ modelTier: "ultra" })).toBe("ultra");
    expect(aiWorkKindForMediaSettings({ modelTier: "premium" })).toBe("standard");
    // The app's echo is not the tier (packages/core/CLAUDE.md), and no tier is balanced.
    expect(aiWorkKindForMediaSettings({ mobile: { qualityPreset: "ultra" } })).toBe("standard");
    expect(aiWorkKindForMediaSettings(null)).toBe("standard");
  });
});
