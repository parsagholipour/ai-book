import { SourceAwareTextModel, sourceRefsFromInput, type CreateProjectInput, type EmbeddingAdapter, type TextModelAdapter } from "@book-maker/core";
import { createSourceService, prisma } from "@book-maker/db";

export function withProjectSources(text: TextModelAdapter, input: CreateProjectInput | undefined, projectId: string | undefined, embedding?: EmbeddingAdapter) {
  const refs = input ? sourceRefsFromInput(input) : [];
  if (!refs.length || !projectId) return text;
  let pending: ReturnType<typeof load> | undefined;
  const load = async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { userId: true } });
    if (!project.userId) throw new Error("Uploaded sources require a project owner.");
    const owned = await prisma.sourceExtraction.findMany({ where: { source: { userId: project.userId }, OR: refs } });
    if (owned.length !== refs.length) throw new Error("A selected source version is unavailable.");
    await prisma.projectSource.createMany({ data: refs.map((ref) => ({ projectId, ...ref })), skipDuplicates: true });
    return createSourceService(project.userId, refs, embedding);
  };
  return new SourceAwareTextModel(text, () => pending ??= load());
}
