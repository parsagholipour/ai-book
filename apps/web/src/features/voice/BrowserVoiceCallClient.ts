import { GoogleGenAI, Modality } from "@google/genai";
import {
  apiGet,
  apiPost,
  type GeminiLiveVoiceCallSession,
  type VoiceCallEventPhase,
  type VoiceCallSession,
  type VoiceChatProviderId,
  type VoiceRtcConfig
} from "../../api.js";
import {
  buildVoiceCallEventPayload,
  collectVoiceConnectionDiagnostics,
  createVoiceCallId,
  retryDelayWithJitter,
  type VoiceConnectionDiagnostics
} from "../../voiceCallDiagnostics.js";
import { asError } from "../shared/formatters.js";
import type { ActiveVoiceCallStatus } from "./types.js";

const VOICE_CALL_ICE_GATHERING_TIMEOUT_MS = 3000;
const VOICE_CALL_CONNECT_TIMEOUT_MS = 30000;
const VOICE_CALL_DISCONNECTED_GRACE_MS = 8000;
const VOICE_CALL_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const VOICE_CALL_MAX_CONNECT_ATTEMPTS = VOICE_CALL_RETRY_DELAYS_MS.length + 1;
const VOICE_CALL_CONTEXT_LINE_LIMIT = 8;
const VOICE_CALL_RECONNECT_CONTEXT_MAX_CHARS = 1200;
const VOICE_RTC_CONFIG_REFRESH_SKEW_MS = 30000;
const GEMINI_INPUT_SAMPLE_RATE = 16000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24000;
const GEMINI_AUDIO_CHUNK_SIZE = 4096;

export type BrowserVoiceCallClientStatus = Exclude<ActiveVoiceCallStatus, "failed">;

export type BrowserVoiceCallClientOptions = {
  voiceModel?: string | undefined;
  onStatusChange?: (status: BrowserVoiceCallClientStatus) => void;
  onFailure?: (error: Error) => void;
};

export interface BrowserVoiceCallClient {
  readonly provider: VoiceChatProviderId;
  connect(): Promise<VoiceCallSession>;
  isEnded(): boolean;
  setMuted(muted: boolean): void;
  end(): Promise<void>;
}

type GeminiLiveRealtimeInput = {
  audio?: { data?: string; mimeType?: string };
  audioStreamEnd?: boolean;
  text?: string;
};

type GeminiLiveSdkSession = {
  sendRealtimeInput(params: GeminiLiveRealtimeInput): void;
  close(): void;
};

export type GeminiPlaybackOutput = {
  node: AudioNode;
  close(): void;
};

// Audio rendered straight to an AudioContext destination is not part of the
// browser's echo-cancellation reference signal, so the mic re-captures the
// character's voice and Gemini's VAD interrupts its own reply. Routing
// playback through a MediaStream-backed <audio> element keeps it inside the
// echo canceller's reference path.
export function createGeminiPlaybackOutput(context: AudioContext): GeminiPlaybackOutput {
  if (typeof context.createMediaStreamDestination !== "function") {
    return { node: context.destination, close: () => undefined };
  }
  const destination = context.createMediaStreamDestination();
  const element = document.createElement("audio");
  element.autoplay = true;
  element.setAttribute("playsinline", "true");
  element.srcObject = destination.stream;
  void element.play().catch(() => undefined);
  return {
    node: destination,
    close: () => {
      element.pause();
      element.srcObject = null;
      try {
        destination.disconnect();
      } catch {
        /* destination may already be disconnected */
      }
    }
  };
}

let voiceRtcConfigCache: { config: VoiceRtcConfig; expiresAtMs: number } | null = null;

export function createBrowserVoiceCallClient(
  provider: VoiceChatProviderId,
  characterId: string,
  options: BrowserVoiceCallClientOptions = {}
): BrowserVoiceCallClient {
  if (provider === "gemini_live") {
    return new GeminiLiveVoiceCallClient(characterId, options);
  }
  return new OpenAIRealtimeVoiceCallClient(characterId, options);
}

export class OpenAIRealtimeVoiceCallClient implements BrowserVoiceCallClient {
  readonly provider = "openai_realtime" as const;
  private readonly clientCallId = createVoiceCallId();
  private readonly startedAtMs = Date.now();
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private closed = false;
  private hasConnected = false;
  private muted = false;
  private reconnecting = false;
  private disconnectTimer: number | null = null;
  private connectionSequence = 0;
  private lastIceCandidateError: string | null = null;
  private recentContextLines: string[] = [];
  private pendingAssistantTranscript = "";

  constructor(
    private readonly characterId: string,
    private readonly options: BrowserVoiceCallClientOptions = {}
  ) {}

  async connect(): Promise<VoiceCallSession> {
    this.closed = false;
    return this.connectWithRetries("connecting");
  }

  isEnded(): boolean {
    return this.closed;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  async end(): Promise<void> {
    void this.emitCallEvent("ended", this.peerConnection);
    this.closed = true;
    this.connectionSequence += 1;
    this.clearDisconnectTimer();
    this.closePeerConnection();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
    }
    this.localStream = null;
    this.audioElement = null;
  }

  private async connectWithRetries(status: BrowserVoiceCallClientStatus): Promise<VoiceCallSession> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < VOICE_CALL_MAX_CONNECT_ATTEMPTS; attempt += 1) {
      const attemptNumber = attempt + 1;
      this.assertOpen();
      if (attempt > 0) {
        this.options.onStatusChange?.("reconnecting");
        await delay(retryDelayWithJitter(VOICE_CALL_RETRY_DELAYS_MS[attempt - 1] ?? VOICE_CALL_RETRY_DELAYS_MS.at(-1) ?? 1000));
        this.assertOpen();
      } else {
        this.options.onStatusChange?.(status);
      }

      try {
        void this.emitCallEvent(status === "connecting" ? "connect_start" : "reconnect_start", undefined, {
          attempt: attemptNumber
        });
        const session = await this.connectOnce();
        this.hasConnected = true;
        this.options.onStatusChange?.("connected");
        void this.emitCallEvent(status === "connecting" ? "connected" : "reconnect_success", this.peerConnection, {
          attempt: attemptNumber
        });
        return session;
      } catch (error) {
        lastError = error;
        this.closePeerConnection();
        if (this.closed) {
          throw asError(error);
        }
      }
    }

    void this.emitCallEvent(status === "connecting" ? "failed" : "reconnect_failed", undefined, {
      error: asError(lastError, "WebRTC voice chat could not connect after retrying.").message
    });
    throw asError(lastError, "WebRTC voice chat could not connect after retrying.");
  }

  private async connectOnce(): Promise<VoiceCallSession> {
    this.connectionSequence += 1;
    const sequence = this.connectionSequence;
    this.clearDisconnectTimer();
    this.closePeerConnection();
    this.lastIceCandidateError = null;

    const peerConnection = new RTCPeerConnection(await resolveVoiceRtcConfiguration());
    const audioElement = this.ensureAudioElement();
    this.peerConnection = peerConnection;
    this.bindPeerConnection(peerConnection, sequence, audioElement);

    const localStream = await this.ensureLocalStream();
    this.assertCurrentPeer(peerConnection, sequence);
    for (const track of localStream.getAudioTracks()) {
      peerConnection.addTrack(track, localStream);
    }
    this.bindRealtimeEventsChannel(peerConnection.createDataChannel("voice-events"));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection, VOICE_CALL_ICE_GATHERING_TIMEOUT_MS);
    this.assertCurrentPeer(peerConnection, sequence);

    const offerSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
    if (!offerSdp) {
      throw new Error("Could not create a WebRTC offer.");
    }

    const reconnectContext = this.reconnectContext();
    const session = await apiPost<VoiceCallSession>(`/api/voice-characters/${this.characterId}/calls`, {
      provider: "openai_realtime",
      transport: "webrtc_sdp",
      offerSdp,
      ...(this.options.voiceModel ? { voiceModel: this.options.voiceModel } : {}),
      ...(reconnectContext ? { reconnectContext } : {})
    });
    if (session.type !== "webrtc_sdp_answer") {
      throw new Error("OpenAI Realtime returned an unexpected voice session.");
    }
    this.assertCurrentPeer(peerConnection, sequence);
    await peerConnection.setRemoteDescription({ type: "answer", sdp: session.answerSdp });
    await waitForPeerConnected(peerConnection, VOICE_CALL_CONNECT_TIMEOUT_MS, () =>
      this.connectionFailureMessage(peerConnection)
    );
    this.assertCurrentPeer(peerConnection, sequence);

    return session;
  }

  private bindPeerConnection(peerConnection: RTCPeerConnection, sequence: number, audioElement: HTMLAudioElement): void {
    peerConnection.ontrack = (event) => {
      if (!this.isCurrentPeer(peerConnection, sequence)) {
        return;
      }
      audioElement.srcObject = event.streams[0] ?? null;
      void audioElement.play().catch(() => undefined);
    };
    peerConnection.onicecandidateerror = (event) => {
      this.lastIceCandidateError = describeIceCandidateError(event);
    };
    peerConnection.onconnectionstatechange = () => this.handlePeerStateChange(peerConnection, sequence);
    peerConnection.oniceconnectionstatechange = () => this.handlePeerStateChange(peerConnection, sequence);
  }

  private bindRealtimeEventsChannel(channel: RTCDataChannel): void {
    channel.onmessage = (event) => {
      this.captureRealtimeEvent(event.data);
    };
  }

  private captureRealtimeEvent(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const record = eventRecord(event);
    if (!record) {
      return;
    }

    const type = eventString(record, "type");
    if (type === "response.audio_transcript.delta" || type === "response.output_audio_transcript.delta") {
      this.pendingAssistantTranscript += eventString(record, "delta") ?? "";
      return;
    }

    if (type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done") {
      const transcript = eventString(record, "transcript") ?? this.pendingAssistantTranscript;
      this.pendingAssistantTranscript = "";
      this.pushContextLine("Assistant", transcript);
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      this.pushContextLine("User", eventString(record, "transcript"));
      return;
    }

    if (type === "conversation.item.created") {
      this.captureConversationItem(record.item);
    }
  }

  private captureConversationItem(item: unknown): void {
    const record = eventRecord(item);
    const role = eventString(record, "role");
    if (role !== "assistant" && role !== "user") {
      return;
    }

    const content = Array.isArray(record?.content) ? record.content : [];
    const text = content
      .map((part) => eventRecord(part))
      .map((part) => eventString(part, "transcript") ?? eventString(part, "text"))
      .filter((part): part is string => Boolean(part?.trim()))
      .join(" ");
    this.pushContextLine(role === "user" ? "User" : "Assistant", text);
  }

  private pushContextLine(speaker: "Assistant" | "User", transcript: string | null | undefined): void {
    const normalized = transcript?.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }

    const line = `${speaker}: ${normalized}`;
    if (this.recentContextLines.at(-1) === line) {
      return;
    }

    this.recentContextLines = [...this.recentContextLines, line].slice(-VOICE_CALL_CONTEXT_LINE_LIMIT);
  }

  private reconnectContext(): string {
    if (!this.hasConnected) {
      return "";
    }

    const contextLines = [...this.recentContextLines];
    const pending = this.pendingAssistantTranscript.replace(/\s+/g, " ").trim();
    if (pending) {
      contextLines.push(`Assistant: ${pending}`);
    }

    const context = contextLines.slice(-VOICE_CALL_CONTEXT_LINE_LIMIT).join("\n");
    return compactReconnectContext(context);
  }

  private handlePeerStateChange(peerConnection: RTCPeerConnection, sequence: number): void {
    if (!this.isCurrentPeer(peerConnection, sequence)) {
      return;
    }

    if (peerConnected(peerConnection)) {
      this.clearDisconnectTimer();
      if (this.hasConnected && !this.reconnecting) {
        this.options.onStatusChange?.("connected");
      }
      return;
    }

    if (peerFailed(peerConnection)) {
      this.scheduleReconnect(this.connectionFailureMessage(peerConnection));
      return;
    }

    if (
      this.hasConnected &&
      !this.reconnecting &&
      !this.disconnectTimer &&
      (peerConnection.connectionState === "disconnected" || peerConnection.iceConnectionState === "disconnected")
    ) {
      this.options.onStatusChange?.("reconnecting");
      void this.emitCallEvent("disconnected", peerConnection, {
        error: this.connectionFailureMessage(peerConnection)
      });
      this.disconnectTimer = window.setTimeout(() => {
        this.disconnectTimer = null;
        if (this.isCurrentPeer(peerConnection, sequence)) {
          this.scheduleReconnect(this.connectionFailureMessage(peerConnection));
        }
      }, VOICE_CALL_DISCONNECTED_GRACE_MS);
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || !this.hasConnected || this.reconnecting) {
      return;
    }

    this.clearDisconnectTimer();
    this.reconnecting = true;
    this.options.onStatusChange?.("reconnecting");
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

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    void this.emitCallEvent("failed", this.peerConnection, { error: error.message });
    this.closed = true;
    this.connectionSequence += 1;
    this.clearDisconnectTimer();
    this.closePeerConnection();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
    }
    this.localStream = null;
    this.audioElement = null;
    this.options.onFailure?.(error);
  }

  private async emitCallEvent(
    phase: VoiceCallEventPhase,
    peerConnection: RTCPeerConnection | null | undefined,
    options: {
      attempt?: number;
      error?: string;
      metadata?: Record<string, string | number | boolean | null>;
    } = {}
  ): Promise<void> {
    let diagnostics: VoiceConnectionDiagnostics | undefined;
    if (peerConnection) {
      diagnostics = await collectVoiceConnectionDiagnostics(peerConnection);
    }

    const metadata = {
      online: navigator.onLine,
      provider: this.provider,
      transport: "webrtc_sdp",
      relayConfigured: voiceRtcConfigCache?.config.relayConfigured ?? false,
      ...options.metadata
    };
    const eventOptions: {
      attempt?: number;
      elapsedMs: number;
      diagnostics?: VoiceConnectionDiagnostics;
      error?: string;
      metadata: Record<string, string | number | boolean | null>;
    } = {
      elapsedMs: Date.now() - this.startedAtMs,
      metadata
    };
    if (options.attempt !== undefined) {
      eventOptions.attempt = options.attempt;
    }
    if (diagnostics) {
      eventOptions.diagnostics = diagnostics;
    }
    if (options.error !== undefined) {
      eventOptions.error = options.error;
    }

    const payload = buildVoiceCallEventPayload(this.clientCallId, phase, eventOptions);
    await apiPost(`/api/voice-characters/${this.characterId}/call-events`, payload).catch(() => undefined);
  }

  private async ensureLocalStream(): Promise<MediaStream> {
    if (this.localStream?.active) {
      return this.localStream;
    }
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.setMuted(this.muted);
    return this.localStream;
  }

  private ensureAudioElement(): HTMLAudioElement {
    if (!this.audioElement) {
      this.audioElement = document.createElement("audio");
      this.audioElement.autoplay = true;
      this.audioElement.setAttribute("playsinline", "true");
    }
    return this.audioElement;
  }

  private closePeerConnection(): void {
    this.clearDisconnectTimer();
    const peerConnection = this.peerConnection;
    this.peerConnection = null;
    if (!peerConnection) {
      return;
    }
    peerConnection.ontrack = null;
    peerConnection.onicecandidateerror = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.close();
    if (this.audioElement) {
      this.audioElement.srcObject = null;
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) {
      window.clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Voice chat ended.");
    }
  }

  private assertCurrentPeer(peerConnection: RTCPeerConnection, sequence: number): void {
    this.assertOpen();
    if (!this.isCurrentPeer(peerConnection, sequence)) {
      throw new Error("Voice chat connection was replaced.");
    }
  }

  private isCurrentPeer(peerConnection: RTCPeerConnection, sequence: number): boolean {
    return !this.closed && this.peerConnection === peerConnection && this.connectionSequence === sequence;
  }

  private connectionFailureMessage(peerConnection: RTCPeerConnection): string {
    const stateDetails = `connection: ${peerConnection.connectionState}, ICE: ${peerConnection.iceConnectionState}`;
    return this.lastIceCandidateError
      ? `WebRTC voice chat connection failed (${stateDetails}). ${this.lastIceCandidateError}`
      : `WebRTC voice chat connection failed (${stateDetails}).`;
  }
}

export class GeminiLiveVoiceCallClient implements BrowserVoiceCallClient {
  readonly provider = "gemini_live" as const;
  private readonly clientCallId = createVoiceCallId();
  private readonly startedAtMs = Date.now();
  private liveSession: GeminiLiveSdkSession | null = null;
  private localStream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: ScriptProcessorNode | null = null;
  private inputSilence: GainNode | null = null;
  private outputContext: AudioContext | null = null;
  private playbackOutput: GeminiPlaybackOutput | null = null;
  private playbackSources: AudioBufferSourceNode[] = [];
  private nextPlaybackTime = 0;
  private closed = false;
  private hasConnected = false;
  private muted = false;
  private reconnecting = false;
  private connectionSequence = 0;
  private sessionHandle = "";
  private recentContextLines: string[] = [];
  private pendingUserTranscript = "";
  private pendingAssistantTranscript = "";
  private geminiSessionOpen = false;

  constructor(
    private readonly characterId: string,
    private readonly options: BrowserVoiceCallClientOptions = {}
  ) {}

  async connect(): Promise<VoiceCallSession> {
    this.closed = false;
    return this.connectWithRetries("connecting");
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
      this.sendGeminiRealtimeInput({ audioStreamEnd: true });
    }
  }

  async end(): Promise<void> {
    void this.emitCallEvent("ended");
    this.closed = true;
    this.connectionSequence += 1;
    this.closeGeminiSession();
    this.closeInputPipeline();
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
  }

  private async connectWithRetries(status: BrowserVoiceCallClientStatus): Promise<VoiceCallSession> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < VOICE_CALL_MAX_CONNECT_ATTEMPTS; attempt += 1) {
      const attemptNumber = attempt + 1;
      this.assertOpen();
      if (attempt > 0) {
        this.options.onStatusChange?.("reconnecting");
        await delay(retryDelayWithJitter(VOICE_CALL_RETRY_DELAYS_MS[attempt - 1] ?? VOICE_CALL_RETRY_DELAYS_MS.at(-1) ?? 1000));
        this.assertOpen();
      } else {
        this.options.onStatusChange?.(status);
      }

      try {
        void this.emitCallEvent(status === "connecting" ? "connect_start" : "reconnect_start", {
          attempt: attemptNumber
        });
        const session = await this.connectOnce();
        this.hasConnected = true;
        this.options.onStatusChange?.("connected");
        void this.emitCallEvent(status === "connecting" ? "connected" : "reconnect_success", {
          attempt: attemptNumber
        });
        return session;
      } catch (error) {
        lastError = error;
        this.closeGeminiSession();
        this.closeInputPipeline();
        if (this.closed) {
          throw asError(error);
        }
      }
    }

    void this.emitCallEvent(status === "connecting" ? "failed" : "reconnect_failed", {
      error: asError(lastError, "Gemini Live voice chat could not connect after retrying.").message
    });
    throw asError(lastError, "Gemini Live voice chat could not connect after retrying.");
  }

  private async connectOnce(): Promise<GeminiLiveVoiceCallSession> {
    this.connectionSequence += 1;
    const sequence = this.connectionSequence;
    this.closeGeminiSession();
    this.closeInputPipeline();
    await this.ensureLocalStream();
    await this.ensureOutputContext();

    const reconnectContext = this.reconnectContext();
    const session = await apiPost<VoiceCallSession>(`/api/voice-characters/${this.characterId}/calls`, {
      provider: "gemini_live",
      transport: "gemini_live",
      ...(this.sessionHandle ? { sessionHandle: this.sessionHandle } : {}),
      ...(this.options.voiceModel ? { voiceModel: this.options.voiceModel } : {}),
      ...(reconnectContext ? { reconnectContext } : {})
    });
    if (session.type !== "gemini_live_token") {
      throw new Error("Gemini Live returned an unexpected voice session.");
    }
    this.assertCurrentSequence(sequence);

    const ai = new GoogleGenAI({
      apiKey: session.token,
      httpOptions: { apiVersion: "v1alpha" }
    });
    const liveSession = await ai.live.connect({
      model: session.model,
      config: {
        responseModalities: [Modality.AUDIO]
      },
      callbacks: {
        onmessage: (message: unknown) => this.handleGeminiMessage(message, sequence),
        onerror: (event: ErrorEvent) => {
          if (this.isCurrentSequence(sequence)) {
            const error = errorFromErrorEvent(event);
            this.markGeminiSessionClosed();
            this.closeInputPipeline();
            if (this.hasConnected && isRetryableGeminiDisconnectReason(error.message)) {
              this.scheduleReconnect(error.message);
              return;
            }
            this.fail(error);
          }
        },
        onclose: (event: CloseEvent) => {
          if (!this.isCurrentSequence(sequence) || this.closed) {
            return;
          }
          const wasOpen = this.geminiSessionOpen && Boolean(this.liveSession);
          this.markGeminiSessionClosed();
          this.closeInputPipeline();
          this.clearPlaybackQueue();
          if (!wasOpen) {
            return;
          }
          const reason = event.reason?.trim() || `Gemini Live connection closed (${event.code}).`;
          if (this.hasConnected && isRetryableGeminiDisconnectReason(reason)) {
            this.scheduleReconnect(reason);
            return;
          }
          this.fail(new Error(reason));
        }
      }
    });
    this.assertCurrentSequence(sequence);
    this.liveSession = liveSession as GeminiLiveSdkSession;
    this.geminiSessionOpen = true;
    await this.startInputPipeline(sequence);

    return session;
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
      if (!this.isCurrentSequence(sequence) || this.muted) {
        return;
      }
      const channel = event.inputBuffer.getChannelData(0);
      const data = encodePcm16Base64(channel, context.sampleRate, GEMINI_INPUT_SAMPLE_RATE);
      this.sendGeminiRealtimeInput({
        audio: {
          data,
          mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`
        }
      }, sequence);
    };

    source.connect(processor);
    processor.connect(silence);
    silence.connect(context.destination);
    this.inputSource = source;
    this.inputProcessor = processor;
    this.inputSilence = silence;
  }

  private handleGeminiMessage(message: unknown, sequence: number): void {
    if (!this.isCurrentSequence(sequence)) {
      return;
    }
    const record = eventRecord(message);
    const serverContent = eventRecord(record?.serverContent);
    if (serverContent?.interrupted === true) {
      this.clearPlaybackQueue();
    }

    this.captureGeminiTranscription("User", eventRecord(serverContent?.inputTranscription));
    this.captureGeminiTranscription("Assistant", eventRecord(serverContent?.outputTranscription));

    const parts = Array.isArray(eventRecord(serverContent?.modelTurn)?.parts)
      ? (eventRecord(serverContent?.modelTurn)?.parts as unknown[])
      : [];
    for (const part of parts) {
      const inlineData = eventRecord(eventRecord(part)?.inlineData);
      const data = eventString(inlineData, "data");
      const mimeType = eventString(inlineData, "mimeType");
      if (data && mimeType?.startsWith("audio/")) {
        void this.playPcm16Audio(data, sampleRateFromMimeType(mimeType) ?? GEMINI_OUTPUT_SAMPLE_RATE);
      }
    }

    if (serverContent?.turnComplete === true) {
      this.flushPendingTranscripts();
    }

    const sessionUpdate = eventRecord(record?.sessionResumptionUpdate);
    if (sessionUpdate?.resumable === true) {
      const newHandle = eventString(sessionUpdate, "newHandle");
      if (newHandle) {
        this.sessionHandle = newHandle;
      }
    }

    if (record?.goAway) {
      this.scheduleReconnect("Gemini Live asked the client to reconnect.");
    }
  }

  private captureGeminiTranscription(speaker: "Assistant" | "User", transcription: Record<string, unknown> | null): void {
    const text = eventString(transcription, "text");
    if (!text) {
      return;
    }
    if (speaker === "User") {
      this.pendingUserTranscript += text;
      if (transcription?.finished === true) {
        this.pushContextLine("User", this.pendingUserTranscript);
        this.pendingUserTranscript = "";
      }
      return;
    }

    this.pendingAssistantTranscript += text;
    if (transcription?.finished === true) {
      this.pushContextLine("Assistant", this.pendingAssistantTranscript);
      this.pendingAssistantTranscript = "";
    }
  }

  private flushPendingTranscripts(): void {
    if (this.pendingUserTranscript.trim()) {
      this.pushContextLine("User", this.pendingUserTranscript);
      this.pendingUserTranscript = "";
    }
    if (this.pendingAssistantTranscript.trim()) {
      this.pushContextLine("Assistant", this.pendingAssistantTranscript);
      this.pendingAssistantTranscript = "";
    }
  }

  private pushContextLine(speaker: "Assistant" | "User", transcript: string | null | undefined): void {
    const normalized = transcript?.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }

    const line = `${speaker}: ${normalized}`;
    if (this.recentContextLines.at(-1) === line) {
      return;
    }

    this.recentContextLines = [...this.recentContextLines, line].slice(-VOICE_CALL_CONTEXT_LINE_LIMIT);
  }

  private reconnectContext(): string {
    if (!this.hasConnected) {
      return "";
    }
    const contextLines = [...this.recentContextLines];
    const pendingUser = this.pendingUserTranscript.replace(/\s+/g, " ").trim();
    const pendingAssistant = this.pendingAssistantTranscript.replace(/\s+/g, " ").trim();
    if (pendingUser) {
      contextLines.push(`User: ${pendingUser}`);
    }
    if (pendingAssistant) {
      contextLines.push(`Assistant: ${pendingAssistant}`);
    }
    return compactReconnectContext(contextLines.slice(-VOICE_CALL_CONTEXT_LINE_LIMIT).join("\n"));
  }

  private async playPcm16Audio(data: string, sampleRate: number): Promise<void> {
    const context = await this.ensureOutputContext();
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
    };
    const startAt = Math.max(context.currentTime + 0.01, this.nextPlaybackTime);
    source.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;
    this.playbackSources.push(source);
  }

  private clearPlaybackQueue(): void {
    for (const source of this.playbackSources) {
      try {
        source.stop();
      } catch {
        /* source may already be stopped */
      }
    }
    this.playbackSources = [];
    this.nextPlaybackTime = this.outputContext?.currentTime ?? 0;
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || !this.hasConnected || this.reconnecting) {
      return;
    }

    this.closeGeminiSession();
    this.closeInputPipeline();
    this.clearPlaybackQueue();
    this.reconnecting = true;
    this.options.onStatusChange?.("reconnecting");
    void this.emitCallEvent("disconnected", { error: reason });
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

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    void this.emitCallEvent("failed", { error: error.message });
    this.closed = true;
    this.connectionSequence += 1;
    this.closeGeminiSession();
    this.closeInputPipeline();
    this.clearPlaybackQueue();
    this.closePlaybackOutput();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.options.onFailure?.(error);
  }

  private async emitCallEvent(
    phase: VoiceCallEventPhase,
    options: {
      attempt?: number;
      error?: string;
      metadata?: Record<string, string | number | boolean | null>;
    } = {}
  ): Promise<void> {
    const metadata = {
      online: navigator.onLine,
      provider: this.provider,
      transport: "gemini_live",
      resumable: Boolean(this.sessionHandle),
      ...options.metadata
    };
    const eventOptions: {
      attempt?: number;
      elapsedMs: number;
      error?: string;
      metadata: Record<string, string | number | boolean | null>;
    } = {
      elapsedMs: Date.now() - this.startedAtMs,
      metadata
    };
    if (options.attempt !== undefined) {
      eventOptions.attempt = options.attempt;
    }
    if (options.error !== undefined) {
      eventOptions.error = options.error;
    }
    const payload = buildVoiceCallEventPayload(this.clientCallId, phase, eventOptions);
    await apiPost(`/api/voice-characters/${this.characterId}/call-events`, payload).catch(() => undefined);
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

  private closeGeminiSession(): void {
    const session = this.liveSession;
    this.markGeminiSessionClosed();
    if (!session) {
      return;
    }
    try {
      session.close();
    } catch {
      /* session may already be closed */
    }
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

  private sendGeminiRealtimeInput(params: GeminiLiveRealtimeInput, sequence = this.connectionSequence): boolean {
    if (!this.isCurrentSequence(sequence) || !this.geminiSessionOpen || !this.liveSession) {
      return false;
    }

    try {
      this.liveSession.sendRealtimeInput(params);
      return true;
    } catch (error) {
      const message = asError(error, "Gemini Live audio send failed.").message;
      this.markGeminiSessionClosed();
      this.closeInputPipeline();
      if (this.hasConnected && isRetryableGeminiDisconnectReason(message)) {
        this.scheduleReconnect(message);
      } else {
        this.fail(new Error(message));
      }
      return false;
    }
  }

  private markGeminiSessionClosed(): void {
    this.geminiSessionOpen = false;
    this.liveSession = null;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Voice chat ended.");
    }
  }

  private assertCurrentSequence(sequence: number): void {
    this.assertOpen();
    if (!this.isCurrentSequence(sequence)) {
      throw new Error("Voice chat connection was replaced.");
    }
  }

  private isCurrentSequence(sequence: number): boolean {
    return !this.closed && this.connectionSequence === sequence;
  }
}

export function encodePcm16Base64(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number): string {
  const resampled = resampleFloat32(samples, sourceSampleRate, targetSampleRate);
  const bytes = new Uint8Array(resampled.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < resampled.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytesToBase64(bytes);
}

export function decodePcm16Base64(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

export function resampleFloat32(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  if (sourceSampleRate === targetSampleRate) {
    return new Float32Array(samples);
  }
  if (samples.length === 0 || sourceSampleRate <= 0 || targetSampleRate <= 0) {
    return new Float32Array();
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, samples.length - 1);
    const weight = sourceIndex - before;
    output[index] = (samples[before] ?? 0) * (1 - weight) + (samples[after] ?? 0) * weight;
  }
  return output;
}

function eventRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function eventString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function compactReconnectContext(context: string): string {
  return context.length > VOICE_CALL_RECONNECT_CONTEXT_MAX_CHARS
    ? context.slice(context.length - VOICE_CALL_RECONNECT_CONTEXT_MAX_CHARS)
    : context;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function resolveVoiceRtcConfiguration(): Promise<RTCConfiguration> {
  const now = Date.now();
  if (!voiceRtcConfigCache || voiceRtcConfigCache.expiresAtMs - VOICE_RTC_CONFIG_REFRESH_SKEW_MS <= now) {
    const config = await apiGet<VoiceRtcConfig>("/api/voice/rtc-config");
    const issuedAtMs = Date.parse(config.issuedAt);
    voiceRtcConfigCache = {
      config,
      expiresAtMs: (Number.isFinite(issuedAtMs) ? issuedAtMs : now) + config.ttlSeconds * 1000
    };
  }

  return {
    iceServers: voiceRtcConfigCache.config.iceServers,
    iceCandidatePoolSize: 2
  };
}

function waitForIceGatheringComplete(peerConnection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peerConnection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;
    const timeout = window.setTimeout(finish, timeoutMs);

    function finish(): void {
      if (finished) {
        return;
      }
      finished = true;
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

function waitForPeerConnected(
  peerConnection: RTCPeerConnection,
  timeoutMs: number,
  failureMessage: () => string
): Promise<void> {
  if (peerConnected(peerConnection)) {
    return Promise.resolve();
  }
  if (peerFailed(peerConnection)) {
    return Promise.reject(new Error(failureMessage()));
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = window.setTimeout(() => finish(() => reject(new Error(failureMessage()))), timeoutMs);

    function finish(callback: () => void): void {
      if (finished) {
        return;
      }
      finished = true;
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
        finish(() => reject(new Error(failureMessage())));
      }
    }

    peerConnection.addEventListener("connectionstatechange", handleStateChange);
    peerConnection.addEventListener("iceconnectionstatechange", handleStateChange);
    handleStateChange();
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

function describeIceCandidateError(event: Event): string {
  const candidateError = event as Event & { errorCode?: number; errorText?: string; url?: string };
  const details = [
    candidateError.errorText?.trim(),
    typeof candidateError.errorCode === "number" ? `ICE error ${candidateError.errorCode}` : "",
    candidateError.url ? `at ${candidateError.url}` : ""
  ].filter(Boolean);
  return details.length ? details.join(" ") : "An ICE candidate could not be reached.";
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
  return new Error(event.message || "Gemini Live voice chat connection failed.");
}

export function isRetryableGeminiDisconnectReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (isGeminiGoAwayDisconnectReason(normalized)) {
    return true;
  }
  if (
    normalized.includes("prepayment credits") ||
    normalized.includes("billing") ||
    normalized.includes("quota") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("permission_denied") ||
    normalized.includes("unauthenticated") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("api key") ||
    normalized.includes("auth token") ||
    normalized.includes("access token") ||
    normalized.includes("invalid_argument")
  ) {
    return false;
  }
  return true;
}

function isGeminiGoAwayDisconnectReason(normalizedReason: string): boolean {
  return (
    normalizedReason.includes("goaway") ||
    normalizedReason.includes("go away") ||
    normalizedReason.includes("session duration") ||
    normalizedReason.includes("failed to close the connection after receiving")
  );
}

function sampleRateFromMimeType(mimeType: string): number | null {
  const match = mimeType.match(/rate=(\d+)/i);
  if (!match) {
    return null;
  }
  const sampleRate = Number.parseInt(match[1]!, 10);
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
