import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import {
  applyProposal,
  completeProject,
  imageQuota,
  quotaAllowed,
  sendChat,
  withRouter
} from "./testing/addImageChatSupport.js";
import {
  appliedEditOperationRecord,
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * "No, I actually want …" after an applied add_image is a REPLACEMENT: the new
 * image takes the old marker's line, never a second picture. The card is the
 * confirmation — its summary names both pictures.
 */
describe("chat image replacement", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

    function appliedAddImage(overrides: Record<string, unknown> = {}) {
      return appliedEditOperationRecord({
        id: "op-old",
        kind: "ADD_IMAGE",
        classifier: { imageEdit: { subject: "a dragon", placement: "end_of_book" } },
        ...overrides
      });
    }

    it("proposes a swap card that names both pictures and targets the old marker's page", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([appliedAddImage()]);
      mockPrisma.page.findFirst.mockResolvedValue({ index: 2 } as never);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "No, I actually want a photo of a castle");
      const body = response.json();

      expect(body.reply.metadata.editProposal).toMatchObject({
        kind: "add_image",
        affectedPageIndexes: [2],
        credits: 45,
        summary: "Replace the illustration of “a dragon” with “a castle”"
      });
      expect(body.reply.metadata.pendingEdit.intent.imageEdit).toEqual({
        subject: "a castle",
        placement: "page",
        pageIndex: 2,
        replace: { operationId: "op-old", oldSubject: "a dragon" }
      });
      await app.close();
    });

    it("skips undone insertions when picking the replace target", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([
        appliedAddImage({
          id: "op-undone",
          classifier: { undoneAt: "2026-08-13T00:00:00.000Z", imageEdit: { subject: "a wolf" } }
        }),
        appliedAddImage()
      ]);
      mockPrisma.page.findFirst.mockResolvedValue({ index: 2 } as never);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "No, I actually want a photo of a castle");

      expect(response.json().reply.metadata.editProposal.summary).toBe(
        "Replace the illustration of “a dragon” with “a castle”"
      );
      await app.close();
    });

    it("answers, without a card, when the book has no illustration to replace", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
      mockPrisma.imageAsset.findMany.mockResolvedValue([]);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "No, I actually want a photo of a castle");
      const body = response.json();

      expect(body.reply.content).toMatch(/couldn’t find an illustration/i);
      expect(body.reply.content).not.toMatch(/Edit Mode/);
      expect(body.reply.metadata.editProposal).toBeUndefined();
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
      await app.close();
    });

    it("proposes replacing a built-in page illustration when the book has no chat-added picture", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
      mockPrisma.imageAsset.findMany.mockResolvedValue([
        { id: "asset-1", page: { index: 1 } }
      ]);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "change the first image to more aggressive");
      const body = response.json();

      expect(body.reply.metadata.editProposal).toMatchObject({
        kind: "add_image",
        affectedPageIndexes: [1],
        credits: 45,
        summary: "Replace the illustration of “the illustration on page 1” with “a more aggressive fox”"
      });
      expect(body.reply.metadata.pendingEdit.intent.imageEdit).toEqual({
        subject: "a more aggressive fox",
        placement: "page",
        pageIndex: 1,
        replace: { operationId: "", assetId: "asset-1", oldSubject: "the illustration on page 1" }
      });
      await app.close();
    });

    it("prefers the image on a named page over a newer chat-added picture elsewhere", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([appliedAddImage()]);
      mockPrisma.page.findFirst.mockResolvedValue({ index: 2 } as never);
      mockPrisma.imageAsset.findMany.mockResolvedValue([
        { id: "asset-1", page: { index: 1 } }
      ]);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "change the first image to more aggressive");
      const body = response.json();

      expect(body.reply.metadata.pendingEdit.intent.imageEdit.replace).toEqual({
        operationId: "",
        assetId: "asset-1",
        oldSubject: "the illustration on page 1"
      });
      expect(body.reply.metadata.editProposal.affectedPageIndexes).toEqual([1]);
      await app.close();
    });

    it("still prefers the newest chat-added picture when no page is named", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([appliedAddImage()]);
      mockPrisma.page.findFirst.mockResolvedValue({ index: 2 } as never);
      mockPrisma.imageAsset.findMany.mockResolvedValue([
        { id: "asset-1", page: { index: 1 } }
      ]);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "No, I actually want a photo of a castle");
      const body = response.json();

      expect(body.reply.metadata.pendingEdit.intent.imageEdit.replace).toEqual({
        operationId: "op-old",
        oldSubject: "a dragon"
      });
      expect(body.reply.metadata.editProposal.affectedPageIndexes).toEqual([2]);
      await app.close();
    });

    it("applies the swap: replaceMarker rides the payload and no quota slot is claimed", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([appliedAddImage()]);
      mockPrisma.page.findFirst.mockResolvedValue({ index: 2 } as never);
      // Free tier with slots left: a replacement must still claim nothing —
      // the book was illustrated by the image being swapped out.
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(0) as never);
      mockBilling.consumeIllustratedBookUse.mockResolvedValue(quotaAllowed);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
      const app = await buildMobileApp(withRouter());

      const proposal = await sendChat(app, "No, I actually want a photo of a castle");
      const proposalId = proposal.json().reply.metadata.editProposal.id;
      const confirm = await applyProposal(app, proposalId);
      const body = confirm.json();

      expect(confirm.statusCode).toBe(200);
      expect(body.reply.content).toMatch(/replacing the one on page 2/);
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            imageInsertion: {
              subject: "a castle",
              placement: "page",
              targetPageIndex: 2,
              replaceMarker: "chat-image-op-old"
            }
          })
        })
      );
      expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
      await app.close();
    });

    it("applies a built-in illustration swap: replaceAssetId rides the payload and no quota slot is claimed", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
      mockPrisma.imageAsset.findMany.mockResolvedValue([
        { id: "asset-1", page: { index: 1 } }
      ]);
      mockPrisma.imageAsset.findFirst.mockResolvedValue({
        id: "asset-1",
        page: { index: 1 }
      } as never);
      mockBilling.getImageQuota.mockResolvedValue(imageQuota(0) as never);
      mockBilling.consumeIllustratedBookUse.mockResolvedValue(quotaAllowed);
      vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-image", type: "APPLY_BOOK_EDIT" }));
      const app = await buildMobileApp(withRouter());

      const proposal = await sendChat(app, "change the first image to more aggressive");
      const proposalId = proposal.json().reply.metadata.editProposal.id;
      const confirm = await applyProposal(app, proposalId);
      const body = confirm.json();

      expect(confirm.statusCode).toBe(200);
      expect(body.reply.content).toMatch(/replacing the one on page 1/);
      expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            imageInsertion: {
              subject: "a more aggressive fox",
              placement: "page",
              targetPageIndex: 1,
              replaceAssetId: "asset-1"
            }
          })
        })
      );
      expect(mockBilling.consumeIllustratedBookUse).not.toHaveBeenCalled();
      await app.close();
    });

    it("re-proposes instead of inserting when the swapped image vanished before Apply", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([appliedAddImage()]);
      mockPrisma.page.findFirst.mockResolvedValueOnce({ index: 2 } as never);
      const app = await buildMobileApp(withRouter());

      const proposal = await sendChat(app, "No, I actually want a photo of a castle");
      const proposalId = proposal.json().reply.metadata.editProposal.id;
      // The marker is gone by Apply time (undo, or deleted in Edit Mode): both
      // the queue-time re-check and the fresh resolution see nothing.
      mockPrisma.page.findFirst.mockResolvedValue(null as never);
      mockPrisma.imageAsset.findMany.mockResolvedValue([]);
      const confirm = await applyProposal(app, proposalId);
      const body = confirm.json();

      expect(body.operation).toBeNull();
      expect(body.reply.content).toMatch(/couldn’t find an illustration/i);
      expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
      await app.close();
    });

    it("restores the previous ImageAsset when undoing a built-in illustration swap", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      const operation = appliedEditOperationRecord({
        id: "op-asset",
        kind: "ADD_IMAGE",
        request: "change the first image to more aggressive",
        classifier: {
          previousAsset: {
            id: "asset-1",
            pageId: "page-1",
            path: "http://localhost:4001/assets/images/project-1/page-1.jpg",
            prompt: "old prompt",
            imagePrompt: "old prompt"
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
          prompt: "old prompt"
        }
      });
      expect(mockPrisma.page.update).toHaveBeenCalledWith({
        where: { id: "page-1" },
        data: expect.objectContaining({ imagePrompt: "old prompt" })
      });
      await app.close();
    });
  });

