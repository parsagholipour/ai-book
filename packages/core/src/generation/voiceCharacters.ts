import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
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

export const voiceCharacterCandidateSchema = z.object({
  name: z.string().min(1),
  role: z.string().default("Supporting character"),
  description: z.string().default("Recurring character in the book."),
  traits: z.array(z.string()).default([]),
  visualRules: z.array(z.string()).default([]),
  source: z.enum(["PLAN", "BOOK_SAMPLE"]).default("PLAN"),
  voiceProfile: voiceProfileSchema.default({
    ageBand: "adult",
    genderPresentation: "unknown",
    energy: "medium",
    warmth: "medium",
    pace: "medium",
    formality: "balanced"
  })
});

const voiceCharacterCandidateListSchema = z.object({
  characters: z.array(voiceCharacterCandidateSchema).max(6).default([])
});

const personaDraftSchema = z.object({
  personality: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  relationships: z.array(z.string()).default([]),
  knownFacts: z.array(z.string()).default([]),
  speakingStyle: z.array(z.string()).default([]),
  spoilerBoundaries: z.array(z.string()).default([]),
  greeting: z.string().default("Hello. I am glad you called."),
  voiceProfile: voiceProfileSchema.optional()
});

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;
export type VoiceCharacterCandidate = z.infer<typeof voiceCharacterCandidateSchema>;
export type VoiceCharacterPersona = {
  name: string;
  role: string;
  description: string;
  traits: string[];
  visualRules: string[];
  personality: string[];
  goals: string[];
  relationships: string[];
  knownFacts: string[];
  speakingStyle: string[];
  spoilerBoundaries: string[];
  greeting: string;
  instructions: string;
  voiceProfile: VoiceProfile;
};

export type RealtimeBookCastMember = {
  name: string;
  role?: string | null | undefined;
  description?: string | null | undefined;
};

export type VoiceCharacterPageSample = {
  index: number;
  title?: string | undefined;
  markdown?: string | undefined;
  summary?: string | undefined;
};

type PlanCharacter = BookPlan["characters"][number];
type PersonaDraft = z.infer<typeof personaDraftSchema>;
type GenderPresentation = VoiceProfile["genderPresentation"];
type GenderEvidence = Record<Exclude<GenderPresentation, "unknown">, number>;
type CharacterMatcher = {
  key: string;
  patterns: RegExp[];
};
type VoiceCharacterModelPageSample = {
  index: number;
  title?: string | undefined;
  summary: string;
  excerpt: string;
  part?: {
    index: number;
    total: number;
  };
};

const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  ageBand: "adult",
  genderPresentation: "unknown",
  energy: "medium",
  warmth: "medium",
  pace: "medium",
  formality: "balanced"
};
const VOICE_CHARACTER_PAGE_CHUNK_CHAR_BUDGET = 24_000;

export function voiceCharactersDisabledForInput(input: Pick<CreateProjectInput, "category" | "prompt" | "subcategory">): boolean {
  if (input.category === "BIOGRAPHY" || input.category === "HISTORY") {
    return !looksFictional(input.prompt, input.subcategory);
  }
  return false;
}

export function shouldExtractFallbackVoiceCharacters(input: Pick<CreateProjectInput, "category" | "prompt" | "subcategory">): boolean {
  if (voiceCharactersDisabledForInput(input)) {
    return false;
  }
  return input.category === "STORY" || input.category === "KIDS" || looksFictional(input.prompt, input.subcategory);
}

export function candidatesFromPlanCharacters(input: CreateProjectInput, plan: BookPlan): VoiceCharacterCandidate[] {
  if (voiceCharactersDisabledForInput(input)) {
    return [];
  }
  return plan.characters.map((character) => candidateFromPlanCharacter(input, character));
}

export async function extractVoiceCharacterCandidates(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  pages: VoiceCharacterPageSample[];
  textModel: TextModelAdapter;
}): Promise<VoiceCharacterCandidate[]> {
  const planCandidates = candidatesFromPlanCharacters(options.input, options.plan);
  if (planCandidates.length > 0) {
    return refineVoiceCharacterCandidatesWithPageSamples(planCandidates, options.pages, options.plan.characters.map((character) => character.name));
  }
  if (!shouldExtractFallbackVoiceCharacters(options.input) || options.pages.length === 0) {
    return [];
  }

  const pageChunks = pageSampleChunks(options.pages);
  const modelCandidates: VoiceCharacterCandidate[] = [];
  for (const [chunkIndex, pageChunk] of pageChunks.entries()) {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "extract-voice-character-candidates",
      temperature: 0.2,
      schema: voiceCharacterCandidateListSchema,
      messages: [
        {
          role: "system",
          content: [
            "Extract recurring fictional characters for a future voice-chat feature.",
            "Use only the supplied book plan and page sample chunk.",
            "Return one complete JSON object. Do not include real people, authors, historical figures, or generic narrators.",
            "If no safe fictional character is present, return an empty characters array.",
            "Infer age/gender voice profile only from explicit evidence; use unknown/neutral adult defaults otherwise."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              prompt: options.input.prompt,
              category: options.input.category,
              subcategory: options.input.subcategory
            },
            pageChunk: {
              index: chunkIndex + 1,
              total: pageChunks.length,
              pages: pageChunk
            }
          })
        }
      ]
    });
    modelCandidates.push(...result.data.characters);
  }

  const candidates = dedupeCandidates(
    modelCandidates
      .map((candidate) => ({
        ...candidate,
        source: "BOOK_SAMPLE" as const,
        voiceProfile: normalizeVoiceProfile(candidate.voiceProfile)
      }))
      .filter((candidate) => safeCandidateName(candidate.name))
  );
  return refineVoiceCharacterCandidatesWithPageSamples(candidates, options.pages);
}

export async function buildVoiceCharacterPersona(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  candidate: VoiceCharacterCandidate;
  pages: VoiceCharacterPageSample[];
  textModel: TextModelAdapter;
}): Promise<VoiceCharacterPersona> {
  const pageChunks = pageSampleChunks(options.pages);
  const chunks = pageChunks.length > 0 ? pageChunks : [[]];
  const personaDrafts: PersonaDraft[] = [];
  for (const [chunkIndex, pageChunk] of chunks.entries()) {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "build-voice-character-persona",
      temperature: 0.35,
      schema: personaDraftSchema,
      messages: [
        {
          role: "system",
          content: [
            "Create a concise fictional character persona for live voice chat.",
            "Use only the supplied plan, candidate, page summaries, and page sample chunk.",
            "Do not store or ask for audio transcripts.",
            "Do not claim knowledge beyond the book. Spoiler boundaries should prevent revealing later plot unless the user asks.",
            "Return one complete JSON object only."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              voiceGuide: options.plan.voiceGuide,
              cast: options.plan.characters,
              prompt: options.input.prompt,
              category: options.input.category,
              subcategory: options.input.subcategory
            },
            candidate: options.candidate,
            pageChunk: {
              index: chunkIndex + 1,
              total: chunks.length,
              pages: pageChunk
            }
          })
        }
      ]
    });
    personaDrafts.push(result.data);
  }
  const personaDraft = mergePersonaDrafts(personaDrafts);

  const voiceProfile = refineVoiceProfileWithPageSamples(
    normalizeVoiceProfile({
      ...options.candidate.voiceProfile,
      ...personaDraft.voiceProfile
    }),
    options.candidate.name,
    options.pages,
    [...options.plan.characters.map((character) => character.name), options.candidate.name]
  );
  const persona: VoiceCharacterPersona = {
    name: options.candidate.name,
    role: options.candidate.role,
    description: options.candidate.description,
    traits: options.candidate.traits,
    visualRules: options.candidate.visualRules,
    personality: personaDraft.personality,
    goals: personaDraft.goals,
    relationships: personaDraft.relationships,
    knownFacts: personaDraft.knownFacts,
    speakingStyle: personaDraft.speakingStyle,
    spoilerBoundaries: personaDraft.spoilerBoundaries,
    greeting: personaDraft.greeting.trim() || greetingForCandidate(options.candidate),
    voiceProfile,
    instructions: ""
  };
  return {
    ...persona,
    instructions: buildRealtimeCharacterInstructions(persona, options.plan)
  };
}

export function buildCharacterProfileImagePrompt(options: {
  plan: BookPlan;
  candidate: {
    name: string;
    role: string;
    description: string;
    traits: string[];
    visualRules: string[];
    voiceProfile?: VoiceProfile | undefined;
  };
}): string {
  const visualRules = options.candidate.visualRules.length
    ? options.candidate.visualRules.join(" ")
    : "Create a clear, memorable portrait based on the character description.";
  const voiceContinuity = voiceProfilePortraitCue(options.candidate.voiceProfile);
  return [
    "Text-free square profile portrait for a fictional character voice call.",
    `Book title: ${options.plan.title}.`,
    `Character name: ${options.candidate.name}.`,
    `Role: ${options.candidate.role}.`,
    `Description: ${options.candidate.description}.`,
    options.candidate.traits.length ? `Personality to imply visually: ${options.candidate.traits.join(", ")}.` : "",
    voiceContinuity,
    `Visual rules: ${visualRules}`,
    `Book art style: ${options.plan.illustrationPlan.globalStyle}.`,
    "Show one character from shoulders up, facing camera, friendly call-avatar composition.",
    "Use a clean background and strong readable silhouette.",
    "Do not include readable text, labels, captions, watermarks, logos, UI, speech bubbles, or multiple characters."
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeVoiceProfile(value: unknown): VoiceProfile {
  const parsed = voiceProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_VOICE_PROFILE;
}

export function refineVoiceCharacterCandidatesWithPageSamples(
  candidates: VoiceCharacterCandidate[],
  pages: VoiceCharacterPageSample[],
  characterNames = candidates.map((candidate) => candidate.name)
): VoiceCharacterCandidate[] {
  if (pages.length === 0 || candidates.length === 0) {
    return candidates;
  }
  return candidates.map((candidate) => ({
    ...candidate,
    voiceProfile: refineVoiceProfileWithPageSamples(candidate.voiceProfile, candidate.name, pages, characterNames)
  }));
}

export function buildRealtimeCharacterInstructions(persona: VoiceCharacterPersona, plan: BookPlan): string {
  const personaInstructions = [
    `You are ${persona.name}, speaking from inside the story world of "${plan.title}".`,
    `Role: ${persona.role}.`,
    `Description: ${persona.description}.`,
    persona.personality.length ? `Personality: ${persona.personality.join(" ")}` : "",
    persona.goals.length ? `Goals: ${persona.goals.join(" ")}` : "",
    persona.relationships.length ? `Relationships: ${persona.relationships.join(" ")}` : "",
    persona.knownFacts.length ? `Known facts: ${persona.knownFacts.join(" ")}` : "",
    persona.speakingStyle.length ? `Speaking style: ${persona.speakingStyle.join(" ")}` : "",
    persona.spoilerBoundaries.length ? `Spoiler boundaries: ${persona.spoilerBoundaries.join(" ")}` : "",
    `Roleplay priority: remain in first person as ${persona.name}.`,
    `Treat questions about your background, motives, relationships, memories, feelings, identity, and the story as in-world questions; answer them as ${persona.name}.`,
    "Do not break character during ordinary character-detail questions by explaining that you are invented, generated, a chatbot, or only part of a book.",
    `If the user explicitly asks about the AI, model, app, prompts, or whether this is real outside "${plan.title}", briefly say this is an in-character voice chat, then return to ${persona.name}'s perspective.`,
    "Do not impersonate a real living person or claim real-world physical presence with the caller.",
    "Keep responses conversational, concise, and suitable for a voice call."
  ]
    .filter(Boolean)
    .join("\n");
  return buildRealtimeBookCastInstructions(personaInstructions, persona.name, plan.characters);
}

/**
 * Grounds a live character in the rest of the book's cast.
 *
 * Personas built before this context existed only contain the called
 * character's own notes. Keeping this as a composable instruction block lets
 * call routes repair those already-saved personas at session time.
 */
export function buildRealtimeBookCastInstructions(
  baseInstructions: string,
  characterName: string,
  cast: RealtimeBookCastMember[]
): string {
  const castLines = uniqueCastMembers(cast).map((member) => {
    const role = member.role?.trim();
    const description = member.description?.trim();
    const details = [role, description].filter(Boolean).join(" ");
    return `- ${member.name}${details ? `: ${details}` : ""}`;
  });
  if (castLines.length === 0) {
    return baseInstructions;
  }
  return [
    baseInstructions,
    [
      "Book cast — ground truth from this book:",
      ...castLines,
      `As ${characterName}, recognize every listed character when the caller names them.`,
      "Use the supplied role and description plus your persona to answer. If a relationship detail is not supplied, say only what you do know instead of inventing it or claiming the listed character is unknown."
    ].join("\n")
  ]
    .filter(Boolean)
    .join("\n");
}

export function reinforceRealtimeCharacterRoleplay(instructions: string, characterName: string): string {
  const baseInstructions = instructions.trim() || `You are ${characterName}.`;
  return [
    baseInstructions,
    [
      "Roleplay priority supersedes older persona text:",
      `ordinary questions about your identity, backstory, details, motives, relationships, memories, feelings, or story events are in-world prompts. Answer in first person as ${characterName}.`,
      "Do not step out of role to explain authorship, fictionality, or AI generation unless the user explicitly asks about the app, model, prompt, or real-world nature of the chat.",
      "If they ask an explicit out-of-character system question, keep the clarification brief, then return to character.",
      "Do not impersonate a real living person or claim real-world physical presence with the caller."
    ].join(" ")
  ].join("\n");
}

export function buildRealtimeGroupCharacterInstructions(options: {
  baseInstructions: string;
  characterName: string;
  participantNames: string[];
}): string {
  const baseInstructions = reinforceRealtimeCharacterRoleplay(options.baseInstructions, options.characterName);
  const participantNames = uniqueStrings(options.participantNames.map((name) => name.trim()).filter(Boolean));
  const otherCharacters = participantNames.filter((name) => name.toLowerCase() !== options.characterName.toLowerCase());
  return [
    baseInstructions,
    [
      "Group voice room rules:",
      `The room participants are User${participantNames.length ? `, ${participantNames.join(", ")}` : ""}.`,
      otherCharacters.length
        ? `Other characters in the room: ${otherCharacters.join(", ")}. Treat their quoted lines as in-world speech.`
        : "",
      `Speak only as ${options.characterName}; never narrate, imitate, or answer for another participant.`,
      "Wait for conductor prompts before speaking. Each prompt contains the recent room transcript and names you as the next speaker.",
      "Answer the latest user or character line naturally, in first person, and keep each turn concise enough for a live voice conversation.",
      "If a prompt says the user interrupted, stop the prior thought and respond to the user's newest line."
    ]
      .filter(Boolean)
      .join(" ")
  ].join("\n");
}

export function buildRealtimeGroupListenerInstructions(participantNames: string[]): string {
  const names = uniqueStrings(participantNames.map((name) => name.trim()).filter(Boolean));
  return [
    "You are a hidden listener for a live fictional character group voice room.",
    "Transcribe the user's microphone input for routing only.",
    "Do not roleplay, do not answer the user, and do not generate spoken responses.",
    names.length ? `Characters in the room: ${names.join(", ")}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function candidateFromPlanCharacter(input: CreateProjectInput, character: PlanCharacter): VoiceCharacterCandidate {
  return voiceCharacterCandidateSchema.parse({
    name: character.name,
    role: character.role,
    description: character.description,
    traits: character.traits,
    visualRules: character.visualRules,
    source: "PLAN",
    voiceProfile: inferVoiceProfileFromCharacter(input, character)
  });
}

function inferVoiceProfileFromCharacter(input: CreateProjectInput, character: PlanCharacter): VoiceProfile {
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

function refineVoiceProfileWithPageSamples(
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

function voiceProfilePortraitCue(profile: VoiceProfile | undefined): string | undefined {
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

function mergePersonaDrafts(drafts: PersonaDraft[]): PersonaDraft {
  const voiceProfile = normalizeVoiceProfile(
    drafts.reduce<Record<string, unknown>>((profile, draft) => ({ ...profile, ...draft.voiceProfile }), {})
  );
  return {
    personality: uniqueStrings(drafts.flatMap((draft) => draft.personality)),
    goals: uniqueStrings(drafts.flatMap((draft) => draft.goals)),
    relationships: uniqueStrings(drafts.flatMap((draft) => draft.relationships)),
    knownFacts: uniqueStrings(drafts.flatMap((draft) => draft.knownFacts)),
    speakingStyle: uniqueStrings(drafts.flatMap((draft) => draft.speakingStyle)),
    spoilerBoundaries: uniqueStrings(drafts.flatMap((draft) => draft.spoilerBoundaries)),
    greeting: drafts.find((draft) => draft.greeting.trim())?.greeting ?? "Hello. I am glad you called.",
    voiceProfile
  };
}

function pageSampleChunks(pages: VoiceCharacterPageSample[]): VoiceCharacterModelPageSample[][] {
  const chunks: VoiceCharacterModelPageSample[][] = [];
  let current: VoiceCharacterModelPageSample[] = [];
  let currentSize = 0;

  for (const sample of pages.flatMap(pageModelSamples)) {
    const sampleSize = JSON.stringify(sample).length;
    if (current.length > 0 && currentSize + sampleSize > VOICE_CHARACTER_PAGE_CHUNK_CHAR_BUDGET) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(sample);
    currentSize += sampleSize;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function pageModelSamples(page: VoiceCharacterPageSample): VoiceCharacterModelPageSample[] {
  const summary = normalizePageText(page.summary ?? "");
  const excerpt = normalizePageText(page.markdown ?? "");
  const baseSize = JSON.stringify({
    index: page.index,
    title: page.title,
    summary,
    excerpt: ""
  }).length;
  const excerptBudget = Math.max(1_000, VOICE_CHARACTER_PAGE_CHUNK_CHAR_BUDGET - baseSize);
  const parts = splitText(excerpt, excerptBudget);
  return parts.map((part, index) => ({
    index: page.index,
    title: page.title,
    summary,
    excerpt: part,
    ...(parts.length > 1
      ? {
          part: {
            index: index + 1,
            total: parts.length
          }
        }
      : {})
  }));
}

function dedupeCandidates(candidates: VoiceCharacterCandidate[]): VoiceCharacterCandidate[] {
  const seen = new Set<string>();
  const unique: VoiceCharacterCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function safeCandidateName(name: string): boolean {
  return Boolean(name.trim()) && !/\b(author|narrator|reader|historian|biographer)\b/i.test(name);
}

function looksFictional(prompt: string, subcategory?: string | null): boolean {
  const text = `${prompt} ${subcategory ?? ""}`.toLowerCase();
  return /\b(story|fiction|novel|character|protagonist|hero|heroine|fantasy|romance|mystery|thriller|adventure|fairy tale|bedtime|picture book)\b/.test(text);
}

function greetingForCandidate(candidate: VoiceCharacterCandidate): string {
  return `Hello, I am ${candidate.name}.`;
}

function splitText(text: string, maxLength: number): string[] {
  const clean = normalizePageText(text);
  if (!clean) {
    return [""];
  }
  const parts: string[] = [];
  for (let start = 0; start < clean.length; ) {
    const hardEnd = Math.min(clean.length, start + maxLength);
    if (hardEnd === clean.length) {
      parts.push(clean.slice(start).trim());
      break;
    }
    const softEnd = clean.lastIndexOf(" ", hardEnd);
    const end = softEnd > start + Math.floor(maxLength * 0.6) ? softEnd : hardEnd;
    parts.push(clean.slice(start, end).trim());
    start = end;
  }
  return parts.filter(Boolean);
}

function normalizePageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueCastMembers(cast: RealtimeBookCastMember[]): RealtimeBookCastMember[] {
  const seen = new Set<string>();
  const members: RealtimeBookCastMember[] = [];
  for (const member of cast) {
    const name = member.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    members.push({
      name,
      role: member.role?.trim() || undefined,
      description: member.description?.trim() || undefined
    });
  }
  return members;
}

function characterKey(name: string): string {
  return name.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
