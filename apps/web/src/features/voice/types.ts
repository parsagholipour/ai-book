import type { VoiceCharacter, VoiceProviderInfo } from "../../api.js";
import type { BrowserVoiceCallClient } from "./BrowserVoiceCallClient.js";
import type { BrowserVoiceRoomClient } from "./BrowserVoiceRoomClient.js";

export type ActiveVoiceCallStatus = "connecting" | "connected" | "reconnecting" | "failed";

export type ActiveVoiceCall = {
  character: VoiceCharacter;
  provider: VoiceProviderInfo;
  voiceModel: string;
  client: BrowserVoiceCallClient | null;
  status: ActiveVoiceCallStatus;
  muted: boolean;
  error?: string;
} | null;

export type ActiveVoiceRoom = {
  characters: VoiceCharacter[];
  provider: VoiceProviderInfo;
  voiceModel: string;
  client: BrowserVoiceRoomClient | null;
  status: ActiveVoiceCallStatus;
  muted: boolean;
  currentSpeakerCharacterId: string | null;
  error?: string;
} | null;
