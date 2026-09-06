import { type BookEpisodes, type ChapterEpisode } from "../schemas/episodes.js";

/**
 * The plan contract: a chapter's assignment is a claim about the world, never
 * a distinction between two ways of reading evidence.
 *
 * Three blind readers of the same balanced-tier book (fresh-plan-5,
 * 6 September 2026) named one paragraph engine — "what a source establishes,
 * then what it cannot establish", closing on a balanced antithesis — in nearly
 * every paragraph of fourteen chapters. The writer never saw the stance
 * positions, so the shape was not imitated: it was assigned. `focus.contribution`
 * was a distinction in 13 of 14 chapters, five `focus.question`s asked what the
 * evidence can and cannot establish, and three of seven `voiceGuide` lines were
 * method rules shown on every compose and edit call. A rule about handling
 * evidence, shown in every call, is performed in every paragraph.
 *
 * Everything here is soft and English-only by design: it names shapes, it never
 * fails a book, and a non-English plan simply is not gated.
 */

/**
 * Shape patterns, always on: the sentence is a distinction or a rule about
 * reading, rather than a claim about what happened and why.
 */
const SHAPE_PATTERNS: readonly RegExp[] = [
  // "distinguish evidence of violent capability … from evidence of violence's frequency"
  /\b(distinguish(es|ing)?|separat(e|es|ing)|tell(ing)? apart|disentangl\w*)\b[^.]{0,80}\bfrom\b/i,
  // "… rather than as a timeless emotional instinct"
  /\brather than\b/i,
  // "… instead of an accumulation of individual cruelties"
  /\b(instead of|as opposed to)\b/i,
  // "without treating prejudice, persecution, and mass murder as identical stages"
  /\bwithout (treating|reducing|turning|assuming|collapsing|flattening|presenting|implying|claiming|forcing)\b/i,
  // "What can a violent archaeological assemblage establish …, and what does it leave undecided?"
  /\b(what|which|how much|how far)\b[^.?]{0,80}\b(can|cannot|could|does|do|may)\b[^.?]{0,40}\b(establish|show|reveal|support|prove|tell|measure|demonstrate|explain)\b[^.?]{0,80}\b(and|but)\b[^.?]{0,60}\b(what|which|cannot|not|leave|remain)/i,
  // "what the record can and cannot say"
  /\b(can|could) and cannot\b|\bcan and can(?:no|')t\b/i,
  // "… and what it leaves undecided"
  /\bleaves? (undecided|open|unresolved|uncertain|out)\b/i,
  // "not simply a feud but an office"
  /\bnot (as|simply|merely|only|just) \b[^.]{0,100}\bbut (as|rather)?\b/i,
  // "neither permanent human brutality nor an originally peaceful humanity"
  /\b(neither|not)\b[^.]{0,60}\bnor\b/i
];

/**
 * The keyword pattern: a sentence about evidence, sources, interpretations or
 * scholars. Only for the stance and the voice guide — on a focus question or an
 * investigation line it over-fires, because naming the source series a chapter
 * measures is exactly the assignment we want ("What do Amsterdam's homicide
 * counts and source series actually measure …").
 */
const KEYWORD_PATTERN = /\b(evidence|sources?|the record|records|interpretations?|inferences?|scholars|readings? of)\b/i;

/** True when the text is a rule about reading rather than a claim about the world. */
export function isMethodShaped(text: string, options: { keywords?: boolean | undefined } = {}): boolean {
  const value = text.trim();
  if (!value) return false;
  if (SHAPE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return Boolean(options.keywords) && KEYWORD_PATTERN.test(value);
}

/** A stance whose thesis or positions are hedged evidence statements. */
export function stanceIsMethodShaped(stance: { thesis: string; positions: readonly string[] }): boolean {
  if (isMethodShaped(stance.thesis, { keywords: true })) return true;
  return stance.positions.some((position) => isMethodShaped(position, { keywords: true }));
}

/**
 * A voice-guide line that is a rule about *shape* — where a chapter, section or
 * paragraph ends, opens or how long it runs. "Vary chapter endings. Some should
 * close on a bounded conclusion, some on an unresolved question…" was shown on
 * every compose call, and three Opus readers heard it performed on schedule:
 * chapters ending on an unanswered question in the same two-clause shape. Rules
 * about tone and about what carries the narrative stay; rules about shape do not.
 */
const SHAPE_RULE_PATTERN =
  /\b(chapter|section|paragraph)s?\b[^.]{0,60}\b(end|ends|ending|endings|close|closes|closing|open|opens|opening|openings|begin|begins|length|lengths|shape|shapes)\b|\b(end|close|open|begin)\s+(each|every|some|most|a|the)\s+(chapter|section|paragraph)\b|\bvary\b[^.]{0,40}\b(endings|openings|closings|paragraph|sentence)/i;

/**
 * The voice-guide lines a per-chapter call may see. Taking styleNotes out
 * wholesale measured worse (composed-20); only the method rules are withheld.
 * A guide made entirely of method rules is kept as it is, because a chapter
 * with no style notes at all is the arm that was already measured.
 */
export function chapterStyleNotes(voiceGuide: readonly string[]): string[] {
  const kept = voiceGuide.filter((line) => !isMethodShaped(line, { keywords: true }) && !SHAPE_RULE_PATTERN.test(line));
  return kept.length > 0 ? kept : [...voiceGuide];
}

export type FocusContractIssue = {
  chapterIndex: number;
  kind: "question" | "contribution" | "investigation";
  text: string;
};

export type EpisodeCollision = {
  earlier: { chapterIndex: number; title: string };
  later: { chapterIndex: number; title: string };
  shared: string[];
  /** The shared tokens a title or a person names: what makes this the same case rather than the same country. */
  strong: string[];
};

/** Method-shaped focus fields, by chapter. Shape patterns only: no keyword rule here. */
export function focusContractIssues(episodes: BookEpisodes): FocusContractIssue[] {
  const issues: FocusContractIssue[] = [];
  for (const chapter of episodes.chapters) {
    const focus = chapter.focus;
    if (!focus) continue;
    if (isMethodShaped(focus.question)) issues.push({ chapterIndex: chapter.index, kind: "question", text: focus.question });
    if (isMethodShaped(focus.contribution)) issues.push({ chapterIndex: chapter.index, kind: "contribution", text: focus.contribution });
    for (const line of focus.investigation) {
      if (isMethodShaped(line)) issues.push({ chapterIndex: chapter.index, kind: "investigation", text: line });
    }
  }
  return issues;
}

/**
 * Host names and generic capitalised title words: shared between two episodes
 * they say nothing about the material. "The Massacre at Sand Creek testimony"
 * and "The Crow Creek massacre" are two different massacres.
 */
export const EPISODE_TOKEN_STOPLIST: ReadonlySet<string> = new Set([
  "Wikisource", "Gutenberg", "Archive", "Internet", "Project", "Massacre", "Battle", "Siege", "Report", "Case",
  "Trial", "Law", "Laws", "Code", "Book", "Vol", "Volume", "King", "Queen", "General", "United", "International",
  "National", "Council", "Committee", "Human", "Violence", "Aggression", "Military", "Civil", "Central", "Great",
  "Global", "Conquest", "Stele", "Texts", "Documents", "History", "Journal", "Nature", "University", "Press",
  "Commission", "Final", "Protocol", "Government", "State", "States", "Empire", "Kingdom", "Republic", "The",
  "And", "Of", "In", "On", "For", "With", "From", "Approximately", "Early", "Late", "Ancient", "Modern",
  "Northern", "Southern", "Eastern", "Western", "North", "South", "East", "West", "New", "Old", "World", "War",
  "Age", "Ages", "Middle",
  // Generic document-title and polity words: a shared "Journey" or "Holy Roman"
  // says nothing about which case an episode is.
  "Holy", "Saint", "San", "Santa", "Journey", "Journeys", "Travels", "Letters", "Letter", "Diary", "Memoirs",
  "Memoir", "Account", "Essay", "Treatise", "Chronicle", "Chronicles", "Annals", "Register", "Survey", "Map",
  "Ledger", "Order", "Ordinance", "Ordinances", "Census", "Rebellion", "Revolution", "Fall", "Rise", "Life",
  "Lives", "Books", "Translated", "Edited", "Edition", "Reprint", "Papers", "Selected", "Collected", "Works",
  "Introduction", "Notes"
]);

/**
 * Tokens that place or house an episode without identifying it: a nationality
 * or ethnic adjective, and the institution words two unrelated artefacts share
 * by sitting in the same building. They count toward the two, and they are
 * reported in `shared`, but two of them alone are not a collision.
 */
export const EPISODE_WEAK_TOKENS: ReadonlySet<string> = new Set([
  "British", "German", "French", "English", "American", "Spanish", "Dutch", "Italian", "Russian", "Soviet",
  "Japanese", "Chinese", "Indian", "Egyptian", "Roman", "Greek", "Persian", "Ottoman", "Byzantine", "Assyrian",
  "Babylonian", "Mongol", "Nazi", "Jewish", "European", "African", "Asian", "Indigenous", "Arab", "Islamic",
  "Christian", "Catholic", "Protestant", "Muslim", "Hebrew", "Latin", "Museum", "Library", "Institute",
  "Collection", "Archives", "Society", "Office", "Ministry", "Department", "Army", "Navy", "Court",
  "Parliament", "Congress", "Senate", "Church"
]);

const PROPER_NOUN = /^[A-Z][a-zà-ÿĀ-ſ-]{2,}$/;

function properNouns(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.split(/[^A-Za-zÀ-ÿĀ-ſ'-]+/)) {
    if (PROPER_NOUN.test(word) && !EPISODE_TOKEN_STOPLIST.has(word)) tokens.add(word);
  }
  return tokens;
}

/**
 * What an episode *is* (title, person), where it happened (place) and where it
 * is *published* (document). The same modern historian, series or translator
 * turns up in the documents of unrelated cases, and two different cases share a
 * country, so the three halves are scored differently.
 */
type EpisodeTokens = { name: Set<string>; place: Set<string>; document: Set<string> };

function episodeTokens(episode: ChapterEpisode): EpisodeTokens {
  return {
    name: properNouns([episode.title, episode.person].join(" ")),
    place: properNouns(episode.place),
    document: properNouns(episode.document)
  };
}

function identityHas(tokens: EpisodeTokens, token: string): boolean {
  return tokens.name.has(token) || tokens.place.has(token);
}

/**
 * A token counts only where it identifies an episode on at least one side, and
 * it is *strong* only when a title or a person names it: two cases in England,
 * or two British ones in India, are not the same case.
 */
function sharedEpisodeTokens(left: EpisodeTokens, right: EpisodeTokens): { shared: string[]; strong: string[] } {
  const shared = new Set<string>();
  for (const token of left.name) {
    if (identityHas(right, token) || right.document.has(token)) shared.add(token);
  }
  for (const token of left.place) {
    if (identityHas(right, token) || right.document.has(token)) shared.add(token);
  }
  for (const token of left.document) {
    if (identityHas(right, token)) shared.add(token);
  }
  // A word either episode files under `place` is a place wherever else it
  // appears: "The London Coroners' Rolls" and "The Decline of Homicide in
  // London" are two cases in one city, and the city is in both titles.
  const strong = [...shared].filter(
    (token) =>
      !EPISODE_WEAK_TOKENS.has(token) &&
      (left.name.has(token) || right.name.has(token)) &&
      !left.place.has(token) &&
      !right.place.has(token)
  );
  return { shared: [...shared], strong };
}

/**
 * Two chapters that took the same case: its full account belongs to the earlier
 * one. Two shared tokens alone are not enough — on candidate 3's stored plan
 * that flagged two different artefacts for both being in the British Museum
 * ("British", "Museum") and two unrelated chapters for "British" and "German",
 * and `applyFocusContract` then dropped legitimate material. A collision needs
 * one shared token that identifies the case rather than placing or housing it.
 * Overlap between two `document` fields alone never counts either: a live run
 * stripped four legitimate episodes because Geoffrey Parker wrote the modern
 * history cited for two different wartime cases, and because one book title
 * said "Journey" where another chapter's place said "India". `strong` is the
 * subset a title or a person names and neither episode files as a place, and a
 * collision needs one: a token either side calls a place is a shared city or
 * country wherever else it is written, not a shared case.
 */
export function episodeCollisions(episodes: BookEpisodes): EpisodeCollision[] {
  const chapters = [...episodes.chapters].sort((left, right) => left.index - right.index);
  const collisions: EpisodeCollision[] = [];
  for (let earlier = 0; earlier < chapters.length; earlier += 1) {
    for (let later = earlier + 1; later < chapters.length; later += 1) {
      const before = chapters[earlier]!;
      const after = chapters[later]!;
      if (before.index === after.index) continue;
      for (const episode of before.episodes) {
        const tokens = episodeTokens(episode);
        for (const candidate of after.episodes) {
          const { shared, strong } = sharedEpisodeTokens(tokens, episodeTokens(candidate));
          if (shared.length < 2 || strong.length === 0) continue;
          collisions.push({
            earlier: { chapterIndex: before.index, title: episode.title },
            later: { chapterIndex: after.index, title: candidate.title },
            shared,
            strong
          });
        }
      }
    }
  }
  return collisions;
}

const ISSUE_KIND_NOTE: Record<FocusContractIssue["kind"], string> = {
  question: "asks what the evidence can or cannot establish; ask instead what happened or why, about the assigned material",
  contribution: "is a distinction between two readings; state what the reader will know happened and why, as a claim about the chapter's material with a person, place, date or document in it",
  investigation: "is a rule about reading rather than something to work out; name an event, a decision, a quantity or a consequence the chapter establishes"
};

/** The re-ask, in the planner's register: one line per offending field, one per collision. */
export function focusFeedbackLines(issues: readonly FocusContractIssue[], collisions: readonly EpisodeCollision[]): string[] {
  const lines = issues.map(
    (issue) =>
      `Chapter ${issue.chapterIndex}: ${issue.kind} "${issue.text}" ${ISSUE_KIND_NOTE[issue.kind]}, with no "rather than", "distinguish", "separate … from", "without treating" or "what X can and cannot establish".`
  );
  for (const collision of collisions) {
    lines.push(
      `Chapters ${collision.earlier.chapterIndex} and ${collision.later.chapterIndex} both take ${collision.earlier.title} (shared: ${collision.shared.join(", ")}); its full account belongs to chapter ${collision.earlier.chapterIndex}; give chapter ${collision.later.chapterIndex} different documented material.`
    );
  }
  return lines;
}

export type FocusContractResult = {
  episodes: BookEpisodes;
  dropped: Array<{ chapterIndex: number; title: string; reason: string }>;
  blanked: Array<{ chapterIndex: number; kind: FocusContractIssue["kind"] }>;
};

/**
 * The deterministic clean-up after the single re-ask. A method-shaped
 * contribution becomes no assigned payoff at all; a method-shaped question is
 * kept, because there is nothing to put in its place; a colliding episode is
 * dropped from the later chapter only while that chapter keeps material. One
 * strong token is enough to *report* a collision to the planner and not enough
 * to take an episode away: a single shared name is as often a trial held where
 * an earlier case was decided as it is the same case told twice.
 */
export function applyFocusContract(episodes: BookEpisodes): FocusContractResult {
  const dropped: FocusContractResult["dropped"] = [];
  const blanked: FocusContractResult["blanked"] = [];
  const droppedTitles = new Map<number, Set<string>>();
  for (const collision of episodeCollisions(episodes)) {
    if (collision.strong.length < 2) continue;
    const chapter = episodes.chapters.find((entry) => entry.index === collision.later.chapterIndex);
    if (!chapter) continue;
    const already = droppedTitles.get(chapter.index) ?? new Set<string>();
    if (already.has(collision.later.title)) continue;
    const remaining = chapter.episodes.filter((episode) => !already.has(episode.title) && episode.title !== collision.later.title);
    if (remaining.length === 0) continue;
    already.add(collision.later.title);
    droppedTitles.set(chapter.index, already);
    dropped.push({
      chapterIndex: chapter.index,
      title: collision.later.title,
      reason: `its full account belongs to chapter ${collision.earlier.chapterIndex} (shared: ${collision.shared.join(", ")})`
    });
  }
  const chapters = episodes.chapters.map((chapter) => {
    const drops = droppedTitles.get(chapter.index);
    const kept = drops ? chapter.episodes.filter((episode) => !drops.has(episode.title)) : chapter.episodes;
    if (!chapter.focus) return { ...chapter, episodes: kept };
    const focus = chapter.focus;
    let investigation = focus.investigation;
    const clean = investigation.filter((line) => !isMethodShaped(line));
    if (clean.length >= 2 && clean.length < investigation.length) {
      for (const line of investigation) {
        if (!clean.includes(line)) blanked.push({ chapterIndex: chapter.index, kind: "investigation" });
      }
      investigation = clean;
    }
    let contribution = focus.contribution;
    if (isMethodShaped(contribution)) {
      contribution = "";
      blanked.push({ chapterIndex: chapter.index, kind: "contribution" });
    }
    return { ...chapter, episodes: kept, focus: { ...focus, investigation, contribution } };
  });
  return { episodes: { chapters }, dropped, blanked };
}
