import { figureFreeProse, figureStandInMarkdown, findFigureFences, hasFigureFence, pageFigureSpecs, validateFigureFences } from "./figures/figureBlocks.js";
import { pageDraftSummary } from "./figures/figureDraftSummary.js";
import { mentionsFigure } from "./figures/figureMentions.js";
import type { FigureSpec } from "./figures/figureSpec.js";

/**
 * What the Quick Draft compile repair reads, and what a figure patch may do.
 *
 * The repair used to send every page in full to both its proposal and its
 * verification (94k of a 30-page novel's 249k input tokens, with the re-screen,
 * to patch one page). A repair is about one to three pages, the pages its
 * findings quote and the pages beside them; the rest of the book is an outline
 * of titles and summaries, plus every page that repeats a number or a name the
 * repair changed, which code finds rather than a model.
 */

export type QuickDraftRepairPage = { index: number; title: string; markdown: string; summary: string };
export type QuickDraftRepairFinding = {
  targets: number[]; kind: string; problem: string; fix: string;
  evidence: { pageIndex: number; quote: string }[];
};

/** Pages a repair is shown in full beside its targets: the findings' evidence, any page the instruction names, and both neighbours. */
export function quickDraftRepairScope(options: {
  pages: readonly QuickDraftRepairPage[]; targets: readonly number[];
  findings: readonly QuickDraftRepairFinding[]; instruction: string;
}): { context: number[]; figurePages: Set<number> } {
  const exists = new Set(options.pages.map((page) => page.index));
  const findings = relevantFindings(options.findings, options.targets);
  const wanted = new Set<number>(options.targets);
  for (const target of options.targets) { wanted.add(target - 1); wanted.add(target + 1); }
  for (const finding of findings) for (const item of finding.evidence) wanted.add(item.pageIndex);
  for (const match of options.instruction.matchAll(/\bpages?\s+(\d{1,4})(?:\s*(?:[-–]|and|,)\s*(\d{1,4}))?/giu))
    for (const value of [match[1], match[2]]) if (value) wanted.add(Number(value));
  const context = [...wanted].filter((index) => exists.has(index)).sort((a, b) => a - b);
  const figurePages = new Set<number>();
  for (const page of options.pages) {
    if (!context.includes(page.index) || !hasFigureFence(page.markdown)) continue;
    const about = findings.filter((finding) => finding.targets.includes(page.index) || finding.evidence.some((item) => item.pageIndex === page.index));
    const quoted = about.some((finding) => finding.evidence.some((item) => item.pageIndex === page.index && quotesFigure(page.markdown, item.quote)));
    const named = about.some((finding) => finding.targets.includes(page.index) && mentionsFigure(`${finding.problem} ${finding.fix}`, pageFigureSpecs(page.markdown)));
    // Without structured findings (a review stored before they were kept) the instruction is all there is.
    const instructed = findings.length === 0 && options.targets.includes(page.index) && mentionsFigure(options.instruction, pageFigureSpecs(page.markdown));
    if (quoted || named || instructed) figurePages.add(page.index);
  }
  return { context, figurePages };
}

export function relevantFindings(findings: readonly QuickDraftRepairFinding[], targets: readonly number[]): QuickDraftRepairFinding[] {
  return findings.filter((finding) => finding.targets.some((index) => targets.includes(index)));
}

/** A finding's quote that is found inside a figure block's JSON rather than in the prose around it. */
function quotesFigure(markdown: string, quote: string): boolean {
  const needle = fold(quote);
  if (!needle || fold(figureFreeProse(markdown)).includes(needle)) return false;
  return findFigureFences(markdown).some((fence) => fold(fence.raw).includes(needle));
}

const fold = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The page as a repair call sees it: its figure's JSON only where a finding is about the figure. */
export function quickDraftRepairView(page: QuickDraftRepairPage, figurePages: ReadonlySet<number>): string {
  return figurePages.has(page.index) ? page.markdown : figureStandInMarkdown(page.markdown);
}

/** Every other page as one line: enough to follow a reference, never enough to patch. */
export function quickDraftRepairOutline(pages: readonly QuickDraftRepairPage[], exclude: ReadonlySet<number>) {
  const limit = pages.length <= 30 ? 240 : pages.length <= 80 ? 180 : 130;
  return pages.filter((page) => !exclude.has(page.index)).map((page) => {
    const summary = pageDraftSummary(page.markdown, page.summary).replace(/\s+/gu, " ").trim();
    return { index: page.index, title: page.title, summary: summary.length > limit ? `${summary.slice(0, limit - 1).replace(/\s+\S*$/u, "")}…` : summary };
  });
}

export type FigurePatchFailure = { reason: "figure_changed" | "figure_invalid" | "figure_kind_changed" | "figure_invented_value"; detail: string };

/**
 * A patched page's figures against the stored page's. Outside a finding's scope
 * a figure stays byte for byte. In scope, each block must still parse, keep its
 * kind and use only numbers already in the block or the page's prose; it may
 * also be removed whole (a chart of values nobody has is fixed by not drawing it).
 * The accepted page stores each kept block in its canonical one-line form.
 */
export function checkQuickDraftFigurePatch(before: string, after: string, inScope: boolean): { markdown: string; failures: FigurePatchFailure[] } {
  const original = findFigureFences(before);
  const next = findFigureFences(after);
  if (original.length === 0 && next.length === 0) return { markdown: after, failures: [] };
  if (next.length === original.length && next.every((fence, i) => fence.raw === original[i]!.raw)) return { markdown: after, failures: [] };
  if (!inScope) return { markdown: before, failures: [{ reason: "figure_changed", detail: "This page's figure is not what the finding is about; leave the [Figure: …] line and its block untouched." }] };
  if (next.length > original.length) return { markdown: before, failures: [{ reason: "figure_invalid", detail: "A repair may change or remove an existing figure, never add one." }] };
  const failures: FigurePatchFailure[] = [];
  const allowed = new Set([...numbersIn(figureFreeProse(before)), ...numbersIn(figureFreeProse(after)),
    ...original.flatMap((fence) => (fence.spec ? figureNumbers(fence.spec) : numbersIn(fence.body)))]);
  for (const fence of next) {
    const was = original.find((candidate) => candidate.title !== undefined && candidate.title === fence.title) ??
      (next.length === original.length ? original[next.indexOf(fence)] : undefined);
    if (!fence.closed || !fence.spec) {
      failures.push({ reason: "figure_invalid", detail: `The figure JSON must stay one valid figure: ${validateFigureFences(fence.raw, { max: 1 }).dropped[0]?.reason ?? "unreadable"}.` });
      continue;
    }
    if (was?.spec && was.spec.kind !== fence.spec.kind)
      failures.push({ reason: "figure_kind_changed", detail: `A ${was.spec.kind} figure must stay a ${was.spec.kind} figure.` });
    const invented = figureNumbers(fence.spec).filter((value) => !allowed.has(value));
    if (invented.length)
      failures.push({ reason: "figure_invented_value", detail: `Every number in the figure must already appear in the block or in the page's prose; not found: ${invented.slice(0, 6).join(", ")}.` });
  }
  if (failures.length) return { markdown: before, failures };
  return { markdown: validateFigureFences(after, { max: next.length }).markdown, failures: [] };
}

/** Numbers as values: thousands separators dropped, trailing zeros of a decimal ignored. */
export function numbersIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\d{1,3}(?:[,\u00a0\u202f ]\d{3}(?!\d))+(?:\.\d+)?|\d+(?:\.\d+)?/gu)) {
    const value = Number(match[0].replace(/[,\u00a0\u202f ]/gu, ""));
    if (Number.isFinite(value)) found.push(String(value));
  }
  return found;
}

function figureNumbers(spec: FigureSpec): string[] {
  const texts = [spec.title, spec.caption ?? "", spec.source];
  const values: string[] = [];
  if (spec.kind === "flow") {
    texts.push(...spec.nodes.map((node) => node.label), ...spec.edges.map((edge) => edge.label ?? ""));
  } else {
    texts.push(...spec.categories, ...spec.series.map((series) => series.name), spec.unit ?? "");
    for (const series of spec.series) values.push(...series.values.map((value) => String(value)));
  }
  return [...new Set([...values, ...texts.flatMap((text) => numbersIn(text))])];
}

const TOKEN = /\p{Lu}[\p{L}\p{M}'’-]{2,}|\d[\d,.]*\d|\d/gu;

/**
 * Unchanged pages that repeat a number or a name the repair removed or added,
 * found in code over the whole book: the reviewer follows a changed clue into
 * the pages that carry it without being sent the book. A token on many pages
 * (the hero's name, a sentence-initial word) says nothing about any one of them.
 */
export function quickDraftRepairEchoPages(options: {
  pages: readonly QuickDraftRepairPage[]; changed: readonly { index: number; before: string; after: string }[];
  exclude: ReadonlySet<number>; limit?: number;
}): number[] {
  const tokens = new Set<string>();
  for (const change of options.changed) {
    const before = new Set(change.before.match(TOKEN) ?? []);
    const after = new Set(change.after.match(TOKEN) ?? []);
    for (const token of before) if (!after.has(token)) tokens.add(token);
    for (const token of after) if (!before.has(token)) tokens.add(token);
  }
  if (tokens.size === 0) return [];
  const pageTokens = new Map(options.pages.map((page) => [page.index, new Set(page.markdown.match(TOKEN) ?? [])]));
  const common = Math.max(6, Math.ceil(options.pages.length * 0.2));
  const rare = [...tokens].filter((token) => [...pageTokens.values()].filter((set) => set.has(token)).length <= common);
  const nearest = (index: number) => Math.min(...options.changed.map((change) => Math.abs(change.index - index)));
  return options.pages
    .filter((page) => !options.exclude.has(page.index))
    .map((page) => ({ index: page.index, hits: rare.filter((token) => pageTokens.get(page.index)!.has(token)).length }))
    .filter((page) => page.hits > 0)
    .sort((a, b) => b.hits - a.hits || nearest(a.index) - nearest(b.index) || a.index - b.index)
    .slice(0, options.limit ?? 4)
    .map((page) => page.index)
    .sort((a, b) => a - b);
}
