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
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  resetMobileHarness,
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

    it("answers, without a card, when there is no chat-added picture to replace", async () => {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue(completeProject());
      mockPrisma.bookEditOperation.findMany.mockResolvedValue([]);
      const app = await buildMobileApp(withRouter());

      const response = await sendChat(app, "No, I actually want a photo of a castle");
      const body = response.json();

      // Chat never dead-ends: the reply says what CAN change the picture and
      // how to add one instead.
      expect(body.reply.content).toMatch(/couldn’t find a picture/i);
      expect(body.reply.content).toMatch(/Edit Mode/);
      expect(body.reply.metadata.editProposal).toBeUndefined();
      expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
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
      const confirm = await applyProposal(app, proposalId);
      const body = confirm.json();

      expect(body.operation).toBeNull();
      expect(body.reply.content).toMatch(/couldn’t find a picture/i);
      expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
      await app.close();
    });
  });

