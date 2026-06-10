import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  bookPlanSchema,
  bookPlanSchemaWithFallback,
  createProjectSchema,
  makeFallbackPlan,
  normalizePlanPageTargets
} from "../packages/core/src/index.ts";
import { Prisma, prisma } from "../packages/db/src/index.ts";

type Args = {
  projectId: string;
  apply: boolean;
  logFile?: string | undefined;
};

type PlannerLogPurpose = "plan-book" | "revise-plan";

const args = parseArgs(process.argv.slice(2));
const bookStorageDir = process.env.BOOK_STORAGE_DIR ?? path.resolve(process.cwd(), "storage/books");

try {
  const result = await repairPlanFromRunLog(args);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}

async function repairPlanFromRunLog(options: Args) {
  const project = await prisma.project.findUnique({
    where: { id: options.projectId },
    include: { currentPlan: true }
  });
  if (!project) {
    throw new Error(`Project ${options.projectId} was not found.`);
  }
  const currentPlan = project.currentPlan;

  const [pageCount, imageCount] = await Promise.all([
    prisma.page.count({ where: { projectId: options.projectId } }),
    prisma.imageAsset.count({ where: { projectId: options.projectId } })
  ]);
  const hasGeneratedArtifacts = pageCount > 0 || imageCount > 0;
  if (options.apply && hasGeneratedArtifacts) {
    throw new Error(`Refusing repair because project already has ${pageCount} pages and ${imageCount} images.`);
  }

  const input = createProjectSchema.parse(currentPlan?.inputSnapshot ?? projectInputFromProject(project));
  const plannerLog = await rawPlannerPayloadFromLog(options.projectId, options.logFile);
  if (plannerLog.purpose === "revise-plan" && !currentPlan) {
    throw new Error(`Project ${options.projectId} needs a current plan to repair a revise-plan log.`);
  }
  const fallback =
    plannerLog.purpose === "revise-plan" && currentPlan
      ? bookPlanSchema.parse(currentPlan.planningPackage)
      : makeFallbackPlan(input);
  const rawText = plannerLog.rawText;
  const rawPlan = JSON.parse(rawText) as unknown;
  const plan = normalizePlanPageTargets(bookPlanSchemaWithFallback(fallback).parse(rawPlan), input.targetPages);
  const latest = await prisma.planVersion.findFirst({
    where: { projectId: options.projectId },
    orderBy: { version: "desc" },
    select: { version: true }
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  const summary = {
    projectId: options.projectId,
    mode: options.apply ? "applied" : "dry-run",
    logPurpose: plannerLog.purpose,
    logFile: plannerLog.logFile,
    oldPlanId: currentPlan?.id ?? null,
    newVersion: nextVersion,
    recoveredTitle: plan.title,
    chapterTitles: plan.chapters.map((chapter) => chapter.title),
    chapterCount: plan.chapters.length,
    researchNoteCount: plan.researchNotes.length,
    pageCount,
    imageCount,
    wouldRefuseApply: hasGeneratedArtifacts
  };

  if (!options.apply) {
    return summary;
  }

  const now = new Date().toISOString();
  const priorMessages = currentPlan && Array.isArray(currentPlan.messages) ? currentPlan.messages : [];
  const newPlan = await prisma.$transaction(async (tx) => {
    if (currentPlan) {
      await tx.planVersion.update({
        where: { id: currentPlan.id },
        data: { status: "SUPERSEDED" }
      });
    }
    const created = await tx.planVersion.create({
      data: {
        projectId: options.projectId,
        version: nextVersion,
        planningPackage: jsonValue(plan),
        inputSnapshot: jsonValue(input),
        messages: jsonValue([
          ...priorMessages,
          {
            role: "system",
            content: "Recovered from the original plan-book run log after planner output normalization was fixed.",
            at: now
          }
        ])
      }
    });
    await tx.project.update({
      where: { id: options.projectId },
      data: { currentPlanId: created.id, status: "PLAN_READY", title: plan.title }
    });
    await tx.character.deleteMany({ where: { projectId: options.projectId } });
    await tx.location.deleteMany({ where: { projectId: options.projectId } });
    await tx.researchSource.deleteMany({ where: { projectId: options.projectId } });
    if (plan.characters.length > 0) {
      await tx.character.createMany({
        data: plan.characters.map((character) => ({
          projectId: options.projectId,
          name: character.name,
          role: character.role,
          description: character.description,
          traits: jsonValue(character.traits),
          visualRules: jsonValue(character.visualRules)
        }))
      });
    }
    if (plan.locations.length > 0) {
      await tx.location.createMany({
        data: plan.locations.map((location) => ({
          projectId: options.projectId,
          name: location.name,
          description: location.description,
          rules: jsonValue(location.rules)
        }))
      });
    }
    if (plan.researchNotes.length > 0) {
      await tx.researchSource.createMany({
        data: plan.researchNotes.map((source) => ({
          projectId: options.projectId,
          query: source.query,
          title: source.title,
          url: source.url ?? null,
          summary: source.summary,
          publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
        }))
      });
    }
    return created;
  });

  return {
    ...summary,
    newPlanId: newPlan.id
  };
}

async function rawPlannerPayloadFromLog(
  projectId: string,
  explicitLogFile: string | undefined
): Promise<{ rawText: string; purpose: PlannerLogPurpose; logFile: string }> {
  const logFile = explicitLogFile ?? (await latestPlanBookLogFile(projectId));
  const content = await readFile(logFile, "utf8");
  for (const line of content.trim().split("\n").reverse()) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as {
      event?: string;
      error?: { context?: { purpose?: string; rawText?: string } };
    };
    if (entry.event === "text.generateJson.error" && entry.error?.context?.rawText) {
      return {
        rawText: entry.error.context.rawText,
        purpose: normalizePlannerPurpose(entry.error.context.purpose) ?? purposeFromLogFile(logFile),
        logFile
      };
    }
  }
  throw new Error(`No planner rawText found in ${logFile}.`);
}

function normalizePlannerPurpose(value: string | undefined): PlannerLogPurpose | undefined {
  return value === "plan-book" || value === "revise-plan" ? value : undefined;
}

function purposeFromLogFile(logFile: string): PlannerLogPurpose {
  return logFile.endsWith("-revise-plan.jsonl") ? "revise-plan" : "plan-book";
}

async function latestPlanBookLogFile(projectId: string): Promise<string> {
  const runDir = path.join(bookStorageDir, projectId, "runs");
  const files = (await readdir(runDir))
    .filter((file) => file.endsWith("-plan-book.jsonl"))
    .sort();
  const file = files.at(-1);
  if (!file) {
    throw new Error(`No plan-book run log found in ${runDir}.`);
  }
  return path.join(runDir, file);
}

function projectInputFromProject(project: {
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
}) {
  return {
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
    mediaSettings: project.mediaSettings
  };
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseArgs(argv: string[]): Args {
  let projectId = "";
  let apply = false;
  let logFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--project") {
      projectId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--log") {
      logFile = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!projectId) {
    throw new Error("Usage: pnpm exec tsx scripts/repair-plan-from-run-log.ts --project <project-id> [--log <path>] [--apply]");
  }
  return { projectId, apply, logFile };
}
