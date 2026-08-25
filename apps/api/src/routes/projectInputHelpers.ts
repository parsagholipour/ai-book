import {
  buildMarginEstimate,
  createLanguageDetectionTextModel,
  createProjectSchema,
  detectPromptLanguage,
  estimateFullBookCreditCost,
  estimateProviderCostForProject,
  isEnglishLanguage,
  mediaSettingsSchema,
  normalizeProjectLanguage,
  type AppConfig,
  type CreateProjectInput,
  type ProjectCostSummary
} from "@book-maker/core";
import { createHash } from "node:crypto";
import type { Prisma } from "@book-maker/db";
import type { ProjectActor } from "../requestAuth.js";

/**
 * Project-input helpers for the operator routes: ownership `where` clauses,
 * billing estimates, and the prompt-to-project derivations. Split from
 * ./projects.ts along the same seam as ./projectExports.ts and
 * ./projectVoiceSupport.ts; nothing here touches Fastify.
 */

export function projectBillingSummary(
  project: {
    title: string;
    subtitle: string | null;
    authorName: string | null;
    coverTagline: string | null;
    prompt: string;
    category: string;
    subcategory: string | null;
    targetPages: number;
    complexity: number;
    temperature: number;
    language: string;
    mediaSettings: unknown;
  },
  cost: ProjectCostSummary | undefined
) {
  const input = createProjectSchema.parse({
    title: project.title,
    ...(project.subtitle ? { subtitle: project.subtitle } : {}),
    ...(project.authorName ? { authorName: project.authorName } : {}),
    ...(project.coverTagline ? { coverTagline: project.coverTagline } : {}),
    prompt: project.prompt,
    category: project.category,
    ...(project.subcategory ? { subcategory: project.subcategory } : {}),
    targetPages: project.targetPages,
    complexity: project.complexity,
    temperature: project.temperature,
    language: project.language,
    mediaSettings: mediaSettingsSchema.parse(project.mediaSettings)
  });
  const creditEstimate = estimateFullBookCreditCost(input);
  const providerEstimate = estimateProviderCostForProject(input);
  return {
    creditEstimate,
    providerEstimate,
    margin: buildMarginEstimate({
      creditEstimate,
      providerEstimate,
      actualProviderCostUsd: cost?.totalUsd ?? null
    })
  };
}

export function ownedPlanWhere(planId: string, actor: ProjectActor): Prisma.PlanVersionWhereInput {
  return { id: planId, project: { userId: actor.userId } };
}

export function ownedVoiceCharacterWhere(characterId: string, actor: ProjectActor): Prisma.VoiceCharacterWhereInput {
  return { id: characterId, project: { userId: actor.userId } };
}

export type ProjectStrategySource = {
  title: string;
  subtitle?: string | null;
  authorName?: string | null;
  coverTagline?: string | null;
  prompt: string;
  category: string;
  subcategory?: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  language: string;
  mediaSettings: unknown;
};

export function planInputForStrategy(inputSnapshot: unknown, project: ProjectStrategySource): CreateProjectInput {
  const fromSnapshot = createProjectSchema.safeParse(inputSnapshot);
  if (fromSnapshot.success) {
    return fromSnapshot.data;
  }
  return createProjectSchema.parse({
    title: project.title,
    subtitle: project.subtitle ?? undefined,
    authorName: project.authorName ?? undefined,
    coverTagline: project.coverTagline ?? undefined,
    prompt: project.prompt,
    category: project.category,
    subcategory: project.subcategory ?? undefined,
    targetPages: project.targetPages,
    complexity: project.complexity,
    temperature: project.temperature,
    language: project.language,
    mediaSettings: mediaSettingsSchema.parse(project.mediaSettings)
  });
}

/** Human-facing asset name: collapse unsafe runs to `-`, trim them, and fall back to `asset`. */
export function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "asset";
}

export function deriveTitle(prompt: string): string {
  return prompt
    .split(/[.!?\n]/)[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Untitled Book";
}

export function projectUpdateDataFromInput(input: CreateProjectInput, templateId: string | null) {
  const subtitle = cleanOptionalText(input.subtitle);
  const authorName = cleanOptionalText(input.authorName);
  const coverTagline = cleanOptionalText(input.coverTagline);
  const subcategory = cleanOptionalText(input.subcategory);

  return {
    title: input.title ?? deriveTitle(input.prompt),
    subtitle: subtitle ?? null,
    authorName: authorName ?? null,
    coverTagline: coverTagline ?? null,
    prompt: input.prompt,
    category: input.category,
    subcategory: subcategory ?? null,
    targetPages: input.targetPages,
    complexity: input.complexity,
    temperature: input.temperature,
    language: input.language,
    mediaSettings: mediaSettingsSchema.parse(input.mediaSettings),
    ...(templateId ? { templateId } : {})
  };
}

export async function inputWithDetectedLanguage(
  input: CreateProjectInput,
  rawBody: unknown,
  appConfig: AppConfig
): Promise<CreateProjectInput> {
  const explicitLanguage = explicitLanguageFromBody(rawBody);
  if (explicitLanguage && !isEnglishLanguage(explicitLanguage)) {
    return { ...input, language: normalizeProjectLanguage(explicitLanguage) };
  }
  const fallbackLanguage = explicitLanguage ? normalizeProjectLanguage(explicitLanguage) : input.language;

  try {
    return {
      ...input,
      language: await detectPromptLanguage(createLanguageDetectionTextModel(appConfig), input.prompt)
    };
  } catch {
    return { ...input, language: fallbackLanguage };
  }
}

function explicitLanguageFromBody(rawBody: unknown): string | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return undefined;
  }
  const language = (rawBody as Record<string, unknown>).language;
  return typeof language === "string" && language.trim() ? language : undefined;
}

export function jsonPayload(input: CreateProjectInput): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

export function jsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

export function stablePayloadHash(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

export function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}
