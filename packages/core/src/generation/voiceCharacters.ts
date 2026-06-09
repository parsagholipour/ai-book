import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithJailbreak } from "./generateWithJailbreak.js";
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

  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "extract-voice-character-candidates",
    lessCensored: false,
    jailbreakRole: "planner",
    temperature: 0.2,
    maxTokens: 1200,
    schema: voiceCharacterCandidateListSchema,
    messages: [
      {
        role: "system",
        content: [
          "Extract recurring fictional characters for a future voice-chat feature.",
          "Use only the supplied book plan and first-page sample.",
          "Return compact JSON. Do not include real people, authors, historical figures, or generic narrators.",
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
          firstPages: compactPageSamples(options.pages)
        })
      }
    ]
  });

  const candidates = dedupeCandidates(
    result.data.characters
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
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "build-voice-character-persona",
    lessCensored: false,
    jailbreakRole: "planner",
    temperature: 0.35,
    maxTokens: 1800,
    schema: personaDraftSchema,
    messages: [
      {
        role: "system",
        content: [
          "Create a concise fictional character persona for live voice chat.",
          "Use only the supplied plan, candidate, page summaries, and first pages.",
          "Do not store or ask for audio transcripts.",
          "Do not claim knowledge beyond the book. Spoiler boundaries should prevent revealing later plot unless the user asks.",
          "Return compact JSON only."
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
            prompt: options.input.prompt,
            category: options.input.category,
            subcategory: options.input.subcategory
          },
          candidate: options.candidate,
          firstPages: compactPageSamples(options.pages)
        })
      }
    ]
  });

  const voiceProfile = refineVoiceProfileWithPageSamples(
    normalizeVoiceProfile({
      ...options.candidate.voiceProfile,
      ...result.data.voiceProfile
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
    personality: result.data.personality,
    goals: result.data.goals,
    relationships: result.data.relationships,
    knownFacts: result.data.knownFacts,
    speakingStyle: result.data.speakingStyle,
    spoilerBoundaries: result.data.spoilerBoundaries,
    greeting: result.data.greeting.trim() || greetingForCandidate(options.candidate),
    voiceProfile,
    instructions: ""
  };
  return {
    ...persona,
    instructions: buildRealtimeCharacterInstructions(persona, options.plan)
  };
}

export function deterministicVoiceCharacterPersona(candidate: VoiceCharacterCandidate, plan: BookPlan): VoiceCharacterPersona {
  const persona: VoiceCharacterPersona = {
    name: candidate.name,
    role: candidate.role,
    description: candidate.description,
    traits: candidate.traits,
    visualRules: candidate.visualRules,
    personality: candidate.traits.length ? candidate.traits : [candidate.description],
    goals: [`Stay faithful to the character's role in ${plan.title}.`],
    relationships: [],
    knownFacts: [candidate.description],
    speakingStyle: [`Speak in the spirit of ${plan.title}.`],
    spoilerBoundaries: ["Do not reveal events beyond what the user has already discussed unless they ask for spoilers."],
    greeting: greetingForCandidate(candidate),
    voiceProfile: normalizeVoiceProfile(candidate.voiceProfile),
    instructions: ""
  };
  return {
    ...persona,
    instructions: buildRealtimeCharacterInstructions(persona, plan)
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
  return [
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
    ageBand: inferAgeBand(text),
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

function inferAgeBand(text: string): VoiceProfile["ageBand"] {
  if (/\b(child|kid|toddler|little|young child|small child|girl|boy)\b/.test(text)) {
    return "child";
  }
  if (/\b(teen|teenager|adolescent|high school|young woman|young man)\b/.test(text)) {
    return "teen";
  }
  if (/\b(young adult|college|twenty|twenties)\b/.test(text)) {
    return "young_adult";
  }
  if (/\b(elder|elderly|old|ancient|grandmother|grandfather|grandma|grandpa|wise old)\b/.test(text)) {
    return "elder";
  }
  return "adult";
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

function collectGenderEvidence(
  text: string,
  matchers: CharacterMatcher[],
  evidenceByCharacter: Map<string, GenderEvidence>
): void {
  let lastMentionedKey: string | undefined;
  for (const segment of splitEvidenceSegments(text)) {
    const mentioned = matchers.filter((matcher) => matcher.patterns.some((pattern) => pattern.test(segment)));
    const genders = gendersInText(segment);
    if (mentioned.length === 1) {
      lastMentionedKey = mentioned[0]!.key;
      addGenderEvidence(evidenceByCharacter.get(lastMentionedKey), genders);
      continue;
    }
    if (mentioned.length > 1) {
      lastMentionedKey = undefined;
      continue;
    }
    if (lastMentionedKey) {
      addGenderEvidence(evidenceByCharacter.get(lastMentionedKey), genders);
    }
  }
}

function genderPresentationFromEvidence(current: GenderPresentation, evidence: GenderEvidence): GenderPresentation {
  const ranked = (Object.entries(evidence) as Array<[Exclude<GenderPresentation, "unknown">, number]>).sort(
    (first, second) => second[1] - first[1]
  );
  const [bestGender, bestScore] = ranked[0] ?? ["neutral", 0];
  const secondScore = ranked[1]?.[1] ?? 0;
  if (bestScore === 0 || bestScore === secondScore) {
    return current;
  }
  if (current === "unknown" || current === "neutral") {
    return bestGender;
  }
  return bestScore >= (evidence[current as Exclude<GenderPresentation, "unknown">] ?? 0) + 2 ? bestGender : current;
}

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

function compactPageSamples(pages: VoiceCharacterPageSample[]) {
  return pages.slice(0, 10).map((page) => ({
    index: page.index,
    title: page.title,
    summary: clip(page.summary ?? "", 500),
    excerpt: clip(page.markdown ?? "", 900)
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

function clip(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  const sliced = clean.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${sliced.slice(0, lastSpace > 120 ? lastSpace : maxLength).trim()}...`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function characterKey(name: string): string {
  return name.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
