import { randomUUID } from "node:crypto";
import {
  coverRetypesetSource,
  creditPricing,
  isAuthorManuscript,
  jsonRecord,
  storyPageDesignFor,
  storyPageDesignPreference
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import { type BookEditIntent } from "../bookEditIntent.js";
import { bookTitleReply, type BookTitleNotice } from "./bookTitleChatCopy.js";
import { matterChatLanguage, type MatterChatLanguage } from "./bookMatterChatLanguage.js";
import { bookUpdateMetadata } from "./bookUpdateMetadata.js";
import { commitCoverChange, dispatchCoverJobs, ManuscriptCoverRefusal, type CommittedCoverChange } from "./coverChange.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { type PendingEditState } from "./pendingEditState.js";
import { createAssistantChatMessage, type ProjectForChat } from "./projectChat.js";
import { fingerprintGenerationRequest, jsonInputValue } from "./support.js";

/**
 * Applies a `book_title` intent: what the book is called, everywhere a reader
 * sees it — the app, the cover, the title page, the file names and the EPUB
 * and Word metadata.
 *
 * No page holds the title, so no page is rewritten, and the book changes the
 * way a presentation edit does: one transaction writes the project row and the
 * current plan (`commitCoverChange`, which both the compile and the cover read),
 * bumps the revision and queues the reprint.
 *
 * **What it costs is decided by the cover**, because the cover is the one place
 * the title is pixels. A designed cover is typeset over a bundled picture, so
 * it is set again with the new title for free, in the design it already wears
 * (a revision-owned cover row keeps it); so is a drawn cover that kept its
 * artwork (`ai-kept`), over the same picture. A book with no cover, or with a
 * picture the author uploaded, has nothing to redraw. An AI cover's artwork is
 * stored only with the old title on it, so the title changes with a redraw at
 * the cover price — a card the reader confirms, charged and settled like the
 * Writing Studio's "Generate with AI" (`coverSettlement.ts`), and claimed by a
 * `BOOK_TITLE` operation row so a Cancel and an Apply cannot both win.
 *
 * An author's book takes its title from the Writing Studio, whose publish
 * re-typesets the cover with it; changing it here would leave the Studio's
 * published record behind.
 *
 * Every reply is in the conversation language (`matterChatLanguage`) and
 * records it as `replyLanguage`, like the matter and busy replies around it.
 */
export async function applyBookTitleEdit(options: {
  userId: string;
  project: ProjectForChat;
  intent: BookEditIntent;
  userMessageId: string;
  message: string;
  executeProposal?: boolean | undefined;
  executionCommandId?: string | undefined;
  quotedCredits?: number | undefined;
  /** `bookEditIntents.ts`'s card writer, handed in so the two modules do not import each other. */
  pendingEditMetadata: (state: PendingEditState) => Record<string, unknown>;
  /** Prior assistant language decisions, used if this turn has no valid one. */
  activeMessages?: readonly { role: string; metadata?: unknown }[] | undefined;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const { project, intent, userMessageId } = options;
  const title = intent.bookTitle?.trim() ?? "";
  const replyLanguage = matterChatLanguage(intent.responseLanguage, options.activeMessages);
  const say = (notice: BookTitleNotice) => bookTitleReply(replyLanguage, notice, title);
  const reply = async (content: string, metadata: Record<string, unknown> = {}) => ({
    reply: await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      content,
      metadata: { intent, charged: false, replyLanguage, ...metadata }
    }),
    operation: null
  });

  if (!title) {
    return reply(say("ask"));
  }
  if (isAuthorManuscript(project.mediaSettings)) {
    return reply(say("studio"));
  }
  if (!project.currentPlanId || !["COMPLETE", "REVIEW_REQUIRED"].includes(project.status)) {
    return reply(say("notFinished"));
  }
  if (title === project.title?.trim()) {
    return reply(say("already"));
  }

  const cover = await currentCoverKind(project.id);
  // A children's book picks its page design from its own words, the title
  // among them, when the reader never chose one; a new title could hand it a
  // different look, so the one it wears is kept.
  const mediaSettingsPatch = pinnedStoryPageDesign(project);

  if (cover !== "ai") {
    const committed = await commit(project.id, {
      title,
      ...(mediaSettingsPatch ? { mediaSettingsPatch } : {}),
      // Keep the design source in the plan too, and use the retypeset handler
      // so changing its words never draws character references or new artwork.
      ...(cover === "design" ? { coverArtSource: "design" as const, drawCover: { purchase: false, retypeset: true } } : {}),
      // A drawn cover that kept its artwork is set again over the same picture.
      ...(cover === "ai-kept" ? { drawCover: { purchase: false, retypeset: true } } : {})
    });
    if (committed instanceof ManuscriptCoverRefusal) {
      return reply(say(chatRefusal(committed)));
    }
    await dispatchCoverJobs(project.id, committed);
    const rest: BookTitleNotice =
      cover === "design" || cover === "ai-kept" ? "retypeset" : cover === "upload" ? "uploaded" : "refreshing";
    return reply(`${say("done")} ${say(rest)} ${say("free")}`, { bookTitle: title, ...bookUpdateMetadata(committed.contentRevision) });
  }

  const cost = creditPricing().coverRegeneration;
  if (!options.executeProposal || options.quotedCredits === undefined || cost > options.quotedCredits) {
    return proposeAiCoverTitle({ ...options, title, cost, replyLanguage });
  }

  const commandId = options.executionCommandId ?? randomUUID();
  const holder: { committed?: CommittedCoverChange; operationId?: string } = {};
  try {
    const started = await startGenerationAttempt({
      userId: options.userId,
      commandKey: `mobile:book-title:${project.id}:${commandId}`,
      requestFingerprint: fingerprintGenerationRequest({ projectId: project.id, title, cover: "ai", cost }),
      projectId: project.id,
      operation: "COVER_REGENERATION",
      quotedCredits: cost,
      description: "Cover redrawn with a new title",
      metadata: { projectId: project.id, coverArtSource: "ai", bookTitle: title },
      create: async (tx, { attemptId, ledgerEntry }) => {
        // The claim: Cancel writes the same `[projectId, requestId]` row, so
        // whichever lands first owns the proposal.
        const operation = await tx.bookEditOperation.create({
          data: {
            projectId: project.id,
            requestId: commandId,
            userMessageId,
            kind: "BOOK_TITLE",
            status: "APPLIED",
            request: options.message,
            editInstruction: `Retitle the book “${title}” and redraw its cover with the new title.`,
            classifier: jsonInputValue({ ...intent, bookTitle: title }),
            affectedPageIndexes: [],
            creditsCharged: cost,
            appliedAt: new Date(),
            ...(ledgerEntry?.id ? { ledgerEntryId: ledgerEntry.id } : {})
          },
          select: { id: true }
        });
        holder.operationId = operation.id;
        const committed = await commitCoverChange(tx, project.id, {
          title,
          ...(mediaSettingsPatch ? { mediaSettingsPatch } : {}),
          drawCover: { attemptId, ledgerEntryId: ledgerEntry?.id ?? null, purchase: true }
        });
        holder.committed = committed;
        return { projectId: project.id, primaryJobId: committed.primaryJobId };
      }
    });
    if (started.replayed || !holder.committed) {
      return reply(say("underWay"));
    }
  } catch (error) {
    if (error instanceof ManuscriptCoverRefusal) {
      return reply(say(chatRefusal(error)));
    }
    throw error;
  }
  await dispatchCoverJobs(project.id, holder.committed);
  return {
    reply: await createAssistantChatMessage({
      projectId: project.id,
      parentId: userMessageId,
      ...(holder.operationId ? { operationId: holder.operationId } : {}),
      content: `${say("done")} ${say("redrawing")}`,
      metadata: { intent, charged: true, creditsCharged: cost, bookTitle: title, replyLanguage }
    }),
    operation: null
  };
}

/** The card for a title change whose AI cover has to be drawn again. */
async function proposeAiCoverTitle(options: {
  pendingEditMetadata: (state: PendingEditState) => Record<string, unknown>;
  project: ProjectForChat;
  intent: BookEditIntent;
  userMessageId: string;
  message: string;
  title: string;
  cost: number;
  replyLanguage: MatterChatLanguage;
}): Promise<{ reply: MobileProjectChatMessageRecord; operation: null }> {
  const { project, title, cost, replyLanguage } = options;
  const proposalId = randomUUID();
  const proposalIntent: BookEditIntent = { ...options.intent, bookTitle: title, clarification: "none" };
  // The card's own summary stays English like every other card's, because the
  // app draws it beside English buttons; the bubble speaks the conversation.
  const summary = `Retitle the book “${title}” and draw a new AI cover with it`;
  return {
    reply: await createAssistantChatMessage({
      projectId: project.id,
      parentId: options.userMessageId,
      content: bookTitleReply(replyLanguage, "proposal", title),
      metadata: {
        intent: proposalIntent,
        charged: false,
        replyLanguage,
        pendingEdit: options.pendingEditMetadata({
          request: options.message,
          scope: "none",
          clarification: "confirm",
          intent: proposalIntent,
          affectedPageIndexes: [],
          credits: cost,
          proposalId
        }),
        editProposal: {
          id: proposalId,
          kind: "book_title",
          scope: "none",
          affectedPageIndexes: [],
          credits: cost,
          summary
        }
      }
    }),
    operation: null
  };
}

/** Commits a free change, answering a refusal rather than throwing it. */
async function commit(
  projectId: string,
  change: Parameters<typeof commitCoverChange>[2]
): Promise<CommittedCoverChange | ManuscriptCoverRefusal> {
  try {
    return await prisma.$transaction((tx) => commitCoverChange(tx, projectId, change));
  } catch (error) {
    if (error instanceof ManuscriptCoverRefusal) {
      return error;
    }
    throw error;
  }
}

/** The shared transaction speaks to the Studio; the chat says the same thing about a title. */
function chatRefusal(refusal: ManuscriptCoverRefusal): BookTitleNotice {
  return refusal.code === "PROJECT_BUSY" ? "busy" : "notUpdated";
}

/**
 * What the book's cover is, read off the row that holds it.
 *
 * `ai` is anything a model drew, including a cover from before the source was
 * recorded: a row that names neither a design nor an upload was drawn by an
 * image model, and treating it as a design would re-typeset a fresh pick over
 * the reader's picture.
 */
/**
 * What changing the words on a book's cover costs, read off its row. `ai-kept`
 * is a drawn cover whose artwork was kept beside it (`coverTypeset.ts` in
 * core): its words are re-set over the same picture for free, like a design's.
 * `ai` is a drawn cover from before artwork was kept, whose words are pixels.
 */
export type CoverKind = "none" | "design" | "upload" | "ai" | "ai-kept";

export async function currentCoverKind(projectId: string, client: Pick<typeof prisma, "imageAsset"> = prisma): Promise<CoverKind> {
  const asset = await client.imageAsset.findFirst({
    where: { projectId, type: "COVER" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true }
  });
  return coverKindFromMetadata(asset ? asset.metadata : undefined);
}

export function coverKindFromMetadata(metadata: unknown): CoverKind {
  if (metadata === undefined) {
    return "none";
  }
  const record = jsonRecord(metadata);
  if (record.source === "upload") return "upload";
  if (record.coverArtSource === "design" || typeof record.coverDesignId === "string") return "design";
  return coverRetypesetSource(record) === "artwork" ? "ai-kept" : "ai";
}

/** The design a children's book wears now, written down when nothing else holds it. */
function pinnedStoryPageDesign(project: ProjectForChat): Record<string, unknown> | undefined {
  if (storyPageDesignPreference(project.mediaSettings)) {
    return undefined;
  }
  const plan = jsonRecord(project.currentPlan?.planningPackage);
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const current = storyPageDesignFor({
    mediaSettings: project.mediaSettings,
    category: project.category,
    prompt: project.prompt,
    plan: { title: text(plan.title), subtitle: text(plan.subtitle), premise: text(plan.premise), audience: text(plan.audience) }
  });
  return current ? { storyPageDesign: current } : undefined;
}
