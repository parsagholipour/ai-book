import {
  jsonPayloadToRecord,
  normalizeGeminiTtsVoiceName,
  normalizeVoiceProfile,
  wavFromPcm16,
  type VoiceConversationHistoryItem,
  type VoiceConversationSpeaker
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Voice-conversation support for the legacy operator API: conversation setup
 * resolution, speaker/snapshot serialization, and voice-call log sanitizing.
 * Split out of routes/projects.ts, its only consumer.
 */

export type VoiceConversationSetup =
  | {
      speakers: VoiceConversationSpeaker[];
      previousConversations: VoiceConversationHistoryItem[];
      parentConversationId: string | null;
      rootConversationId: string | null;
    }
  | {
      statusCode: 400 | 404 | 409;
      error: string;
    };

export async function resolveInitialVoiceConversationSetup(projectId: string, characterIds: string[]): Promise<VoiceConversationSetup> {
  const characters = await prisma.voiceCharacter.findMany({
    where: { id: { in: characterIds } }
  });
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  const orderedCharacters = characterIds.flatMap((characterId) => {
    const character = charactersById.get(characterId);
    return character ? [character] : [];
  });
  if (
    orderedCharacters.length !== characterIds.length ||
    orderedCharacters.some((character) => character.projectId !== projectId)
  ) {
    return { statusCode: 404, error: "Voice conversation character not found." };
  }
  if (orderedCharacters.some((character) => character.status !== "READY")) {
    return { statusCode: 409, error: "Both voice conversation characters must be ready." };
  }
  return {
    speakers: orderedCharacters.map((character) => voiceConversationSpeakerFromRecord(character)),
    previousConversations: [],
    parentConversationId: null,
    rootConversationId: null
  };
}

export async function resolveVoiceConversationContinuationSetup(
  projectId: string,
  parentConversationId: string
): Promise<VoiceConversationSetup> {
  const parent = await prisma.voiceConversation.findUnique({ where: { id: parentConversationId } });
  if (!parent || parent.projectId !== projectId) {
    return { statusCode: 404, error: "Voice conversation not found." };
  }

  const rootConversationId = typeof parent.rootConversationId === "string" && parent.rootConversationId.trim()
    ? parent.rootConversationId
    : parent.id;
  const chain = await prisma.voiceConversation.findMany({
    where: {
      projectId,
      OR: [{ id: rootConversationId }, { rootConversationId }]
    },
    orderBy: { createdAt: "asc" },
    take: 50
  });
  const contextChain = voiceConversationAncestorChain(parent, chain);
  const snapshots = voiceConversationSnapshotsFromRecord(parent.characterSnapshots);
  if (snapshots.length < 2 || snapshots.length > 4) {
    return { statusCode: 409, error: "The original voice conversation does not have a usable saved speaker cast." };
  }

  const characterIds = snapshots.filter((snapshot) => !snapshot.temporary).map((snapshot) => snapshot.id);
  const characters = await prisma.voiceCharacter.findMany({ where: { id: { in: characterIds } } });
  const charactersById = new Map(characters.map((character) => [character.id, character]));
  return {
    speakers: snapshots.map((snapshot) => voiceConversationSpeakerFromSnapshot(snapshot, charactersById.get(snapshot.id))),
    previousConversations: contextChain.map(voiceConversationHistoryItemFromRecord),
    parentConversationId: parent.id,
    rootConversationId
  };
}

export function voiceConversationSpeakerFromRecord(character: {
  id: string;
  name: string;
  role: string;
  description: string;
  traits: unknown;
  persona: unknown;
  voiceProfile: unknown;
}): VoiceConversationSpeaker {
  return {
    id: character.id,
    name: character.name,
    role: character.role,
    description: character.description,
    traits: Array.isArray(character.traits)
      ? character.traits.flatMap((trait) => (typeof trait === "string" && trait.trim() ? [trait.trim()] : []))
      : [],
    persona: jsonPayloadToRecord(character.persona),
    voiceProfile: normalizeVoiceProfile(character.voiceProfile)
  };
}

export type VoiceConversationSnapshot = {
  id: string;
  name: string;
  role?: string | null | undefined;
  description?: string | null | undefined;
  voiceName: string;
  temporary?: boolean | undefined;
};

export function voiceConversationSpeakerFromSnapshot(
  snapshot: VoiceConversationSnapshot,
  character:
    | {
        id: string;
        name: string;
        role: string;
        description: string;
        traits: unknown;
        persona: unknown;
        voiceProfile: unknown;
      }
    | undefined
): VoiceConversationSpeaker {
  const fromRecord = character ? voiceConversationSpeakerFromRecord(character) : null;
  return {
    id: snapshot.id,
    name: snapshot.name,
    role: snapshot.role ?? fromRecord?.role,
    description: snapshot.description ?? fromRecord?.description,
    traits: fromRecord?.traits ?? [],
    persona: fromRecord?.persona ?? {},
    voiceProfile: fromRecord?.voiceProfile ?? normalizeVoiceProfile({}),
    voiceName: normalizeGeminiTtsVoiceName(snapshot.voiceName) ?? snapshot.voiceName,
    temporary: snapshot.temporary
  };
}

export function voiceConversationSnapshotsFromRecord(value: unknown): VoiceConversationSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = jsonPayloadToRecord(entry);
    const id = stringFromRecord(record, "id");
    const name = stringFromRecord(record, "name");
    const voiceName = stringFromRecord(record, "voiceName");
    if (!id || !name || !voiceName) {
      return [];
    }
    return [
      {
        id,
        name,
        role: stringFromRecord(record, "role"),
        description: stringFromRecord(record, "description"),
        voiceName,
        temporary: record.temporary === true
      }
    ];
  });
}

export function voiceConversationAncestorChain<T extends { id: string; parentConversationId: string | null; createdAt: Date }>(
  parent: T,
  chain: T[]
): T[] {
  const byId = new Map(chain.map((conversation) => [conversation.id, conversation]));
  const ancestors: T[] = [];
  let current: T | undefined = parent;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ancestors.unshift(current);
    current = current.parentConversationId ? byId.get(current.parentConversationId) : undefined;
  }
  return ancestors.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

export function voiceConversationHistoryItemFromRecord(conversation: {
  prompt: string;
  transcript: unknown;
}): VoiceConversationHistoryItem {
  const transcript = jsonPayloadToRecord(conversation.transcript);
  const rawTurns = Array.isArray(transcript.turns) ? transcript.turns : [];
  return {
    prompt: conversation.prompt,
    transcript: {
      ...(typeof transcript.title === "string" && transcript.title.trim() ? { title: transcript.title.trim() } : {}),
      turns: rawTurns.flatMap((turn) => {
        const record = jsonPayloadToRecord(turn);
        const speakerId = stringFromRecord(record, "speakerId");
        const speakerName = stringFromRecord(record, "speakerName");
        const text = stringFromRecord(record, "text");
        return speakerId && speakerName && text ? [{ speakerId, speakerName, text }] : [];
      })
    }
  };
}

export function mockVoiceConversationWav(): Buffer {
  return wavFromPcm16(Buffer.alloc(24_000 * 2), { sampleRate: 24_000 });
}

export function serializeVoiceConversation(conversation: {
  id: string;
  projectId: string;
  parentConversationId: string | null;
  rootConversationId: string | null;
  prompt: string;
  characterSnapshots: unknown;
  transcript: unknown;
  provider: string;
  model: string;
  audioPath: string;
  durationMs: number | null;
  metadata: unknown;
  createdAt: Date;
}) {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    parentConversationId: conversation.parentConversationId,
    rootConversationId: conversation.rootConversationId,
    prompt: conversation.prompt,
    characters: conversation.characterSnapshots,
    transcript: conversation.transcript,
    provider: conversation.provider,
    model: conversation.model,
    audioPath: conversation.audioPath,
    durationMs: conversation.durationMs,
    metadata: conversation.metadata,
    createdAt: conversation.createdAt.toISOString()
  };
}


export function sanitizeVoiceCallMetadata(
  metadata: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> {
  const entries: Array<[string, string | number | boolean | null]> = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveVoiceCallKey(key)) {
      continue;
    }
    if (typeof value === "string") {
      entries.push([key, sanitizeVoiceCallText(value, 240)]);
      continue;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        entries.push([key, value]);
      }
      continue;
    }
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeVoiceCallOptionalText(value: string | undefined): string | undefined {
  const sanitized = value ? sanitizeVoiceCallText(value) : "";
  return sanitized || undefined;
}

export function sanitizeVoiceCallText(value: string, maxLength = 500): string {
  return value
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{0,4}\b/gi, "[redacted-ip]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function isSensitiveVoiceCallKey(key: string): boolean {
  return /sdp|candidate|ip|address|port|audio|transcript|secret|credential|token|password/i.test(key);
}

export function isVoiceConfigurationError(message: string): boolean {
  return /OPENAI_API_KEY|GEMINI_API_KEY|required|not configured|Unsupported voice provider|offer SDP/i.test(message);
}

export function stringFromRecord(value: unknown, key: string): string | null {
  const record = jsonPayloadToRecord(value);
  const field = record[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}
