/**
 * One page's stripped text and tokens, built once per compile and reused by
 * every manuscript check. The near-duplicate loop is n(n-1)/2 comparisons; a
 * 60-page book used to re-run `plainMarkdown` plus the word regex ~3,500 times.
 */

export type PageTokens = {
  values: string[];
  starts: number[];
  ends: number[];
  wordCount: number;
  script: NonSpacedScript | null;
};

export type NonSpacedScript = { pattern: RegExp; charactersPerWord: number };

export const WORD_TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}]/u;

export const CJK_SCRIPT: NonSpacedScript = {
  pattern: /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u,
  charactersPerWord: 2
};
export const UNSEGMENTED_SCRIPT: NonSpacedScript = {
  pattern: /[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}]/u,
  charactersPerWord: 4
};
const NON_SPACED_CHARACTER_PATTERN = new RegExp(
  `${CJK_SCRIPT.pattern.source}|${UNSEGMENTED_SCRIPT.pattern.source}`,
  "u"
);
const COMBINING_MARK_PATTERN = /\p{M}/u;

export const SENTENCE_BOUNDARY_PATTERN =
  /(?<=[。！？។။][」』】〉》）'’"”]*)(?![」』】〉》）'’"”])|(?<=[.!?؟۔…]['’"”»)\]]*)\s+|(?<=[\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}])\s+/u;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function plainMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!??\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*_`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizePage(plain: string): PageTokens {
  const values: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of plain.matchAll(WORD_TOKEN_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    values.push(raw.toLowerCase());
    starts.push(start);
    ends.push(start + raw.length);
  }
  return { values, starts, ends, ...measureWords(values) };
}

function measureWords(tokens: string[]): { wordCount: number; script: NonSpacedScript | null } {
  let spacedWords = 0;
  let cjkCharacters = 0;
  let unsegmentedCharacters = 0;
  for (const token of tokens) {
    if (!NON_SPACED_CHARACTER_PATTERN.test(token)) {
      spacedWords += 1;
      continue;
    }
    let spacedCharacters = 0;
    for (const character of token) {
      if (COMBINING_MARK_PATTERN.test(character)) {
        continue;
      }
      if (CJK_SCRIPT.pattern.test(character)) {
        cjkCharacters += 1;
      } else if (UNSEGMENTED_SCRIPT.pattern.test(character)) {
        unsegmentedCharacters += 1;
      } else {
        spacedCharacters += 1;
      }
    }
    if (spacedCharacters > 0) {
      spacedWords += 1;
    }
  }
  const cjkWords = Math.ceil(cjkCharacters / CJK_SCRIPT.charactersPerWord);
  const unsegmentedWords = Math.ceil(unsegmentedCharacters / UNSEGMENTED_SCRIPT.charactersPerWord);
  const wordCount = spacedWords + cjkWords + unsegmentedWords;
  const script =
    cjkWords > 0 && cjkWords >= unsegmentedWords && cjkWords * 2 >= wordCount
      ? CJK_SCRIPT
      : unsegmentedWords > 0 && unsegmentedWords * 2 >= wordCount
        ? UNSEGMENTED_SCRIPT
        : null;
  return { wordCount, script };
}

export function firstSentence(plain: string): string {
  return plain.split(SENTENCE_BOUNDARY_PATTERN)[0] ?? "";
}

export type RepetitionLane = {
  count: number;
  hashAt(start: number): number | null;
  keyAt(start: number): string;
  quoteAt(start: number): string;
};

export function repetitionLane(
  text: string,
  tokens: PageTokens,
  spec: { words: number; minKeyLength: number }
): RepetitionLane {
  return tokens.script
    ? nonSpacedCharacterLane(text, tokens.script, spec.words * tokens.script.charactersPerWord)
    : spacedWordLane(text, tokens, spec.words, spec.minKeyLength);
}

function spacedWordLane(text: string, tokens: PageTokens, window: number, minKeyLength: number): RepetitionLane {
  const { values, starts, ends } = tokens;
  return {
    count: Math.max(0, values.length - window + 1),
    hashAt(start) {
      let length = window - 1;
      let hash = FNV_OFFSET_BASIS;
      for (let offset = 0; offset < window; offset += 1) {
        const word = values[start + offset]!;
        if (offset > 0) {
          hash = Math.imul(hash ^ 0x20, FNV_PRIME);
        }
        length += word.length;
        for (let position = 0; position < word.length; position += 1) {
          hash = Math.imul(hash ^ word.charCodeAt(position), FNV_PRIME);
        }
      }
      return length < minKeyLength ? null : hash;
    },
    keyAt: (start) => values.slice(start, start + window).join(" "),
    quoteAt: (start) => text.slice(starts[start]!, ends[start + window - 1]!)
  };
}

function nonSpacedCharacterLane(text: string, script: NonSpacedScript, window: number): RepetitionLane {
  const characters: string[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    if (script.pattern.test(character) && WORD_CHARACTER_PATTERN.test(character)) {
      characters.push(character);
      offsets.push(offset);
    }
    offset += character.length;
  }
  return {
    count: Math.max(0, characters.length - window + 1),
    hashAt(start) {
      let hash = FNV_OFFSET_BASIS;
      for (let position = 0; position < window; position += 1) {
        const character = characters[start + position]!;
        for (let unit = 0; unit < character.length; unit += 1) {
          hash = Math.imul(hash ^ character.charCodeAt(unit), FNV_PRIME);
        }
      }
      return hash;
    },
    keyAt: (start) => characters.slice(start, start + window).join(""),
    quoteAt(start) {
      const last = start + window - 1;
      return text.slice(offsets[start]!, offsets[last]! + characters[last]!.length);
    }
  };
}

export function forEachDistinctShingle(lane: RepetitionLane, visit: (hash: number, start: number) => void): void {
  const seen = new Set<number>();
  for (let start = 0; start < lane.count; start += 1) {
    const hash = lane.hashAt(start);
    if (hash === null || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    visit(hash, start);
  }
}

export function candidateShingleHashes(
  pageCount: number,
  laneFor: (pageIndex: number) => RepetitionLane | null,
  minPages: number
): Set<number> {
  const pagesByHash = new Map<number, number>();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const lane = laneFor(pageIndex);
    if (!lane) {
      continue;
    }
    forEachDistinctShingle(lane, (hash) => {
      pagesByHash.set(hash, (pagesByHash.get(hash) ?? 0) + 1);
    });
  }
  const candidates = new Set<number>();
  for (const [hash, count] of pagesByHash) {
    if (count >= minPages) {
      candidates.add(hash);
    }
  }
  return candidates;
}
