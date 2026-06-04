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
