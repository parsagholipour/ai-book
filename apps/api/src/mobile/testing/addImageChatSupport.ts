import { approvedPlanRecord, buildMobileApp, bearer, generatedPages, projectRecord } from "./mobileApiHarness.js";

/**
 * Shared fixtures for the chat add_image suites (addImageEdits.test.ts,
 * addImageReplacement.test.ts). Image requests have no model-free fast path —
 * the router's insert_image target is the one classifier — so these suites
 * inject a canned decide-tool model through the routingTextModel test seam.
 * The decision table is what routerSystemPrompt teaches the real model to
 * extract for each suite message; classification itself is covered by
 * bookEditImageRouting.test.ts.
 */

export function completeProject(overrides: Record<string, unknown> = {}) {
  return projectRecord({
    id: "project-1",
    status: "COMPLETE",
    currentPlanId: "plan-1",
    currentPlan: approvedPlanRecord(),
    pages: generatedPages(),
    ...overrides
  });
}

export function withTier(tier: string) {
  return {
    mediaSettings: {
      fullIllustrations: true,
      includeCover: true,
      modelTier: tier,
      mobile: { bookType: "lead_magnet", lengthPreset: "short", qualityPreset: tier, imagesEnabled: true }
    }
  };
}

export function imageRouterModel() {
  const decideBase = {
    confidence: 0.93,
    reasoning: "Routing decision.",
    assistantMessage: "I’ll add that picture.",
    clarification: "none",
    pageIndexes: [] as number[],
    chapterIndex: null,
    targetLanguage: null,
    action: "propose_edit",
    editInstruction: "Add or replace the requested illustration at the requested location.",
    editTarget: "insert_image"
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
      let stage = "";
      for (const entry of options.messages) {
        try {
          const parsed = JSON.parse(String(entry.content)) as { userMessage?: unknown; projectStage?: unknown };
          if (typeof parsed.userMessage === "string") {
            message = parsed.userMessage;
            stage = String(parsed.projectStage ?? "");
          }
        } catch {
          // System prompt and non-JSON turns.
        }
      }
      if (stage !== "complete") {
        // Simulates the plan-stage schema refusing insert_image: classification
        // falls to the degraded heuristics, exactly like a router failure.
        throw new Error(`no canned decision at stage ${stage}`);
      }
      if (message.startsWith("No, I actually want")) {
        // A correction of an applied image: the new subject plus the replace
        // flag — never a second add.
        return decide({ ...decideBase, imageSubject: "a castle", imageReplace: true });
      }
      if (message.includes("first image") || message.includes("more aggressive")) {
        return decide({
          ...decideBase,
          imageSubject: "a more aggressive fox",
          imageReplace: true,
          pageIndexes: [1]
        });
      }
      if (message.includes("castle")) {
        return decide({ ...decideBase, imageSubject: "the castle", pageIndexes: [1] });
      }
      if (message.includes("the race")) {
        return decide({ ...decideBase, imageSubject: "the race" });
      }
      if (message.includes("dragon")) {
        return decide({ ...decideBase, imageSubject: "a dragon", imagePlacement: "end_of_book" });
      }
      throw new Error(`no canned decision for: ${message}`);
    },
    async *streamText() {
      yield "";
    }
  };
}

export function withRouter() {
  return { routingTextModel: imageRouterModel() };
}

export async function sendChat(app: Awaited<ReturnType<typeof buildMobileApp>>, message: string) {
  return app.inject({
    method: "POST",
    url: "/api/mobile/projects/project-1/chat/messages",
    headers: bearer("token-a"),
    payload: { message }
  });
}

export async function applyProposal(app: Awaited<ReturnType<typeof buildMobileApp>>, proposalId: string) {
  return app.inject({
    method: "POST",
    url: "/api/mobile/projects/project-1/chat/proposals/apply",
    headers: bearer("token-a"),
    payload: { proposalId }
  });
}

export function imageQuota(used: number) {
  return { limit: 3, used, remaining: Math.max(0, 3 - used), periodKey: "2026-08", resetsAt: new Date("2026-09-01T00:00:00.000Z") };
}

export const quotaAllowed = {
  allowed: true,
  used: 1,
  limit: 3,
  periodKey: "2026-08",
  resetsAt: new Date("2026-09-01T00:00:00.000Z")
};
