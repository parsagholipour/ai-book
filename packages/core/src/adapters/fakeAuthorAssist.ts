import { AUTHOR_ASSIST_PURPOSES, type AuthorAssistPurpose } from "../authoring/authorAssistTypes.js";
import type { GenerateJsonOptions } from "./types.js";

/**
 * Dry-run answers for the Writing Studio's AI tools (`authoring/`), one per
 * purpose, read off the same JSON payload the real prompt sends — so a
 * `MOCK_AI` Studio session, and every API or widget test driven through the
 * fake adapter, sees a deterministic, plausible suggestion that survives the
 * runners' own clean-up:
 *
 * - rewrite: the selection with a small visible change (shorter drops its
 *   later sentences, longer adds one, the rest tag the first sentence);
 * - proofread: one correction when the selection holds a common typo such as
 *   "teh" exactly once, and none otherwise;
 * - continue, describe: a fixed paragraph, and the selection plus a fixed
 *   sensory sentence;
 * - brainstorm: three fixed ideas; ask: a fixed answer naming the question;
 * - draft: fixed paragraphs (pages, for a picture layout);
 * - chapter feedback and consistency: two notes, the first quoting the first
 *   sentence of the (first) chapter;
 * - outline: six chapters, or one chapter of page beats for a picture book.
 */
export function fakeAuthorAssist(purpose: AuthorAssistPurpose, options: GenerateJsonOptions<unknown>): unknown {
  const payload = userPayload(options);
  switch (purpose) {
    case AUTHOR_ASSIST_PURPOSES.rewrite:
      return { text: fakeRewrite(text(payload.selection), text(payload.preset)) };
    case AUTHOR_ASSIST_PURPOSES.proofread:
      return { corrections: fakeCorrections(text(payload.selection)) };
    case AUTHOR_ASSIST_PURPOSES.continue:
      return { text: FAKE_CONTINUATION };
    case AUTHOR_ASSIST_PURPOSES.describe:
      return { text: `${text(payload.selection).trim()} The air smelled of rain and cut grass, and somewhere a door creaked softly on its hinges.` };
    case AUTHOR_ASSIST_PURPOSES.brainstorm:
      return { ideas: FAKE_IDEAS };
    case AUTHOR_ASSIST_PURPOSES.ask:
      return { answer: `[MOCK_AI] An editor's answer to "${clip(text(payload.instruction), 80)}": the passage reads clearly; tighten the second sentence and let the last image land on its own.` };
    case AUTHOR_ASSIST_PURPOSES.draftChapter:
      return { markdown: fakeDraft(record(payload.chapter), text(payload.layout)) };
    case AUTHOR_ASSIST_PURPOSES.chapterFeedback:
      return { notes: fakeFeedback(text(record(payload.chapter).markdown)) };
    case AUTHOR_ASSIST_PURPOSES.consistency:
      return { notes: fakeConsistency(Array.isArray(payload.chapters) ? payload.chapters.map(record) : []) };
    case AUTHOR_ASSIST_PURPOSES.outline:
      return { chapters: fakeOutline(text(record(payload.book).kind)) };
  }
}

const FAKE_CONTINUATION =
  "[MOCK_AI] For a while nobody spoke. The kettle ticked as it cooled, and the light through the window slid a little further across the table, over the folded map and the two chipped cups. Somewhere below, a cart rattled past and was gone. She turned the key over in her fingers, feeling the worn teeth, and thought about the door it had been made for. It would be easy to leave it here, easy to pretend she had never found it. Instead she slipped it into her pocket, stood, and reached for her coat.";

const FAKE_IDEAS = [
  { title: "A stranger at the door", text: "[MOCK_AI] Someone arrives who knows more about the key than they should, and asks for it back." },
  { title: "The map is wrong", text: "[MOCK_AI] A landmark on the map does not exist, which means someone drew it to mislead." },
  { title: "An old promise", text: "[MOCK_AI] A letter surfaces reminding her of a promise she made years ago and never kept." }
];

const COMMON_TYPOS: ReadonlyArray<readonly [string, string]> = [
  ["teh", "the"],
  ["recieve", "receive"],
  ["definately", "definitely"],
  ["seperate", "separate"],
  ["occured", "occurred"],
  ["wich", "which"],
  ["alot", "a lot"],
  ["untill", "until"]
];

function fakeRewrite(selection: string, preset: string): string {
  const trimmed = selection.trim();
  const sentences = trimmed.match(/[^.!?]+[.!?]+["'”’]*\s*|[^.!?]+$/g) ?? [trimmed];
  if (preset === "shorter" && sentences.length > 1) {
    return sentences.slice(0, Math.ceil(sentences.length / 2)).join("").trim();
  }
  if (preset === "longer") {
    return `${trimmed} Nothing about the moment was hurried; every detail seemed to wait its turn.`;
  }
  const first = sentences[0]!.trimEnd();
  const rest = trimmed.slice(sentences[0]!.length).trimStart();
  return [`${first} [MOCK_AI ${preset || "rewrite"}]`, rest].filter(Boolean).join(" ");
}

function fakeCorrections(selection: string): Array<{ find: string; replace: string; reason: string }> {
  for (const [typo, fix] of COMMON_TYPOS) {
    const matches = [...selection.matchAll(new RegExp(`\\b${typo}\\b`, "gi"))];
    if (matches.length !== 1) continue;
    const found = matches[0]![0];
    if (selection.indexOf(found) !== selection.lastIndexOf(found)) continue;
    const replace = found[0] === found[0]!.toUpperCase() ? `${fix[0]!.toUpperCase()}${fix.slice(1)}` : fix;
    return [{ find: found, replace, reason: "[MOCK_AI] spelling" }];
  }
  return [];
}

function fakeDraft(chapter: Record<string, unknown>, layout: string): string {
  const title = text(chapter.title).trim() || "this chapter";
  const paragraphs = [
    `[MOCK_AI] The morning ${title.toLowerCase()} began was grey and still, and the house held its breath with it.`,
    "She went down the stairs slowly, counting them the way she had as a child, and found the kitchen exactly as she had left it: the chair pushed back, the letter still unopened on the table.",
    "By noon the rain had come. She read the letter twice, folded it along its old creases, and knew that whatever she decided now would not be undone."
  ];
  return layout === "picture" ? paragraphs.join("\n\n<!-- page -->\n\n") : paragraphs.join("\n\n");
}

function fakeFeedback(markdown: string): Array<{ quote: string | null; note: string; severity: string }> {
  const quote = firstSentence(markdown);
  return [
    { quote, note: "[MOCK_AI] This opening could reach the scene's tension sooner.", severity: "suggestion" },
    { quote: null, note: "[MOCK_AI] The chapter's ending resolves quickly; consider leaving one question open.", severity: "issue" }
  ];
}

function fakeConsistency(chapters: Array<Record<string, unknown>>): Array<{
  chapterNumber: number | null;
  quote: string | null;
  note: string;
  severity: string;
}> {
  const first = chapters[0];
  if (!first) return [];
  const last = chapters[chapters.length - 1]!;
  return [
    {
      chapterNumber: typeof first.number === "number" ? first.number : 1,
      quote: firstSentence(text(first.text)),
      note: "[MOCK_AI] Check that this detail matches how later chapters describe it.",
      severity: "suggestion"
    },
    {
      chapterNumber: typeof last.number === "number" ? last.number : chapters.length,
      quote: null,
      note: "[MOCK_AI] Confirm the timeline here agrees with the opening chapter.",
      severity: "suggestion"
    }
  ];
}

function fakeOutline(kind: string): Array<{ title: string; notes: string }> {
  if (kind === "picture") {
    return [
      {
        title: "[MOCK_AI] The Lost Mitten",
        notes: [
          "A small fox finds a red mitten in the snow.",
          "She asks the owl whose it might be.",
          "The owl shrugs and points to the hill.",
          "On the hill, a rabbit is shivering.",
          "The mitten is too big for the rabbit.",
          "They meet a bear with one cold paw.",
          "The mitten fits the bear exactly.",
          "The bear gives the fox a warm hug.",
          "Everyone walks home together as the stars come out.",
          "The fox falls asleep, warm and happy."
        ].join("\n")
      }
    ];
  }
  return [
    ["The Key", "[MOCK_AI] The heroine finds a key that fits no door in her house, and decides to find out why."],
    ["The Map", "[MOCK_AI] A map in her grandmother's desk points to a house across the valley."],
    ["The Crossing", "[MOCK_AI] She crosses the valley and meets the one person who remembers the house."],
    ["The Door", "[MOCK_AI] The key opens the house, and what she finds inside changes what she believed."],
    ["The Choice", "[MOCK_AI] She must decide whether to keep the secret or tell her family."],
    ["The Return", "[MOCK_AI] She goes home changed, and the key finds its place at last."]
  ].map(([title, notes]) => ({ title: title!, notes: notes! }));
}

/** The first sentence of the first prose line, copied from the text so it is a verbatim quote. */
function firstSentence(markdown: string): string | null {
  const line = markdown
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !/^(?:#|!\[|```|~~~|<!--|\[…)/.test(candidate));
  if (!line) return null;
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  return sentence.slice(0, 200);
}

function userPayload(options: GenerateJsonOptions<unknown>): Record<string, unknown> {
  const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
  if (!userMessage) return {};
  try {
    return record(JSON.parse(userMessage.content));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
