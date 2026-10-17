import {
  bookArcSchema, type BookArc, bookPlanSchema, bookDevelopmentIssues, caseEvidenceIssues, developBookPlan, isRecord, planAuthorStance, supportsBookDevelopment,
  type AuthorStance, type BookPlan, type CreateProjectInput, type TextModelAdapter, type PrimarySourceSearch
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { persistPlanField, prepareBookMaterial, recordDossierSources } from "./composedChaptersMaterial.js";
import { prepareVerifiedCases } from "./composedEvidence.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import type { loadQualityContext } from "./qualitySettings.js";
import type { RunLogger } from "../providers/runLogging.js";

/**
 * Whether `prepareComposedDevelopment` will research and replan this book — the
 * shelved development arms, which rewrite the plan's chapters and episodes.
 * The speculative prep plans nothing past the stance for such a book, and the
 * book run fences the prep before the development reads the plan it compares.
 */
export function composedDevelopmentWillRun(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  quality: Awaited<ReturnType<typeof loadQualityContext>>;
  hasPages: boolean;
}): boolean {
  if (!supportsBookDevelopment(options.input, options.plan) || options.plan.bookDevelopment) return false;
  if (options.hasPages || config.MOCK_AI) return false;
  return options.quality.enabled("bookDevelopment") || options.quality.enabled("caseEvidence");
}

/** Freeze the research and new structure together before any page can use either. */
export async function prepareComposedDevelopment(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  textModel: TextModelAdapter;
  searchSources?: PrimarySourceSearch | undefined;
  quality: Awaited<ReturnType<typeof loadQualityContext>>;
  hasPages: boolean;
  generationJobId?: string | undefined;
  runLog?: Pick<RunLogger, "append"> | undefined;
}): Promise<BookPlan> {
  if (!supportsBookDevelopment(options.input, options.plan)) return options.plan;
  const stored = options.plan.bookDevelopment;
  if (stored) {
    const same = stored.chapters.length === options.plan.chapters.length && stored.chapters.every((chapter, index) => {
      const planned = options.plan.chapters[index];
      return planned?.index === chapter.index && planned.title === chapter.title && planned.targetPages === chapter.targetPages && planned.summary === chapter.summary && JSON.stringify(planned.keyBeats) === JSON.stringify(chapter.keyBeats);
    });
    if (!same) throw new Error("The saved development plan does not match its chapters; refusing to change chapter boundaries on resume.");
    const issues = bookDevelopmentIssues(stored, options.plan.dossier?.evidencePackets ?? [], options.input.targetPages);
    if (issues.length) throw new Error(`The saved development plan is incomplete: ${issues.join("; ")}`);
    if (options.plan.dossier?.evidencePackets?.some((packet) => caseEvidenceIssues(packet).length)) {
      throw new Error("The saved case evidence is incomplete; refusing to resume with unsupported material.");
    }
    return options.plan;
  }
  // Old manuscripts keep their chapter boundaries, even if today's defaults have changed.
  if (options.hasPages || config.MOCK_AI) return options.plan;
  const replan = options.quality.enabled("bookDevelopment");
  const verify = options.quality.enabled("caseEvidence") || replan;
  if (!replan && !verify) return options.plan;
  const before = await prisma.planVersion.findUnique({ where: { id: options.planId }, select: { planningPackage: true } });
  if (!before || !isRecord(before.planningPackage)) throw new Error("The book plan is unavailable for development.");
  const material = await prepareBookMaterial({ ...options, evidenceRequired: verify, persist: false });
  await advanceJobStep(options.generationJobId, "briefs", 15, "Checking evidence for the book's main cases", { phase: "evidence" });
  const verified = await prepareVerifiedCases({ ...options, episodes: material.episodes, dossier: material.dossier, coverage: replan ? "book" : "chapter" });
  let plan: BookPlan = { ...options.plan, ...verified, authorStance: options.stance };
  if (replan) {
    await advanceJobStep(options.generationJobId, "briefs", 16, "Developing the book's chapter progression", { phase: "develop" });
    plan = await developBookPlan({ ...options, plan, dossier: verified.dossier });
  }
  const persisted = await persistPreparedComposedPlan(options.projectId, options.planId, plan, before.planningPackage);
  if (persisted.dossier) await recordDossierSources(options.projectId, persisted.dossier);
  return persisted;
}

export async function persistPreparedComposedPlan(projectId: string, planId: string, plan: BookPlan, expectedPlan?: unknown): Promise<BookPlan> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    if (!row || !isRecord(row.planningPackage)) throw new Error("The book plan disappeared before its development could be saved.");
    if (expectedPlan !== undefined && JSON.stringify(row.planningPackage) !== JSON.stringify(expectedPlan)) throw new Error("The book plan changed while research and development were running.");
    if (isRecord(row.planningPackage.bookDevelopment)) return bookPlanSchema.parse(row.planningPackage);
    if (await tx.page.count({ where: { projectId } }) > 0) throw new Error("Pages were written while developing the plan; refusing to replace their chapter boundaries.");
    const next: Record<string, unknown> = {
      ...row.planningPackage, chapters: plan.chapters, authorStance: plan.authorStance,
      episodes: plan.episodes, dossier: plan.dossier,
      ...(plan.bookDevelopment ? { bookDevelopment: plan.bookDevelopment } : {})
    };
    // An old arc refers to the old chapter indexes. It cannot ride the replacement structure, and neither can a
    // form plan or a guide's setting the speculative composition prep stored for the old chapters.
    if (plan.bookDevelopment) {
      delete next.bookArc;
      delete next.compositions;
      delete next.instructionalSetting;
    }
    const written = await tx.planVersion.updateMany({
      where: { id: planId, planningPackage: { equals: row.planningPackage as Prisma.InputJsonValue } },
      data: { planningPackage: next as unknown as Prisma.InputJsonValue }
    });
    if (written.count !== 1) throw new Error("The book plan changed while its development was being saved.");
    return plan;
  }, { isolationLevel: "Serializable", timeout: 30_000 });
}

export async function persistBookArc(planId: string, arc: BookArc, chapters: BookPlan["chapters"] | undefined): Promise<void> {
  try {
    const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    // A stored arc that parses stands; one that does not is repaired here,
    // or every retry would re-architect, never persist, and resume "fresh".
    if (!row || !isRecord(row.planningPackage) || bookArcSchema.safeParse(row.planningPackage.bookArc).success) {
      return;
    }
    // The cut rides with the arc: the compile places chapter headings by the
    // stored plan's targetPages, so rows cut one way under a plan cut another
    // print headings mid-chapter.
    await prisma.planVersion.update({
      where: { id: planId },
      data: {
        planningPackage: { ...row.planningPackage, bookArc: arc, ...(chapters ? { chapters } : {}) } as unknown as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    console.warn("Book arc was not persisted onto the plan", { event: "generation.composed_chapters.arc_not_persisted", planId, error });
  }
}

/**
 * Never over a stance the plan already carried that the pass can write from, and a compare-and-swap like every
 * other plan field, so a field the speculative composition prep wrote meanwhile is never written over
 * (`persistPlanField`). A stored stance the pass cannot write from (`planAuthorStance` refuses it) is the one it
 * just replaced in memory, so the generated one takes its place: a resume composes from the stance its finished
 * chapters were written to, and the book run adopts the one the prep generated.
 */
export async function persistGeneratedAuthorStance(planId: string, stance: AuthorStance): Promise<void> {
  await persistPlanField(planId, "authorStance", stance, storedStanceUsable);
}

export function storedStanceUsable(stored: unknown): boolean {
  return isRecord(stored) && planAuthorStance({ authorStance: stored } as unknown as BookPlan) !== undefined;
}
