import {
  createProjectSchema,
  mediaSettingsSchema,
  type CreateProjectInput
} from "@book-maker/core";

export type ProjectInputSource = {
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

export function inputForPlanVersion(project: ProjectInputSource, inputSnapshot: unknown): CreateProjectInput {
  return inputFromSnapshot(inputSnapshot) ?? inputFromProject(project);
}

export function inputFromProject(project: ProjectInputSource): CreateProjectInput {
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

export function inputFromSnapshot(snapshot: unknown): CreateProjectInput | null {
  const result = createProjectSchema.safeParse(snapshot);
  return result.success ? result.data : null;
}

export function inputWithMessageMediaPreferences(input: CreateProjectInput, message: string): CreateProjectInput {
  const preference = negativeMediaPreferenceFromMessage(message);
  if (!preference) {
    return input;
  }

  const fullIllustrations = preference.disableIllustrations ? false : input.mediaSettings.fullIllustrations;
  const includeCover = preference.disableCover ? false : input.mediaSettings.includeCover;
  const illustrationCadence = !fullIllustrations ? "manual" : input.mediaSettings.illustrationCadence;
  const mobile = jsonRecord(input.mediaSettings.mobile);
  const nextMediaSettings = mediaSettingsSchema.parse({
    ...input.mediaSettings,
    fullIllustrations,
    illustrationCadence,
    includeCover,
    ...(input.mediaSettings.mobile !== undefined
      ? {
          mobile: {
            ...mobile,
            imagesEnabled: fullIllustrations || includeCover
          }
        }
      : {})
  });

  return {
    ...input,
    mediaSettings: nextMediaSettings
  };
}

function negativeMediaPreferenceFromMessage(
  message: string
): { disableIllustrations: boolean; disableCover: boolean } | null {
  const normalized = message.replace(/\s+/g, " ").trim();
  const negativeMedia = /\b(?:i\s+(?:do\s+not|don't|dont)\s+want|no|without|skip|remove|disable|turn\s+off)\b.{0,80}\b(?:images?|covers?|visuals?|illustrations?|artwork|pictures?)\b/i.test(
    normalized
  );
  if (!negativeMedia) {
    return null;
  }

  const cover = /\bcovers?\b/i.test(normalized);
  const broadImages = /\b(?:images?|visuals?|artwork|pictures?)\b/i.test(normalized);
  const illustrations = /\billustrations?\b/i.test(normalized);
  return {
    disableIllustrations: broadImages || illustrations,
    disableCover: cover || broadImages
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
