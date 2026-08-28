import { getProjectOrThrow, imageGenerationMetadata, imageStorageMetadata, strategyForInput } from "../generation/bookHelpers.js";
import { inputForPlanVersion } from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { dispatchWorkerGenerationJob, enqueueWorkerJob } from "../runtime/dispatch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import { jsonInputValue, jsonPayloadToRecord } from "../runtime/serialization.js";
import {
  characterReferencePromptInstruction,
  imageAssetPlanId,
  selectReferenceImagePaths,
  toWorkerImageAsset
} from "../generation/characterReferences.js";
import { characterPreparationDedupeKey } from "../generation/characterPreparation.js";
import {
  bookPlanSchema,
  buildCharacterProfileImagePrompt,
  buildVoiceCharacterPersona,
  createProviders,
  createVoiceProvider,
  extractVoiceCharacterCandidates,
  normalizeVoiceProfile,
  optimizeImageForStorage,
  publicAssetUrl,
  safePathPart,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type ProviderSet,
  type VoiceCharacterCandidate
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import type {
  BuildCharacterPersonaJob,
  PrepareCharacterCandidatesJob
} from "../runtime/jobPayloads.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `prepare-character-candidates` and `build-character-persona` jobs backing the
 * voice-character feature.
 */

export async function maybeEnqueueCharacterCandidatePreparation(
  projectId: string,
  planId: string,
  persistedJobId?: string
) {
  if (persistedJobId) {
    // Export publication created this exact row in the artifact transaction.
    // The post-completion hook is dispatch-only: recreating on a miss would
    // reopen the crash gap the durable publication claim just closed.
    const persisted = await prisma.generationJob.findFirst({
      where: {
        id: persistedJobId,
        projectId,
        type: "PREPARE_CHARACTER_CANDIDATES",
        payload: { path: ["planId"], equals: planId }
      },
      select: { id: true, status: true, bullJobId: true }
    });
    if (persisted?.status === "QUEUED" && !persisted.bullJobId) {
      await dispatchWorkerGenerationJob(persisted.id);
    }
    return;
  }

  const [existingCharacters, openJob] = await Promise.all([
    prisma.voiceCharacter.count({
      where: {
        projectId,
        planVersionId: planId,
        status: { not: "REJECTED" }
      }
    }),
    prisma.generationJob.findFirst({
      where: {
        projectId,
        type: "PREPARE_CHARACTER_CANDIDATES",
        status: { in: ["QUEUED", "ACTIVE"] },
        payload: { path: ["planId"], equals: planId }
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, bullJobId: true }
    })
  ]);
  if (existingCharacters > 0) {
    return;
  }
  if (openJob) {
    // A row-first enqueue that crashed before Redis is recoverable here as well
    // as by the periodic undispatched-job reconciler.
    if (openJob.status === "QUEUED" && !openJob.bullJobId) {
      await dispatchWorkerGenerationJob(openJob.id);
    }
    return;
  }

  await enqueueWorkerJob({
    projectId,
    type: "PREPARE_CHARACTER_CANDIDATES",
    payload: { planId },
    // `enqueueWorkerJob` appends the current attempt id; the shared helper is
    // called with null here to produce that base key.
    dedupeKey: characterPreparationDedupeKey(projectId, planId, null)
  });
}

export async function prepareCharacterCandidates(job: PrepareCharacterCandidatesJob) {
  const { projectId, planId, generationJobId } = job.data;
  const [project, planVersion, existingCharacters] = await Promise.all([
    getProjectOrThrow(projectId),
    prisma.planVersion.findUnique({ where: { id: planId } }),
    prisma.voiceCharacter.count({
      where: {
        projectId,
        planVersionId: planId,
        status: { not: "REJECTED" }
      }
    })
  ]);
  if (!planVersion) {
    throw new Error("Plan not found for character candidate preparation");
  }
  if (existingCharacters > 0) {
    await advanceJobStep(generationJobId, "save", 90, "Character candidates already exist");
    return;
  }

  const input = inputForPlanVersion(project, planVersion.inputSnapshot);
  const plan = bookPlanSchema.parse(planVersion.planningPackage);
  const pages = await samplePagesForVoiceCharacters(projectId);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  await advanceJobStep(generationJobId, "detect", 35);
  const candidates = await extractVoiceCharacterCandidates({
    input,
    plan,
    pages,
    textModel: providers.text
  });
  if (candidates.length === 0) {
    await advanceJobStep(generationJobId, "save", 90, "No fictional voice characters detected");
    return;
  }

  const voiceProvider = createVoiceProvider(config);
  await advanceJobStep(generationJobId, "save", 75, `Saving ${candidates.length} character candidate${candidates.length === 1 ? "" : "s"}`);
  await prisma.voiceCharacter.createMany({
    data: candidates.map((candidate) => {
      const selection = voiceProvider.selectVoice(candidate.voiceProfile);
      return {
        projectId,
        planVersionId: planId,
        // Copy-by-value, like the plan snapshot it came from: the cast sheet
        // shows the saved character's own portrait and says the book was built
        // from it, and deleting that character later changes no book state.
        libraryCharacterId: candidate.libraryCharacterId ?? null,
        name: candidate.name,
        role: candidate.role,
        description: candidate.description,
        traits: jsonInputValue(candidate.traits),
        visualRules: jsonInputValue(candidate.visualRules),
        source: candidate.source,
        status: "CANDIDATE",
        voiceProfile: jsonInputValue(candidate.voiceProfile),
        voiceProvider: selection.provider,
        voiceModel: selection.model,
        voiceId: selection.voiceId,
        providerMetadata: jsonInputValue(selection.metadata)
      };
    })
  });
}

export async function buildCharacterPersona(job: BuildCharacterPersonaJob) {
  const { projectId, voiceCharacterId, generationJobId } = job.data;
  const voiceCharacter = await prisma.voiceCharacter.findUnique({
    where: { id: voiceCharacterId },
    include: { project: { include: { currentPlan: true } } }
  });
  if (!voiceCharacter || voiceCharacter.projectId !== projectId) {
    throw new Error("Voice character not found for persona build");
  }
  if (voiceCharacter.status === "REJECTED") {
    await advanceJobStep(generationJobId, "save", 90, "Character was rejected");
    return;
  }

  await prisma.voiceCharacter.update({
    where: { id: voiceCharacter.id },
    data: { status: "BUILDING", error: null }
  });

  try {
    const planVersionId = voiceCharacter.planVersionId ?? voiceCharacter.project.currentPlanId;
    if (!planVersionId) {
      throw new Error("Voice character does not have a plan version");
    }
    const planVersion =
      voiceCharacter.project.currentPlan?.id === planVersionId
        ? voiceCharacter.project.currentPlan
        : await prisma.planVersion.findUnique({ where: { id: planVersionId } });
    if (!planVersion) {
      throw new Error("Plan not found for voice character persona");
    }

    const input = inputForPlanVersion(voiceCharacter.project, planVersion.inputSnapshot);
    const plan = bookPlanSchema.parse(planVersion.planningPackage);
    const strategy = strategyForInput(input);
    const providers = createLoggedProviders(job, createProviders(config, input), input);
    const candidate = voiceCharacterCandidateFromRecord(voiceCharacter);
    const pages = await samplePagesForVoiceCharacters(projectId);
    await advanceJobStep(generationJobId, "persona", 30);
    const persona = await buildVoiceCharacterPersona({
      input,
      plan,
      candidate,
      pages,
      textModel: providers.text
    });

    await advanceJobStep(generationJobId, "portrait", 60);
    const profileImageAsset = await generateCharacterProfileImage({
      projectId,
      planId: planVersionId,
      voiceCharacterId,
      input,
      plan,
      persona,
      providers,
      strategy
    });
    const voiceProvider = createVoiceProvider(config);
    const voiceSelection = voiceProvider.selectVoice(persona.voiceProfile);

    await advanceJobStep(generationJobId, "save", 85);
    await prisma.voiceCharacter.update({
      where: { id: voiceCharacter.id },
      data: {
        status: "READY",
        persona: jsonInputValue(persona),
        voiceProfile: jsonInputValue(persona.voiceProfile),
        voiceProvider: voiceSelection.provider,
        voiceModel: voiceSelection.model,
        voiceId: voiceSelection.voiceId,
        providerMetadata: jsonInputValue({
          ...jsonPayloadToRecord(voiceCharacter.providerMetadata),
          ...voiceSelection.metadata,
          profileImageAssetId: profileImageAsset.id,
          noTranscriptPersistence: true
        }),
        profileImageAssetId: profileImageAsset.id,
        error: null,
        builtAt: new Date()
      }
    });
  } catch (error) {
    await prisma.voiceCharacter.update({
      where: { id: voiceCharacter.id },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : "Unknown persona build error"
      }
    });
    throw error;
  }
}

export async function samplePagesForVoiceCharacters(projectId: string) {
  return prisma.page.findMany({
    where: { projectId },
    orderBy: { index: "asc" },
    select: {
      index: true,
      title: true,
      markdown: true,
      summary: true
    }
  });
}

export async function generateCharacterProfileImage(options: {
  projectId: string;
  planId: string;
  voiceCharacterId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  persona: Pick<VoiceCharacterCandidate, "name" | "role" | "description" | "traits" | "visualRules" | "voiceProfile">;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
}) {
  const basePrompt = buildCharacterProfileImagePrompt({
    plan: options.plan,
    candidate: options.persona
  });
  const characterReferenceAssets = await prisma.imageAsset.findMany({
    where: { projectId: options.projectId, type: "CHARACTER_REFERENCE" },
    orderBy: { createdAt: "asc" }
  });
  const references = await selectReferenceImagePaths({
    input: options.input,
    plan: options.plan,
    // A replan leaves the previous plan's sheets on the project, so the plan is
    // part of the identity of a reference — without it this avatar could be
    // drawn from a superseded book's cast. The same JS-side filter the sheet
    // generator uses, since the plan lives in the asset's JSON metadata.
    assets: characterReferenceAssets
      .filter((asset) => imageAssetPlanId(asset.metadata) === options.planId)
      .map(toWorkerImageAsset),
    projectId: options.projectId,
    image: options.providers.image,
    context: `${options.persona.name}\n${options.persona.description}\n${basePrompt}`
  });
  const referenceImagePaths = references.paths;
  // Attached images the prompt never mentions are treated as loose inspiration,
  // which is how an avatar drifted off the face the page renders use. The page
  // and cover handlers say what the attachments are; so does this one.
  const promptForReferenceImages = (attached: readonly string[]) =>
    [basePrompt, characterReferencePromptInstruction(references, attached)].filter(Boolean).join("\n");
  const prompt = promptForReferenceImages(referenceImagePaths);
  const image = await options.strategy.generateImageBytes({
    image: options.providers.image,
    prompt,
    projectId: options.projectId,
    referenceImagePaths,
    promptForReferenceImages,
    aspectRatio: "1:1"
  });
  const optimizedImage = await optimizeImageForStorage({ bytes: image.bytes, mimeType: image.mimeType });
  const ext = optimizedImage.extension;
  const projectImageDir = join(config.IMAGE_STORAGE_DIR, options.projectId);
  await mkdir(projectImageDir, { recursive: true });
  const filename = `character-profile-${safePathPart(options.voiceCharacterId)}.${ext}`;
  const filePath = join(projectImageDir, filename);
  await writeFile(filePath, optimizedImage.bytes);

  return prisma.imageAsset.create({
    data: {
      projectId: options.projectId,
      type: "CHARACTER_PROFILE",
      prompt,
      provider: image.provider,
      path: publicAssetUrl(config.PUBLIC_API_URL, `/assets/images/${options.projectId}/${filename}`),
      metadata: {
        voiceCharacterId: options.voiceCharacterId,
        characterName: options.persona.name,
        voiceProfile: options.persona.voiceProfile,
        model: image.model,
        ...imageStorageMetadata(optimizedImage),
        revisedPrompt: image.revisedPrompt,
        ...imageGenerationMetadata(image),
        characterReferenceCount: referenceImagePaths.length,
        fileName: filename
      }
    }
  });
}

export function voiceCharacterCandidateFromRecord(record: {
  name: string;
  role: string;
  description: string;
  traits: unknown;
  visualRules: unknown;
  source: string;
  voiceProfile: unknown;
}): VoiceCharacterCandidate {
  return {
    name: record.name,
    role: record.role,
    description: record.description,
    traits: stringArrayFromJson(record.traits),
    visualRules: stringArrayFromJson(record.visualRules),
    source: record.source === "BOOK_SAMPLE" ? "BOOK_SAMPLE" : "PLAN",
    voiceProfile: normalizeVoiceProfile(record.voiceProfile)
  };
}

export function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
