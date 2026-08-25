import {
  adviseMobileBook,
  authorForMobilePayload,
  briefForMobilePayload,
  composeMobileProjectPrompt,
  mergeMobileCreationPresets,
  mobileBookAdvisorResponseSchema,
  mobileCreationDraftPayloadSchema,
  titleForMobilePayload,
  type MobileBookAdvisorResponse,
  type MobileCreationDraftPayload,
} from "../mobileCreation.js";
import { BUILD_CHARACTER_SNAPSHOT_LIMIT } from "../mobileCreationSchemas.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  _chatTitleForPayload,
  conversationMessagesFromPayload,
  createCreationOutputForProject,
  creationOutputsForDraft,
  mobileCreationDraftOutputsInclude,
  serializeCreationOutput,
  updateCreationDraftCas
} from "./creationSessions.js";
import {
  type FinalizeOutcome,
  type MobileCreationBuildOverrides,
  type MobileCreationFinalizeResponseDto,
  type MobileCreationOutputRecord,
  type MobilePageCountRecommendationDto,
  type MobilePlanOperationDto,
  type MobileProjectRecord
} from "./dto.js";
import { sendInsufficientCredits, sendMobileError } from "./httpErrors.js";
import {
  buildMobileCreateProjectInput,
  createMobileProjectRecord,
  deterministicPageCountRecommendations,
  loadMobileProjectDetail,
  normalizePageCountRecommendations,
  presetsWithResolvedPageCount,
  resolveMobilePageCount
} from "./projectRecords.js";
import { planOperation } from "./projectStatusSerializers.js";
import { inputSnapshotFromProject, serializeProjectDetail } from "./projectSummarySerializers.js";
import {
  mobilePageCountRecommendationAiSchema
} from "./schemas.js";
import { fingerprintGenerationRequest, hashString, jsonInputValue, jsonRecord, promiseWithTimeout } from "./support.js";
import {
  creditCostForOperation,
  foldCharacterName,
  generateJsonWithRetry,
  isLibraryMentionNameCharacterAt,
  libraryMentionTokenEndsAt,
  libraryCharacterRelativeFile,
} from "@book-maker/core";
import { createLiveFastJudgmentsTextModel } from "../generationTextModelRouting.js";
import { linearizeCreationMessages } from "../creationChatTree.js";
import { fieldsFromJson as characterFieldsFromJson } from "./characterSerializer.js";
import { prisma } from "@book-maker/db";
import {
  GenerationAttemptConflictError,
  InsufficientCreditsError,
  startGenerationAttempt
} from "@book-maker/db/billing";
import { type FastifyReply } from "fastify";
import type { MobileRouteContext } from "./routeContext.js";
import { assessCurrentContentRestrictions } from "../contentRestrictions.js";
import { expandLibraryCharacterGraph, generationDescription } from "./libraryMentionGraph.js";

class CreationSessionConflictError extends Error {
  constructor() {
    super("Creation session changed before the build started.");
    this.name = "CreationSessionConflictError";
  }
}

/**
 * The stored advisor snapshot, stamped with the draft revision and preset
 * context it was computed from. A bare snapshot used to be reused forever, so
 * a rebuild after twenty more chat messages planned against stale advice; and
 * the preflight's advisor was thrown away, so every build tap paid for the
 * same calls twice. The stamp makes the snapshot safe to reuse exactly when
 * nothing it depends on has moved, and worthless the moment anything has.
 */
export function advisorSnapshotForStorage(
  advisor: MobileBookAdvisorResponse,
  revision: number,
  contextFingerprint: string
): Record<string, unknown> {
  return { snapshotRevision: revision, contextFingerprint, advisor };
}

function storedAdvisorForBuild(
  draft: { advisorSnapshot: unknown; revision: number },
  contextFingerprint: string
): MobileBookAdvisorResponse | null {
  const record = jsonRecord(draft.advisorSnapshot);
  if (record.snapshotRevision !== draft.revision || record.contextFingerprint !== contextFingerprint) {
    // Legacy bare snapshots land here too: with no stamp there is no way to
    // know what they were computed from, and stale advice priced a real book.
    return null;
  }
  const parsed = mobileBookAdvisorResponseSchema.safeParse(record.advisor);
  return parsed.success ? parsed.data : null;
}

function advisorContextFingerprintFor(payload: MobileCreationDraftPayload): string {
  return hashString(
    JSON.stringify({
      presets: payload.selectedPresets ?? null,
      sourceNotes: payload.sourceNotes ?? "",
      optionalDetails: payload.optionalDetails ?? null
    })
  );
}

/**
 * The creation "build" step: turn an accepted creation draft into a real
 * Project, resolving page count and charging credits along the way.
 *
 * Exposed as a factory because these helpers close over the route context
 * (config, rate limiters, AI enrichment hooks). Both the creation-session and
 * the legacy creation-draft routes build their own copy.
 */
export function createCreationBuildHelpers(context: MobileRouteContext) {
  const { appConfig, options, advisorEnrichment } = context;

  async function prepareMobileCreationBuild(
    userId: string,
    draftId: string,
    overrides: MobileCreationBuildOverrides = {}
  ) {
    const draft = await prisma.mobileCreationDraft.findFirst({
      where: { id: draftId, userId },
      include: mobileCreationDraftOutputsInclude()
    });
    if (!draft) {
      return { ok: false as const, status: 404, code: "DRAFT_NOT_FOUND", message: "Creation draft not found." };
    }
    if (draft.status !== "ACTIVE" && draft.status !== "COMPLETED") {
      return { ok: false as const, status: 409, code: "DRAFT_NOT_ACTIVE", message: "This creation draft is not available for building." };
    }

    const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
    if (!parsedPayload.success) {
      return {
        ok: false as const,
        status: 400,
        code: "VALIDATION_ERROR",
        message: "This creation draft needs to be updated before it can create a project."
      };
    }

    const mergedPresets = overrides.presets
      ? mergeMobileCreationPresets(parsedPayload.data.selectedPresets, overrides.presets)
      : parsedPayload.data.selectedPresets;
    const mergedPayload: MobileCreationDraftPayload = {
      ...parsedPayload.data,
      ...(mergedPresets ? { selectedPresets: mergedPresets } : {}),
      ...(overrides.sourceNotes !== undefined ? { sourceNotes: overrides.sourceNotes } : {}),
      ...(overrides.optionalDetails ? { optionalDetails: overrides.optionalDetails } : {})
    };
    const restriction = await assessCurrentContentRestrictions(
      [
        mergedPayload.rawIdea ?? "",
        mergedPayload.sourceNotes ?? "",
        JSON.stringify(mergedPayload.optionalDetails ?? {})
      ].join("\n")
    );
    if (!restriction.allowed) {
      return {
        ok: false as const,
        status: 422,
        code: restriction.reason === "copyright" ? "COPYRIGHT_RESTRICTED" : "CONTENT_RESTRICTED",
        message: restriction.message
      };
    }
    const advisorContextFingerprint = advisorContextFingerprintFor(mergedPayload);
    // A snapshot stamped with the current revision and preset context was
    // computed by this very function moments ago (the preflight); reusing it
    // skips both advisor calls. Anything else — older revision, different
    // presets, a legacy unstamped snapshot — is recomputed.
    const storedAdvisor = storedAdvisorForBuild(draft, advisorContextFingerprint);
    const advisor =
      storedAdvisor ??
      (await adviseMobileBook(mergedPayload, {
        enrich: advisorEnrichment,
        timeoutMs: options.advisorTimeoutMs
      }));
    const selectedPresets = mergedPayload.selectedPresets ?? advisor.recommendation;
    const unresolvedAuto = selectedPresets.bookTypeChoice === "auto";
    const effectiveAdvisor = !storedAdvisor && unresolvedAuto && advisor.detectedLane !== "auto"
      ? await adviseMobileBook(
          mobileCreationDraftPayloadSchema.parse({
            ...mergedPayload,
            selectedPresets: { ...selectedPresets, bookTypeChoice: "auto" },
            detectedLane: "auto",
            recipe: undefined
          }),
          { enrich: advisorEnrichment, timeoutMs: options.advisorTimeoutMs }
        )
      : advisor;
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...mergedPayload,
      selectedPresets,
      detectedLane: unresolvedAuto ? effectiveAdvisor.detectedLane : mergedPayload.detectedLane ?? effectiveAdvisor.detectedLane,
      recipe: unresolvedAuto ? effectiveAdvisor.recipe : mergedPayload.recipe ?? effectiveAdvisor.recipe
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...effectiveAdvisor,
      recommendation: selectedPresets,
      detectedLane: finalPayload.detectedLane ?? effectiveAdvisor.detectedLane,
      recipe: finalPayload.recipe ?? effectiveAdvisor.recipe
    };
    return {
      ok: true as const,
      draft,
      selectedPresets,
      finalPayload,
      finalAdvisor,
      advisorContextFingerprint,
      pageCount: resolveMobilePageCount(finalPayload, selectedPresets)
    };
  }

  async function finalizeMobileCreationDraft(
    userId: string,
    draftId: string,
    overrides: MobileCreationBuildOverrides = {},
    options: { requireResolvedPageCount?: boolean } = {}
  ): Promise<FinalizeOutcome> {
    const prepared = await prepareMobileCreationBuild(userId, draftId, overrides);
    if (!prepared.ok) {
      return prepared;
    }
    if (options.requireResolvedPageCount && !prepared.pageCount.resolved) {
      return { ok: false, status: 409, code: "PAGE_COUNT_REQUIRED", message: "Choose how many pages this book should be before building the plan." };
    }

    const { draft } = prepared;
    const buildRequestId = overrides.requestId ?? `legacy-build-${draftId}-${draft.revision ?? 1}`;
    const selectedPresets = presetsWithResolvedPageCount(prepared.selectedPresets, prepared.pageCount);
    // The @-mentioned characters are copied into the payload here — active
    // branch only, read live from the library at this moment — so they ride
    // `mediaSettings.mobile.characters` into the plan's inputSnapshot and the
    // book stops depending on the library from now on. The stored payload's
    // own `characters` is always discarded first: a draft payload is client
    // JSON, and a planted snapshot naming another user's portraitFile must
    // never survive into the book.
    const characterSnapshots = await libraryCharacterSnapshotsForBuild(userId, prepared.finalPayload);
    const { characters: _storedCharacters, ...preparedPayload } = prepared.finalPayload;
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...preparedPayload,
      ...(characterSnapshots.length > 0 ? { characters: characterSnapshots } : {}),
      selectedPresets
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...prepared.finalAdvisor,
      recommendation: selectedPresets
    };

    const input = buildMobileCreateProjectInput({
      bookType: selectedPresets.bookType,
      bookTypeChoice: selectedPresets.bookTypeChoice,
      lengthPreset: selectedPresets.lengthPreset,
      qualityPreset: selectedPresets.qualityPreset,
      imagesEnabled: selectedPresets.imagesEnabled,
      coverEnabled: selectedPresets.coverEnabled,
      illustrationsEnabled: selectedPresets.illustrationsEnabled,
      pageCountMode: selectedPresets.pageCountMode,
      targetPages: selectedPresets.targetPages,
      pageCountSource: selectedPresets.pageCountSource,
      title: titleForMobilePayload(finalPayload, finalAdvisor),
      authorName: authorForMobilePayload(finalPayload),
      prompt: composeMobileProjectPrompt(finalPayload, finalAdvisor),
      language: overrides.language ?? prepared.finalPayload.language ?? "en",
      creationBrief: briefForMobilePayload(finalPayload, finalAdvisor),
      creationPayload: finalPayload,
      advisor: finalAdvisor
    });
    const planCost = creditCostForOperation("PLAN_GENERATION");
    let project: MobileProjectRecord | null = null;
    let output: MobileCreationOutputRecord;
    let operation: MobilePlanOperationDto | null = null;
    let createdOutput: MobileCreationOutputRecord | null = null;
    let claimedRevision: number | null = null;
    try {
      const started = await startGenerationAttempt({
        userId,
        commandKey: `mobile:creation-build:${draftId}:${buildRequestId}`,
        requestFingerprint: fingerprintGenerationRequest({ draftId, buildRequestId, input }),
        operation: "PLAN_GENERATION",
        quotedCredits: planCost,
        description: "Mobile plan generation",
        metadata: { draftId, buildRequestId },
        create: async (tx, { attemptId, ledgerEntry }) => {
          const claimed = await updateCreationDraftCas({
            draft,
            expectedRevision: overrides.expectedRevision,
            data: {
              status: "ACTIVE",
              advisorSnapshot: jsonInputValue(
                advisorSnapshotForStorage(finalAdvisor, draft.revision, prepared.advisorContextFingerprint)
              ),
              payload: jsonInputValue(finalPayload)
            },
            transaction: tx
          });
          if (!claimed) {
            throw new CreationSessionConflictError();
          }
          claimedRevision = claimed.revision;
          const createdProject = await createMobileProjectRecord(userId, input, tx);
          project = createdProject;
          createdOutput = await createCreationOutputForProject({
            draftId,
            projectId: createdProject.id,
            requestId: buildRequestId,
            title: createdProject.title,
            existingOutputs: creationOutputsForDraft(draft, finalPayload),
            transaction: tx
          });
          await tx.project.update({ where: { id: createdProject.id }, data: { status: "PLANNING" } });
          const durableJob = await enqueueGenerationJob({
            projectId: createdProject.id,
            type: "PLAN_BOOK",
            dedupeKey: `plan-book:${createdProject.id}`,
            transaction: tx,
            dispatch: false,
            attemptId,
            payload: {
              inputSnapshot: inputSnapshotFromProject(createdProject),
              ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
            }
          });
          await tx.mobileCreationDraft.update({
            where: { id: draftId },
            data: {
              status: "ACTIVE",
              advisorSnapshot: jsonInputValue(
                advisorSnapshotForStorage(finalAdvisor, draft.revision, prepared.advisorContextFingerprint)
              ),
              createdProjectId: createdProject.id,
              revision: { increment: 1 }
            }
          });
          return { projectId: createdProject.id, primaryJobId: durableJob.id };
        }
      });
      if (!started.attempt.projectId || !started.attempt.primaryJobId) {
        throw new Error("Creation attempt is missing its project or primary job.");
      }
      project = project ?? (await loadMobileProjectDetail(userId, started.attempt.projectId));
      if (!project) {
        throw new Error("Created project could not be loaded.");
      }
      const loadedOutput =
        createdOutput ??
        (await prisma.mobileCreationOutput.findFirst({
          where: { draftId, requestId: buildRequestId },
          include: { project: { select: { title: true, updatedAt: true } } }
        }));
      if (!loadedOutput) {
        throw new Error("Created output could not be loaded.");
      }
      output = loadedOutput;
      const durableJob = await dispatchGenerationJob(started.attempt.primaryJobId);
      if (!durableJob) {
        throw new Error("Creation attempt has no durable job.");
      }
      operation = planOperation("planning_queued", project.id, null, durableJob, "Creating your book plan.");
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return { ok: false, insufficient: error };
      }
      if (error instanceof GenerationAttemptConflictError) {
        return { ok: false, status: 409, code: error.code, message: error.message };
      }
      if (error instanceof CreationSessionConflictError) {
        return {
          ok: false,
          status: 409,
          code: "SESSION_CONFLICT",
          message: "This chat changed elsewhere. Reload it before building."
        };
      }
      throw error;
    }
    const refreshedProject = (await loadMobileProjectDetail(userId, project.id)) ?? project;
    const latestDraft = await prisma.mobileCreationDraft.findUnique({
      where: { id: draftId },
      select: { revision: true }
    });
    return {
      ok: true,
      project: await serializeProjectDetail(refreshedProject, appConfig, userId),
      output: serializeCreationOutput(output),
      operation,
      sessionRevision: latestDraft?.revision ?? claimedRevision ?? draft.revision ?? 1
    };
  }

  async function pageCountRecommendationsForPreflight(
    payload: MobileCreationDraftPayload,
    advisor: MobileBookAdvisorResponse
  ): Promise<MobilePageCountRecommendationDto[]> {
    const fallback = deterministicPageCountRecommendations(payload, advisor);
    try {
      const textModel = createLiveFastJudgmentsTextModel(appConfig);
      const result = await promiseWithTimeout(
        generateJsonWithRetry(textModel, {
          purpose: "mobile-page-count-preflight",
          temperature: 0.2,
          maxTokens: 700,
          schema: mobilePageCountRecommendationAiSchema,
          messages: [
            {
              role: "system",
              content:
                "Recommend 2-4 practical page counts for a mobile book creator. Keep options concise. Do not mention AI models, providers, tokens, billing, or internal systems."
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  chat: conversationMessagesFromPayload(payload)
                    .slice(-20)
                    .map((message) => ({ role: message.role, content: message.content })),
                  rawIdea: payload.rawIdea,
                  sourceNotesPreview: payload.sourceNotes.slice(0, 600),
                  detectedLane: advisor.detectedLane,
                  recipe: advisor.recipe,
                  fallback
                },
                null,
                2
              )
            }
          ]
        }),
        options.pageCountRecommendationTimeoutMs ?? 2500
      );
      return normalizePageCountRecommendations(result.data.recommendations, fallback);
    } catch {
      return fallback;
    }
  }

  return { prepareMobileCreationBuild, finalizeMobileCreationDraft, pageCountRecommendationsForPreflight };
}

/**
 * The characters the book will actually carry: every @-mention on the ACTIVE
 * branch (an edited-away mention stays out), resolved against the live library
 * at build time. A character deleted since being mentioned simply drops out.
 */
async function libraryCharacterSnapshotsForBuild(
  userId: string,
  payload: MobileCreationDraftPayload
): Promise<Array<Record<string, unknown>>> {
  const active = linearizeCreationMessages(payload.messages ?? []).active;
  // The union over a whole branch, clamped to what the payload schema accepts
  // — each message caps its own mentions, but a chat is many messages, and an
  // over-long list would fail the re-parse below as a 500 no retry can clear.
  // First mentioned wins: that is the cast the chat was built around.
  const tapped = active.flatMap((message) => (message.characters ?? []).map((ref) => ref.id));
  const ids = [...new Set([...tapped, ...(await typedCharacterIds(userId, active))])].slice(
    0,
    BUILD_CHARACTER_SNAPSHOT_LIMIT
  );
  if (ids.length === 0) {
    return [];
  }
  // The cap here is a *total*: `mobileCreationCharacterSnapshotSchema` accepts
  // no more than this many, and the ids above are already clamped to it — so
  // the linked characters get whatever room the tapped cast leaves, and a
  // branch that filled the list on its own carries no expansion rather than
  // failing the payload re-parse. The graph takes it as the total and narrows
  // it to nothing of its own — it used to `Math.min` the argument against the
  // chat's mention cap, which is the same ten, so raising this constant (and
  // `MAX_SNAPSHOT_CHARACTERS`, which the worker reads the copy back through)
  // would have bought no extra sheets and said nothing about why. A character
  // deleted since being mentioned is simply missing, which is why nothing here
  // reads `missingIds`.
  const { characters: rows } = await expandLibraryCharacterGraph(userId, ids, BUILD_CHARACTER_SNAPSHOT_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: generationDescription(row),
    // The look, when one has been recorded. Absent rather than empty: the
    // planner prompt branches on whether a character has one at all, and
    // "" would read as "recorded, and it is nothing" — which is the invented
    // -appearance bug wearing a different hat.
    ...(row.appearance?.trim() ? { appearance: row.appearance.trim() } : {}),
    fields: characterFieldsFromJson(row.fields),
    // The same condition `serializeLibraryCharacter` calls `usedInBooks`, so
    // what the app says about a character is what the book actually gets.
    ...(row.portraitStatus === "READY" && row.portraitPath
      ? {
          portraitFile: libraryCharacterRelativeFile(userId, row.portraitPath),
          // Adopted artwork is re-posed rather than reinterpreted, which is a
          // different instruction to the renderer — so the provenance has to
          // survive the copy into the book.
          portraitSource: row.portraitSource === "ADOPTED_UPLOAD" ? "adopted_upload" : "generated"
        }
      : {})
  }));
}

/**
 * The mentions nobody tapped.
 *
 * `message.characters` is written only when the composer's suggestion chip was
 * tapped, so a reader who typed "@Natalia" by hand — or who tapped the chip and
 * then edited the message, which rebuilds the text and drops the refs — sent no
 * id at all. The name still sits in the transcript the planner reads, so the
 * book was built *about* the saved character while carrying no snapshot of
 * them: no appearance, no portrait, and a planner free to invent both.
 *
 * Two properties this must not break:
 *
 * - **An edited-away mention stays out.** This reads the ACTIVE branch's
 *   current text, never history, so a name the reader deleted is a name that is
 *   no longer there. That is the same rule the tapped ids follow, expressed
 *   against the text rather than against the refs.
 * - **A common word is not a mention.** "Rose", "Hope" and "می" are ordinary
 *   words, and matching bare prose would drag a character into every book that
 *   used one. The literal "@" is required — it is what the composer writes and
 *   what a reader types when they mean the saved character — and it must itself
 *   start a word, so "me@luna.com" is an address rather than a cast list.
 *
 * Only user text is scanned: the assistant echoes names back constantly, and
 * nothing it writes is a decision about who is in the book.
 */
async function typedCharacterIds(
  userId: string,
  active: readonly { role: string; content: string }[]
): Promise<string[]> {
  const texts = active.filter((message) => message.role === "user").map((message) => message.content);
  if (!texts.some((text) => text.includes("@"))) {
    return [];
  }
  const rows = await prisma.libraryCharacter.findMany({
    where: { userId },
    select: { id: true, name: true }
  });
  const folded = rows
    .map((row) => ({ id: row.id, folded: foldCharacterName(row.name) }))
    .filter((candidate) => candidate.folded.length > 0);
  // Two library characters can fold to one name ("Luna" and "luna" are two
  // distinct rows), and typed text carries no id to tell them apart. Neither is
  // taken, for the reason `matchLibraryCharacter` refuses an ambiguous match: a
  // missing seed is a character drawn from prose, a wrong one is a stranger
  // wearing the reader's saved face. Tapping the chip still binds either.
  const ambiguous = new Set(
    folded
      .map((candidate) => candidate.folded)
      .filter((name, index, names) => names.indexOf(name) !== index)
  );
  // Longest first, so "@Luna Vega" binds Luna Vega and not the Luna inside her.
  const candidates = folded
    .filter((candidate) => !ambiguous.has(candidate.folded))
    .sort((left, right) => right.folded.length - left.folded.length);
  return texts.flatMap((text) => scanTypedMentions(text, candidates));
}

/** Ids of the library characters `text` @-mentions, in the order they appear. */
function scanTypedMentions(
  text: string,
  candidates: readonly { id: string; folded: string }[]
): string[] {
  // Both sides folded, so a name typed from a Persian keyboard, decomposed by
  // an IME, or wrapped in bidi marks is still the name that was saved. Folding
  // moves offsets, which is why nothing here reports one to the caller.
  const haystack = foldCharacterName(text);
  const claimed: Array<{ start: number; end: number }> = [];
  const found: Array<{ at: number; id: string }> = [];
  for (const candidate of candidates) {
    const needle = `@${candidate.folded}`;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      // Same boundary helpers the composer and the description scanner use, so
      // a UTF-16 unit that is only half of 𐐀 cannot open a word, and a hyphen
      // that joins the next word still binds nobody.
      if (
        isLibraryMentionNameCharacterAt(haystack, at - 1) ||
        !libraryMentionTokenEndsAt(haystack, end)
      ) {
        continue;
      }
      // A longer name got here first and this match is inside it.
      if (claimed.some((span) => at < span.end && end > span.start)) {
        continue;
      }
      claimed.push({ start: at, end });
      found.push({ at, id: candidate.id });
    }
  }
  return found.sort((left, right) => left.at - right.at).map((entry) => entry.id);
}

export function sendFinalizeOutcome(reply: FastifyReply, outcome: FinalizeOutcome): FastifyReply {
  if (outcome.ok) {
    return reply.code(201).send({
      project: outcome.project,
      output: outcome.output,
      operation: outcome.operation,
      sessionRevision: outcome.sessionRevision
    } satisfies MobileCreationFinalizeResponseDto);
  }
  if ("insufficient" in outcome) {
    return sendInsufficientCredits(reply, outcome.insufficient);
  }
  return sendMobileError(reply, outcome.status, outcome.code, outcome.message);
}
