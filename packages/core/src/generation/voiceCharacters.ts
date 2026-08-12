import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  libraryCharactersFromMediaSettings,
  matchLibraryCharacter,
  type LibraryCharacterSnapshot
} from "./libraryCharacters.js";
import {
  inferVoiceProfileFromCharacter,
  normalizeVoiceProfile,
  refineVoiceProfileWithPageSamples,
  uniqueStrings,
  voiceProfilePortraitCue,
  voiceProfileSchema,
  type VoiceCharacterPageSample,
  type VoiceProfile
} from "./voiceCharacterProfile.js";

export {
  normalizeVoiceProfile,
  voiceAgeBandSchema,
  voiceFormalitySchema,
  voiceGenderPresentationSchema,
  voiceIntensitySchema,
  voicePaceSchema,
  voiceProfileSchema,
  type VoiceCharacterPageSample,
  type VoiceProfile
} from "./voiceCharacterProfile.js";

export const voiceCharacterCandidateSchema = z.object({
  name: z.string().min(1),
  role: z.string().default("Supporting character"),
  description: z.string().default("Recurring character in the book."),
  traits: z.array(z.string()).default([]),
  visualRules: z.array(z.string()).default([]),
  source: z.enum(["PLAN", "BOOK_SAMPLE"]).default("PLAN"),
  /**
   * The saved library character this cast member *is*, when the plan carried a
   * mentioned character's name. Absent for a character the book invented, and
   * for every candidate extracted from page samples — the model is never shown
   * an id and could not return one.
   */
  libraryCharacterId: z.string().min(1).optional(),
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

type PlanCharacter = BookPlan["characters"][number];
type PersonaDraft = z.infer<typeof personaDraftSchema>;
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
  // Read once for the whole cast: the snapshots are this book's own copy of the
  // @-mentioned library characters, and a plan character links back to one by
  // carrying its name verbatim.
  const librarySnapshots = libraryCharactersFromMediaSettings(input.mediaSettings);
  return plan.characters.map((character) => candidateFromPlanCharacter(input, character, librarySnapshots));
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

/**
 * One cast member, copied from the plan and linked back to the saved character
 * it was made from where there is one.
 *
 * Everything the reader sees about a cast member is otherwise the planner's:
 * the description is what a text model wrote about a character it was given a
 * name for, and the avatar is drawn from that description. A reader who put
 * their own saved character in the book therefore met a same-named twin on the
 * cast sheet. Where the snapshot has its own words they win — they are the
 * user's, and the planner's are at best a paraphrase.
 *
 * The recorded appearance only fills *empty* visualRules. With a look on file
 * the planner is told to reuse it verbatim, so a non-empty rule set already
 * carries it; overwriting one earned from the prose would drop the rest of that
 * character's continuity notes. And the voice profile is inferred from the
 * merged text rather than the plan's, because an age read off a placeholder
 * description is how an adult woman ended up with a six-year-old's voice.
 */
function candidateFromPlanCharacter(
  input: CreateProjectInput,
  character: PlanCharacter,
  librarySnapshots: readonly LibraryCharacterSnapshot[]
): VoiceCharacterCandidate {
  const library = matchLibraryCharacter(character.name, librarySnapshots);
  const appearance = library?.appearance?.trim();
  const merged: PlanCharacter = {
    ...character,
    description: library?.description.trim() || character.description,
    visualRules: character.visualRules.length === 0 && appearance ? [appearance] : character.visualRules
  };
  return voiceCharacterCandidateSchema.parse({
    name: merged.name,
    role: merged.role,
    description: merged.description,
    traits: merged.traits,
    visualRules: merged.visualRules,
    source: "PLAN",
    voiceProfile: inferVoiceProfileFromCharacter(input, merged),
    ...(library ? { libraryCharacterId: library.id } : {})
  });
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
