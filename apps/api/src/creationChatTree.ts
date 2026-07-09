import { randomUUID } from "node:crypto";
import type { MobileCreationMessage } from "./mobileCreation.js";

export type CreationChatBranchDto = {
  index: number;
  total: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
};

export const CREATION_TRANSCRIPT_CAP = 60;
export const CREATION_SUMMARY_MAX = 2400;
// Hard cap on stored tree nodes; past it, inactive branches are pruned oldest-first.
export const CREATION_STORED_MESSAGE_CAP = 240;

const ROOT_KEY = "__creation_chat_root__";

function parentKey(parentId: string | null | undefined): string {
  return parentId ?? ROOT_KEY;
}

function messageId(message: MobileCreationMessage): string {
  // Normalized messages always carry ids; the fallback keeps lookups total.
  return message.id ?? "";
}

/**
 * Assigns deterministic ids and a linear parent chain to legacy messages that
 * predate branching. Ids are derived from array position ("legacy-<index>") so
 * a client that saw them on a GET can reference them on a later POST, before
 * the first write persists them.
 */
export function normalizeCreationMessageIds(messages: MobileCreationMessage[]): MobileCreationMessage[] {
  let previousId: string | null = null;
  return messages.map((message, index) => {
    const id = message.id ?? `legacy-${index}`;
    const normalized: MobileCreationMessage = {
      ...message,
      id,
      // undefined means "written before branching": chain to the previous message.
      parentId: message.parentId === undefined ? previousId : message.parentId,
      isActiveChild: message.isActiveChild ?? true
    };
    previousId = id;
    return normalized;
  });
}

function childrenByParent(messages: MobileCreationMessage[]): Map<string, MobileCreationMessage[]> {
  const groups = new Map<string, MobileCreationMessage[]>();
  for (const message of messages) {
    const key = parentKey(message.parentId);
    const siblings = groups.get(key) ?? [];
    siblings.push(message);
    groups.set(key, siblings);
  }
  return groups;
}

function selectedCreationChild(siblings: MobileCreationMessage[]): MobileCreationMessage | null {
  if (siblings.length === 0) {
    return null;
  }
  return [...siblings].reverse().find((message) => message.isActiveChild !== false) ?? siblings.at(-1)!;
}

/**
 * Resolves the tree into the currently-selected linear thread plus branch
 * metadata (position among siblings) for every message that sits at a fork.
 * Sibling order is array insertion order, which is stable for a JSON payload.
 */
export function linearizeCreationMessages(messages: MobileCreationMessage[]): {
  active: MobileCreationMessage[];
  branches: Map<string, CreationChatBranchDto>;
} {
  const normalized = normalizeCreationMessageIds(messages);
  const groups = childrenByParent(normalized);
  const branches = new Map<string, CreationChatBranchDto>();

  for (const siblings of groups.values()) {
    if (siblings.length <= 1) {
      continue;
    }
    siblings.forEach((message, index) => {
      branches.set(messageId(message), {
        index: index + 1,
        total: siblings.length,
        canGoPrevious: index > 0,
        canGoNext: index < siblings.length - 1
      });
    });
  }

  const active: MobileCreationMessage[] = [];
  const visited = new Set<string>();
  let next = selectedCreationChild(groups.get(ROOT_KEY) ?? []);
  while (next && !visited.has(messageId(next))) {
    active.push(next);
    visited.add(messageId(next));
    next = selectedCreationChild(groups.get(parentKey(messageId(next))) ?? []);
  }

  return { active, branches };
}

export function activeCreationLeafId(messages: MobileCreationMessage[]): string | null {
  const { active } = linearizeCreationMessages(messages);
  const leaf = active.at(-1);
  return leaf ? messageId(leaf) : null;
}

/** Appends a message as the child of the active leaf and returns the new tree. */
export function appendCreationMessage(
  messages: MobileCreationMessage[],
  message: Omit<MobileCreationMessage, "id" | "parentId" | "isActiveChild">
): { messages: MobileCreationMessage[]; id: string } {
  const normalized = normalizeCreationMessageIds(messages);
  const id = randomUUID();
  const appended: MobileCreationMessage = {
    ...message,
    id,
    parentId: activeCreationLeafId(normalized),
    isActiveChild: true
  };
  return { messages: [...normalized, appended], id };
}

/**
 * Creates a sibling of the edited message (a new branch off the same parent)
 * and makes it the active branch. Returns null when the id is unknown.
 */
export function forkCreationSiblingMessage(
  messages: MobileCreationMessage[],
  editMessageId: string,
  message: Omit<MobileCreationMessage, "id" | "parentId" | "isActiveChild">
): { messages: MobileCreationMessage[]; id: string } | null {
  const normalized = normalizeCreationMessageIds(messages);
  const edited = normalized.find((candidate) => messageId(candidate) === editMessageId);
  if (!edited) {
    return null;
  }
  const id = randomUUID();
  const editedParentKey = parentKey(edited.parentId);
  const deactivated = normalized.map((candidate) =>
    parentKey(candidate.parentId) === editedParentKey ? { ...candidate, isActiveChild: false } : candidate
  );
  const forked: MobileCreationMessage = {
    ...message,
    id,
    parentId: edited.parentId ?? null,
    isActiveChild: true
  };
  return { messages: [...deactivated, forked], id };
}

/**
 * Moves the active-branch selection to the previous/next sibling of the given
 * message. Returns null when the id is unknown; returns the tree unchanged
 * when there is no sibling in that direction.
 */
export function switchCreationBranch(
  messages: MobileCreationMessage[],
  targetMessageId: string,
  direction: "previous" | "next"
): MobileCreationMessage[] | null {
  const normalized = normalizeCreationMessageIds(messages);
  const current = normalized.find((candidate) => messageId(candidate) === targetMessageId);
  if (!current) {
    return null;
  }
  const currentParentKey = parentKey(current.parentId);
  const siblings = normalized.filter((candidate) => parentKey(candidate.parentId) === currentParentKey);
  const currentIndex = siblings.findIndex((candidate) => messageId(candidate) === targetMessageId);
  const target = siblings[direction === "previous" ? currentIndex - 1 : currentIndex + 1];
  if (!target) {
    return normalized;
  }
  const selectedId = messageId(target);
  return normalized.map((candidate) =>
    parentKey(candidate.parentId) === currentParentKey
      ? { ...candidate, isActiveChild: messageId(candidate) === selectedId }
      : candidate
  );
}

function subtreeIds(messages: MobileCreationMessage[], rootId: string): Set<string> {
  const groups = childrenByParent(messages);
  const ids = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const child of groups.get(parentKey(currentId)) ?? []) {
      const childId = messageId(child);
      if (!ids.has(childId)) {
        ids.add(childId);
        queue.push(childId);
      }
    }
  }
  return ids;
}

function foldedSummary(
  dropped: MobileCreationMessage[],
  existingSummary: string | undefined
): string | undefined {
  if (dropped.length === 0) {
    return existingSummary?.trim() || undefined;
  }
  const droppedLines = dropped
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.replace(/\s+/g, " ").slice(0, 160)}`)
    .join("\n");
  const combined = [existingSummary?.trim(), droppedLines].filter(Boolean).join("\n");
  // Keep the newest folded content when the summary itself overflows.
  const trimmed = combined.length > CREATION_SUMMARY_MAX ? combined.slice(-CREATION_SUMMARY_MAX) : combined;
  return trimmed || undefined;
}

/**
 * The foldable "spine": the chain of messages from the unique root that every
 * leaf descends from — single-child links plus the first fork node itself.
 * Folding a fork node re-roots its children as a root-level sibling group,
 * which linearization already handles.
 */
function foldableSpine(messages: MobileCreationMessage[]): MobileCreationMessage[] {
  const groups = childrenByParent(messages);
  const roots = groups.get(ROOT_KEY) ?? [];
  if (roots.length !== 1) {
    return [];
  }
  const spine: MobileCreationMessage[] = [];
  let current: MobileCreationMessage | undefined = roots[0];
  while (current) {
    spine.push(current);
    const children = groups.get(parentKey(messageId(current))) ?? [];
    current = children.length === 1 ? children[0] : undefined;
  }
  return spine;
}

/**
 * Tree-aware version of the transcript fold: keeps long chats bounded without
 * destroying branch structure. Only the shared spine above the earliest fork
 * may fold into the rolling summary; with no forks this behaves exactly like
 * the old linear fold. When the stored tree outgrows the hard cap, whole
 * inactive sibling subtrees are pruned oldest-first.
 */
export function foldCreationTranscriptTree(
  messages: MobileCreationMessage[],
  existingSummary: string | undefined
): { messages: MobileCreationMessage[]; conversationSummary: string | undefined } {
  let tree = normalizeCreationMessageIds(messages);

  // Prune inactive subtrees while the stored tree exceeds the hard cap.
  while (tree.length > CREATION_STORED_MESSAGE_CAP) {
    const { active } = linearizeCreationMessages(tree);
    const activeIds = new Set(active.map((message) => messageId(message)));
    const groups = childrenByParent(tree);
    const pruneRoot = tree.find((candidate) => {
      const siblings = groups.get(parentKey(candidate.parentId)) ?? [];
      return siblings.length > 1 && !activeIds.has(messageId(candidate));
    });
    if (!pruneRoot) {
      break;
    }
    const removed = subtreeIds(tree, messageId(pruneRoot));
    tree = tree.filter((candidate) => !removed.has(messageId(candidate)));
  }

  const { active } = linearizeCreationMessages(tree);
  const excess = active.length - CREATION_TRANSCRIPT_CAP;
  if (excess <= 0) {
    return { messages: tree, conversationSummary: existingSummary?.trim() || undefined };
  }

  const dropped = foldableSpine(tree).slice(0, excess);
  if (dropped.length === 0) {
    // Forks reach the root, so nothing shared can fold; accept the overflow.
    return { messages: tree, conversationSummary: existingSummary?.trim() || undefined };
  }
  const droppedIds = new Set(dropped.map((message) => messageId(message)));
  const newRootParentId = messageId(dropped.at(-1)!);
  const kept = tree
    .filter((candidate) => !droppedIds.has(messageId(candidate)))
    .map((candidate) =>
      parentKey(candidate.parentId) === parentKey(newRootParentId) ? { ...candidate, parentId: null } : candidate
    );
  return { messages: kept, conversationSummary: foldedSummary(dropped, existingSummary) };
}
