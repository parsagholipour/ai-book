/**
 * H8's reconciliation detector, as pre-registered (`.scratch/eval-data/h8/preregistration.md`): chapter N's facts
 * against chapter N+1's facts, both read against the ledger before N, compared on (subject, attribute) keys in code.
 * Pure; the shape is core's `ChapterFact`.
 */
import type { Fact, KeyConflict } from "./types.ts";

const fold = (text: string) =>
  text.normalize("NFC").replace(/[‘’`]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim().toLowerCase();
const subjectKey = (subject: string) => fold(subject).replace(/^the /, "");

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "sir", "lady", "lord", "the", "of", "a", "an"]);
const nameTokens = (key: string) => key.split(/[^\p{L}\p{N}]+/u).filter((token) => token && !HONORIFICS.has(token));

const ATTRIBUTE_SYNONYMS: Array<[RegExp, string]> = [
  [/^(job|occupation|profession|position|title|work)\b/, "role"],
  [/^pronouns\b/, "pronoun"],
  [/^relationship\b/, "relation"]
];
/** States a later chapter may legitimately change; never compared. */
const MUTABLE = /location|whereabouts|current|status|condition|state|mood|feeling|situation|problem|project|deadline|goal|plan|task|activity|action|decision/;

export function attributeKey(attribute: string): string {
  let key = fold(attribute).replace(/^(the|his|her|their|its) /, "");
  for (const [pattern, canonical] of ATTRIBUTE_SYNONYMS) key = key.replace(pattern, canonical);
  return key;
}

const STOPWORDS = new Set(("the and for with from into onto that this than then who whom whose which what when where why how her his their its "
  + "she him they them our your are was were has had have but not nor per via about over under after before also only just very more most "
  + "one two each other another some any all both own same such").split(" "));
const contentWords = (value: string) => new Set(fold(value).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !STOPWORDS.has(word) && !/^\d/.test(word)));
const numbers = (value: string) => new Set([...fold(value).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => match[0].replace(/,/g, "").replace(/\.0+$/, "")));
const PRONOUNS: Record<string, string> = { she: "she", her: "she", he: "he", him: "he", his: "he", they: "they", them: "they", it: "it" };
const pronounOf = (value: string) => fold(value).split(/[^\p{L}]+/u).map((word) => PRONOUNS[word]).find(Boolean);

const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((item) => b.has(item));
const sameSet = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && subset(a, b);

/** Whether two values for the same (subject, attribute) cannot both stand. */
export function valuesConflict(attribute: string, earlier: string, later: string): boolean {
  if (fold(earlier) === fold(later)) return false;
  const a = numbers(earlier);
  const b = numbers(later);
  if (a.size > 0 && b.size > 0) return !sameSet(a, b);
  if (attribute === "pronoun") {
    const pa = pronounOf(earlier);
    const pb = pronounOf(later);
    return Boolean(pa && pb && pa !== pb);
  }
  const wa = contentWords(earlier);
  const wb = contentWords(later);
  if (wa.size === 0 || wb.size === 0) return false;
  if (subset(wa, wb) || subset(wb, wa)) return false;
  const shared = [...wa].filter((word) => wb.has(word)).length;
  return shared / (wa.size + wb.size - shared) < 0.34;
}

/** N's subject a later subject names: the same key, or the unique name its tokens are a subset of (or vice versa). */
function matchSubject(later: string, earlierKeys: readonly string[]): string | undefined {
  const key = subjectKey(later);
  if (earlierKeys.includes(key)) return key;
  const tokens = new Set(nameTokens(key));
  const candidates = earlierKeys.filter((candidate) => {
    const other = new Set(nameTokens(candidate));
    const [small, large] = tokens.size <= other.size ? [tokens, other] : [other, tokens];
    return small.size > 0 && [...small].some((token) => token.length >= 3) && subset(small, large);
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function detectConflicts(earlierFacts: readonly Fact[], laterFacts: readonly Fact[]): KeyConflict[] {
  const earlier = new Map<string, Fact>();
  for (const fact of earlierFacts) {
    if (!fact.attribute) continue;
    const attribute = attributeKey(fact.attribute);
    if (MUTABLE.test(attribute)) continue;
    // Latest value wins within a chapter, as the ledger keeps it.
    earlier.set(`${subjectKey(fact.subject)}\u0000${attribute}`, fact);
  }
  const earlierKeys = [...new Set([...earlier.keys()].map((key) => key.split("\u0000")[0]!))];
  const conflicts: KeyConflict[] = [];
  const seen = new Set<string>();
  for (const fact of laterFacts) {
    if (!fact.attribute) continue;
    const attribute = attributeKey(fact.attribute);
    if (MUTABLE.test(attribute)) continue;
    const subject = matchSubject(fact.subject, earlierKeys);
    if (!subject) continue;
    const prior = earlier.get(`${subject}\u0000${attribute}`);
    if (!prior || !valuesConflict(attribute, prior.value, fact.value)) continue;
    const id = `${subject}\u0000${attribute}`;
    if (seen.has(id)) continue;
    seen.add(id);
    conflicts.push({ subject: prior.subject, attribute, earlierValue: prior.value, laterValue: fact.value, earlierSubject: prior.subject, laterSubject: fact.subject });
  }
  return conflicts;
}
