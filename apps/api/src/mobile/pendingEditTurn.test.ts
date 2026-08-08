import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { resolvePendingEditTurn } from "./pendingEditTurn.js";
import type { PendingEditState } from "./bookEditIntents.js";

const scopeClarification = (overrides: Partial<PendingEditState> = {}): PendingEditState => ({
  request: "Make the villain more sympathetic",
  scope: "none",
  clarification: "scope",
  ...overrides
});

const pricedProposal = (overrides: Partial<PendingEditState> = {}): PendingEditState => ({
  request: "Replace rabbit with fly",
  scope: "none",
  clarification: "confirm",
  intent: { kind: "local_patch" } as PendingEditState["intent"],
  credits: 0,
  proposalId: "proposal-1",
  ...overrides
});

describe("resolvePendingEditTurn", () => {
  it("passes an ordinary message through untouched when nothing is pending", () => {
    const turn = resolvePendingEditTurn(null, "Make chapter 2 funnier");

    expect(turn).toMatchObject({
      currentScope: "none",
      pendingCarriesFullRequest: false,
      resolvesPendingScope: false,
      resolvedPendingEdit: null,
      clarifyExhausted: false,
      resolvedMessage: "Make chapter 2 funnier",
      confirmedPendingEdit: false,
      pendingScopeIsRecoverable: false
    });
  });

  it("resumes a scope clarification when the reply finally names a scope", () => {
    const turn = resolvePendingEditTurn(scopeClarification(), "everywhere in the whole book");

    expect(turn.currentScope).toBe("all_pages");
    expect(turn.resolvesPendingScope).toBe(true);
    expect(turn.resolvedPendingEdit).toEqual({
      request: "Make the villain more sympathetic",
      scope: "all_pages",
      scopeMessage: "everywhere in the whole book"
    });
    // The router sees the original request with the scope attached, never the
    // bare fragment the user typed.
    expect(turn.resolvedMessage).toBe("Make the villain more sympathetic throughout the whole book.");
    expect(turn.clarifyExhausted).toBe(false);
  });

  it("resumes a clarification whose scope was recovered earlier on a bare confirmation", () => {
    const turn = resolvePendingEditTurn(scopeClarification({ scope: "all_pages" }), "ok");

    expect(turn.resolvesPendingScope).toBe(true);
    expect(turn.resolvedPendingEdit).toMatchObject({ scope: "all_pages" });
    expect(turn.pendingScopeIsRecoverable).toBe(true);
  });

  it("exhausts the one question when the reply neither answers nor cancels it", () => {
    // "just add" satisfies no scope: a second question here is the loop the
    // user cannot escape, so the turn is forced onward with the request merged.
    const turn = resolvePendingEditTurn(scopeClarification(), "just add");

    expect(turn.resolvesPendingScope).toBe(false);
    expect(turn.resolvedPendingEdit).toBeNull();
    expect(turn.clarifyExhausted).toBe(true);
    expect(turn.resolvedMessage).toBe(
      "Make the villain more sympathetic\n\nFollow-up from the user: just add"
    );
    // A bare scope clarification has nothing to recover; the recovery reply
    // would be the same question again.
    expect(turn.pendingScopeIsRecoverable).toBe(false);
  });

  it("does not exhaust a clarification the user cancels", () => {
    const turn = resolvePendingEditTurn(scopeClarification(), "never mind");

    expect(turn.clarifyExhausted).toBe(false);
    expect(turn.resolvedPendingEdit).toBeNull();
    expect(turn.resolvedMessage).toBe("never mind");
  });

  it("confirms a priced proposal on a pure confirmation, keeping the quoted request", () => {
    const turn = resolvePendingEditTurn(pricedProposal(), "apply it");

    expect(turn.pendingCarriesFullRequest).toBe(true);
    expect(turn.confirmedPendingEdit).toBe(true);
    // The proposal carries its full target; the resolved message is the
    // request itself, not the confirmation fragment.
    expect(turn.resolvedMessage).toBe("Replace rabbit with fly");
    expect(turn.pendingScopeIsRecoverable).toBe(true);
  });

  it("re-routes a proposal reply that adds scope instead of confirming", () => {
    const turn = resolvePendingEditTurn(pricedProposal(), "do that everywhere in the whole book");

    expect(turn.resolvesPendingScope).toBe(true);
    // Not a pure confirmation: the changed target goes back through routing
    // and re-pricing rather than executing the stale quote.
    expect(turn.confirmedPendingEdit).toBe(false);
    expect(turn.resolvedMessage).toBe("Replace rabbit with fly throughout the whole book.");
  });

  it("resumes a busy-queued edit on confirmation without treating it as a proposal", () => {
    const turn = resolvePendingEditTurn(
      scopeClarification({ clarification: "busy", request: "Add a dragon to chapter 3" }),
      "go ahead"
    );

    expect(turn.pendingCarriesFullRequest).toBe(true);
    expect(turn.resolvedPendingEdit).toMatchObject({ request: "Add a dragon to chapter 3", scope: "none" });
    expect(turn.resolvedMessage).toBe("Add a dragon to chapter 3");
    // Only clarification "confirm" makes a confirmation execute a priced
    // proposal; a busy resume goes back through routing.
    expect(turn.confirmedPendingEdit).toBe(false);
    // Only a scope clarification can exhaust the one question.
    expect(turn.clarifyExhausted).toBe(false);
  });

  it("honors a caller-precomputed scope so it is derived exactly once per turn", () => {
    const turn = resolvePendingEditTurn(scopeClarification(), "just add", { currentScope: "all_pages" });

    expect(turn.currentScope).toBe("all_pages");
    expect(turn.resolvesPendingScope).toBe(true);
    expect(turn.resolvedPendingEdit).toMatchObject({ scope: "all_pages" });
  });
});
