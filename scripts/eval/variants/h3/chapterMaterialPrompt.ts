/**
 * H3 prototype (harness plan §H3; not shipped — the eval of 2026-10-16 failed its primary-document gate):
 * one grounded prompt for a chapter's research brief and up to two of its dossier leads. Google bills Gemini
 * 2.5 grounding per *prompt*, so a sourced book that pays once for each chapter's `chapter-research` brief and
 * once for every lead's `case-source-search` could pay a third as often. One prompt answers both, in Markdown
 * sections, and the grounding supports say which section cited which source. Pure: no IO.
 *
 * Wordings, as measured (`container/h3-material.ts --wording`):
 *   v1  probe P1b's: "Search the web separately for the chapter topic and for each numbered lead (N searches at
 *       least)". 0 of 30 answers ungrounded; ~3.4 searches a prompt, so ~1 a lead (today's lead prompt runs ~4).
 *   v2  two searches a lead, one aimed at its original document: ~6.6 searches a prompt.
 *   v3  four searches a lead: ~12.3 searches a prompt, prompt median 13 s against ~9 s.
 */
export const CHAPTER_MATERIAL_SEARCH_PURPOSE = "chapter-material-search";

export type MaterialWording = "v1" | "v2" | "v3";

/** What one material prompt asks: the chapter's background (its first prompt only) and its leads. */
export type ChapterMaterialRequest = {
  /** Present on a chapter's first prompt: the brief `chapter-research` used to write, plus plan research queries folded into it. */
  background?: { alsoCover?: readonly string[] | undefined } | undefined;
  /** The dossier leads answered in this prompt, one `## Lead N` section each. Two at most: three in one prompt lost ~30% of excerpts (P1). */
  leads: readonly string[];
  wording?: MaterialWording | undefined;
};

/** One section of a material answer: `background` or `lead1`, `lead2`, …; its text and the grounding chunks it cited. */
export type ChapterMaterialSection = { key: string; text: string; chunkIndexes: number[] };

const LEAD_RULE_V1 =
  "find the original source documents — original papers, firsthand records, official texts or transcripts, standards, or documentation published by the responsible institution. Cite direct original document URLs, preferably accessible full text or PDF. Prioritise originals over encyclopedias, summaries and commercial explainers. A lead may be wrong: find documents that can establish or refute it.";
const LEAD_RULE =
  "find the original source documents — original papers, firsthand records, official texts or transcripts, standards, or documentation published by the responsible institution — and cite them directly, preferably as accessible full text or PDF; seek an alternate original edition or an institution's copy when one is inaccessible. Prioritise originals over encyclopedias, news summaries and commercial explainers: a summary of a document is not the document. A lead may be wrong: find documents that can establish or refute it.";

const SEARCHES_PER_LEAD: Record<MaterialWording, number> = { v1: 1, v2: 2, v3: 4 };

/** The prompt. Every wording opens by telling the model to search for each part (P1b: 6 of 30 answers ungrounded without it, 0 with). */
export function chapterMaterialPrompt(topic: string, request: ChapterMaterialRequest): string {
  const wording = request.wording ?? "v1";
  const extra = request.background?.alsoCover?.filter((entry) => entry.trim()) ?? [];
  const searches = (request.background ? 1 + extra.length : 0) + SEARCHES_PER_LEAD[wording] * request.leads.length;
  const first = (() => {
    if (wording === "v1") {
      const parts = request.background ? `the chapter topic${extra.length > 0 ? ", each additional topic" : ""} and for each numbered lead below` : "each numbered lead below";
      return `Search the web separately for ${parts} (${searches} searches at least), then answer in Markdown sections built only from what the searches returned.`;
    }
    const subjects = request.background ? `for the chapter topic${extra.length > 0 ? " and each additional topic" : ""}, and ` : "";
    const perLead = wording === "v2"
      ? "at least twice for each numbered lead below — once for what the lead describes and once for its original document (the official text, record, transcript, dataset or report, preferably as PDF)"
      : "at least four times for each numbered lead below — for what the lead describes, and three times for its original documents (the official text, record, transcript, dataset or report, preferably as PDF; an institution's own copy)";
    return `Search the web ${subjects}${perLead} — ${searches} searches at least. Then answer in Markdown sections built only from what the searches returned.`;
  })();
  return [
    first,
    ...(request.background
      ? [`Section "## Background": concise factual background for the chapter topic${extra.length > 0 ? " and the additional topics" : ""}, citing the search results.`]
      : []),
    `${request.background ? "Then one" : "One"} section per lead, headed exactly "## Lead N": for that lead, ${wording === "v1" ? LEAD_RULE_V1 : LEAD_RULE}`,
    "Separate verified facts from claims that are contested or unsupported.",
    "Do not invent or launder made-up studies, journals, institutes, experts, statistics, citations, or numeric findings.",
    "Do not mention this request, prompts, outlines, or the production process; answer only with factual notes about the topic.",
    "",
    ...(request.background ? [`Chapter topic: ${topic}`, ...extra.map((entry) => `Additional topic: ${entry}`)] : []),
    ...request.leads.map((lead, index) => `Lead ${index + 1}: ${lead}`)
  ].join("\n");
}

/** A section heading as the model writes it: `## Lead 2`, `### Lead 2: …`, `**Background**`, or `Lead 2:` alone on its line. */
const HEADING =
  /^[ \t]*(?:#{1,6}[ \t]*\**[ \t]*|\*\*[ \t]*)(background|lead[ \t]*(\d+))\b[^\n]*$|^[ \t]*(background|lead[ \t]*(\d+))[ \t]*:?[ \t]*$/gim;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The answer cut at its section headings, each section with the grounding chunks its supports cite. A support
 * belongs to the section its segment starts in; Gemini reports `segment.startIndex` in UTF-8 bytes of the answer
 * (an absent index is 0). Text before the first heading is background. An answer with no heading at all is one
 * background section, so its leads get no attributed source and the caller falls back for them. Heading lines
 * at the top of a section are dropped: the model often repeats the lead's search string as a subheading.
 */
export function chapterMaterialSections(rawText: string, supports: readonly unknown[]): ChapterMaterialSection[] {
  const heads: Array<{ key: string; charStart: number; charEnd: number; byteStart: number }> = [];
  for (const match of rawText.matchAll(HEADING)) {
    const number = match[2] ?? match[4];
    heads.push({
      key: number ? `lead${Number(number)}` : "background",
      charStart: match.index,
      charEnd: match.index + match[0].length,
      byteStart: utf8Length(rawText.slice(0, match.index))
    });
  }
  const order: string[] = [];
  const texts = new Map<string, string[]>();
  const chunks = new Map<string, Set<number>>();
  const add = (key: string, raw: string) => {
    const text = raw.replace(/^(?:\s*#{1,6}[^\n]*(?:\n|$))+/, "");
    if (!texts.has(key)) {
      order.push(key);
      texts.set(key, []);
      chunks.set(key, new Set());
    }
    if (text.trim()) texts.get(key)!.push(text.trim());
  };
  add("background", rawText.slice(0, heads[0]?.charStart ?? rawText.length));
  heads.forEach((head, index) => add(head.key, rawText.slice(head.charEnd, heads[index + 1]?.charStart ?? rawText.length)));
  const sectionAt = (byte: number) => {
    let key = "background";
    for (const head of heads) if (head.byteStart <= byte) key = head.key;
    return key;
  };
  for (const support of supports) {
    const record = support as { segment?: { startIndex?: unknown }; groundingChunkIndices?: unknown } | null;
    const start = typeof record?.segment?.startIndex === "number" ? record.segment.startIndex : 0;
    const indexes = Array.isArray(record?.groundingChunkIndices) ? record.groundingChunkIndices : [];
    for (const index of indexes) if (typeof index === "number") chunks.get(sectionAt(start))!.add(index);
  }
  return order
    .map((key) => ({ key, text: texts.get(key)!.join("\n\n"), chunkIndexes: [...chunks.get(key)!].sort((a, b) => a - b) }))
    .filter((section) => section.key !== "background" || section.text || section.chunkIndexes.length > 0);
}
