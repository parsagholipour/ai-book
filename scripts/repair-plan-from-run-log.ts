import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createProjectSchema, makeFallbackPlan, normalizePlanPageTargets, bookPlanSchemaWithFallback } from "../packages/core/src/index.ts";
import { Prisma, prisma } from "../packages/db/src/index.ts";

type Args = {
  projectId: string;
  apply: boolean;
  logFile?: string | undefined;
};

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
  if (!project?.currentPlan) {
    throw new Error(`Project ${options.projectId} does not have a current plan.`);
  }

  const [pageCount, imageCount] = await Promise.all([
    prisma.page.count({ where: { projectId: options.projectId } }),
    prisma.imageAsset.count({ where: { projectId: options.projectId } })
  ]);
  const hasGeneratedArtifacts = pageCount > 0 || imageCount > 0;
  if (options.apply && hasGeneratedArtifacts) {
    throw new Error(`Refusing repair because project already has ${pageCount} pages and ${imageCount} images.`);
  }

  const input = createProjectSchema.parse(project.currentPlan.inputSnapshot ?? projectInputFromProject(project));
  const rawText = await rawPlannerTextFromLog(options.projectId, options.logFile);
  const rawPlan = JSON.parse(rawText) as unknown;
  const fallback = makeFallbackPlan(input);
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
    oldPlanId: project.currentPlan.id,
    newVersion: nextVersion,
    recoveredTitle: plan.title,
    chapterTitles: plan.chapters.map((chapter) => chapter.title),
    chapterCount: plan.chapters.length,
    pageCount,
    imageCount,
    wouldRefuseApply: hasGeneratedArtifacts
  };

  if (!options.apply) {
    return summary;
  }

  const now = new Date().toISOString();
  const priorMessages = Array.isArray(project.currentPlan.messages) ? project.currentPlan.messages : [];
  const newPlan = await prisma.$transaction(async (tx) => {
    await tx.planVersion.update({
      where: { id: project.currentPlan!.id },
      data: { status: "SUPERSEDED" }
    });
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
            content: "Recovered from the original plan-book run log after planner wrapper normalization was fixed.",
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
    return created;
  });

  return {
    ...summary,
    newPlanId: newPlan.id
  };
}

async function rawPlannerTextFromLog(projectId: string, explicitLogFile: string | undefined): Promise<string> {
  const logFile = explicitLogFile ?? (await latestPlanBookLogFile(projectId));
  const content = await readFile(logFile, "utf8");
  for (const line of content.trim().split("\n").reverse()) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as {
      event?: string;
      error?: { context?: { rawText?: string } };
    };
    if (entry.event === "text.generateJson.error" && entry.error?.context?.rawText) {
      return entry.error.context.rawText;
    }
  }
  throw new Error(`No planner rawText found in ${logFile}.`);
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
