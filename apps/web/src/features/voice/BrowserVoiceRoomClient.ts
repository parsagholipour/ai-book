import { GoogleGenAI, Modality } from "@google/genai";
import {
  apiGet,
  apiPost,
  type CreateVoiceRoomSessionRequest,
  type GeminiLiveVoiceCallSession,
  type VoiceCallEventPhase,
  type VoiceCharacter,
  type VoiceChatProviderId,
  type VoiceRoomSessionResponse,
  type VoiceRtcConfig
} from "../../api.js";
import {
  buildVoiceCallEventPayload,
  collectVoiceConnectionDiagnostics,
  createVoiceCallId,
  type VoiceConnectionDiagnostics
} from "../../voiceCallDiagnostics.js";
import { asError } from "../shared/formatters.js";
import {
  createGeminiPlaybackOutput,
  decodePcm16Base64,
  encodePcm16Base64,
  isRetryableGeminiDisconnectReason,
  type GeminiPlaybackOutput
} from "./BrowserVoiceCallClient.js";
import type { ActiveVoiceCallStatus } from "./types.js";

const VOICE_ROOM_ICE_GATHERING_TIMEOUT_MS = 3000;
const VOICE_ROOM_CONNECT_TIMEOUT_MS = 30000;
const VOICE_ROOM_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const VOICE_ROOM_MAX_CONNECT_ATTEMPTS = VOICE_ROOM_RETRY_DELAYS_MS.length + 1;
const VOICE_ROOM_RECENT_TURN_LIMIT = 12;
const VOICE_ROOM_AUTO_TURNS_AFTER_USER = 6;
const OPENAI_ROOM_LISTENER_TRANSCRIPT_FLUSH_MS = 700;
const OPENAI_ROOM_RESPONSE_DONE_FALLBACK_MS = 5000;
const OPENAI_ROOM_TURN_TAIL_MS = 700;
const OPENAI_ROOM_AI_SPEAKER_SWITCH_DELAY_MS = 1000;
const GEMINI_ROOM_TURN_IDLE_FALLBACK_MS = 900;
const GEMINI_INPUT_SAMPLE_RATE = 16000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24000;
const GEMINI_AUDIO_CHUNK_SIZE = 4096;
const VOICE_RTC_CONFIG_REFRESH_SKEW_MS = 30000;

type VoiceRoomClientStatus = Exclude<ActiveVoiceCallStatus, "failed">;

export type BrowserVoiceRoomClientOptions = {
  voiceModel?: string | undefined;
  onStatusChange?: (status: VoiceRoomClientStatus) => void;
  onCurrentSpeakerChange?: (characterId: string | null) => void;
  onFailure?: (error: Error) => void;
};

export interface BrowserVoiceRoomClient {
  readonly provider: VoiceChatProviderId;
  connect(): Promise<VoiceRoomSessionResponse>;
  isEnded(): boolean;
  setMuted(muted: boolean): void;
  end(): Promise<void>;
}

export type VoiceRoomConductorCharacter = Pick<VoiceCharacter, "id" | "name">;

export type VoiceRoomTurn = {
  speakerId: string;
  speakerName: string;
  text: string;
};

type GeminiLiveRealtimeInput = {
  audio?: { data?: string; mimeType?: string };
  audioStreamEnd?: boolean;
  text?: string;
};

type GeminiLiveClientContent = {
  turns?: string;
  turnComplete?: boolean;
};

type GeminiLiveSdkSession = {
  sendRealtimeInput(params: GeminiLiveRealtimeInput): void;
  sendClientContent(params: GeminiLiveClientContent): void;
  close(): void;
};

type CharacterTurnOptions = {
  advanceWithoutTranscript?: boolean;
};

let voiceRoomRtcConfigCache: { config: VoiceRtcConfig; expiresAtMs: number } | null = null;

export function createBrowserVoiceRoomClient(
  provider: VoiceChatProviderId,
  projectId: string,
  characters: VoiceCharacter[],
  options: BrowserVoiceRoomClientOptions = {}
): BrowserVoiceRoomClient {
  if (provider === "gemini_live") {
    return new GeminiLiveVoiceRoomClient(projectId, characters, options);
  }
  return new OpenAIRealtimeVoiceRoomClient(projectId, characters, options);
}

export function buildOpenAIVoiceRoomResponseCreateEvent(characterName: string): Record<string, unknown> {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: `Speak now as ${characterName}. Keep this turn brief and in character.`
    }
  };
}

export function shouldCancelOpenAIUnscheduledResponseEvent(
  currentSpeakerId: string | null,
  characterId: string,
  eventType: string | null | undefined
): boolean {
  return Boolean(eventType?.startsWith("response.") && eventType !== "response.done" && currentSpeakerId !== characterId);
}

export class VoiceRoomConductor {
  private recentTurns: VoiceRoomTurn[] = [];
  private lastSpeakerId: string | null = null;
  private autoTurnsRemaining = 0;

  constructor(
    private readonly characters: VoiceRoomConductorCharacter[],
    private readonly options: { autoTurnsAfterUser?: number; recentTurnLimit?: number } = {}
  ) {}

  appendUserTurn(text: string): VoiceRoomConductorCharacter | null {
    const normalized = normalizeTranscript(text);
    if (!normalized) {
      return null;
    }
    this.pushTurn({ speakerId: "user", speakerName: "User", text: normalized });
    this.autoTurnsRemaining = this.options.autoTurnsAfterUser ?? VOICE_ROOM_AUTO_TURNS_AFTER_USER;
    return this.selectNextSpeaker(normalized);
  }

  appendCharacterTurn(
    characterId: string,
    text: string | null | undefined,
    options: CharacterTurnOptions = {}
  ): VoiceRoomConductorCharacter | null {
    const normalized = normalizeTranscript(text);
    const character = this.characters.find((candidate) => candidate.id === characterId);
    if (!character) {
      return null;
    }
    if (!normalized && !options.advanceWithoutTranscript) {
      return null;
    }
    this.lastSpeakerId = character.id;
    if (normalized) {
      this.pushTurn({ speakerId: character.id, speakerName: character.name, text: normalized });
    }
    if (this.autoTurnsRemaining <= 0) {
      return null;
    }
    this.autoTurnsRemaining -= 1;
    if (this.autoTurnsRemaining <= 0) {
      return null;
    }
    return this.selectNextSpeaker(normalized);
  }

  clear(): void {
    this.recentTurns = [];
    this.lastSpeakerId = null;
    this.autoTurnsRemaining = 0;
  }

  buildPrompt(nextSpeaker: VoiceRoomConductorCharacter): string {
    const transcript = this.recentTurns.map((turn) => `${turn.speakerName}: ${turn.text}`).join("\n");
    const finalTurnGuidance =
      this.autoTurnsRemaining === 1
        ? [
            "",
            "This is the final autonomous character turn before waiting for the user.",
            "Close the current exchange warmly. Do not end with a question, do not ask anyone else to respond, and do not invite another turn."
          ]
        : [];
    return [
      "Live group voice room transcript:",
      transcript || "The room has just started.",
      "",
      `Next speaker: ${nextSpeaker.name}.`,
      `Respond now as ${nextSpeaker.name}. Do not narrate. Do not speak for anyone else.`,
      ...finalTurnGuidance
    ].join("\n");
  }

  recentTurnCount(): number {
    return this.recentTurns.length;
  }

  private selectNextSpeaker(triggerText: string): VoiceRoomConductorCharacter | null {
    const mentioned = this.characters.find((character) => mentionsCharacter(triggerText, character.name));
    if (mentioned) {
      this.lastSpeakerId = mentioned.id;
      return mentioned;
    }
    if (this.characters.length === 0) {
      return null;
    }
    const lastIndex = this.characters.findIndex((character) => character.id === this.lastSpeakerId);
    const nextIndex = lastIndex < 0 ? 0 : (lastIndex + 1) % this.characters.length;
    const next = this.characters[nextIndex] ?? this.characters[0] ?? null;
    this.lastSpeakerId = next?.id ?? null;
    return next;
  }

  private pushTurn(turn: VoiceRoomTurn): void {
    const limit = this.options.recentTurnLimit ?? VOICE_ROOM_RECENT_TURN_LIMIT;
    const previous = this.recentTurns.at(-1);
    if (previous?.speakerId === turn.speakerId && previous.text === turn.text) {
      return;
    }
    this.recentTurns = [...this.recentTurns, turn].slice(-limit);
  }
}

class OpenAIRealtimeVoiceRoomClient implements BrowserVoiceRoomClient {
  readonly provider = "openai_realtime" as const;
  private readonly clientRoomId = createVoiceCallId();
  private readonly startedAtMs = Date.now();
  private readonly conductor: VoiceRoomConductor;
  private listenerPeer: RTCPeerConnection | null = null;
  private listenerChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private participants = new Map<string, OpenAIRoomParticipant>();
  private closed = false;
  private muted = false;
  private connectionSequence = 0;
  private currentSpeakerId: string | null = null;
  private pendingListenerTranscript = "";
  private listenerTranscriptTimer: number | null = null;
  private pendingSpeakerAfterTail: VoiceRoomConductorCharacter | null = null;
  private turnTailTimer: number | null = null;
  private listenerInputEnabled = true;

  constructor(
    private readonly projectId: string,
    private readonly characters: VoiceCharacter[],
    private readonly options: BrowserVoiceRoomClientOptions = {}
  ) {
    this.conductor = new VoiceRoomConductor(characters);
  }

  async connect(): Promise<VoiceRoomSessionResponse> {
    this.closed = false;
    this.connectionSequence += 1;
    const sequence = this.connectionSequence;
    this.options.onStatusChange?.("connecting");
    try {
      const session = await this.connectOnce(sequence);
      this.assertCurrentSequence(sequence);
      this.options.onStatusChange?.("connected");
      await Promise.all(this.characters.map((character) => this.emitCallEvent(character.id, "connected")));
      return session;
    } catch (error) {
      await this.end();
      this.options.onFailure?.(asError(error, "OpenAI group voice room could not connect."));
      throw error;
    }
  }

  isEnded(): boolean {
    return this.closed;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyListenerInputTrackState();
  }

  async end(): Promise<void> {
    const wasClosed = this.closed;
    if (!wasClosed) {
      await Promise.all(this.characters.map((character) => this.emitCallEvent(character.id, "ended")));
    }
    this.closed = true;
    this.connectionSequence += 1;
    this.setCurrentSpeaker(null);
    this.clearOpenAIListenerTranscriptTimer();
    this.clearOpenAITurnTailTimer();
    this.listenerPeer?.close();
    this.listenerPeer = null;
    this.listenerChannel = null;
    for (const participant of this.participants.values()) {
      this.clearOpenAIResponseDoneFallback(participant);
      participant.peerConnection.close();
      participant.audioElement.srcObject = null;
      participant.audioElement.remove();
    }
    this.participants.clear();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.pendingListenerTranscript = "";
    this.pendingSpeakerAfterTail = null;
    this.listenerInputEnabled = true;
    this.conductor.clear();
  }

  private async connectOnce(sequence: number): Promise<VoiceRoomSessionResponse> {
    await this.ensureLocalStream();
    this.assertCurrentSequence(sequence);
    const listener = await this.prepareListenerPeer(sequence);
    const participantOffers = await Promise.all(this.characters.map((character) => this.prepareParticipantPeer(character, sequence)));
    this.assertCurrentSequence(sequence);

    const response = await apiPost<VoiceRoomSessionResponse>(`/api/projects/${this.projectId}/voice-rooms/sessions`, {
      provider: "openai_realtime",
      transport: "webrtc_sdp",
      listenerOfferSdp: listener.offerSdp,
      participants: participantOffers.map((participant) => ({
        characterId: participant.character.id,
        offerSdp: participant.offerSdp
      })),
      ...(this.options.voiceModel ? { voiceModel: this.options.voiceModel } : {})
    } satisfies CreateVoiceRoomSessionRequest);
    this.assertCurrentSequence(sequence);

    if (response.listener.type !== "webrtc_sdp_answer") {
      throw new Error("OpenAI voice room listener returned an unexpected session.");
    }
    await listener.peerConnection.setRemoteDescription({ type: "answer", sdp: response.listener.answerSdp });
    this.assertCurrentSequence(sequence);

    await Promise.all(
      response.participants.map(async (participantSession) => {
        if (participantSession.session.type !== "webrtc_sdp_answer") {
          throw new Error("OpenAI voice room participant returned an unexpected session.");
        }
        const participant = this.participants.get(participantSession.characterId);
        if (!participant) {
          throw new Error("Voice room participant was not prepared.");
        }
        await participant.peerConnection.setRemoteDescription({ type: "answer", sdp: participantSession.session.answerSdp });
      })
    );
    this.assertCurrentSequence(sequence);

    await Promise.all([
      waitForPeerConnected(listener.peerConnection, VOICE_ROOM_CONNECT_TIMEOUT_MS),
      ...[...this.participants.values()].map((participant) =>
        waitForPeerConnected(participant.peerConnection, VOICE_ROOM_CONNECT_TIMEOUT_MS)
      ),
      ...[listener.channel, ...[...this.participants.values()].map((participant) => participant.channel)].map(waitForDataChannelOpen)
    ]);
    this.assertCurrentSequence(sequence);
    await Promise.all(this.characters.map((character) => this.emitCallEvent(character.id, "connect_start")));
    return response;
  }

  private async prepareListenerPeer(
    sequence: number
  ): Promise<{ peerConnection: RTCPeerConnection; channel: RTCDataChannel; offerSdp: string }> {
    const peerConnection = new RTCPeerConnection(await resolveVoiceRoomRtcConfiguration());
    this.assertCurrentSequence(sequence);
    const channel = peerConnection.createDataChannel("voice-room-listener");
    this.listenerPeer = peerConnection;
    this.listenerChannel = channel;
    channel.onmessage = (event) => this.captureListenerEvent(event.data);
    const stream = await this.ensureLocalStream();
    for (const track of stream.getAudioTracks()) {
      peerConnection.addTrack(track, stream);
    }
    const offerSdp = await createOfferSdp(peerConnection);
    this.assertCurrentSequence(sequence);
    return { peerConnection, channel, offerSdp };
  }

  private async prepareParticipantPeer(
    character: VoiceCharacter,
    sequence: number
  ): Promise<{ character: VoiceCharacter; offerSdp: string }> {
    const peerConnection = new RTCPeerConnection(await resolveVoiceRoomRtcConfiguration());
    this.assertCurrentSequence(sequence);
    peerConnection.addTransceiver("audio", { direction: "recvonly" });
    const channel = peerConnection.createDataChannel(`voice-room-${character.id}`);
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.muted = true;
    audioElement.volume = 1;
    audioElement.setAttribute("playsinline", "true");
    audioElement.style.position = "fixed";
    audioElement.style.left = "-9999px";
    audioElement.style.width = "1px";
    audioElement.style.height = "1px";
    audioElement.style.opacity = "0";
    audioElement.style.pointerEvents = "none";
    document.body.appendChild(audioElement);
    const participant: OpenAIRoomParticipant = {
      character,
      peerConnection,
      channel,
      audioElement,
      remoteStream: new MediaStream(),
      pendingTranscript: "",
      responsePending: false,
      responseDone: false,
      audioOutputStarted: false,
      audioOutputDone: false,
      turnFinalized: false,
      responseFallbackTimer: null
    };
    peerConnection.ontrack = (event) => {
      const stream = event.streams[0] ?? participant.remoteStream;
      if (!stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track);
      }
      audioElement.srcObject = stream;
      void audioElement.play().catch((error) => {
        const message = asError(error, "Voice room audio playback was blocked.").message;
        void this.emitCallEvent(character.id, "failed", { error: message });
        this.options.onFailure?.(new Error(message));
      });
    };
    channel.onmessage = (event) => this.captureParticipantEvent(character.id, event.data);
    channel.onerror = () => {
      void this.emitCallEvent(character.id, "failed", { error: "Voice room data channel failed." });
    };
    this.participants.set(character.id, participant);
    const offerSdp = await createOfferSdp(peerConnection);
    this.assertCurrentSequence(sequence);
    return { character, offerSdp };
  }

  private captureListenerEvent(data: unknown): void {
    const record = parseRealtimeEvent(data);
    if (!record || eventString(record, "type") !== "conversation.item.input_audio_transcription.completed") {
      return;
    }
    if (!this.listenerInputEnabled) {
      this.pendingListenerTranscript = "";
      this.clearOpenAIListenerTranscriptTimer();
      return;
    }
    const transcript = normalizeTranscript(eventString(record, "transcript"));
    if (!transcript) {
      return;
    }
    this.pendingListenerTranscript = [this.pendingListenerTranscript, transcript].filter(Boolean).join(" ");
    this.scheduleOpenAIListenerTranscriptFlush();
  }

  private captureParticipantEvent(characterId: string, data: unknown): void {
    const record = parseRealtimeEvent(data);
    if (!record) {
      return;
    }
    const type = eventString(record, "type");
    const participant = this.participants.get(characterId);
    if (!participant) {
      return;
    }
    if (shouldCancelOpenAIUnscheduledResponseEvent(this.currentSpeakerId, characterId, type)) {
      this.cancelOpenAIResponse(participant);
      return;
    }
    if (type === "response.audio_transcript.delta" || type === "response.output_audio_transcript.delta") {
      participant.pendingTranscript += eventString(record, "delta") ?? "";
      return;
    }
    if (isOpenAIAudioOutputDeltaEvent(type)) {
      participant.audioOutputStarted = true;
      return;
    }
    if (isOpenAIAudioOutputDoneEvent(type)) {
      participant.audioOutputDone = true;
      this.finalizeOpenAICharacterTurnIfComplete(participant, characterId);
      return;
    }
    if (type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done") {
      const transcript = eventString(record, "transcript") ?? participant.pendingTranscript;
      participant.pendingTranscript = transcript;
      return;
    }
    if (type === "response.done") {
      if (openAIResponseDoneWasCancelled(record)) {
        this.clearOpenAIResponseDoneFallback(participant);
        participant.responsePending = false;
        participant.turnFinalized = true;
        return;
      }
      participant.responseDone = true;
      this.finalizeOpenAICharacterTurnIfComplete(participant, characterId);
    }
  }

  private handleUserTranscript(transcript: string | null | undefined): void {
    const text = normalizeTranscript(transcript);
    if (!text || this.closed) {
      return;
    }
    if (this.currentSpeakerId) {
      this.cancelAllOpenAIResponses();
    }
    this.clearOpenAITurnTailTimer();
    const next = this.conductor.appendUserTurn(text);
    if (next) {
      this.promptCharacter(next);
    }
  }

  private finalizeOpenAICharacterTurn(
    participant: OpenAIRoomParticipant,
    characterId: string,
    transcript: string | null | undefined,
    options: CharacterTurnOptions = {}
  ): void {
    if (participant.turnFinalized) {
      return;
    }
    const text = normalizeTranscript(transcript);
    if (!text && !options.advanceWithoutTranscript) {
      return;
    }
    participant.turnFinalized = true;
    participant.responsePending = false;
    this.clearOpenAIResponseDoneFallback(participant);
    participant.pendingTranscript = "";
    this.handleCharacterTranscript(characterId, text, options);
  }

  private finalizeOpenAICharacterTurnIfComplete(participant: OpenAIRoomParticipant, characterId: string): void {
    if (participant.turnFinalized || !participant.responseDone) {
      return;
    }
    if (participant.audioOutputStarted && !participant.audioOutputDone) {
      this.scheduleOpenAIResponseDoneFallback(participant, characterId);
      return;
    }
    this.finalizeOpenAICharacterTurn(participant, characterId, participant.pendingTranscript, {
      advanceWithoutTranscript: true
    });
  }

  private handleCharacterTranscript(
    characterId: string,
    transcript: string | null | undefined,
    options: CharacterTurnOptions = {}
  ): void {
    const text = normalizeTranscript(transcript);
    if ((!text && !options.advanceWithoutTranscript) || this.closed) {
      return;
    }
    if (this.currentSpeakerId === characterId) {
      this.scheduleOpenAINextSpeakerAfterTail(null, characterId);
    }
    const next = this.conductor.appendCharacterTurn(characterId, text, options);
    if (next) {
      this.scheduleOpenAINextSpeakerAfterTail(next, characterId);
    }
  }

  private promptCharacter(character: VoiceRoomConductorCharacter): void {
    const participant = this.participants.get(character.id);
    if (!participant || participant.channel.readyState !== "open") {
      return;
    }
    this.cancelAllOpenAIResponses(character.id);
    this.clearOpenAITurnTailTimer();
    this.setOpenAIListenerInputEnabled(false);
    this.pendingListenerTranscript = "";
    this.clearOpenAIListenerTranscriptTimer();
    const prompt = this.conductor.buildPrompt(character);
    participant.pendingTranscript = "";
    participant.turnFinalized = false;
    participant.responsePending = true;
    participant.responseDone = false;
    participant.audioOutputStarted = false;
    participant.audioOutputDone = false;
    this.clearOpenAIResponseDoneFallback(participant);
    this.setCurrentSpeaker(character.id);
    participant.channel.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      })
    );
    participant.channel.send(
      JSON.stringify(buildOpenAIVoiceRoomResponseCreateEvent(character.name))
    );
  }

  private cancelAllOpenAIResponses(exceptCharacterId: string | null = null): void {
    for (const [characterId, participant] of this.participants) {
      if (characterId === exceptCharacterId || !participant.responsePending) {
        continue;
      }
      this.cancelOpenAIResponse(participant);
    }
    if (this.currentSpeakerId && this.currentSpeakerId !== exceptCharacterId) {
      this.setCurrentSpeaker(null);
    }
  }

  private cancelOpenAIResponse(participant: OpenAIRoomParticipant): void {
    if (participant.channel.readyState === "open") {
      participant.channel.send(JSON.stringify({ type: "response.cancel" }));
    }
    participant.audioElement.muted = true;
    participant.responsePending = false;
    participant.responseDone = false;
    participant.audioOutputStarted = false;
    participant.audioOutputDone = false;
    participant.turnFinalized = true;
    participant.pendingTranscript = "";
    this.clearOpenAIResponseDoneFallback(participant);
  }

  private scheduleOpenAIListenerTranscriptFlush(): void {
    this.clearOpenAIListenerTranscriptTimer();
    this.listenerTranscriptTimer = window.setTimeout(
      () => this.flushOpenAIListenerTranscript(),
      OPENAI_ROOM_LISTENER_TRANSCRIPT_FLUSH_MS
    );
  }

  private flushOpenAIListenerTranscript(): void {
    this.clearOpenAIListenerTranscriptTimer();
    const transcript = this.pendingListenerTranscript;
    this.pendingListenerTranscript = "";
    if (!this.listenerInputEnabled) {
      return;
    }
    this.handleUserTranscript(transcript);
  }

  private clearOpenAIListenerTranscriptTimer(): void {
    if (this.listenerTranscriptTimer !== null) {
      window.clearTimeout(this.listenerTranscriptTimer);
      this.listenerTranscriptTimer = null;
    }
  }

  private scheduleOpenAIResponseDoneFallback(participant: OpenAIRoomParticipant, characterId: string): void {
    this.clearOpenAIResponseDoneFallback(participant);
    participant.responseFallbackTimer = window.setTimeout(() => {
      participant.responseFallbackTimer = null;
      this.finalizeOpenAICharacterTurn(participant, characterId, participant.pendingTranscript, {
        advanceWithoutTranscript: true
      });
    }, OPENAI_ROOM_RESPONSE_DONE_FALLBACK_MS);
  }

  private clearOpenAIResponseDoneFallback(participant: OpenAIRoomParticipant): void {
    if (participant.responseFallbackTimer !== null) {
      window.clearTimeout(participant.responseFallbackTimer);
      participant.responseFallbackTimer = null;
    }
  }

  private scheduleOpenAINextSpeakerAfterTail(
    character: VoiceRoomConductorCharacter | null,
    completedCharacterId: string
  ): void {
    this.clearOpenAITurnTailTimer();
    this.pendingSpeakerAfterTail = character;
    const delayMs = character ? OPENAI_ROOM_AI_SPEAKER_SWITCH_DELAY_MS : OPENAI_ROOM_TURN_TAIL_MS;
    this.turnTailTimer = window.setTimeout(() => {
      this.turnTailTimer = null;
      const next = this.pendingSpeakerAfterTail;
      this.pendingSpeakerAfterTail = null;
      if (next) {
        this.promptCharacter(next);
        return;
      }
      if (this.currentSpeakerId === completedCharacterId) {
        this.setCurrentSpeaker(null);
      }
      this.setOpenAIListenerInputEnabled(true);
    }, delayMs);
  }

  private clearOpenAITurnTailTimer(): void {
    if (this.turnTailTimer !== null) {
      window.clearTimeout(this.turnTailTimer);
      this.turnTailTimer = null;
    }
    this.pendingSpeakerAfterTail = null;
  }

  private setOpenAIListenerInputEnabled(enabled: boolean): void {
    this.listenerInputEnabled = enabled;
    this.applyListenerInputTrackState();
  }

  private applyListenerInputTrackState(): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !this.muted && this.listenerInputEnabled;
    }
  }

  private setCurrentSpeaker(characterId: string | null): void {
    this.currentSpeakerId = characterId;
    this.syncOpenAIParticipantAudioGates();
    this.options.onCurrentSpeakerChange?.(characterId);
  }

  private syncOpenAIParticipantAudioGates(): void {
    for (const [characterId, participant] of this.participants) {
      participant.audioElement.muted = characterId !== this.currentSpeakerId;
    }
  }

  private assertCurrentSequence(sequence: number): void {
    if (!this.isCurrentSequence(sequence)) {
      throw new Error("Voice room ended.");
    }
  }

  private isCurrentSequence(sequence: number): boolean {
    return !this.closed && this.connectionSequence === sequence;
  }

  private async ensureLocalStream(): Promise<MediaStream> {
    if (this.localStream?.active) {
      return this.localStream;
    }
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this.applyListenerInputTrackState();
    return this.localStream;
  }

  private async emitCallEvent(
    characterId: string,
    phase: VoiceCallEventPhase,
    options: { error?: string; metadata?: Record<string, string | number | boolean | null> } = {}
  ): Promise<void> {
    let diagnostics: VoiceConnectionDiagnostics | undefined;
    const peerConnection = this.participants.get(characterId)?.peerConnection;
    if (peerConnection) {
      diagnostics = await collectVoiceConnectionDiagnostics(peerConnection);
    }
    const eventOptions: {
      elapsedMs: number;
      diagnostics?: VoiceConnectionDiagnostics;
      error?: string;
      metadata: Record<string, string | number | boolean | null>;
    } = {
      elapsedMs: Date.now() - this.startedAtMs,
      metadata: {
        online: navigator.onLine,
        provider: this.provider,
        transport: "webrtc_sdp",
        mode: "group",
        clientRoomId: this.clientRoomId,
        ...options.metadata
      }
    };
    if (diagnostics) {
      eventOptions.diagnostics = diagnostics;
    }
    if (options.error !== undefined) {
      eventOptions.error = options.error;
    }
    const payload = buildVoiceCallEventPayload(`${this.clientRoomId}:${characterId}`, phase, eventOptions);
    await apiPost(`/api/voice-characters/${characterId}/call-events`, payload).catch(() => undefined);
  }
}

class GeminiLiveVoiceRoomClient implements BrowserVoiceRoomClient {
  readonly provider = "gemini_live" as const;
  private readonly clientRoomId = createVoiceCallId();
  private readonly startedAtMs = Date.now();
  private readonly conductor: VoiceRoomConductor;
  private localStream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private inputSilence: GainNode | null = null;
  private outputContext: AudioContext | null = null;
  private playbackOutput: GeminiPlaybackOutput | null = null;
  private playbackSources: AudioBufferSourceNode[] = [];
  private nextPlaybackTime = 0;
  private pendingPlaybackChunks = 0;
  private playbackGeneration = 0;
  private listenerSession: GeminiLiveSdkSession | null = null;
  private participants = new Map<string, GeminiRoomParticipant>();
  private closed = false;
  private muted = false;
  private hasConnected = false;
  private reconnecting = false;
  private connectionSequence = 0;
  private currentSpeakerId: string | null = null;
  private pendingListenerTranscript = "";
  private listenerTranscriptTimer: number | null = null;
  private pendingSpeakerAfterPlayback: VoiceRoomConductorCharacter | null = null;
  private listenerSessionHandle = "";
  private participantSessionHandles = new Map<string, string>();

  constructor(
    private readonly projectId: string,
    private readonly characters: VoiceCharacter[],
    private readonly options: BrowserVoiceRoomClientOptions = {}
  ) {
    this.conductor = new VoiceRoomConductor(characters);
  }

  async connect(): Promise<VoiceRoomSessionResponse> {
    this.closed = false;
    this.hasConnected = false;
    this.reconnecting = false;
    try {
      return await this.connectWithRetries("connecting");
    } catch (error) {
      await this.end();
      this.options.onFailure?.(asError(error, "Gemini group voice room could not connect."));
      throw error;
    }
  }

  private async connectWithRetries(status: "connecting" | "reconnecting"): Promise<VoiceRoomSessionResponse> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < VOICE_ROOM_MAX_CONNECT_ATTEMPTS; attempt += 1) {
      this.assertOpen();
      if (attempt > 0) {
        this.options.onStatusChange?.("reconnecting");
        await delay(VOICE_ROOM_RETRY_DELAYS_MS[attempt - 1] ?? VOICE_ROOM_RETRY_DELAYS_MS.at(-1) ?? 1000);
        this.assertOpen();
      } else {
        this.options.onStatusChange?.(status);
      }

      try {
        await Promise.all(
          this.characters.map((character) =>
            this.emitCallEvent(character.id, status === "connecting" ? "connect_start" : "reconnect_start")
          )
        );
        const response = await this.connectOnce();
        this.hasConnected = true;
        this.options.onStatusChange?.("connected");
        await Promise.all(
          this.characters.map((character) =>
            this.emitCallEvent(character.id, status === "connecting" ? "connected" : "reconnect_success")
          )
        );
        return response;
      } catch (error) {
        lastError = error;
        this.closeGeminiSessionsForReconnect();
        if (this.closed) {
          throw asError(error);
        }
      }
    }

    await Promise.all(
      this.characters.map((character) => this.emitCallEvent(character.id, status === "connecting" ? "failed" : "reconnect_failed"))
    );
    throw asError(lastError, "Gemini group voice room could not connect after retrying.");
  }

  private async connectOnce(): Promise<VoiceRoomSessionResponse> {
    this.connectionSequence += 1;
    const sequence = this.connectionSequence;
    this.closeGeminiSessionsForReconnect();
    await this.ensureLocalStream();
    await this.ensureOutputContext();
    this.assertCurrentSequence(sequence);
    const response = await apiPost<VoiceRoomSessionResponse>(`/api/projects/${this.projectId}/voice-rooms/sessions`, {
      provider: "gemini_live",
      transport: "gemini_live",
      ...(this.listenerSessionHandle ? { listenerSessionHandle: this.listenerSessionHandle } : {}),
      participants: this.characters.map((character) => {
        const sessionHandle = this.participantSessionHandles.get(character.id);
        return {
          characterId: character.id,
          ...(sessionHandle ? { sessionHandle } : {})
        };
      }),
      ...(this.options.voiceModel ? { voiceModel: this.options.voiceModel } : {})
    } satisfies CreateVoiceRoomSessionRequest);
    this.assertCurrentSequence(sequence);
    if (response.listener.type !== "gemini_live_token") {
      throw new Error("Gemini voice room listener returned an unexpected session.");
    }
    this.listenerSession = await this.connectGeminiSession(response.listener, "listener", sequence);
    await Promise.all(
      response.participants.map(async (participantSession) => {
        if (participantSession.session.type !== "gemini_live_token") {
          throw new Error("Gemini voice room participant returned an unexpected session.");
        }
        const character = this.characters.find((candidate) => candidate.id === participantSession.characterId);
        if (!character) {
          throw new Error("Voice room participant was not prepared.");
        }
        const session = await this.connectGeminiSession(participantSession.session, character.id, sequence);
        this.assertCurrentSequence(sequence);
        this.participants.set(character.id, {
          character,
          session,
          pendingTranscript: "",
          heardAudioInCurrentTurn: false,
          turnCompleteInCurrentTurn: false,
          turnFinalized: false,
          turnFallbackTimer: null
        });
      })
    );
    await this.startInputPipeline(sequence);
    return response;
  }

  isEnded(): boolean {
    return this.closed;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    if (muted) {
      this.sendGeminiListenerRealtimeInput({ audioStreamEnd: true });
    }
  }

  async end(): Promise<void> {
    const wasClosed = this.closed;
    if (!wasClosed) {
      await Promise.all(this.characters.map((character) => this.emitCallEvent(character.id, "ended")));
    }
    this.closed = true;
    this.connectionSequence += 1;
    this.setCurrentSpeaker(null);
    this.listenerSession?.close();
    this.listenerSession = null;
    this.pendingSpeakerAfterPlayback = null;
    for (const participant of this.participants.values()) {
      this.clearGeminiTurnFallbackTimer(participant);
      participant.session.close();
    }
    this.participants.clear();
    this.closeInputPipeline();
    this.clearListenerTranscriptTimer();
    this.clearPlaybackQueue();
    this.closePlaybackOutput();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    await this.inputContext?.close().catch(() => undefined);
    await this.outputContext?.close().catch(() => undefined);
    this.localStream = null;
    this.inputContext = null;
    this.outputContext = null;
    this.pendingListenerTranscript = "";
    this.hasConnected = false;
    this.reconnecting = false;
    this.listenerSessionHandle = "";
    this.participantSessionHandles.clear();
    this.conductor.clear();
  }

  private async connectGeminiSession(
    session: GeminiLiveVoiceCallSession,
    role: "listener" | string,
    sequence: number
  ): Promise<GeminiLiveSdkSession> {
    const ai = new GoogleGenAI({
      apiKey: session.token,
      httpOptions: { apiVersion: "v1alpha" }
    });
    this.assertCurrentSequence(sequence);
    const liveSession = (await ai.live.connect({
      model: session.model,
      config: {
        responseModalities: [Modality.AUDIO]
      },
      callbacks: {
        onmessage: (message: unknown) => this.handleGeminiMessage(role, message, sequence),
        onerror: (event: ErrorEvent) => {
          if (this.isCurrentSequence(sequence)) {
            const error = errorFromErrorEvent(event);
            if (this.reconnecting) {
              return;
            }
            if (this.hasConnected && isRetryableGeminiDisconnectReason(error.message)) {
              this.scheduleReconnect(error.message);
              return;
            }
            this.fail(error);
          }
        },
        onclose: (event: CloseEvent) => {
          if (this.isCurrentSequence(sequence)) {
            const reason = event.reason?.trim() || `Gemini Live connection closed (${event.code}).`;
            if (this.reconnecting) {
              return;
            }
            if (this.hasConnected && isRetryableGeminiDisconnectReason(reason)) {
              this.scheduleReconnect(reason);
              return;
            }
            this.fail(new Error(reason));
          }
        }
      }
    })) as GeminiLiveSdkSession;
    if (!this.isCurrentSequence(sequence)) {
      liveSession.close();
      throw new Error("Gemini voice room ended.");
    }
    return liveSession;
  }

  private async startInputPipeline(sequence: number): Promise<void> {
    const stream = await this.ensureLocalStream();
    const context = await this.ensureInputContext();
    this.assertCurrentSequence(sequence);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(GEMINI_AUDIO_CHUNK_SIZE, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (!this.isCurrentSequence(sequence) || this.muted || !this.listenerSession) {
        return;
      }
      const channel = event.inputBuffer.getChannelData(0);
      this.sendGeminiListenerRealtimeInput(
        {
          audio: {
            data: encodePcm16Base64(channel, context.sampleRate, GEMINI_INPUT_SAMPLE_RATE),
            mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`
          }
        },
        sequence
      );
    };

    source.connect(processor);
    processor.connect(silence);
    silence.connect(context.destination);
    this.inputSource = source;
    this.inputProcessor = processor;
    this.inputSilence = silence;
  }

  private handleGeminiMessage(role: "listener" | string, message: unknown, sequence: number): void {
    if (!this.isCurrentSequence(sequence)) {
      return;
    }
    const record = eventRecord(message);
    this.captureGeminiSessionUpdate(role, record);
    if (record?.goAway) {
      this.scheduleReconnect("Gemini Live asked the voice room to reconnect.");
      return;
    }
    const serverContent = eventRecord(record?.serverContent);
    if (!serverContent) {
      return;
    }
    if (role === "listener" && serverContent.interrupted === true) {
      this.clearPlaybackQueue();
    }
    if (role === "listener") {
      const inputTranscription = eventRecord(serverContent.inputTranscription);
      const text = eventString(inputTranscription, "text");
      if (text) {
        this.pendingListenerTranscript += text;
        this.scheduleListenerTranscriptFlush();
      }
      if (inputTranscription?.finished === true || serverContent.turnComplete === true) {
        this.flushListenerTranscript();
      }
      return;
    }

    const participant = this.participants.get(role);
    if (!participant) {
      return;
    }
    const outputTranscription = eventRecord(serverContent.outputTranscription);
    const text = eventString(outputTranscription, "text");
    if (text) {
      participant.pendingTranscript += text;
    }

    const parts = Array.isArray(eventRecord(serverContent.modelTurn)?.parts)
      ? (eventRecord(serverContent.modelTurn)?.parts as unknown[])
      : [];
    for (const part of parts) {
      const inlineData = eventRecord(eventRecord(part)?.inlineData);
      const data = eventString(inlineData, "data");
      const mimeType = eventString(inlineData, "mimeType");
      if (data && mimeType?.startsWith("audio/")) {
        participant.heardAudioInCurrentTurn = true;
        const playbackGeneration = this.playbackGeneration;
        this.pendingPlaybackChunks += 1;
        void this.playPcm16Audio(data, sampleRateFromMimeType(mimeType) ?? GEMINI_OUTPUT_SAMPLE_RATE, playbackGeneration)
          .catch((error) => {
            this.options.onFailure?.(asError(error, "Gemini Live room audio playback failed."));
          })
          .finally(() => {
            if (this.playbackGeneration !== playbackGeneration) {
              return;
            }
            this.pendingPlaybackChunks = Math.max(0, this.pendingPlaybackChunks - 1);
            this.flushPendingSpeakerAfterPlayback();
          });
        this.scheduleGeminiCharacterTurnFallback(participant, role);
      }
    }

    if (outputTranscription?.finished === true || serverContent.turnComplete === true) {
      participant.turnCompleteInCurrentTurn = true;
      const transcript = participant.pendingTranscript;
      this.finalizeGeminiCharacterTurn(participant, role, transcript, {
        advanceWithoutTranscript: serverContent.turnComplete === true && participant.heardAudioInCurrentTurn
      });
    }
  }

  private handleUserTranscript(transcript: string | null | undefined): void {
    const text = normalizeTranscript(transcript);
    if (!text || this.closed) {
      return;
    }
    if (this.currentSpeakerId) {
      this.clearPlaybackQueue();
      this.setCurrentSpeaker(null);
    }
    const next = this.conductor.appendUserTurn(text);
    if (next) {
      this.promptCharacter(next);
    }
  }

  private finalizeGeminiCharacterTurn(
    participant: GeminiRoomParticipant,
    characterId: string,
    transcript: string | null | undefined,
    options: CharacterTurnOptions = {}
  ): void {
    if (participant.turnFinalized) {
      return;
    }
    const text = normalizeTranscript(transcript);
    if (!text && !options.advanceWithoutTranscript) {
      return;
    }
    participant.turnFinalized = true;
    participant.pendingTranscript = "";
    participant.heardAudioInCurrentTurn = false;
    participant.turnCompleteInCurrentTurn = false;
    this.clearGeminiTurnFallbackTimer(participant);
    this.handleCharacterTranscript(characterId, text, options);
  }

  private handleCharacterTranscript(
    characterId: string,
    transcript: string | null | undefined,
    options: CharacterTurnOptions = {}
  ): void {
    const text = normalizeTranscript(transcript);
    if ((!text && !options.advanceWithoutTranscript) || this.closed) {
      return;
    }
    const next = this.conductor.appendCharacterTurn(characterId, text, options);
    if (next) {
      this.promptCharacterAfterPlayback(next);
      return;
    }
    this.clearCurrentSpeakerWhenPlaybackEnds(characterId);
  }

  private promptCharacter(character: VoiceRoomConductorCharacter): void {
    const participant = this.participants.get(character.id);
    if (!participant) {
      return;
    }
    this.clearGeminiTurnFallbackTimer(participant);
    participant.pendingTranscript = "";
    participant.heardAudioInCurrentTurn = false;
    participant.turnCompleteInCurrentTurn = false;
    participant.turnFinalized = false;
    this.setCurrentSpeaker(character.id);
    participant.session.sendClientContent({ turns: this.conductor.buildPrompt(character), turnComplete: true });
  }

  private promptCharacterAfterPlayback(character: VoiceRoomConductorCharacter): void {
    this.pendingSpeakerAfterPlayback = character;
    if (!this.hasPendingPlayback()) {
      this.flushPendingSpeakerAfterPlayback();
    }
  }

  private clearCurrentSpeakerWhenPlaybackEnds(characterId: string): void {
    if (this.currentSpeakerId !== characterId) {
      return;
    }
    if (this.hasPendingPlayback()) {
      this.pendingSpeakerAfterPlayback = null;
      return;
    }
    this.setCurrentSpeaker(null);
  }

  private async playPcm16Audio(data: string, sampleRate: number, playbackGeneration: number): Promise<void> {
    const context = await this.ensureOutputContext();
    if (this.closed || this.playbackGeneration !== playbackGeneration) {
      return;
    }
    const samples = decodePcm16Base64(data);
    if (samples.length === 0) {
      return;
    }
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = new Float32Array(samples.length);
    channel.set(samples);
    buffer.copyToChannel(channel, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackOutput?.node ?? context.destination);
    source.onended = () => {
      this.playbackSources = this.playbackSources.filter((candidate) => candidate !== source);
      if (this.playbackGeneration === playbackGeneration) {
        this.flushPendingSpeakerAfterPlayback();
      }
    };
    const startAt = Math.max(context.currentTime + 0.01, this.nextPlaybackTime);
    source.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;
    this.playbackSources.push(source);
  }

  private clearPlaybackQueue(): void {
    this.playbackGeneration += 1;
    for (const source of this.playbackSources) {
      try {
        source.stop();
      } catch {
        /* source may already be stopped */
      }
    }
    this.playbackSources = [];
    this.nextPlaybackTime = this.outputContext?.currentTime ?? 0;
    this.pendingPlaybackChunks = 0;
    this.pendingSpeakerAfterPlayback = null;
  }

  private hasPendingPlayback(): boolean {
    return (
      this.pendingPlaybackChunks > 0 ||
      this.playbackSources.length > 0 ||
      (this.outputContext ? this.nextPlaybackTime > this.outputContext.currentTime + 0.05 : false)
    );
  }

  private flushPendingSpeakerAfterPlayback(): void {
    if (this.closed || this.hasPendingPlayback()) {
      return;
    }
    const next = this.pendingSpeakerAfterPlayback;
    this.pendingSpeakerAfterPlayback = null;
    if (next) {
      this.promptCharacter(next);
      return;
    }
    this.setCurrentSpeaker(null);
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connectionSequence += 1;
    this.setCurrentSpeaker(null);
    try {
      this.listenerSession?.close();
    } catch {
      /* session may already be closed */
    }
    this.listenerSession = null;
    this.pendingSpeakerAfterPlayback = null;
    for (const participant of this.participants.values()) {
      this.clearGeminiTurnFallbackTimer(participant);
      try {
        participant.session.close();
      } catch {
        /* session may already be closed */
      }
    }
    this.participants.clear();
    this.closeInputPipeline();
    this.clearListenerTranscriptTimer();
    this.clearPlaybackQueue();
    this.closePlaybackOutput();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.pendingListenerTranscript = "";
    this.hasConnected = false;
    this.reconnecting = false;
    this.listenerSessionHandle = "";
    this.participantSessionHandles.clear();
    this.options.onFailure?.(error);
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || !this.hasConnected || this.reconnecting) {
      return;
    }

    this.reconnecting = true;
    this.options.onStatusChange?.("reconnecting");
    void Promise.all(this.characters.map((character) => this.emitCallEvent(character.id, "disconnected")));
    this.closeGeminiSessionsForReconnect();
    void this.connectWithRetries("reconnecting")
      .catch((error) => {
        if (!this.closed) {
          this.fail(asError(error, reason));
        }
      })
      .finally(() => {
        this.reconnecting = false;
      });
  }

  private closeGeminiSessionsForReconnect(): void {
    try {
      this.listenerSession?.close();
    } catch {
      /* session may already be closed */
    }
    this.listenerSession = null;
    this.pendingSpeakerAfterPlayback = null;
    for (const participant of this.participants.values()) {
      this.clearGeminiTurnFallbackTimer(participant);
      try {
        participant.session.close();
      } catch {
        /* session may already be closed */
      }
    }
    this.participants.clear();
    this.closeInputPipeline();
    this.clearListenerTranscriptTimer();
    this.clearPlaybackQueue();
    this.setCurrentSpeaker(null);
  }

  private captureGeminiSessionUpdate(role: "listener" | string, record: Record<string, unknown> | null): void {
    const sessionUpdate = eventRecord(record?.sessionResumptionUpdate);
    if (sessionUpdate?.resumable !== true) {
      return;
    }
    const newHandle = eventString(sessionUpdate, "newHandle");
    if (!newHandle) {
      return;
    }
    if (role === "listener") {
      this.listenerSessionHandle = newHandle;
      return;
    }
    this.participantSessionHandles.set(role, newHandle);
  }

  private scheduleGeminiCharacterTurnFallback(participant: GeminiRoomParticipant, characterId: string): void {
    this.clearGeminiTurnFallbackTimer(participant);
    participant.turnFallbackTimer = window.setTimeout(() => {
      participant.turnFallbackTimer = null;
      if (!participant.heardAudioInCurrentTurn && !participant.pendingTranscript.trim()) {
        return;
      }
      this.finalizeGeminiCharacterTurn(participant, characterId, participant.pendingTranscript, {
        advanceWithoutTranscript: true
      });
    }, GEMINI_ROOM_TURN_IDLE_FALLBACK_MS);
  }

  private clearGeminiTurnFallbackTimer(participant: GeminiRoomParticipant): void {
    if (participant.turnFallbackTimer !== null) {
      window.clearTimeout(participant.turnFallbackTimer);
      participant.turnFallbackTimer = null;
    }
  }

  private sendGeminiListenerRealtimeInput(params: GeminiLiveRealtimeInput, sequence = this.connectionSequence): boolean {
    if (!this.isCurrentSequence(sequence) || !this.listenerSession) {
      return false;
    }
    try {
      this.listenerSession.sendRealtimeInput(params);
      return true;
    } catch (error) {
      const message = asError(error, "Gemini Live room audio send failed.").message;
      if (this.hasConnected && isRetryableGeminiDisconnectReason(message)) {
        this.scheduleReconnect(message);
      } else {
        this.fail(new Error(message));
      }
      return false;
    }
  }

  private setCurrentSpeaker(characterId: string | null): void {
    this.currentSpeakerId = characterId;
    this.options.onCurrentSpeakerChange?.(characterId);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Gemini voice room ended.");
    }
  }

  private assertCurrentSequence(sequence: number): void {
    this.assertOpen();
    if (!this.isCurrentSequence(sequence)) {
      throw new Error("Gemini voice room ended.");
    }
  }

  private isCurrentSequence(sequence: number): boolean {
    return !this.closed && this.connectionSequence === sequence;
  }

  private async ensureLocalStream(): Promise<MediaStream> {
    if (this.localStream?.active) {
      return this.localStream;
    }
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this.setMuted(this.muted);
    return this.localStream;
  }

  private async ensureInputContext(): Promise<AudioContext> {
    if (!this.inputContext || this.inputContext.state === "closed") {
      this.inputContext = new (audioContextConstructor())();
    }
    if (this.inputContext.state === "suspended") {
      await this.inputContext.resume();
    }
    return this.inputContext;
  }

  private async ensureOutputContext(): Promise<AudioContext> {
    if (!this.outputContext || this.outputContext.state === "closed") {
      this.outputContext = new (audioContextConstructor())({ sampleRate: GEMINI_OUTPUT_SAMPLE_RATE });
      this.nextPlaybackTime = this.outputContext.currentTime;
      this.playbackOutput?.close();
      this.playbackOutput = createGeminiPlaybackOutput(this.outputContext);
    }
    if (this.outputContext.state === "suspended") {
      await this.outputContext.resume();
    }
    return this.outputContext;
  }

  private closePlaybackOutput(): void {
    this.playbackOutput?.close();
    this.playbackOutput = null;
  }

  private closeInputPipeline(): void {
    if (this.inputProcessor) {
      this.inputProcessor.onaudioprocess = null;
      try {
        this.inputProcessor.disconnect();
      } catch {
        /* input node may already be disconnected */
      }
    }
    try {
      this.inputSource?.disconnect();
    } catch {
      /* input node may already be disconnected */
    }
    try {
      this.inputSilence?.disconnect();
    } catch {
      /* input node may already be disconnected */
    }
    this.inputProcessor = null;
    this.inputSource = null;
    this.inputSilence = null;
  }

  private scheduleListenerTranscriptFlush(): void {
    this.clearListenerTranscriptTimer();
    this.listenerTranscriptTimer = window.setTimeout(() => this.flushListenerTranscript(), 750);
  }

  private flushListenerTranscript(): void {
    this.clearListenerTranscriptTimer();
    const transcript = this.pendingListenerTranscript;
    this.pendingListenerTranscript = "";
    this.handleUserTranscript(transcript);
  }

  private clearListenerTranscriptTimer(): void {
    if (this.listenerTranscriptTimer) {
      window.clearTimeout(this.listenerTranscriptTimer);
      this.listenerTranscriptTimer = null;
    }
  }

  private async emitCallEvent(characterId: string, phase: VoiceCallEventPhase): Promise<void> {
    const payload = buildVoiceCallEventPayload(`${this.clientRoomId}:${characterId}`, phase, {
      elapsedMs: Date.now() - this.startedAtMs,
      metadata: {
        online: navigator.onLine,
        provider: this.provider,
        transport: "gemini_live",
        mode: "group",
        clientRoomId: this.clientRoomId
      }
    });
    await apiPost(`/api/voice-characters/${characterId}/call-events`, payload).catch(() => undefined);
  }
}

type OpenAIRoomParticipant = {
  character: VoiceCharacter;
  peerConnection: RTCPeerConnection;
  channel: RTCDataChannel;
  audioElement: HTMLAudioElement;
  remoteStream: MediaStream;
  pendingTranscript: string;
  responsePending: boolean;
  responseDone: boolean;
  audioOutputStarted: boolean;
  audioOutputDone: boolean;
  turnFinalized: boolean;
  responseFallbackTimer: number | null;
};

type GeminiRoomParticipant = {
  character: VoiceCharacter;
  session: GeminiLiveSdkSession;
  pendingTranscript: string;
  heardAudioInCurrentTurn: boolean;
  turnCompleteInCurrentTurn: boolean;
  turnFinalized: boolean;
  turnFallbackTimer: number | null;
};

async function createOfferSdp(peerConnection: RTCPeerConnection): Promise<string> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(peerConnection, VOICE_ROOM_ICE_GATHERING_TIMEOUT_MS);
  const offerSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
  if (!offerSdp) {
    throw new Error("Could not create a WebRTC offer.");
  }
  return offerSdp;
}

function waitForIceGatheringComplete(peerConnection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peerConnection.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(finish, timeoutMs);
    function finish(): void {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("icecandidate", handleIceCandidate);
      peerConnection.removeEventListener("icegatheringstatechange", handleIceGatheringStateChange);
      resolve();
    }
    function handleIceCandidate(event: RTCPeerConnectionIceEvent): void {
      if (!event.candidate) {
        finish();
      }
    }
    function handleIceGatheringStateChange(): void {
      if (peerConnection.iceGatheringState === "complete") {
        finish();
      }
    }
    peerConnection.addEventListener("icecandidate", handleIceCandidate);
    peerConnection.addEventListener("icegatheringstatechange", handleIceGatheringStateChange);
    handleIceGatheringStateChange();
  });
}

function waitForPeerConnected(peerConnection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peerConnected(peerConnection)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(() => reject(new Error("Voice room WebRTC connection timed out."))), timeoutMs);
    function finish(callback: () => void): void {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("connectionstatechange", handleStateChange);
      peerConnection.removeEventListener("iceconnectionstatechange", handleStateChange);
      callback();
    }
    function handleStateChange(): void {
      if (peerConnected(peerConnection)) {
        finish(resolve);
        return;
      }
      if (peerFailed(peerConnection)) {
        finish(() => reject(new Error("Voice room WebRTC connection failed.")));
      }
    }
    peerConnection.addEventListener("connectionstatechange", handleStateChange);
    peerConnection.addEventListener("iceconnectionstatechange", handleStateChange);
    handleStateChange();
  });
}

function waitForDataChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(() => reject(new Error("Voice room data channel timed out."))), 10000);
    function finish(callback: () => void): void {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", handleOpen);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
      callback();
    }
    function handleOpen(): void {
      finish(resolve);
    }
    function handleClose(): void {
      finish(() => reject(new Error("Voice room data channel closed.")));
    }
    function handleError(): void {
      finish(() => reject(new Error("Voice room data channel failed.")));
    }
    channel.addEventListener("open", handleOpen);
    channel.addEventListener("close", handleClose);
    channel.addEventListener("error", handleError);
  });
}

function peerConnected(peerConnection: RTCPeerConnection): boolean {
  return (
    peerConnection.connectionState === "connected" ||
    peerConnection.iceConnectionState === "connected" ||
    peerConnection.iceConnectionState === "completed"
  );
}

function peerFailed(peerConnection: RTCPeerConnection): boolean {
  return (
    peerConnection.connectionState === "failed" ||
    peerConnection.connectionState === "closed" ||
    peerConnection.iceConnectionState === "failed" ||
    peerConnection.iceConnectionState === "closed"
  );
}

async function resolveVoiceRoomRtcConfiguration(): Promise<RTCConfiguration> {
  const now = Date.now();
  if (!voiceRoomRtcConfigCache || voiceRoomRtcConfigCache.expiresAtMs - VOICE_RTC_CONFIG_REFRESH_SKEW_MS <= now) {
    const config = await apiGet<VoiceRtcConfig>("/api/voice/rtc-config");
    const issuedAtMs = Date.parse(config.issuedAt);
    voiceRoomRtcConfigCache = {
      config,
      expiresAtMs: (Number.isFinite(issuedAtMs) ? issuedAtMs : now) + config.ttlSeconds * 1000
    };
  }
  return {
    iceServers: voiceRoomRtcConfigCache.config.iceServers,
    iceCandidatePoolSize: 2
  };
}

function parseRealtimeEvent(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    return eventRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function eventString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function openAIResponseDoneWasCancelled(record: Record<string, unknown>): boolean {
  const response = eventRecord(record.response);
  const status = eventString(response, "status")?.toLowerCase();
  const statusDetails = eventRecord(response?.status_details);
  const reason = eventString(statusDetails, "reason")?.toLowerCase() ?? eventString(statusDetails, "type")?.toLowerCase();
  return status === "cancelled" || status === "failed" || reason === "cancelled" || reason === "turn_detected";
}

function isOpenAIAudioOutputDeltaEvent(type: string | null): boolean {
  return type === "response.audio.delta" || type === "response.output_audio.delta";
}

function isOpenAIAudioOutputDoneEvent(type: string | null): boolean {
  return type === "response.audio.done" || type === "response.output_audio.done";
}

function normalizeTranscript(text: string | null | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mentionsCharacter(text: string, characterName: string): boolean {
  const aliases = characterAliases(characterName);
  return aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text));
}

function characterAliases(name: string): string[] {
  const clean = name.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return [clean, words[0], words.at(-1)]
    .filter((value): value is string => Boolean(value && value.length > 1))
    .filter((value, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function audioContextConstructor(): typeof AudioContext {
  const constructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!constructor) {
    throw new Error("This browser does not support Web Audio voice chat.");
  }
  return constructor;
}

function errorFromErrorEvent(event: ErrorEvent): Error {
  if (event.error instanceof Error) {
    return event.error;
  }
  return new Error(event.message || "Gemini Live voice room connection failed.");
}

function sampleRateFromMimeType(mimeType: string): number | null {
  const match = mimeType.match(/rate=(\d+)/i);
  if (!match) {
    return null;
  }
  const sampleRate = Number.parseInt(match[1]!, 10);
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null;
}
