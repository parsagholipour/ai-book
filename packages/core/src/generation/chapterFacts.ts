import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { targetLanguageGenerationGuidance, targetLanguagePayload } from "../prompting/language.js";
import { figureStandInMarkdown } from "./figures/figureBlocks.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

/**
 * The continuity ledger of a composed book: the attributes each chapter fixed
 * about its people, places, documents and example people — a role, a relation,
 * a pronoun, a date, a figure — read off the chapter's composed draft by one
 * short call, so the next chapter's writer and editor can keep to them.
 *
 * Every chapter used to be written blind to the facts of the chapters before
 * it: the story state was built at finalize, after the last chapter, and the
 * page notes of chapter N-1 were still being described while chapter N was
 * composed. The 2026-09-30 Quick Draft novel gave its founding battle two
 * dates, made Maelin Avar's mother and then his sister, and its clerk a rider;
 * the workbook's Mara had $2,000 of monthly essentials and then $2,400.
 *
 * A fact is an attribute and a short value, never a passage. The first ledger
 * stored clauses, and a clause about a document is its wording: the q3 novel's
 * chapter 3 was handed five quoted notes from chapter 2 through the ledger alone
 * and reprinted all five word for word (33 six-word runs in its prose came from
 * nowhere else), and the per-subject line grew until its newest figures were
 * cut away. Keyed by attribute, a later value replaces an earlier one, a quoted
 * or copied value is refused by code, and a real publication the book cites is
 * named and filed apart rather than taking the slots.
 */
export const EXTRACT_CHAPTER_FACTS_PURPOSE = "extract-chapter-facts";

/** `attribute` is empty only on a fact stored before attributes existed. */
export type ChapterFact = { subject: string; attribute: string; value: string };

/** What code refused from one reply, for the run log. */
export type ChapterFactDrops = { sources: number; quoted: number; long: number; copied: number };

/** Pairs one chapter adds; the model is told the same number. */
export const MAX_CHAPTER_FACTS = 14;
/** The value the model is asked for; code refuses one past `MAX_VALUE_WORDS` as a passage rather than an attribute. */
export const FACT_VALUE_WORDS = 12;
const MAX_VALUE_WORDS = 16;
/** A run this long shared with the chapter is a copied sentence, not a name or a date. */
const COPIED_RUN_WORDS = 9;
/** The ledger a prompt carries; the subjects the chapter names go first when it has to be cut. */
export const ESTABLISHED_FACTS_MAX_CHARACTERS = 6000;
/** One subject's line; past it the attributes updated longest ago give way, never the first one. */
const MAX_LINE_CHARACTERS = 1000;
const MAX_NAME_CHARACTERS = 80;
const MAX_ATTRIBUTE_CHARACTERS = 60;
const RECORDED_KINDS = ["person", "place", "thing", "event"] as const;

const replySchema = z.object({
  subjects: z.array(z.object({ name: z.unknown(), kind: z.unknown(), facts: z.unknown() }).passthrough()).default([])
}).passthrough();

function extractionPrompt(language: string | undefined): string {
  return [
    "You keep the continuity ledger of a book written one chapter at a time, so that no later chapter contradicts an earlier one. knownFacts is the ledger so far: one line per subject, each attribute with its current value.",
    `Return one JSON object with one key, subjects. Each subject is {"name", "kind", "facts"}: name is spelled exactly as knownFacts spells it when knownFacts has it; kind is ${[...RECORDED_KINDS, "source"].map((kind) => `"${kind}"`).join(", ")}; facts is a list of {"attribute", "value"} pairs this chapter fixes that knownFacts does not already hold — at most ${MAX_CHAPTER_FACTS} pairs across all subjects, most important first, and fewer is fine. attribute names the property in one to four words, reusing knownFacts' attribute for the same property; value is at most ${FACT_VALUE_WORDS} words of your own — never a quotation, never quotation marks, never a sentence from the chapter.`,
    "Record only these.",
    "1. For each person the chapter names or titles: role or job; relation to another person (parent, child, sibling, spouse, employer), even when stated in passing, as \"her brother's shop\" fixes a brother; age; whether alive, dead, missing or held; and pronoun — she, he or they — for a person known only by a title too.",
    "2. The date or year of an event, and where it happened.",
    "3. A letter, ledger, record or other document the book's own people hold or write: who holds it, how it is dated, and what it establishes in a few words — never its wording, never a line from it.",
    "4. What identifies a mark, seal or sign, in a few words.",
    "5. For a named, invented example person in a guide or workbook: their job, business, clients or team, the situation they are in — a project, a deadline, a problem — and each figure the chapter gives them, one figure per pair with the attribute saying what it is for, such as \"monthly rent\" with \"$1,050\".",
    "A real book, study, survey, report, law, regulation, agency or website the book cites is kind \"source\" with facts empty, and so is every real person the book cites for what they wrote, said or found — an author, a researcher, an executive it quotes: name them, never record what they say. Record nothing else: not the book's own advice, definitions or methods; not appearance, clothing, furniture, weather, gestures or feelings.",
    "Copy names, numbers and dates exactly. Give a known attribute again only with a new value the chapter itself narrates — a balance that grew, a promotion, a move; where the chapter merely says something different, leave it out: knownFacts stands.",
    'Return {"subjects": [{"name": "", "kind": "person", "facts": [{"attribute": "", "value": ""}]}]}.',
    ...targetLanguageGenerationGuidance(language)
  ].join(" ");
}

/**
 * One call over a chapter's prose. It throws what the provider throws; the
 * caller decides that a missing ledger is a chapter written without one.
 */
export async function extractChapterFacts(options: {
  title: string;
  chapterIndex: number;
  markdown: string;
  known: readonly ChapterFact[];
  textModel: TextModelAdapter;
  language?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ facts: ChapterFact[]; dropped: ChapterFactDrops }> {
  const prose = figureStandInMarkdown(options.markdown);
  const reply = await generateJsonWithRetry(options.textModel, {
    purpose: EXTRACT_CHAPTER_FACTS_PURPOSE,
    temperature: 0,
    maxTokens: 2000,
    schema: replySchema,
    ...(options.signal ? { signal: options.signal } : {}),
    messages: [
      { role: "system", content: extractionPrompt(options.language) },
      {
        role: "user",
        content: JSON.stringify({
          language: targetLanguagePayload(options.language),
          book: { title: options.title },
          chapter: { index: options.chapterIndex, markdown: prose },
          knownFacts: chapterFactLines(options.known, { mentionText: prose, maxCharacters: ESTABLISHED_FACTS_MAX_CHARACTERS })
        }, null, 2)
      }
    ]
  });
  return newFacts(reply.data.subjects, options.known, prose);
}

const fold = (text: string) => text.normalize("NFC").replace(/[‘’`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
const subjectKey = (subject: string) => fold(subject).replace(/^the /, "");
const tidy = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.;,:]+$/, "");
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const attributeKey = (fact: ChapterFact) => (fact.attribute ? fold(fact.attribute).replace(/^the /, "") : `#${fold(fact.value)}`);
const words = (text: string) => fold(text).split(/[^\p{L}\p{N}$%]+/u).filter(Boolean);

/**
 * Quotation marks of any script — and a straight single quote opening a span of
 * several words, which a possessive ("the riders' seal") never does: a value
 * carrying one is a document's wording, not an attribute.
 */
const QUOTATION = /["“”„«»‹›「」『』]|‘[^’]*’|(?:^|[\s(])'[^'\s][^']*\s[^']*'/u;

function runs(tokens: readonly string[], length: number): Set<string> {
  const found = new Set<string>();
  for (let start = 0; start + length <= tokens.length; start += 1) found.add(tokens.slice(start, start + length).join(" "));
  return found;
}

/**
 * The reply's pairs as ledger facts. A source is counted and dropped; so is a
 * value that quotes, runs past a phrase, or copies a run of the chapter's own
 * sentence — the three shapes of text a writer can reprint. A value the ledger
 * already holds for that attribute is not news; a new one replaces it.
 */
export function newFacts(subjects: readonly unknown[], known: readonly ChapterFact[], chapter = ""): { facts: ChapterFact[]; dropped: ChapterFactDrops } {
  const dropped: ChapterFactDrops = { sources: 0, quoted: 0, long: 0, copied: 0 };
  const current = new Map<string, string>();
  for (const fact of known) current.set(`${subjectKey(fact.subject)}\u0000${attributeKey(fact)}`, fold(fact.value));
  const chapterRuns = runs(words(chapter), COPIED_RUN_WORDS);
  const kept = new Map<string, ChapterFact>();
  for (const raw of subjects) {
    const subject = raw as { name?: unknown; kind?: unknown; facts?: unknown };
    if (typeof subject.name !== "string" || !subject.name.trim()) continue;
    const pairs = Array.isArray(subject.facts) ? subject.facts as Array<{ attribute?: unknown; value?: unknown }> : [];
    if (typeof subject.kind === "string" && fold(subject.kind) === "source") {
      dropped.sources += 1;
      continue;
    }
    const name = clip(tidy(subject.name), MAX_NAME_CHARACTERS);
    for (const pair of pairs) {
      if (typeof pair?.attribute !== "string" || typeof pair.value !== "string") continue;
      const attribute = clip(tidy(pair.attribute), MAX_ATTRIBUTE_CHARACTERS);
      const value = tidy(pair.value);
      if (!value) continue;
      if (QUOTATION.test(value)) { dropped.quoted += 1; continue; }
      const valueWords = words(value);
      if (valueWords.length > MAX_VALUE_WORDS) { dropped.long += 1; continue; }
      if ([...runs(valueWords, COPIED_RUN_WORDS)].some((run) => chapterRuns.has(run))) { dropped.copied += 1; continue; }
      const fact = { subject: name, attribute, value };
      const key = `${subjectKey(name)}\u0000${attributeKey(fact)}`;
      if (current.get(key) === fold(value)) continue;
      // A later pair for the same attribute is the chapter's later value.
      kept.delete(key);
      if (kept.size === MAX_CHAPTER_FACTS) continue;
      kept.set(key, fact);
    }
  }
  return { facts: [...kept.values()], dropped };
}

/**
 * The ledger as prompt lines: one per subject in the order the book met it,
 * each attribute once with its latest value, in the order it was first set.
 * A line past its cap keeps the subject's first attribute — usually who they
 * are — and then the most recently set, so a person's current figures survive
 * and the ones a later chapter replaced are already gone. Over the total
 * budget, the subjects the mention text names are kept first; the order of the
 * lines never changes.
 */
export function chapterFactLines(
  facts: readonly ChapterFact[],
  options: { mentionText?: string | undefined; maxCharacters?: number | undefined } = {}
): string[] {
  type Entry = { attribute: string; value: string; first: number; last: number };
  const bySubject = new Map<string, { subject: string; attributes: Map<string, Entry> }>();
  facts.forEach((fact, position) => {
    const key = subjectKey(fact.subject);
    const subject = bySubject.get(key) ?? { subject: tidy(fact.subject), attributes: new Map<string, Entry>() };
    const attribute = attributeKey(fact);
    const entry = subject.attributes.get(attribute);
    if (entry) Object.assign(entry, { value: tidy(fact.value), last: position });
    else subject.attributes.set(attribute, { attribute: tidy(fact.attribute), value: tidy(fact.value), first: position, last: position });
    bySubject.set(key, subject);
  });
  const render = (subject: string, entries: readonly Entry[]) =>
    `${subject} — ${entries.map((entry) => (entry.attribute ? `${entry.attribute}: ${entry.value}` : entry.value)).join("; ")}.`;
  const lines = [...bySubject.values()].map(({ subject, attributes }) => {
    const entries = [...attributes.values()];
    const whole = render(subject, entries);
    if (whole.length <= MAX_LINE_CHARACTERS) return whole;
    const keep = new Set<Entry>([entries[0]!]);
    for (const entry of entries.slice(1).sort((a, b) => b.last - a.last)) {
      keep.add(entry);
      if (render(subject, entries.filter((candidate) => keep.has(candidate))).length > MAX_LINE_CHARACTERS) keep.delete(entry);
    }
    return clip(render(subject, entries.filter((entry) => keep.has(entry))), MAX_LINE_CHARACTERS);
  });
  const max = options.maxCharacters ?? Number.POSITIVE_INFINITY;
  if (lines.reduce((sum, line) => sum + line.length + 1, 0) <= max) return lines;
  const mentioned = options.mentionText ? fold(options.mentionText) : "";
  const named = (subject: string) => {
    const nameWords = subjectKey(subject).split(/[\s,:'-]+/).filter((word) => word.length >= 4);
    return nameWords.length === 0 ? mentioned.includes(subjectKey(subject)) : nameWords.some((word) => mentioned.includes(word));
  };
  const subjects = [...bySubject.values()].map((entry) => entry.subject);
  const order = [...lines.keys()].sort((a, b) => Number(named(subjects[b]!)) - Number(named(subjects[a]!)) || a - b);
  const keep = new Set<number>();
  let used = 0;
  for (const index of order) {
    const cost = lines[index]!.length + 1;
    if (used + cost > max) continue;
    keep.add(index);
    used += cost;
  }
  return lines.filter((_, index) => keep.has(index));
}

/** A fact read back from a chapter report: the current shape, or a clause stored before attributes existed. */
export function storedChapterFact(raw: unknown): ChapterFact | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const fact = raw as Record<string, unknown>;
  if (typeof fact.subject !== "string") return undefined;
  if (typeof fact.value === "string") return { subject: fact.subject, attribute: typeof fact.attribute === "string" ? fact.attribute : "", value: fact.value };
  return typeof fact.fact === "string" ? { subject: fact.subject, attribute: "", value: fact.fact } : undefined;
}

/** The writer's line, when the ledger has anything in it. */
export const ESTABLISHED_FACTS_WRITER_RULE =
  "establishedFacts is what earlier chapters already told the reader: one line per person, place or thing, each attribute with its current value. It is for consistency, not material: wherever this chapter touches one of them, keep it as listed — the same name, role, relation, pronoun, age, date and figure. Never bring a fact in because it is listed; the reader already knows it. A person returns without being introduced again, and a listed document, mark or find is referred to in a clause by what it is — never quoted, read out, described or discovered again.";

/** The line editor's line. */
export const ESTABLISHED_FACTS_EDITOR_RULE =
  "establishedFacts is what earlier chapters already told the reader. Where the draft contradicts one — another role, relation, pronoun, age, date or figure for the same person or thing — change the draft's words to agree with it; that is the one change of fact this edit makes. Never add a sentence restating a listed fact, and never quote a listed document.";

/** The acceptance reviewer's line, so a continuity correction is not judged a change of meaning. */
export const ESTABLISHED_FACTS_ACCEPTANCE_RULE =
  "establishedFacts is what earlier chapters already printed: a change that brings a name, role, relation, pronoun, age, date or figure into line with it is a continuity correction and preserves meaning.";
