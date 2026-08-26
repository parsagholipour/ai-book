import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeFallbackPlan } from "../prompting/templates.js";
import {
  chapterBriefSchema,
  chapterPlanSchema,
  createProjectSchema,
  pageDraftSchema,
  pageProductionBeatSchema,
  pageQualityReportSchema,
  type ChapterBrief,
  type CreateProjectInput,
  type PageDraft,
  type PageProductionBeat,
  type PageQualityReport
} from "../schemas/book.js";
import type { ReviewPageOptions } from "./pagesReview.js";
import type { PriorPageContext } from "./pagesShared.js";

const SOURCE_IDENTITY_LEAD_REFERENCE =
  /\b(?:archives?|citations?|diar(?:y|ies)|dispatch(?:es)?|documents?|documented (?:civilian|account|testimony|human)|named (?:source|testimony|record|dispatch|archive)|pageBrief'?s? explicit sourc|publications?|records?|sources?|sourced civilian testimony|testimon(?:y|ies)|"one contemporary record"|contemporary reports|photograph caption)\b/i;
const SOURCE_IDENTITY_LEAD_DEMAND =
  /\b(?:could benefit from|does not (?:fulfill|identify|include|name|provide|use)|fails? to|failing|lacks?|missing|no (?:actual|clearly|named|precise|specific)|omit\w*|requested|required|unnamed|without (?:identifying|naming|providing|specifying))\b/i;
const SOURCE_IDENTITY_LEAD_DISCLAIMER =
  /\b(?:acceptable as|brief allows|current page is acceptable|does not (?:attribute|constitute|invent|present|require)|fulfills? (?:the )?(?:brief's )?requirement|general conditions|not (?:a )?rejection reason|this is acceptable)\b/i;

const STILL_REJECT_NEEDLE: Record<number, RegExp> = {
  121: /Camp Hardy|Camp L[ée]opold|Thysville|mutiny/i,
  124: /Lumumba|Thysville|chronolog|January 17/i,
  127: /Tiran|Nasser|22 May/i,
  152: /restage|page 153|closing material|accountability|repatriation/i,
  170: /repeat|chemical|preceding page/i,
  171: /unsupported|insufficiently sourced|factual/i,
  190: /repeat|aftermath|restage|memorial/i
};

type ClassFile = {
  page: number;
  keep_fail: boolean;
  retest: { expected: string };
};

type FrozenUser = {
  book?: {
    title?: string;
    premise?: string;
    audience?: string;
    category?: string;
    subcategory?: string;
    voiceGuide?: string[];
    antiAiRules?: string[];
  };
  chapter?: unknown;
  chapterBrief?: unknown;
  pageBrief?: unknown;
  openingHook?: string;
  pageScope?: {
    chapterPageStart?: number;
    chapterPageEnd?: number;
    previousChapterPageBriefs?: Array<Record<string, unknown>>;
    futureChapterPageBriefs?: Array<Record<string, unknown>>;
  };
  pageIndex?: number;
  draft?: unknown;
  previousPages?: Array<{
    index: number;
    title?: string;
    summary?: string;
    markdown?: string;
    excerpt?: string;
  }>;
  continuityNotes?: string[];
};

export type ReviewPageReplayFixture = {
  page: number;
  fixtureDir: string;
  draftKind: "first" | "leftover";
  expected: string;
  keepFail: boolean;
  input: CreateProjectInput;
  options: Omit<ReviewPageOptions, "textModel">;
  frozen: PageQualityReport;
};

export type ReviewPageReplayVerdict = {
  ok: boolean;
  reason: string;
};

function padPage(page: number): string {
  return String(page).padStart(3, "0");
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function asBeat(raw: unknown, fallbackChapter: number): PageProductionBeat {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return pageProductionBeatSchema.parse({
    pageIndex: record.pageIndex,
    chapterIndex: record.chapterIndex ?? fallbackChapter,
    purpose: record.purpose ?? record.beat ?? "",
    beat: record.beat ?? record.purpose ?? "",
    requiredContinuity: record.requiredContinuity ?? [],
    endingPressure: record.endingPressure ?? ""
  });
}

function chapterPages(user: FrozenUser, current: PageProductionBeat): PageProductionBeat[] {
  const scope = user.pageScope ?? {};
  const previous = (scope.previousChapterPageBriefs ?? []).map((item) => asBeat(item, current.chapterIndex));
  const future = (scope.futureChapterPageBriefs ?? []).map((item) => asBeat(item, current.chapterIndex));
  return [...previous, current, ...future];
}

function priorPages(raw: FrozenUser["previousPages"]): PriorPageContext[] {
  return (raw ?? []).map((page) => ({
    index: page.index,
    title: page.title ?? "",
    markdown: page.markdown ?? page.excerpt ?? "",
    summary: page.summary ?? ""
  }));
}

function stripHeading(markdown: string, title: string): string {
  const trimmed = markdown.replace(/^\uFEFF/, "");
  const heading = `# ${title}`.toLowerCase();
  const lines = trimmed.split(/\r?\n/);
  const first = lines[0]?.trim().toLowerCase();
  if (first === heading || first === `# ${title.toLowerCase()}`) {
    return lines.slice(1).join("\n").replace(/^\n+/, "");
  }
  return trimmed;
}

export async function loadReviewPageReplayFixture(
  fixtureRoot: string,
  page: number,
  draftKind: "first" | "leftover" = "first"
): Promise<ReviewPageReplayFixture> {
  const fixtureDir = join(fixtureRoot, "fixtures", `page-${padPage(page)}`);
  const klass = await readJson<ClassFile>(join(fixtureDir, "CLASS.json"));
  const user = await readJson<FrozenUser>(join(fixtureDir, "first-review-user.json"));
  const frozen = pageQualityReportSchema.parse(await readJson(join(fixtureDir, "first-review-response.json")));
  const project = await readJson<{ mediaSettings?: unknown }>(join(fixtureRoot, "project.json"));
  const pageBrief = pageProductionBeatSchema.parse(await readJson(join(fixtureDir, "page-brief.json")));
  const book = user.book ?? {};
  const input = createProjectSchema.parse({
    title: book.title,
    prompt: book.premise ?? "Replay a frozen review-page fixture from a 200-page history book.",
    category: book.category ?? "CUSTOM",
    ...(book.subcategory ? { subcategory: book.subcategory } : {}),
    targetPages: 200,
    complexity: 5,
    temperature: 0.8,
    mediaSettings: project.mediaSettings
  });

  const fallback = makeFallbackPlan(input);
  const plan = {
    ...fallback,
    title: book.title ?? fallback.title,
    premise: book.premise ?? fallback.premise,
    audience: book.audience ?? fallback.audience,
    ...(book.voiceGuide && book.voiceGuide.length > 0 ? { voiceGuide: book.voiceGuide } : {}),
    ...(book.antiAiRules && book.antiAiRules.length > 0 ? { antiAiRules: book.antiAiRules } : {}),
    researchNotes: [],
    ...(typeof user.openingHook === "string" && user.openingHook.trim()
      ? { openingHook: user.openingHook.trim() }
      : {})
  };
  const chapter = user.chapter ? chapterPlanSchema.parse(user.chapter) : undefined;
  const pages = chapterPages(user, pageBrief);
  const chapterBrief: ChapterBrief | undefined = user.chapterBrief
    ? chapterBriefSchema.parse({
        ...(user.chapterBrief as object),
        pages
      })
    : undefined;

  let draft: PageDraft;
  if (draftKind === "leftover") {
    const leftoverMeta = await readJson<{ title: string; summary: string }>(join(fixtureDir, "leftover.json"));
    const leftoverMarkdown = await readFile(join(fixtureDir, "leftover.md"), "utf8");
    draft = pageDraftSchema.parse({
      title: leftoverMeta.title,
      markdown: stripHeading(leftoverMarkdown, leftoverMeta.title),
      summary: leftoverMeta.summary,
      continuityNotes: []
    });
  } else {
    draft = pageDraftSchema.parse(user.draft);
  }

  const options: Omit<ReviewPageOptions, "textModel"> = {
    input,
    plan,
    ...(chapter ? { chapter } : {}),
    ...(chapterBrief ? { chapterBrief } : {}),
    pageBrief,
    ...(typeof user.pageScope?.chapterPageStart === "number"
      ? { chapterPageStart: user.pageScope.chapterPageStart }
      : {}),
    ...(typeof user.pageScope?.chapterPageEnd === "number"
      ? { chapterPageEnd: user.pageScope.chapterPageEnd }
      : {}),
    pageIndex: user.pageIndex ?? page,
    draft,
    previousPages: priorPages(user.previousPages),
    continuityNotes: user.continuityNotes ?? [],
    researchNotes: []
  };

  return {
    page,
    fixtureDir,
    draftKind,
    expected: page === 22 ? "must-not-reject-as-fabricated" : klass.retest.expected,
    keepFail: page === 22 ? false : klass.keep_fail,
    input,
    options,
    frozen
  };
}

export function evaluateReviewPageReplay(
  fixture: ReviewPageReplayFixture,
  report: PageQualityReport
): ReviewPageReplayVerdict {
  if (fixture.expected === "must-not-reject-as-fabricated") {
    return report.approved
      ? { ok: true, reason: "fabrication-only concern no longer rejects the page" }
      : { ok: false, reason: "page still rejected after fabrication-only concerns were made non-blocking" };
  }

  if (fixture.expected === "must-not-lead-with-missing-named-source") {
    const firstIssue = report.issues[0] ?? "";
    if (
      SOURCE_IDENTITY_LEAD_REFERENCE.test(firstIssue) &&
      SOURCE_IDENTITY_LEAD_DEMAND.test(firstIssue) &&
      !SOURCE_IDENTITY_LEAD_DISCLAIMER.test(firstIssue)
    ) {
      return { ok: false, reason: "issue 1 still demands a named source the notes never contained" };
    }
    return { ok: true, reason: "did not lead with a missing-named-source complaint" };
  }

  const needle = STILL_REJECT_NEEDLE[fixture.page];
  if (report.approved) {
    return { ok: false, reason: "guard page was approved" };
  }
  const blob = report.issues.join("\n");
  if (needle && !needle.test(blob)) {
    return { ok: false, reason: `rejected, but issues do not mention the known defect (${needle})` };
  }
  return { ok: true, reason: "still rejected for the known defect" };
}

export async function writeLastReviewPageReplay(
  fixture: ReviewPageReplayFixture,
  report: PageQualityReport,
  verdict: ReviewPageReplayVerdict
): Promise<Record<string, unknown>> {
  const comparison = {
    page: fixture.page,
    draft: fixture.draftKind,
    expected: fixture.expected,
    keep_fail: fixture.keepFail,
    frozen: {
      approved: fixture.frozen.approved,
      score: fixture.frozen.score,
      firstIssue: fixture.frozen.issues[0] ?? ""
    },
    live: {
      approved: report.approved,
      score: report.score,
      firstIssue: report.issues[0] ?? "",
      issues: report.issues,
      requiredRevisions: report.requiredRevisions,
      notes: report.notes
    },
    cliffWouldBlock: report.score >= 0 && report.score < 75 && report.approved === false,
    verdict
  };

  await mkdir(fixture.fixtureDir, { recursive: true });
  await writeFile(join(fixture.fixtureDir, "last-replay.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  return comparison;
}
