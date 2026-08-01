import {
  type BookEditChapterContext,
  type BookEditIntent,
  type BookEditPageContext,
  type BookEditProjectStage
} from "../bookEditIntent.js";
import {
  type MobileBookEditOperationDto,
  type MobileBookEditOperationRecord,
  type MobileJsonValue,
  type MobileProjectChatBranchDto,
  type MobileProjectChatMessageDto,
  type MobileProjectChatMessageRecord,
  type MobileProjectChatMessageResponseDto,
  type MobileProjectChatResponseDto
} from "./dto.js";
import { UNDOABLE_EDIT_KINDS } from "./manualEdits.js";
import { currentActionForEditOperation, normalizeJobStatus, serializePlan } from "./projectSerializers.js";
import { clipText, jsonInputValue, jsonRecord, jsonValue } from "./support.js";
import { prisma } from "@book-maker/db";
import { InsufficientCreditsError } from "@book-maker/db/billing";

/**
 * Post-generation chat storage: the message tree, branch selection, and
 * serialization of messages and edit operations.
 */

export async function loadProjectChatResponse(
  projectId: string,
  pagination: { beforeMessageId?: string | undefined; limit?: number | undefined } = {}
): Promise<MobileProjectChatResponseDto> {
  const [messages, planVersions, operations] = await Promise.all([
    prisma.projectChatMessage.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 5000
    }),
    prisma.planVersion.findMany({
      where: { projectId },
      orderBy: { version: "asc" },
      take: 50
    }),
    prisma.bookEditOperation.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
      // The snapshot count is what tells the app an edit can be reviewed; the
      // rows themselves are only read when the user opens the diff.
      include: {
        generationJob: { select: { id: true, status: true } },
        ledgerEntry: { select: { status: true, reversedByEntry: { select: { id: true } } } },
        _count: { select: { snapshots: true } }
      }
    })
  ]);
  const activeChat = linearizeProjectChatMessages(messages.reverse());
  const limit = Math.min(150, Math.max(1, pagination.limit ?? 150));
  const beforeIndex = pagination.beforeMessageId
    ? activeChat.messages.findIndex((message) => message.id === pagination.beforeMessageId)
    : activeChat.messages.length;
  const windowEnd = beforeIndex >= 0 ? beforeIndex : activeChat.messages.length;
  const windowStart = Math.max(0, windowEnd - limit);
  const exposedMessages = activeChat.messages.slice(windowStart, windowEnd);
  const hasMore = windowStart > 0;
  const activeMessageIds = new Set(activeChat.messages.map((message) => message.id));
  const exposedOperations = operations
    .filter((operation) => shouldExposeChatOperation(operation, planVersions))
    .filter((operation) => shouldExposeChatOperationForBranch(operation, activeMessageIds));
  const latestUndoableId = exposedOperations.find((operation) => operationCanUndo(operation))?.id ?? null;
  return {
    messages: exposedMessages.map((message) => serializeProjectChatMessage(message, activeChat.branches.get(message.id) ?? null)),
    plans: planVersions.map((planVersion) => serializePlan(planVersion)),
    operations: exposedOperations.map((operation) =>
      serializeBookEditOperation(operation, { canUndo: operation.id === latestUndoableId })
    ),
    hasMore,
    nextCursor: hasMore ? exposedMessages[0]?.id ?? null : null
  };
}

export async function loadActiveProjectChatMessages(projectId: string): Promise<MobileProjectChatMessageRecord[]> {
  const messages = await prisma.projectChatMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 5000
  });
  return linearizeProjectChatMessages(messages.reverse()).messages;
}

export function shouldExposeChatOperationForBranch(
  operation: MobileBookEditOperationRecord,
  activeMessageIds: Set<string>
): boolean {
  if (activeMessageIds.size === 0) {
    return true;
  }
  const userMessageId = operation.userMessageId ?? null;
  const assistantMessageId = operation.assistantMessageId ?? null;
  if (!userMessageId && !assistantMessageId) {
    return true;
  }
  return Boolean(
    (userMessageId && activeMessageIds.has(userMessageId)) ||
      (assistantMessageId && activeMessageIds.has(assistantMessageId))
  );
}

export function activeProjectChatLeafId(messages: MobileProjectChatMessageRecord[]): string | null {
  return messages.at(-1)?.id ?? null;
}

export function linearizeProjectChatMessages(messages: MobileProjectChatMessageRecord[]): {
  messages: MobileProjectChatMessageRecord[];
  branches: Map<string, MobileProjectChatBranchDto>;
} {
  const sorted = normalizeLegacyProjectChatParents([...messages].sort(compareProjectChatMessages));
  const childrenByParent = new Map<string, MobileProjectChatMessageRecord[]>();
  const branches = new Map<string, MobileProjectChatBranchDto>();

  for (const message of sorted) {
    const key = projectChatParentKey(message.parentId ?? null);
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(message);
    childrenByParent.set(key, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareProjectChatMessages);
    if (siblings.length <= 1) {
      continue;
    }
    siblings.forEach((message, index) => {
      branches.set(message.id, {
        index: index + 1,
        total: siblings.length,
        canGoPrevious: index > 0,
        canGoNext: index < siblings.length - 1
      });
    });
  }

  const linearized: MobileProjectChatMessageRecord[] = [];
  const visited = new Set<string>();
  let next = selectedProjectChatChild(childrenByParent.get(projectChatParentKey(null)) ?? []);
  while (next && !visited.has(next.id)) {
    linearized.push(next);
    visited.add(next.id);
    next = selectedProjectChatChild(childrenByParent.get(projectChatParentKey(next.id)) ?? []);
  }

  return { messages: linearized, branches };
}

export function normalizeLegacyProjectChatParents(
  messages: MobileProjectChatMessageRecord[]
): MobileProjectChatMessageRecord[] {
  if (messages.length <= 1 || messages.some((message) => message.parentId != null)) {
    return messages;
  }
  return messages.map((message, index) =>
    index === 0
      ? { ...message, parentId: null }
      : { ...message, parentId: messages[index - 1]!.id, isActiveChild: message.isActiveChild ?? true }
  );
}

export function selectedProjectChatChild(siblings: MobileProjectChatMessageRecord[]): MobileProjectChatMessageRecord | null {
  if (siblings.length === 0) {
    return null;
  }
  return [...siblings].reverse().find((message) => message.isActiveChild !== false) ?? siblings.at(-1)!;
}

export function compareProjectChatMessages(a: MobileProjectChatMessageRecord, b: MobileProjectChatMessageRecord): number {
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return a.id.localeCompare(b.id);
}

export function projectChatParentKey(parentId: string | null): string {
  return parentId ?? "__project_chat_root__";
}

export async function createUserProjectChatMessage(options: {
  projectId: string;
  parentId: string | null;
  content: string;
  requestId?: string | undefined;
  metadata: Record<string, unknown>;
  selectSibling?: boolean;
}): Promise<MobileProjectChatMessageRecord> {
  const data = {
    projectId: options.projectId,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    parentId: options.parentId,
    role: "USER" as const,
    content: options.content,
    metadata: jsonInputValue(options.metadata),
    isActiveChild: true
  };
  if (!options.selectSibling) {
    return prisma.projectChatMessage.create({ data });
  }
  return prisma.$transaction(async (tx) => {
    await tx.projectChatMessage.updateMany({
      where: projectChatSiblingWhere(options.projectId, options.parentId),
      data: { isActiveChild: false }
    });
    return tx.projectChatMessage.create({ data });
  });
}

export async function replayProjectChatRequest(
  projectId: string,
  requestId: string
): Promise<MobileProjectChatMessageResponseDto | null> {
  const userMessage = (await prisma.projectChatMessage.findUnique({
    where: { projectId_requestId: { projectId, requestId } }
  })) as MobileProjectChatMessageRecord | null;
  if (!userMessage) {
    return null;
  }
  const [assistantMessage, operation] = await Promise.all([
    prisma.projectChatMessage.findFirst({
      where: { projectId, parentId: userMessage.id, role: "ASSISTANT", isActiveChild: true },
      orderBy: { createdAt: "desc" }
    }) as Promise<MobileProjectChatMessageRecord | null>,
    prisma.bookEditOperation.findFirst({
      where: { projectId, userMessageId: userMessage.id },
      orderBy: { createdAt: "desc" },
      include: { generationJob: { select: { id: true, status: true } } }
    }) as Promise<MobileBookEditOperationRecord | null>
  ]);
  if (!assistantMessage) {
    return null;
  }
  return {
    ...(await loadProjectChatResponse(projectId)),
    reply: serializeProjectChatMessage(assistantMessage),
    operation: operation ? serializeBookEditOperation(operation) : null
  };
}

export async function switchProjectChatBranch(options: {
  projectId: string;
  messageId: string;
  direction: "previous" | "next";
}): Promise<boolean> {
  const messages = await prisma.projectChatMessage.findMany({
    where: { projectId: options.projectId },
    orderBy: { createdAt: "desc" },
    take: 5000
  });
  messages.reverse();
  const current = messages.find((message) => message.id === options.messageId);
  if (!current) {
    return false;
  }
  const parentId = current.parentId ?? null;
  const siblings = messages
    .filter((message) => (message.parentId ?? null) === parentId)
    .sort(compareProjectChatMessages);
  if (siblings.length <= 1) {
    return true;
  }
  const currentIndex = siblings.findIndex((message) => message.id === current.id);
  const targetIndex = options.direction === "previous" ? currentIndex - 1 : currentIndex + 1;
  const target = siblings[targetIndex];
  if (!target) {
    return true;
  }
  await selectProjectChatSibling(options.projectId, parentId, target.id);
  return true;
}

export async function selectProjectChatSibling(projectId: string, parentId: string | null, messageId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.projectChatMessage.updateMany({
      where: projectChatSiblingWhere(projectId, parentId),
      data: { isActiveChild: false }
    });
    await tx.projectChatMessage.updateMany({
      where: { projectId, id: messageId },
      data: { isActiveChild: true }
    });
  });
}

export function projectChatSiblingWhere(projectId: string, parentId: string | null): { projectId: string; parentId: string | null } {
  return { projectId, parentId };
}

export function shouldExposeChatOperation(
  operation: MobileBookEditOperationRecord,
  planVersions: Array<{ createdAt: Date }>
): boolean {
  if (operation.kind !== "PLAN_REVISION" || operation.status !== "FAILED") {
    return true;
  }
  return !planVersions.some((planVersion) => planVersion.createdAt > operation.createdAt);
}

export async function createAssistantChatMessage(options: {
  projectId: string;
  parentId: string;
  content: string;
  metadata: Record<string, unknown>;
  operationId?: string | undefined;
}): Promise<MobileProjectChatMessageRecord> {
  return prisma.projectChatMessage.create({
    data: {
      projectId: options.projectId,
      parentId: options.parentId,
      role: "ASSISTANT",
      content: options.content,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      metadata: jsonInputValue(options.metadata)
    }
  });
}

export async function insufficientCreditsChatMessage(
  projectId: string,
  parentId: string,
  intent: BookEditIntent,
  error: InsufficientCreditsError
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId,
    content: `You need ${error.requiredCredits} credits for that edit, but you have ${error.availableCredits}. Add credits, then send the edit again.`,
    metadata: {
      intent,
      charged: false,
      insufficientCredits: {
        requiredCredits: error.requiredCredits,
        availableCredits: error.availableCredits,
        reservedCredits: error.reservedCredits
      }
    }
  });
}

/**
 * Assistant replies used to announce the price in prose ("This uses 800
 * credits."). The app now shows that number as a tappable badge sourced from
 * `metadata.creditsCharged` / `metadata.editProposal.credits`, so the sentence
 * is dropped on the way out — otherwise every message stored before the change
 * would state the price twice. Stored content is left intact: the intent
 * classifier reads the records, not this DTO.
 */
const CREDIT_ANNOUNCEMENT = /\s*(?:this|it)\s+(?:uses|would\s+use)\s+[\d,]+\s+credits\./gi;

export function stripCreditAnnouncement(content: string): string {
  const stripped = content.replace(CREDIT_ANNOUNCEMENT, "");
  return stripped === content ? content : stripped.replace(/[ \t]{2,}/g, " ").trim();
}

export function serializeProjectChatMessage(
  message: MobileProjectChatMessageRecord,
  branch: MobileProjectChatBranchDto | null = null
): MobileProjectChatMessageDto {
  return {
    id: message.id,
    projectId: message.projectId,
    parentId: message.parentId ?? null,
    role: message.role.toLowerCase() as MobileProjectChatMessageDto["role"],
    content: message.role === "ASSISTANT" ? stripCreditAnnouncement(message.content) : message.content,
    operationId: message.operationId,
    metadata: sanitizePublicChatMetadata(jsonValue(message.metadata)),
    branch,
    createdAt: message.createdAt.toISOString()
  };
}

export function sanitizePublicChatMetadata(value: MobileJsonValue): MobileJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicChatMetadata(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const safe: Record<string, MobileJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      ["reasoning", "confidence", "assistantMessage", "provider", "model", "chainOfThought", "rawResponse"].includes(key)
    ) {
      continue;
    }
    safe[key] = sanitizePublicChatMetadata(item);
  }
  return safe;
}

export function serializeBookEditOperation(
  operation: MobileBookEditOperationRecord,
  options?: { canUndo?: boolean }
): MobileBookEditOperationDto {
  const retryLimit = operation.automaticRetryLimit ?? 0;
  const retryCount = operation.automaticRetryCount ?? 0;
  const retryBudgetAvailable = retryCount < retryLimit;
  const retryScheduled = operation.status === "FAILED" && retryBudgetAvailable && Boolean(operation.nextRetryAt);
  const retryAvailable = operation.kind === "PLAN_REVISION" && operation.status === "FAILED" && retryBudgetAvailable;
  const retryState = retryScheduled
    ? "scheduled"
    : retryAvailable
      ? "available"
      : operation.kind === "PLAN_REVISION" && operation.status === "FAILED"
        ? "exhausted"
        : null;
  const retryMessage = retryScheduled
    ? "Retrying this plan revision automatically."
    : retryAvailable
      ? "This plan revision can be retried at no additional charge."
      : retryState === "exhausted"
        ? "This plan revision could not be recovered automatically."
        : null;
  return {
    id: operation.id,
    projectId: operation.projectId,
    kind: operation.kind.toLowerCase() as MobileBookEditOperationDto["kind"],
    status: operation.status.toLowerCase() as MobileBookEditOperationDto["status"],
    affectedPageIndexes: operation.affectedPageIndexes,
    creditsCharged: operation.creditsCharged,
    currentAction: currentActionForEditOperation(operation),
    error: operation.error ?? null,
    job: operation.generationJob
      ? {
          id: operation.generationJob.id,
          status: normalizeJobStatus(operation.generationJob.status),
          currentAction: currentActionForEditOperation(operation)
        }
      : null,
    retryAvailable,
    nextRetryAt: operation.nextRetryAt?.toISOString() ?? null,
    retryState,
    retryMessage,
    submittedText: typeof operation.request === "string" ? operation.request : null,
    requestId: operation.requestId ?? null,
    createdAt: operation.createdAt.toISOString(),
    appliedAt: operation.appliedAt?.toISOString() ?? null,
    anchorMessageId: operation.assistantMessageId ?? operation.userMessageId ?? null,
    canUndo: options?.canUndo ?? false,
    changesAvailable: (operation._count?.snapshots ?? 0) > 0,
    creditsRefunded: operationCreditsRefunded(operation)
  };
}

/**
 * Whether the credits this operation reserved ended up back in the balance.
 *
 * Two shapes, because a refund depends on how far the spend got: an entry still
 * reserved is released in place and left `REFUNDED`, while a settled one keeps
 * its row and gains a separate reversing entry.
 */
export function operationCreditsRefunded(operation: MobileBookEditOperationRecord): boolean {
  const ledgerEntry = operation.ledgerEntry;
  if (!ledgerEntry) {
    return false;
  }
  return ledgerEntry.status === "REFUNDED" || Boolean(ledgerEntry.reversedByEntry);
}

export function operationCanUndo(operation: MobileBookEditOperationRecord): boolean {
  if (operation.status !== "APPLIED") {
    return false;
  }
  if (!(UNDOABLE_EDIT_KINDS as readonly string[]).includes(operation.kind)) {
    return false;
  }
  return jsonRecord(operation.classifier).undoneAt === undefined;
}

export async function loadProjectForChat(userId: string, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, userId },
    include: {
      currentPlan: true,
      chapters: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, title: true, summary: true }
      },
      pages: {
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          title: true,
          summary: true,
          status: true,
          chapter: { select: { index: true } }
        }
      },
      research: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { title: true, url: true, summary: true }
      }
    }
  });
}

/**
 * Page markdown is deliberately excluded from loadProjectForChat (a 600-page
 * book would load megabytes per chat message); the few flows that need prose
 * fetch just their target pages here.
 */
export async function loadChatPageBodies(projectId: string, indexes: number[]): Promise<Map<number, string>> {
  if (indexes.length === 0) {
    return new Map();
  }
  const rows = await prisma.page.findMany({
    where: { projectId, index: { in: indexes } },
    select: { index: true, markdown: true }
  });
  return new Map(rows.map((row) => [row.index, row.markdown]));
}

export function chatChaptersForProject(project: ProjectForChat): BookEditChapterContext[] {
  return project.chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    pageIndexes: project.pages
      .filter((page) => page.chapter?.index === chapter.index)
      .map((page) => page.index)
      .sort((a, b) => a - b)
  }));
}

export type ProjectForChat = NonNullable<Awaited<ReturnType<typeof loadProjectForChat>>>;

export function chatPagesForProject(project: ProjectForChat): BookEditPageContext[] {
  return project.pages.map((page) => ({
    id: page.id,
    index: page.index,
    title: page.title,
    summary: page.summary,
    // Summary-based on purpose: page markdown is no longer loaded per chat
    // message. Quoted-text targeting matches against the DB instead
    // (pagesMatchingNeedle), so this preview only feeds display/heuristics.
    previewText: clipText(page.summary, 900)
  }));
}

export function chatStageForProject(status: string, currentPlan: ProjectForChat["currentPlan"]): BookEditProjectStage {
  if (status === "COMPLETE" || status === "REVIEW_REQUIRED") {
    return "complete";
  }
  if (currentPlan?.status === "APPROVED") {
    return "approved_plan";
  }
  if (currentPlan || status === "PLAN_READY") {
    return "plan_ready";
  }
  return "other";
}
