import { z } from "zod";
import { uniqueStrings } from "../collections.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";

export const voiceAgeBandSchema = z.enum(["child", "teen", "young_adult", "adult", "elder"]);
export const voiceGenderPresentationSchema = z.enum(["feminine", "masculine", "neutral", "unknown"]);
export const voiceIntensitySchema = z.enum(["low", "medium", "high"]);
export const voicePaceSchema = z.enum(["slow", "medium", "fast"]);
export const voiceFormalitySchema = z.enum(["casual", "balanced", "formal"]);

export const voiceProfileSchema = z.object({
  ageBand: voiceAgeBandSchema.default("adult"),
  genderPresentation: voiceGenderPresentationSchema.default("unknown"),
  energy: voiceIntensitySchema.default("medium"),
  warmth: voiceIntensitySchema.default("medium"),
  pace: voicePaceSchema.default("medium"),
  formality: voiceFormalitySchema.default("balanced"),
  accentNotes: z.string().optional()
});

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export type VoiceCharacterPageSample = {
  index: number;
  title?: string | undefined;
  markdown?: string | undefined;
  summary?: string | undefined;
};

type PlanCharacter = BookPlan["characters"][number];
type GenderPresentation = VoiceProfile["genderPresentation"];
type GenderEvidence = Record<Exclude<GenderPresentation, "unknown">, number>;
type CharacterMatcher = {
  key: string;
  patterns: RegExp[];
};

const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  ageBand: "adult",
  genderPresentation: "unknown",
  energy: "medium",
  warmth: "medium",
  pace: "medium",
  formality: "balanced"
};

export function normalizeVoiceProfile(value: unknown): VoiceProfile {
  const parsed = voiceProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_VOICE_PROFILE;
}

export function inferVoiceProfileFromCharacter(input: CreateProjectInput, character: PlanCharacter): VoiceProfile {
  const text = [
    character.name,
    character.role,
    character.description,
    character.traits.join(" "),
    character.visualRules.join(" "),
    input.subcategory ?? ""
  ].join(" ").toLowerCase();

  return normalizeVoiceProfile({
    ageBand: inferAgeBand(text, { childAudience: input.category === "KIDS" }),
    genderPresentation: inferGenderPresentation(text),
    energy: /energetic|excited|bold|lively|wild|spirited|brave|adventurous/.test(text)
      ? "high"
      : /quiet|gentle|calm|reserved|soft|shy|sleepy/.test(text)
        ? "low"
        : "medium",
    warmth: /kind|warm|loving|friendly|tender|caring|gentle|sweet/.test(text)
      ? "high"
      : /cold|stern|severe|distant|grim/.test(text)
        ? "low"
        : "medium",
    pace: /quick|fast|rapid|chatty|excited|energetic/.test(text)
      ? "fast"
      : /slow|measured|careful|sleepy|ancient|elder/.test(text)
        ? "slow"
        : "medium",
    formality: /royal|queen|king|professor|scholar|formal|proper|ceremonial/.test(text)
      ? "formal"
      : /playful|casual|kid|child|friend|buddy/.test(text)
        ? "casual"
        : "balanced",
    accentNotes: inferAccentNotes(text)
  });
}

/**
 * Age band for a character, from whatever the description says.
 *
 * Signals are read strongest-first, which is the whole point of the ordering.
 * A stated age beats everything: "a young woman in her early twenties" who is
 * also called a "slave girl" is in her twenties, and reading her as a child
 * would put a child's voice into an adult book.
 *
 * `girl` and `boy` count as ages only in a children's book, where "a brave
 * girl" means exactly that. In any other category they are gender words far
 * more often than age words — "slave girl", "call girl", "the new boy in
 * accounting" — and reading them as ages is what put a child's voice into an
 * adult book.
 */
function inferAgeBand(
  text: string,
  options: { childAudience: boolean } = { childAudience: false }
): VoiceProfile["ageBand"] {
  const statedAge = statedAgeFromText(text);
  if (statedAge !== undefined) {
    return ageBandForYears(statedAge);
  }
  if (/\b(young adult|college|undergraduate|twenties|twenty-something)\b/.test(text)) {
    return "young_adult";
  }
  if (/\b(teen|teenager|teenaged|adolescent|high school|schoolboy|schoolgirl)\b/.test(text)) {
    return "teen";
  }
  if (/\b(elder|elderly|old|ancient|grandmother|grandfather|grandma|grandpa)\b/.test(text)) {
    return "elder";
  }
  if (/\b(child|kid|toddler|infant|baby|young child|small child)\b/.test(text)) {
    return "child";
  }
  if (options.childAudience && /\b(girl|boy)\b/.test(text) && !describesAnAdult(text)) {
    return "child";
  }
  return "adult";
}

/**
 * Whether the description calls this character an adult in so many words.
 *
 * Guards the `girl`/`boy` rule even inside a children's book, where a mother
 * or a grown woman can still be called a girl in passing.
 */
function describesAnAdult(text: string): boolean {
  return /\b(woman|man|adult|lady|gentleman|widow|widower|husband|wife|mother|father)\b/.test(text);
}

/** Years from "in her early twenties", "late thirties", "aged 34", "34 years old". */
function statedAgeFromText(text: string): number | undefined {
  const decades: Record<string, number> = {
    teens: 15,
    twenties: 25,
    thirties: 35,
    forties: 45,
    fifties: 55,
    sixties: 65,
    seventies: 75,
    eighties: 85,
    nineties: 95
  };
  const decade = text.match(/\b(early|mid|late)?[\s-]*(teens|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/);
  if (decade) {
    const base = decades[decade[2]!]!;
    const offset = decade[1] === "early" ? -4 : decade[1] === "late" ? 4 : 0;
    return base + offset;
  }
  const years = text.match(/\b(?:aged\s+)?(\d{1,3})\s*(?:years?\s*old|-year-old)\b/) ?? text.match(/\baged\s+(\d{1,3})\b/);
  const parsed = years ? Number.parseInt(years[1]!, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 130 ? parsed : undefined;
}

function ageBandForYears(years: number): VoiceProfile["ageBand"] {
  if (years < 13) {
    return "child";
  }
  if (years < 18) {
    return "teen";
  }
  if (years < 30) {
    return "young_adult";
  }
  if (years < 60) {
    return "adult";
  }
  return "elder";
}

function inferGenderPresentation(text: string): VoiceProfile["genderPresentation"] {
  if (/\b(she|her|hers|girl|woman|mother|mom|queen|princess|sister|daughter|aunt|female|feminine|lady)\b/.test(text)) {
    return "feminine";
  }
  if (/\b(he|him|his|boy|man|father|dad|king|prince|brother|son|uncle|male|masculine|gentleman)\b/.test(text)) {
    return "masculine";
  }
  if (/\b(they|them|nonbinary|non-binary|androgynous|neutral)\b/.test(text)) {
    return "neutral";
  }
  return "unknown";
}

export function refineVoiceProfileWithPageSamples(
  profile: VoiceProfile,
  characterName: string,
  pages: VoiceCharacterPageSample[],
  characterNames: string[]
): VoiceProfile {
  const evidence = genderEvidenceForCharacter(characterName, pages, characterNames);
  const genderPresentation = genderPresentationFromEvidence(profile.genderPresentation, evidence);
  return normalizeVoiceProfile({
    ...profile,
    genderPresentation
  });
}

function genderEvidenceForCharacter(
  characterName: string,
  pages: VoiceCharacterPageSample[],
  characterNames: string[]
): GenderEvidence {
  const matchers = characterMatchers(uniqueStrings([...characterNames, characterName]));
  const targetKey = characterKey(characterName);
  const evidenceByCharacter = new Map<string, GenderEvidence>();
  for (const matcher of matchers) {
    evidenceByCharacter.set(matcher.key, emptyGenderEvidence());
  }

  for (const page of pages) {
    collectGenderEvidence(page.summary ?? "", matchers, evidenceByCharacter);
    collectGenderEvidence(page.markdown ?? "", matchers, evidenceByCharacter);
  }

  return evidenceByCharacter.get(targetKey) ?? emptyGenderEvidence();
}

/**
 * Credits pronouns to a character only in sentences that name them.
 *
 * Carrying the last-named character forward across unnamed sentences looked
 * like cheap extra signal and was the opposite: a paragraph that names one
 * character and then describes another for three sentences handed all of the
 * second character's pronouns to the first. Unattributable pronouns are now
 * simply dropped — there is far more prose than any character needs.
 */
function collectGenderEvidence(
  text: string,
  matchers: CharacterMatcher[],
  evidenceByCharacter: Map<string, GenderEvidence>
): void {
  for (const segment of splitEvidenceSegments(text)) {
    const mentioned = matchers.filter((matcher) => matcher.patterns.some((pattern) => pattern.test(segment)));
    // Exactly one name, or the pronouns could belong to either of them.
    if (mentioned.length !== 1) {
      continue;
    }
    addGenderEvidence(evidenceByCharacter.get(mentioned[0]!.key), gendersInText(segment));
  }
}

/**
 * Fills in a gender the description did not state. It never overrules one it did.
 *
 * Counting pronouns near a name is a weak signal: prose that sits close to one
 * character floods every neighbourhood of text with that character's pronouns,
 * including the sentences around everyone else's name. It was overruling
 * explicit descriptions — "a tall, imposing man… He is… His demeanor" read as
 * feminine because the narration around him was about someone else — so it is
 * now only consulted when the description left the question open.
 */
function genderPresentationFromEvidence(current: GenderPresentation, evidence: GenderEvidence): GenderPresentation {
  if (current !== "unknown" && current !== "neutral") {
    return current;
  }

  const ranked = (Object.entries(evidence) as Array<[Exclude<GenderPresentation, "unknown">, number]>).sort(
    (first, second) => second[1] - first[1]
  );
  const [bestGender, bestScore] = ranked[0] ?? ["neutral", 0];
  const secondScore = ranked[1]?.[1] ?? 0;
  // A bare majority over hundreds of pronouns is noise. Guessing wrong here is
  // worse than leaving the neutral default in place.
  if (bestScore === 0 || bestScore < secondScore * GENDER_EVIDENCE_MAJORITY) {
    return current;
  }
  return bestGender;
}

/** How far ahead the leading gender must be before a guess is worth making. */
const GENDER_EVIDENCE_MAJORITY = 2;

function gendersInText(text: string): Array<Exclude<GenderPresentation, "unknown">> {
  const genders: Array<Exclude<GenderPresentation, "unknown">> = [];
  if (/\b(she|her|hers)\b/i.test(text)) {
    genders.push("feminine");
  }
  if (/\b(he|him|his)\b/i.test(text)) {
    genders.push("masculine");
  }
  if (/\b(they|them|their|theirs)\b/i.test(text)) {
    genders.push("neutral");
  }
  return genders;
}

function addGenderEvidence(evidence: GenderEvidence | undefined, genders: Array<Exclude<GenderPresentation, "unknown">>): void {
  if (!evidence) {
    return;
  }
  for (const gender of genders) {
    evidence[gender] += 1;
  }
}

function emptyGenderEvidence(): GenderEvidence {
  return {
    feminine: 0,
    masculine: 0,
    neutral: 0
  };
}

function characterMatchers(names: string[]): CharacterMatcher[] {
  return names.map((name) => ({
    key: characterKey(name),
    patterns: characterAliases(name).map((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i"))
  }));
}

function characterAliases(name: string): string[] {
  const clean = name.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return uniqueStrings(
    [clean, words.length > 1 ? words[words.length - 1] : undefined].filter((value): value is string => Boolean(value))
  );
}

function splitEvidenceSegments(text: string): string[] {
  return text
    .split(/(?:[.!?]+|\n+)+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function voiceProfilePortraitCue(profile: VoiceProfile | undefined): string | undefined {
  if (!profile) {
    return undefined;
  }
  const cues = [
    profile.genderPresentation !== "unknown" ? `${profile.genderPresentation} gender presentation` : "",
    profile.ageBand !== "adult" ? `${profile.ageBand === "young_adult" ? "young adult" : profile.ageBand} age band` : ""
  ].filter(Boolean);
  if (cues.length === 0) {
    return undefined;
  }
  return `Voice/portrait continuity: keep the avatar consistent with the chat voice (${cues.join(", ")}). For animals or non-human characters, express this subtly while preserving species anatomy.`;
}

function inferAccentNotes(text: string): string | undefined {
  const explicit = text.match(/\b(?:accent|dialect|speaks with|voice sounds)\b[^.]{0,80}/i)?.[0]?.trim();
  return explicit || undefined;
}

function characterKey(name: string): string {
  return name.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
