import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";
import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";

import { enqueueGenerationJob } from "../queue.js";
import { applyProposal, completeProject, sendChat } from "./testing/addImageChatSupport.js";
import {
  appliedEditOperationRecord,
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { currentActionForEditOperation } from "./editOperationCopy.js";
import { UNDOABLE_EDIT_KINDS } from "./manualEdits.js";
import { operationCanUndo, serializeBookEditOperation } from "./projectChat.js";
import { bookEditCreditCost } from "./bookEditPricing.js";

function layoutRouterModel() {
  const decideBase = {
    confidence: 0.93,
    reasoning: "Routing decision.",
    assistantMessage: "I’ll change that picture.",
    clarification: "none",
    pageIndexes: [] as number[],
    chapterIndex: null,
    targetLanguage: null,
    action: "propose_edit",
    editInstruction: "Apply the requested illustration layout change."
  };
  const decide = (args: Record<string, unknown>) => ({
    text: "",
    model: "test-router",
    provider: "test",
    toolCalls: [{ id: "call-decide", name: "decide", arguments: args }]
  });
  return {
    generateText: async () => ({ text: "", model: "test-router", provider: "test" }),
    generateJson: async () => {
      throw new Error("generateJson is not used by the tool-calling router");
    },
    generateWithTools: async (options: { messages: Array<{ content: unknown }> }) => {
      let message = "";
      for (const entry of options.messages) {
        try {
          const parsed = JSON.parse(String(entry.content)) as { userMessage?: unknown };
          if (typeof parsed.userMessage === "string") {
            message = parsed.userMessage;
          }
        } catch {
          // System prompt.
        }
      }
      if (message.toLowerCase().includes("remove")) {
        const chapter = /chapter (\d+)/i.exec(message);
        return decide({
          ...decideBase,
          editTarget: "remove_image",
          pageIndexes: message.includes("page 1") ? [1] : [],
          ...(chapter
            ? { imageSelection: "chapter", chapterIndex: Number(chapter[1]) }
            : /\ball\b|\bevery\b/i.test(message)
              ? { imageSelection: "all" }
              : {})
        });
      }
      if (message.toLowerCase().includes("move") || /\bput the (picture|image)\b/i.test(message)) {
        const onPage1 = /on page 1/i.test(message);
        const toPage1 = /to page 1/i.test(message);
        const toPage2 = /to page 2/i.test(message);
        const position = /\b(top|bottom)\b/i.exec(message)?.[1]?.toLowerCase();
        return decide({
          ...decideBase,
          editTarget: "move_image",
          pageIndexes: onPage1 ? [1] : [],
          ...(toPage1 ? { imageDestPageIndexes: [1] } : toPage2 ? { imageDestPageIndexes: [2] } : {}),
          ...(position ? { imagePosition: position } : {}),
          ...(message.includes("end of the book") ? { imagePlacement: "end_of_book" } : {})
        });
      }
      throw new Error(`no canned decision for: ${message}`);
    },
    async *streamText() {
      yield "";
    }
  };
}

function withLayoutRouter() {
  return { routingTextModel: layoutRouterModel() };
}

describe("chat image layout", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("proposes a 0-credit remove card for a built-in illustration", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Remove the picture on page 1");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "remove_image",
      affectedPageIndexes: [1],
      credits: 0,
      summary: "Remove the illustration of “the illustration on page 1” from page 1"
    });
    expect(body.reply.metadata.pendingEdit.intent.imageLayout).toEqual({
      action: "remove",
      pageIndex: 1,
      targets: [{ operationId: "", assetId: "asset-1", oldSubject: "the illustration on page 1", pageIndex: 1 }]
    });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("proposes one free card naming every illustration for a whole-book remove", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([
      { id: "asset-1", page: { index: 1 } },
      { id: "asset-2", page: { index: 2 } }
    ]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Remove all the pictures");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "remove_image",
      affectedPageIndexes: [1, 2],
      credits: 0,
      summary: "Remove all 2 illustrations"
    });
    // The count is the confirmation, so the card has to have resolved the whole
    // set before it is shown — not left it to Apply.
    expect(body.reply.metadata.pendingEdit.intent.imageLayout.targets).toHaveLength(2);
    expect(body.reply.metadata.pendingEdit.intent.imageLayout.selection).toEqual({ kind: "all" });
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    await app.close();
  });

  it("scopes a chapter remove to that chapter's pages", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      completeProject({
        chapters: [
          { id: "chapter-1", index: 1, title: "One", summary: "" },
          { id: "chapter-2", index: 2, title: "Two", summary: "" }
        ],
        pages: [
          { id: "page-1", index: 1, title: "One", summary: "", status: "COMPLETED", chapter: { index: 1 } },
          { id: "page-2", index: 2, title: "Two", summary: "", status: "COMPLETED", chapter: { index: 2 } }
        ]
      })
    );
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([
      { id: "asset-1", page: { index: 1 } },
      { id: "asset-2", page: { index: 2 } }
    ]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Remove the images from chapter 2");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "remove_image",
      affectedPageIndexes: [2],
      credits: 0,
      summary: "Remove the illustration in chapter 2"
    });
    expect(body.reply.metadata.pendingEdit.intent.imageLayout.targets).toHaveLength(1);
    await app.close();
  });

  it("answers rather than proposing when a named chapter has no illustrations", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      completeProject({
        chapters: [{ id: "chapter-1", index: 1, title: "One", summary: "" }],
        pages: [
          { id: "page-1", index: 1, title: "One", summary: "", status: "COMPLETED", chapter: { index: 1 } }
        ]
      })
    );
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Remove the images from chapter 2");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toBeUndefined();
    expect(body.reply.content).toMatch(/couldn’t find chapter 2/i);
    await app.close();
  });

  it("proposes a within-page move rather than answering “already on page 1”", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Move the picture on page 1 to the bottom of the page");
    const body = response.json();

    expect(body.reply.content).not.toMatch(/already on page/i);
    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "move_image",
      affectedPageIndexes: [1],
      credits: 0,
      summary: "Move the illustration of “the illustration on page 1” to the bottom of page 1"
    });
    expect(body.reply.metadata.pendingEdit.intent.imageLayout.destPosition).toBe("bottom");
    await app.close();
  });

  it("answers without a card when the book has no illustration to remove", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Remove the picture");
    const body = response.json();

    expect(body.reply.content).toMatch(/couldn’t find an illustration/i);
    expect(body.reply.metadata.editProposal).toBeUndefined();
    await app.close();
  });

  it("proposes moving a chat-added picture to a named page", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([
      appliedEditOperationRecord({
        id: "op-old",
        kind: "ADD_IMAGE",
        classifier: { imageEdit: { subject: "a dragon", placement: "end_of_book" } }
      })
    ]);
    mockPrisma.page.findFirst.mockResolvedValue({ index: 2 } as never);
    mockPrisma.imageAsset.findMany.mockResolvedValue([]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Move the picture to page 1");
    const body = response.json();

    expect(body.reply.metadata.editProposal).toMatchObject({
      kind: "move_image",
      credits: 0
    });
    expect(body.reply.metadata.editProposal.summary).toMatch(/Move the illustration/i);
    await app.close();
  });

  it("answers when the picture is already on the destination page", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    const app = await buildMobileApp(withLayoutRouter());

    const response = await sendChat(app, "Move the picture on page 1 to page 1");
    const body = response.json();

    expect(body.reply.content).toMatch(/already on page 1/i);
    expect(body.reply.metadata.editProposal).toBeUndefined();
    await app.close();
  });

  it("queues a 0-credit APPLY_BOOK_EDIT with imageLayout and no quota claim", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    mockPrisma.imageAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      page: { index: 1 }
    });
    const app = await buildMobileApp(withLayoutRouter());

    const proposal = await sendChat(app, "Remove the picture on page 1");
    const proposalId = proposal.json().reply.metadata.editProposal.id;
    const confirm = await applyProposal(app, proposalId);
    const body = confirm.json();

    expect(body.operation).toMatchObject({ kind: "remove_image", creditsCharged: 0 });
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        payload: expect.objectContaining({
          intentKind: "remove_image",
          [PRE_EDIT_PROJECT_STATUS]: "COMPLETE",
          imageLayout: {
            action: "remove",
            sources: [{ pageIndex: 1, replaceAssetId: "asset-1" }]
          }
        })
      })
    );
    expect(vi.mocked(reserveCredits)).toHaveBeenCalledWith(expect.objectContaining({ amountCredits: 0 }));
    expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
    await app.close();
  });

  it("stamps REVIEW_REQUIRED on an image layout edit before enqueue changes the project status", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject({ status: "REVIEW_REQUIRED" }));
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    mockPrisma.imageAsset.findFirst.mockResolvedValue({ id: "asset-1", page: { index: 1 } });
    const app = await buildMobileApp(withLayoutRouter());

    const proposal = await sendChat(app, "Remove the picture on page 1");
    await applyProposal(app, proposal.json().reply.metadata.editProposal.id);

    expect(vi.mocked(enqueueGenerationJob).mock.calls.at(-1)?.[0].payload[PRE_EDIT_PROJECT_STATUS]).toBe(
      "REVIEW_REQUIRED"
    );
    await app.close();
  });

  // The card said "Remove all 2 illustrations", so 2 is what Apply removes. A
  // picture added between the card and the tap is not swept into an edit the
  // reader never saw — the same rule the charged edits follow about never going
  // past the number they quoted.
  it("removes exactly the illustrations the card named, not the book's current set", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([
      { id: "asset-1", page: { index: 1 } },
      { id: "asset-2", page: { index: 2 } }
    ]);
    mockPrisma.imageAsset.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "asset-1"
        ? { id: "asset-1", page: { index: 1 } }
        : where.id === "asset-2"
          ? { id: "asset-2", page: { index: 2 } }
          : null
    );
    const app = await buildMobileApp(withLayoutRouter());

    const proposal = await sendChat(app, "Remove all the pictures");
    const proposalId = proposal.json().reply.metadata.editProposal.id;

    // A third picture arrives between the card and the tap.
    mockPrisma.imageAsset.findMany.mockResolvedValue([
      { id: "asset-1", page: { index: 1 } },
      { id: "asset-2", page: { index: 2 } },
      { id: "asset-3", page: { index: 2 } }
    ]);
    mockPrisma.imageAsset.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "asset-3" ? { id: "asset-3", page: { index: 2 } } : { id: where.id, page: { index: 1 } }
    );

    await applyProposal(app, proposalId);

    const call = vi.mocked(enqueueGenerationJob).mock.calls.at(-1)?.[0] as unknown as {
      payload: { imageLayout: { sources: Array<{ replaceAssetId?: string }> } };
    };
    expect(call.payload.imageLayout.sources).toHaveLength(2);
    expect(call.payload.imageLayout.sources.map((source) => source.replaceAssetId)).not.toContain("asset-3");
    await app.close();
  });

  it("re-proposes instead of applying when the picture vanished before Apply", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
    mockPrisma.imageAsset.findMany.mockResolvedValue([{ id: "asset-1", page: { index: 1 } }]);
    mockPrisma.imageAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      page: { index: 1 }
    });
    const app = await buildMobileApp(withLayoutRouter());

    const proposal = await sendChat(app, "Remove the picture on page 1");
    const proposalId = proposal.json().reply.metadata.editProposal.id;
    mockPrisma.imageAsset.findFirst.mockResolvedValue(null as never);
    mockPrisma.imageAsset.findMany.mockResolvedValue([]);
    const confirm = await applyProposal(app, proposalId);
    const body = confirm.json();

    expect(body.operation).toBeNull();
    expect(body.reply.content).toMatch(/couldn’t find an illustration/i);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("names running layout operations and keeps them undoable", () => {
    expect(
      currentActionForEditOperation(
        appliedEditOperationRecord({ kind: "REMOVE_IMAGE", status: "ACTIVE", appliedAt: null }) as never
      )
    ).toBe("Removing the illustration.");
    expect(
      currentActionForEditOperation(
        appliedEditOperationRecord({ kind: "MOVE_IMAGE", status: "ACTIVE", appliedAt: null }) as never
      )
    ).toBe("Moving the illustration.");
    expect(UNDOABLE_EDIT_KINDS).toContain("MOVE_IMAGE");
    expect(UNDOABLE_EDIT_KINDS).toContain("REMOVE_IMAGE");
    expect(serializeBookEditOperation(appliedEditOperationRecord({ kind: "REMOVE_IMAGE" }) as never).kind).toBe(
      "remove_image"
    );
  });

  // The worker cannot write a chat message, so the card is the only place a
  // layout edit that found nothing can correct the reply that already promised
  // the change — and offering Undo there would revert the *previous* edit,
  // because `undoLastBookEdit` skips an operation with no snapshots.
  it("says a skipped layout edit changed nothing, and does not offer Undo for it", () => {
    const missing = appliedEditOperationRecord({
      kind: "REMOVE_IMAGE",
      affectedPageIndexes: [],
      classifier: { layoutMissing: true, layoutSkippedReason: "missing" }
    });
    expect(currentActionForEditOperation(missing as never)).toBe(
      "Nothing was changed: that illustration had already gone."
    );
    expect(operationCanUndo(missing as never)).toBe(false);

    const inPlace = appliedEditOperationRecord({
      kind: "MOVE_IMAGE",
      affectedPageIndexes: [],
      classifier: { layoutMissing: true, layoutSkippedReason: "already_positioned" }
    });
    expect(currentActionForEditOperation(inPlace as never)).toBe(
      "Nothing was changed: that picture is already where you asked for it."
    );
    expect(operationCanUndo(inPlace as never)).toBe(false);

    // An ordinary applied layout edit is untouched by any of that: it
    // snapshotted the page it unlinked the picture from, which is what the undo
    // restores and therefore what the button is drawn from.
    expect(
      operationCanUndo(
        appliedEditOperationRecord({ kind: "REMOVE_IMAGE", _count: { snapshots: 1 } }) as never
      )
    ).toBe(true);
    // And a record is what makes it undoable, not the absence of a marker: a
    // layout edit that wrote no snapshot is skipped by the picker whatever its
    // classifier says.
    expect(operationCanUndo(appliedEditOperationRecord({ kind: "REMOVE_IMAGE" }) as never)).toBe(false);
  });

  it("prices move and remove at zero", () => {
    const project = completeProject();
    expect(bookEditCreditCost("move_image", 2, project as never)).toBe(0);
    expect(bookEditCreditCost("remove_image", 1, project as never)).toBe(0);
  });

  it("restores ImageAsset pageId when undoing a remove", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const operation = appliedEditOperationRecord({
      id: "op-remove",
      kind: "REMOVE_IMAGE",
      request: "Remove the picture on page 1",
      classifier: {
        previousAsset: {
          id: "asset-1",
          pageId: "page-1",
          path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
          prompt: "a dragon",
          imagePrompt: "a dragon"
        }
      },
      snapshots: [
        {
          pageId: "page-1",
          pageIndex: 1,
          titleBefore: "One",
          markdownBefore: "Prose.",
          summaryBefore: "S",
          revisionBefore: 1
        }
      ]
    });
    state.bookEditOperations.push(operation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([operation]);
    mockPrisma.imageAsset.updateMany.mockResolvedValue({ count: 1 });
    state.pages.push({
      id: "page-1",
      projectId: "project-1",
      index: 1,
      title: "One",
      markdown: "Prose.",
      summary: "S",
      revision: 2,
      status: "COMPLETED"
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-1", projectId: "project-1" },
      data: {
        path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
        prompt: "a dragon",
        pageId: "page-1"
      }
    });
    await app.close();
  });

  it("restores every picture when undoing a bulk remove", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const operation = appliedEditOperationRecord({
      id: "op-remove-all",
      kind: "REMOVE_IMAGE",
      request: "Remove all the pictures",
      affectedPageIndexes: [1, 2],
      classifier: {
        previousAssets: [
          {
            id: "asset-1",
            pageId: "page-1",
            path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
            prompt: "a dragon",
            imagePrompt: "a dragon"
          },
          {
            id: "asset-2",
            pageId: "page-2",
            path: "http://localhost:4001/assets/images/project-1/page-2.jpg",
            prompt: "a fox",
            imagePrompt: "a fox"
          }
        ]
      },
      snapshots: [
        {
          pageId: "page-1",
          pageIndex: 1,
          titleBefore: "One",
          markdownBefore: "Prose one.",
          summaryBefore: "S",
          revisionBefore: 1
        },
        {
          pageId: "page-2",
          pageIndex: 2,
          titleBefore: "Two",
          markdownBefore: "Prose two.",
          summaryBefore: "T",
          revisionBefore: 1
        }
      ]
    });
    state.bookEditOperations.push(operation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([operation]);
    mockPrisma.imageAsset.updateMany.mockResolvedValue({ count: 1 });
    for (const page of [
      { id: "page-1", index: 1, title: "One", markdown: "Prose one.", summary: "S" },
      { id: "page-2", index: 2, title: "Two", markdown: "Prose two.", summary: "T" }
    ]) {
      state.pages.push({ ...page, projectId: "project-1", revision: 2, status: "COMPLETED" });
    }
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    // Every picture goes back, not just the first — the singular reader this
    // replaced would have restored one and silently left the rest unlinked.
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "asset-1", projectId: "project-1" } })
    );
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "asset-2", projectId: "project-1" } })
    );
    await app.close();
  });

  it("restores both the moved hero and the demoted dest hero on undo", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    const operation = appliedEditOperationRecord({
      id: "op-move",
      kind: "MOVE_IMAGE",
      request: "Move the picture to page 2",
      classifier: {
        previousAsset: {
          id: "asset-moved",
          pageId: "page-1",
          destPageId: "page-2",
          path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
          prompt: "a dragon",
          imagePrompt: "a dragon",
          destImagePrompt: "a fox"
        },
        demotedAsset: {
          id: "asset-dest",
          pageId: "page-2",
          path: "http://localhost:4001/assets/images/project-1/page-2.jpg",
          prompt: "a fox",
          imagePrompt: "a fox"
        }
      },
      snapshots: [
        {
          pageId: "page-1",
          pageIndex: 1,
          titleBefore: "One",
          markdownBefore: "Prose.",
          summaryBefore: "S",
          revisionBefore: 1
        },
        {
          pageId: "page-2",
          pageIndex: 2,
          titleBefore: "Two",
          markdownBefore: "Later.",
          summaryBefore: "T",
          revisionBefore: 1
        }
      ]
    });
    state.bookEditOperations.push(operation);
    mockPrisma.bookEditOperation.findMany.mockResolvedValue([operation]);
    mockPrisma.imageAsset.updateMany.mockResolvedValue({ count: 1 });
    state.pages.push(
      {
        id: "page-1",
        projectId: "project-1",
        index: 1,
        title: "One",
        markdown: "Prose.",
        summary: "S",
        revision: 2,
        status: "COMPLETED"
      },
      {
        id: "page-2",
        projectId: "project-1",
        index: 2,
        title: "Two",
        markdown: "Later.\n\n![a fox](/assets/images/project-1/page-2.jpg)",
        summary: "T",
        revision: 2,
        status: "COMPLETED"
      }
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/edits/undo",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-moved", projectId: "project-1" },
      data: expect.objectContaining({ pageId: "page-1" })
    });
    expect(mockPrisma.imageAsset.updateMany).toHaveBeenCalledWith({
      where: { id: "asset-dest", projectId: "project-1" },
      data: expect.objectContaining({ pageId: "page-2" })
    });
    await app.close();
  });
});
