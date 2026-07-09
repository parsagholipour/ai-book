import { describe, expect, it } from "vitest";
import type { MobileCreationMessage } from "./mobileCreation.js";
import {
  CREATION_STORED_MESSAGE_CAP,
  CREATION_TRANSCRIPT_CAP,
  appendCreationMessage,
  foldCreationTranscriptTree,
  forkCreationSiblingMessage,
  linearizeCreationMessages,
  normalizeCreationMessageIds,
  switchCreationBranch
} from "./creationChatTree.js";

function legacyMessage(role: "user" | "assistant", content: string): MobileCreationMessage {
  return { role, content };
}

function legacyTranscript(turns: number): MobileCreationMessage[] {
  const messages: MobileCreationMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push(legacyMessage(index % 2 === 0 ? "user" : "assistant", `Message ${index}`));
  }
  return messages;
}

describe("normalizeCreationMessageIds", () => {
  it("assigns deterministic ids and a linear parent chain to legacy messages", () => {
    const normalized = normalizeCreationMessageIds(legacyTranscript(3));
    expect(normalized.map((message) => message.id)).toEqual(["legacy-0", "legacy-1", "legacy-2"]);
    expect(normalized.map((message) => message.parentId)).toEqual([null, "legacy-0", "legacy-1"]);
    expect(normalized.every((message) => message.isActiveChild === true)).toBe(true);
  });

  it("is stable across repeated calls and leaves normalized trees untouched", () => {
    const once = normalizeCreationMessageIds(legacyTranscript(4));
    const twice = normalizeCreationMessageIds(once);
    expect(twice).toEqual(once);
  });
});

describe("linearizeCreationMessages", () => {
  it("returns the whole transcript with no branches for a linear chat", () => {
    const { active, branches } = linearizeCreationMessages(legacyTranscript(4));
    expect(active.map((message) => message.content)).toEqual([
      "Message 0",
      "Message 1",
      "Message 2",
      "Message 3"
    ]);
    expect(branches.size).toBe(0);
  });

  it("follows the active child at forks and reports branch positions", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(4));
    const forked = forkCreationSiblingMessage(base, "legacy-2", legacyMessage("user", "Edited message 2"));
    expect(forked).not.toBeNull();
    const { active, branches } = linearizeCreationMessages(forked!.messages);
    expect(active.map((message) => message.content)).toEqual([
      "Message 0",
      "Message 1",
      "Edited message 2"
    ]);
    expect(branches.get("legacy-2")).toEqual({ index: 1, total: 2, canGoPrevious: false, canGoNext: true });
    expect(branches.get(forked!.id)).toEqual({ index: 2, total: 2, canGoPrevious: true, canGoNext: false });
  });
});

describe("appendCreationMessage", () => {
  it("appends as the child of the active leaf", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(2));
    const { messages, id } = appendCreationMessage(base, legacyMessage("user", "Next"));
    const appended = messages.find((message) => message.id === id);
    expect(appended?.parentId).toBe("legacy-1");
    const { active } = linearizeCreationMessages(messages);
    expect(active.at(-1)?.id).toBe(id);
  });

  it("appends to the active branch after a fork, not the abandoned one", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(3));
    const forked = forkCreationSiblingMessage(base, "legacy-2", legacyMessage("user", "Edited"))!;
    const { messages, id } = appendCreationMessage(forked.messages, legacyMessage("assistant", "Reply"));
    const appended = messages.find((message) => message.id === id);
    expect(appended?.parentId).toBe(forked.id);
  });
});

describe("forkCreationSiblingMessage", () => {
  it("returns null for an unknown message id", () => {
    expect(forkCreationSiblingMessage(legacyTranscript(2), "missing", legacyMessage("user", "x"))).toBeNull();
  });

  it("deactivates prior siblings and activates the fork", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(3));
    const forked = forkCreationSiblingMessage(base, "legacy-2", legacyMessage("user", "Edited"))!;
    const original = forked.messages.find((message) => message.id === "legacy-2");
    const fork = forked.messages.find((message) => message.id === forked.id);
    expect(original?.isActiveChild).toBe(false);
    expect(fork?.isActiveChild).toBe(true);
    expect(fork?.parentId).toBe("legacy-1");
  });
});

describe("switchCreationBranch", () => {
  it("returns null for an unknown message id", () => {
    expect(switchCreationBranch(legacyTranscript(2), "missing", "previous")).toBeNull();
  });

  it("moves between siblings and back", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(3));
    const forked = forkCreationSiblingMessage(base, "legacy-2", legacyMessage("user", "Edited"))!;

    const previous = switchCreationBranch(forked.messages, forked.id, "previous")!;
    expect(linearizeCreationMessages(previous).active.at(-1)?.content).toBe("Message 2");

    const next = switchCreationBranch(previous, "legacy-2", "next")!;
    expect(linearizeCreationMessages(next).active.at(-1)?.content).toBe("Edited");
  });

  it("is a no-op at the edge of the sibling range", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(3));
    const forked = forkCreationSiblingMessage(base, "legacy-2", legacyMessage("user", "Edited"))!;
    const unchanged = switchCreationBranch(forked.messages, forked.id, "next")!;
    expect(linearizeCreationMessages(unchanged).active.at(-1)?.content).toBe("Edited");
  });
});

describe("foldCreationTranscriptTree", () => {
  it("keeps short transcripts untouched", () => {
    const { messages, conversationSummary } = foldCreationTranscriptTree(legacyTranscript(10), undefined);
    expect(messages).toHaveLength(10);
    expect(conversationSummary).toBeUndefined();
  });

  it("folds a linear overflow into the summary exactly like the legacy fold", () => {
    const transcript = legacyTranscript(CREATION_TRANSCRIPT_CAP + 5);
    const { messages, conversationSummary } = foldCreationTranscriptTree(transcript, undefined);
    expect(messages).toHaveLength(CREATION_TRANSCRIPT_CAP);
    expect(messages[0]?.parentId).toBeNull();
    expect(messages[0]?.content).toBe("Message 5");
    expect(conversationSummary).toContain("User: Message 0");
    expect(conversationSummary).toContain("Assistant: Message 3");
    expect(conversationSummary).not.toContain("Message 5");
  });

  it("folds only the shared spine above the earliest fork", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(CREATION_TRANSCRIPT_CAP + 4));
    // Fork near the tail: the active path overflows by 3, so 3 spine
    // messages fold while the fork group itself stays intact.
    const forkAtId = `legacy-${CREATION_TRANSCRIPT_CAP + 2}`;
    const forked = forkCreationSiblingMessage(base, forkAtId, legacyMessage("user", "Edited near tail"))!;
    const { messages, conversationSummary } = foldCreationTranscriptTree(forked.messages, undefined);
    expect(messages.some((message) => message.id === "legacy-2")).toBe(false);
    expect(messages.some((message) => message.id === "legacy-3")).toBe(true);
    expect(messages.find((message) => message.id === "legacy-3")?.parentId).toBeNull();
    expect(messages.some((message) => message.id === forkAtId)).toBe(true);
    expect(messages.some((message) => message.id === forked.id)).toBe(true);
    expect(conversationSummary).toContain("Message 0");
    expect(conversationSummary).toContain("Message 2");
    const { branches } = linearizeCreationMessages(messages);
    expect(branches.get(forkAtId)?.total).toBe(2);
    expect(linearizeCreationMessages(messages).active).toHaveLength(CREATION_TRANSCRIPT_CAP);
  });

  it("accepts overflow when forks reach the root and nothing shared can fold", () => {
    const base = normalizeCreationMessageIds(legacyTranscript(CREATION_TRANSCRIPT_CAP + 2));
    // Fork at the very first message, then switch back to the long original
    // branch so the active path overflows while the fork sits at the root.
    const forked = forkCreationSiblingMessage(base, "legacy-0", legacyMessage("user", "Fresh start"))!;
    const switched = switchCreationBranch(forked.messages, forked.id, "previous")!;
    const { messages, conversationSummary } = foldCreationTranscriptTree(switched, undefined);
    expect(messages).toHaveLength(switched.length);
    expect(conversationSummary).toBeUndefined();
  });

  it("prunes the oldest inactive subtree past the stored cap", () => {
    let tree = normalizeCreationMessageIds(legacyTranscript(CREATION_TRANSCRIPT_CAP));
    // Fork early: the abandoned subtree below legacy-10 is large and inactive.
    const forked = forkCreationSiblingMessage(tree, "legacy-10", legacyMessage("user", "New direction"))!;
    tree = forked.messages;
    // Grow the active branch until the stored tree exceeds the hard cap.
    while (tree.length <= CREATION_STORED_MESSAGE_CAP) {
      tree = appendCreationMessage(tree, legacyMessage("assistant", `Filler ${tree.length}`)).messages;
    }
    const { messages } = foldCreationTranscriptTree(tree, undefined);
    expect(messages.length).toBeLessThanOrEqual(CREATION_STORED_MESSAGE_CAP);
    // The inactive original sibling (and its whole subtree) is gone.
    expect(messages.some((message) => message.id === "legacy-10")).toBe(false);
    expect(messages.some((message) => message.id === "legacy-30")).toBe(false);
    // Pruning collapsed the fork, so the now-linear transcript folds down to
    // the cap and keeps the newest messages.
    expect(linearizeCreationMessages(messages).active.length).toBeLessThanOrEqual(CREATION_TRANSCRIPT_CAP);
    expect(messages.at(-1)?.content).toBe(tree.at(-1)?.content);
  });
});
