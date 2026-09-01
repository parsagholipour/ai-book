import { z, type ZodType } from "zod";
import { validationIssuesFrom } from "../adapters/json.js";
import { range } from "../collections.js";
import { chapterBriefSchema, type ChapterBrief, type PageProductionBeat } from "../schemas/book.js";
import {
  MODEL_CHAPTER_INDEX_KEYS,
  MODEL_PAGE_ARRAY_KEYS,
  MODEL_PAGE_BEAT_KEYS,
  MODEL_PAGE_CONTINUITY_KEYS,
  MODEL_PAGE_ENDING_PRESSURE_KEYS,
  MODEL_PAGE_IMAGE_MOMENT_KEYS,
  MODEL_PAGE_INDEX_KEYS,
  MODEL_PAGE_PURPOSE_KEYS
} from "./generatedPageResponse.js";
import { arrayLikeField, integerField, isRecord, stringArrayField, stringField } from "./pagesShared.js";

export type GeneratedChapterBriefContract = {
  chapterIndex: number;
  pageRange: { start: number; end: number };
  allowCompleteLocalPageNumbering: boolean;
};

const PAGE_MAP_RESPONSE_VIOLATION_CODES = [
  "CHAPTER_BRIEF_NOT_OBJECT",
  "PAGE_ARRAY_MISSING",
  "PAGE_NOT_OBJECT",
  "PAGE_INDEX_INVALID",
  "PURPOSE_NOT_SUBSTANTIVE",
  "BEAT_NOT_SUBSTANTIVE",
  "ENDING_PRESSURE_NOT_SUBSTANTIVE",
  "CHAPTER_INDEX_MISMATCH",
  "DUPLICATE_PAGE_INDEX",
  "MISSING_PAGE_INDEX",
  "EXTRA_PAGE_INDEX",
  "PAGE_INDEX_OUT_OF_ORDER",
  "MIXED_PAGE_NUMBERING"
] as const;

type PageMapResponseViolationCode = (typeof PAGE_MAP_RESPONSE_VIOLATION_CODES)[number];

type PageMapResponseViolation = {
  code: PageMapResponseViolationCode;
  indexes: number[];
};

const ROOT_WRAPPER_KEYS = ["chapterBrief", "brief", "productionBrief", "data", "result"];
const CHAPTER_TITLE_KEYS = ["title", "chapterTitle", "name"];
const CHAPTER_SUMMARY_KEYS = ["summary", "chapterSummary", "overview", "description"];
const CHAPTER_CONTINUITY_KEYS = ["continuityFocus", "continuity", "continuityNotes", "requiredContinuity"];
const METADATA_TOKENS = new Set(
  [
    ...ROOT_WRAPPER_KEYS,
    ...MODEL_PAGE_ARRAY_KEYS,
    ...MODEL_PAGE_INDEX_KEYS,
    ...MODEL_CHAPTER_INDEX_KEYS,
    ...MODEL_PAGE_PURPOSE_KEYS,
    ...MODEL_PAGE_BEAT_KEYS,
    ...MODEL_PAGE_CONTINUITY_KEYS,
    ...MODEL_PAGE_ENDING_PRESSURE_KEYS,
    ...MODEL_PAGE_IMAGE_MOMENT_KEYS,
    ...CHAPTER_TITLE_KEYS,
    ...CHAPTER_SUMMARY_KEYS,
    ...CHAPTER_CONTINUITY_KEYS,
    "field",
    "fields",
    "schema"
  ].flatMap((fieldName) => normalizeAssignment(fieldName).split(" "))
);
const GENERIC_PLACEHOLDER_TOKENS = new Set([
  "introduction",
  "intro",
  "continue",
  "continuation",
  "tension",
  "conclusion",
  "recap",
  "overview",
  "transition",
  "setup",
  "development",
  "climax",
  "filler",
  "beginning",
  "middle",
  "start",
  "close",
  "closing",
  "hook",
  "ending"
]);

export class PageMapResponseInvalidError extends Error {
  readonly code = "PAGE_MAP_RESPONSE_INVALID" as const;

  constructor(
    readonly chapterIndex: number,
    readonly expectedRange: { start: number; end: number },
    readonly violations: PageMapResponseViolation[]
  ) {
    const codes = [...new Set(violations.map((violation) => violation.code))];
    super(
      `Chapter ${chapterIndex} page map was invalid for pages ${expectedRange.start}-${expectedRange.end} (${codes.join(", ")}).`
    );
    this.name = "PageMapResponseInvalidError";
  }
}

export function decodeGeneratedChapterBrief(
  raw: unknown,
  contract: GeneratedChapterBriefContract
): ChapterBrief {
  const expectedIndexes = range(contract.pageRange.start, contract.pageRange.end);
  const response = readGeneratedPageResponse(raw, ROOT_WRAPPER_KEYS);
  if (!response.rootRecord) {
    throw invalid(contract, [{ code: "CHAPTER_BRIEF_NOT_OBJECT", indexes: [] }]);
  }

  const rawRecord = raw as Record<string, unknown>;
  const chapterRecord = response.rootRecord;
  const violations: PageMapResponseViolation[] = [];
  const pageItems = response.pageItems;
  if (!pageItems) {
    violations.push({ code: "PAGE_ARRAY_MISSING", indexes: expectedIndexes });
    throw invalid(contract, coalesceViolations(violations));
  }

  const nonObjectIndexes = pageItems.flatMap((page, position) =>
    isRecord(page) ? [] : [expectedIndexes[position] ?? contract.pageRange.start + position]
  );
  if (nonObjectIndexes.length > 0) {
    violations.push({ code: "PAGE_NOT_OBJECT", indexes: nonObjectIndexes });
    throw invalid(contract, coalesceViolations(violations));
  }

  const pages = pageItems.map((item, position) => {
    const assignment = readGeneratedPageAssignment(item);
    const pageIndex = assignment.pageIndex;
    const affectedIndex = pageIndex ?? expectedIndexes[position] ?? contract.pageRange.start + position;
    if (pageIndex === undefined || pageIndex < 1) {
      violations.push({ code: "PAGE_INDEX_INVALID", indexes: [affectedIndex] });
    }

    const purpose = substantiveValue(assignment.purpose);
    const beat = substantiveValue(assignment.beat);
    const endingPressure = substantiveValue(assignment.endingPressure);
    if (!purpose) {
      violations.push({ code: "PURPOSE_NOT_SUBSTANTIVE", indexes: [affectedIndex] });
    }
    if (!beat) {
      violations.push({ code: "BEAT_NOT_SUBSTANTIVE", indexes: [affectedIndex] });
    }
    if (!endingPressure) {
      violations.push({ code: "ENDING_PRESSURE_NOT_SUBSTANTIVE", indexes: [affectedIndex] });
    }

    const imageMoment = assignment.imageMoment;
    return {
      pageIndex: pageIndex ?? affectedIndex,
      chapterIndex: contract.chapterIndex,
      purpose: purpose ?? "",
      beat: beat ?? "",
      requiredContinuity: assignment.requiredContinuity.map((continuity) => continuity.trim()),
      endingPressure: endingPressure ?? "",
      ...(imageMoment?.trim() ? { imageMoment: imageMoment.trim() } : {})
    } satisfies PageProductionBeat;
  });

  violations.push(...numberingViolations(pages.map((page) => page.pageIndex), expectedIndexes, contract));
  if (violations.length > 0) {
    throw invalid(contract, coalesceViolations(violations));
  }

  const localIndexes = range(1, expectedIndexes.length);
  const orderedPages = [...pages].sort((left, right) => left.pageIndex - right.pageIndex);
  const usesLocalPageNumbers =
    contract.allowCompleteLocalPageNumbering
    && arraysEqual(orderedPages.map((page) => page.pageIndex), localIndexes);
  const normalizedPages = orderedPages.map((page) => ({
    ...page,
    pageIndex: usesLocalPageNumbers ? expectedIndexes[page.pageIndex - 1]! : page.pageIndex,
    chapterIndex: contract.chapterIndex
  }));

  // Local numbering is accepted only as an input convention. The remapped
  // result must satisfy the same complete global contract before it can leave
  // this seam.
  const finalViolations = validateNormalizedPages(normalizedPages, expectedIndexes, contract);
  if (finalViolations.length > 0) {
    throw invalid(contract, coalesceViolations(finalViolations));
  }

  const title = stringField(chapterRecord, CHAPTER_TITLE_KEYS)
    ?? stringField(rawRecord, CHAPTER_TITLE_KEYS)
    ?? "";
  const summary = stringField(chapterRecord, CHAPTER_SUMMARY_KEYS)
    ?? stringField(rawRecord, CHAPTER_SUMMARY_KEYS)
    ?? "";

  return chapterBriefSchema.parse({
    chapterIndex: contract.chapterIndex,
    title: title.trim(),
    summary: summary.trim(),
    pages: normalizedPages,
    continuityFocus: (stringArrayField(chapterRecord, CHAPTER_CONTINUITY_KEYS) ?? []).map((item) => item.trim())
  });
}

export function generatedChapterBriefResponseSchema(
  contract: GeneratedChapterBriefContract
): ZodType<ChapterBrief> {
  return z.preprocess((raw, context) => {
    try {
      return decodeGeneratedChapterBrief(raw, contract);
    } catch (error) {
      if (!(error instanceof PageMapResponseInvalidError)) {
        throw error;
      }
      for (const violation of error.violations) {
        context.addIssue({
          code: "custom",
          message: `${violation.code}: ${violation.indexes.length > 0 ? `indexes ${violation.indexes.join(", ")}` : "chapter response"}`,
          params: { pageMapResponseViolation: violation }
        });
      }
      return z.NEVER;
    }
  }, chapterBriefSchema);
}

export function pageMapResponseInvalidErrorFromSchemaError(
  error: unknown,
  contract: GeneratedChapterBriefContract
): PageMapResponseInvalidError | undefined {
  const violations = pageMapResponseViolationsFromIssues(validationIssuesFrom(error) ?? []);
  return violations.length > 0 ? invalid(contract, coalesceViolations(violations)) : undefined;
}

/** Machine-only violation codes from a schema or adapter validation error. */
export function pageMapResponseViolationCodesFromError(error: unknown): string[] {
  const codes: string[] = [];
  for (const violation of pageMapResponseViolationsFromIssues(validationIssuesFrom(error) ?? [])) {
    if (!codes.includes(violation.code)) {
      codes.push(violation.code);
    }
    if (codes.length >= 16) {
      break;
    }
  }
  return codes;
}

type GeneratedPageAssignment = {
  pageIndex?: number;
  purpose?: string;
  beat?: string;
  requiredContinuity: string[];
  endingPressure?: string;
  imageMoment?: string;
};

type GeneratedPageResponse = {
  rootRecord?: Record<string, unknown>;
  pageItems?: unknown[];
};

/**
 * Strict chapter-brief envelope reading. Only named wrappers unwrap; arbitrary
 * nested objects are not searched. Whole-book map discovery stays in
 * `pagesPageMap.ts` so that path's fallback boundary is independent of this seam.
 */
function readGeneratedPageResponse(
  raw: unknown,
  wrapperKeys: readonly string[]
): GeneratedPageResponse {
  if (!isRecord(raw)) {
    return {};
  }
  const rootRecord = unwrapStrictRoot(raw, wrapperKeys);
  const pageItems = directPageItems(rootRecord) ?? directPageItems(raw);
  return {
    rootRecord,
    ...(pageItems != null ? { pageItems } : {})
  };
}

/** Shared alias and type reading; acceptance policy is applied by the caller. */
function readGeneratedPageAssignment(value: unknown): GeneratedPageAssignment {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    return {
      requiredContinuity: []
    };
  }
  const pageIndex = integerField(record, MODEL_PAGE_INDEX_KEYS);
  const purpose = stringField(record, [...MODEL_PAGE_PURPOSE_KEYS]);
  const beat = stringField(record, [...MODEL_PAGE_BEAT_KEYS]);
  const endingPressure = stringField(record, [...MODEL_PAGE_ENDING_PRESSURE_KEYS]);
  const imageMoment = stringField(record, [...MODEL_PAGE_IMAGE_MOMENT_KEYS]);
  return {
    ...(pageIndex != null ? { pageIndex } : {}),
    ...(purpose != null ? { purpose } : {}),
    ...(beat != null ? { beat } : {}),
    requiredContinuity: stringArrayField(record, [...MODEL_PAGE_CONTINUITY_KEYS]) ?? [],
    ...(endingPressure != null ? { endingPressure } : {}),
    ...(imageMoment != null ? { imageMoment } : {})
  };
}

function unwrapStrictRoot(
  root: Record<string, unknown>,
  wrapperKeys: readonly string[]
): Record<string, unknown> {
  let current = root;
  const visited = new Set<Record<string, unknown>>();
  while (!visited.has(current)) {
    visited.add(current);
    const nested = wrapperKeys.map((key) => current[key]).find(isRecord);
    if (!nested) {
      break;
    }
    current = nested;
  }
  return current;
}

function directPageItems(record: Record<string, unknown>): unknown[] | undefined {
  for (const key of MODEL_PAGE_ARRAY_KEYS) {
    const arrayValue = arrayLikeField(record, key);
    if (arrayValue) {
      return arrayValue;
    }
    const value = record[key];
    if (isRecord(value)) {
      return Object.values(value);
    }
  }
  return undefined;
}

function pageMapResponseViolationsFromIssues(issues: unknown[]): PageMapResponseViolation[] {
  return issues.flatMap((issue) => {
    if (!isRecord(issue) || issue.code !== "custom" || !isRecord(issue.params)) {
      return [];
    }
    const violation = issue.params.pageMapResponseViolation;
    return isPageMapResponseViolation(violation) ? [violation] : [];
  });
}

function invalid(
  contract: GeneratedChapterBriefContract,
  violations: PageMapResponseViolation[]
): PageMapResponseInvalidError {
  return new PageMapResponseInvalidError(contract.chapterIndex, contract.pageRange, violations);
}

function isPageMapResponseViolation(value: unknown): value is PageMapResponseViolation {
  if (!isRecord(value) || typeof value.code !== "string" || !Array.isArray(value.indexes)) {
    return false;
  }
  return (
    PAGE_MAP_RESPONSE_VIOLATION_CODES.includes(value.code as PageMapResponseViolationCode)
    && value.indexes.every((index) => Number.isInteger(index))
  );
}

function substantiveValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && isSubstantivePageAssignment(value) ? value : undefined;
}

/**
 * Whether a purpose, beat, or ending-pressure string is real assigned work
 * rather than a generic production template or metadata-only placeholder.
 * Phase 01 uses this to refuse generated chapter-brief fields; Phase 02 uses
 * the same predicate on a finished map, including whole-book briefs that never
 * passed `decodeGeneratedChapterBrief`.
 */
export function isSubstantivePageAssignment(value: string): boolean {
  const normalized = normalizeAssignment(value);
  if (!normalized) {
    return false;
  }
  if (
    /^(?:advance|develop) (?:the )?(?:book|chapter)(?: (?:on|for))?(?: page \d+)?$/.test(normalized)
    || /^advance (?:the )?(?:book|chapter) with (?:a )?concrete non repetitive beat (?:on|for) page \d+$/.test(normalized)
    || /^(?:a )?concrete (?:beat|turn) for page \d+$/.test(normalized)
    || /^leave (?:a )?concrete reason for (?:the )?next page to continue$/.test(normalized)
    || /^(?:a )?(?:concrete )?reason page \d+ must continue$/.test(normalized)
    || /^(?:pageindex )?(?:global )?(?:page )?\d+$/.test(normalized)
  ) {
    return false;
  }

  const contentTokens = normalized
    .split(" ")
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !METADATA_TOKENS.has(token));
  return contentTokens.some((token) => !GENERIC_PLACEHOLDER_TOKENS.has(token));
}

function normalizeAssignment(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function numberingViolations(
  indexes: number[],
  expectedIndexes: number[],
  contract: GeneratedChapterBriefContract
): PageMapResponseViolation[] {
  const violations: PageMapResponseViolation[] = [];
  const localIndexes = range(1, expectedIndexes.length);
  const expectedSet = new Set(expectedIndexes);
  const localSet = new Set(localIndexes);
  const duplicates = duplicateIndexes(indexes);
  if (duplicates.length > 0) {
    violations.push({ code: "DUPLICATE_PAGE_INDEX", indexes: duplicates });
  }

  const exactGlobalSet = sameIndexSet(indexes, expectedIndexes);
  const exactLocalSet = contract.allowCompleteLocalPageNumbering && sameIndexSet(indexes, localIndexes);
  const hasLocalOnly = indexes.some((index) => localSet.has(index) && !expectedSet.has(index));
  const hasGlobalOnly = indexes.some((index) => expectedSet.has(index) && !localSet.has(index));
  if (hasLocalOnly && hasGlobalOnly) {
    violations.push({ code: "MIXED_PAGE_NUMBERING", indexes: [...indexes] });
  }

  if (exactGlobalSet || exactLocalSet) {
    return violations;
  }

  const missing = expectedIndexes.filter((index) => !indexes.includes(index));
  if (missing.length > 0) {
    violations.push({ code: "MISSING_PAGE_INDEX", indexes: missing });
  }
  const extra = [...new Set(indexes.filter((index) => !expectedSet.has(index)))];
  if (extra.length > 0) {
    violations.push({ code: "EXTRA_PAGE_INDEX", indexes: extra });
  }
  return violations;
}

function validateNormalizedPages(
  pages: PageProductionBeat[],
  expectedIndexes: number[],
  contract: GeneratedChapterBriefContract
): PageMapResponseViolation[] {
  const violations = numberingViolations(pages.map((page) => page.pageIndex), expectedIndexes, {
    ...contract,
    allowCompleteLocalPageNumbering: false
  });
  for (const page of pages) {
    if (!isSubstantivePageAssignment(page.purpose)) {
      violations.push({ code: "PURPOSE_NOT_SUBSTANTIVE", indexes: [page.pageIndex] });
    }
    if (!isSubstantivePageAssignment(page.beat)) {
      violations.push({ code: "BEAT_NOT_SUBSTANTIVE", indexes: [page.pageIndex] });
    }
    if (!isSubstantivePageAssignment(page.endingPressure)) {
      violations.push({ code: "ENDING_PRESSURE_NOT_SUBSTANTIVE", indexes: [page.pageIndex] });
    }
  }
  return violations;
}

function coalesceViolations(violations: PageMapResponseViolation[]): PageMapResponseViolation[] {
  const byCode = new Map<PageMapResponseViolationCode, number[]>();
  for (const violation of violations) {
    const indexes = byCode.get(violation.code) ?? [];
    for (const index of violation.indexes) {
      if (!indexes.includes(index)) {
        indexes.push(index);
      }
    }
    byCode.set(violation.code, indexes);
  }
  return [...byCode].map(([code, indexes]) => ({ code, indexes }));
}

function duplicateIndexes(indexes: number[]): number[] {
  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const index of indexes) {
    if (seen.has(index) && !duplicates.includes(index)) {
      duplicates.push(index);
    }
    seen.add(index);
  }
  return duplicates;
}

function sameIndexSet(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && expected.every((index) => actual.filter((value) => value === index).length === 1);
}

function arraysEqual(first: number[], second: number[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
