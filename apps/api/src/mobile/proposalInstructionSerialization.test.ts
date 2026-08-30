import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { type BookEditIntent, type BookEditIntentKind } from "../bookEditIntent.js";
import { editProposalMessage, editProposalSummary } from "./bookEditCopy.js";
import { serializeProjectChatMessage } from "./projectChat.js";

function intentFor(kind: BookEditIntentKind, editInstruction?: string): BookEditIntent {
  return {
    kind,
    confidence: 0.9,
    reasoning: "r",
    assistantMessage: "a",
    affectedPageIndexes: kind === "page_rewrite" ? [1] : [],
    scope: kind === "page_rewrite" ? "explicit_pages" : "none",
    impact: kind === "book_replan" ? "structural_replan" : "style_rewrite",
    clarification: "none",
    ...(editInstruction ? { editInstruction } : {}),
    ...(kind === "restructure_pages"
      ? {
          structuralEdit: {
            action: "insert" as const,
            anchorPageIndex: 1,
            pageIndexes: [],
            pageCount: 1
          }
        }
      : {}),
    ...(kind === "continue_book" ? { continuation: { chapterCount: 2 } } : {}),
    ...(kind === "book_replan"
      ? { replanSettings: { targetPages: 8, fullIllustrations: false, includeCover: false } }
      : {})
  };
}

function longInstruction(label: string, targetLength: number): string {
  const tail = `FINAL ${label} REQUIREMENT: keep the lighthouse scene, preserve Mina's apology, and end with the brass key.`;
  const prefix = `Rewrite the requested material for ${label}. `;
  const filler = "Keep every named event in chronological order and retain all established character motivations. ";
  const repeated = filler.repeat(Math.ceil((targetLength - prefix.length - tail.length) / filler.length));
  return `${prefix}${repeated.slice(0, targetLength - prefix.length - tail.length)}${tail}`;
}

describe("serialized proposal instruction contracts", () => {
  it.each([
    ["page_rewrite", "text", 240],
    ["restructure_pages", "restructure", 1198],
    ["continue_book", "continuation", 1195],
    ["book_replan", "replan", 1192]
  ] as const)("keeps the complete %s instruction visible through mobile serialization", (kind, label, length) => {
    const editInstruction = longInstruction(label, length);
    const intent = intentFor(kind, editInstruction);
    const affectedPageIndexes = intent.affectedPageIndexes;
    const summary = editProposalSummary(kind, affectedPageIndexes, intent);
    const content = editProposalMessage(kind, affectedPageIndexes, intent);
    const serialized = serializeProjectChatMessage({
      id: `chat-${kind}`,
      projectId: "project-1",
      parentId: "chat-user",
      role: "ASSISTANT",
      content,
      operationId: null,
      metadata: {
        intent,
        editProposal: { id: `proposal-${kind}`, kind, summary }
      },
      createdAt: new Date("2026-08-29T00:00:00.000Z")
    });

    const serializedProposal = serialized.metadata as {
      editProposal: { summary: string };
      intent: { editInstruction: string };
    };
    expect(editInstruction).toHaveLength(length);
    expect(serializedProposal.intent.editInstruction).toBe(editInstruction);
    expect(serializedProposal.editProposal.summary.endsWith(editInstruction)).toBe(true);
    expect(serialized.content).toContain(editInstruction);
    expect(serializedProposal.editProposal.summary).toContain(`FINAL ${label} REQUIREMENT`);
    expect(serializedProposal.editProposal.summary).not.toMatch(/…|\.\.\.$/);
  });

  it.each([
    ["page_rewrite", "Rewrite page 1"],
    ["restructure_pages", "Add 1 new page after page 1"],
    ["continue_book", "Write 2 new chapters continuing your book"],
    ["book_replan", "Rebuild as a new 8-page copy without illustrations with a designed cover"]
  ] as const)("keeps safe legacy %s copy when no durable instruction exists", (kind, expected) => {
    const intent = intentFor(kind);
    expect(editProposalSummary(kind, intent.affectedPageIndexes, intent)).toBe(expected);
  });
});
