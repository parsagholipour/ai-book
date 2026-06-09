import type { VoiceCharacter, VoiceProviderInfo } from "../../api.js";
import type { BrowserVoiceCallClient } from "./BrowserVoiceCallClient.js";

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
