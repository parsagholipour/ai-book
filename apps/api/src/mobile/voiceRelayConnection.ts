import WebSocket, { type RawData } from "ws";
import type { Prisma } from "@book-maker/db";
import {
  authorizeVoiceRelay, finishVoiceRelay, VoiceRelayError,
  type VoiceRelayLease, type VoiceRelaySession
} from "@book-maker/db/billing";
import { recordVoiceUsage, voiceUsageModel, VoiceUsageMeter } from "./voiceRelayUsage.js";

export type VoiceRelayClaim = { lease: VoiceRelayLease; session: VoiceRelaySession; deadline: Date; projectId: string | null };
export type VoiceRelaySocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "terminate" | "ping"> & {
  on(event: "message", listener: (data: RawData, binary: boolean) => void): unknown;
  on(event: "open" | "close" | "error" | "pong", listener: () => void): unknown;
};
type RelayDeps = {
  authorize: typeof authorizeVoiceRelay;
  finish: typeof finishVoiceRelay;
  openProvider: (session: VoiceRelaySession) => VoiceRelaySocket;
  warn: (error: unknown) => void;
  /** Writes a call's provider cost rows (`voiceRelayUsage.ts`). Its failures never reach the call. */
  recordUsage: (rows: Prisma.ProviderCallLogCreateManyInput[]) => Promise<void>;
};

const PROVIDER_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
/** How much metered usage a crashed process can lose: each call writes a cost segment at least this often. */
const USAGE_FLUSH_MS = 60_000;
const active = new Map<string, VoiceRelayConnection>();

export async function stopLocalVoiceRelay(callId: string, reason = "ended"): Promise<void> {
  await active.get(callId)?.stop(reason);
}

/** No provider credential or resumption handle is ever sent to the device. */
export class VoiceRelayConnection {
  private upstream: VoiceRelaySocket | undefined;
  private ready = false;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private renewing = false;
  private deadline: number;
  private resumeHandle: string | undefined;
  private resumes = 0;
  private pongAt = Date.now();
  private audioBudget = 64_000;
  private budgetAt = Date.now();
  private frameBudget = 100;
  private frameAt = Date.now();
  private readonly usage: VoiceUsageMeter;
  private usageFlushedAt = Date.now();
  /** Segment writes run one after another, and the stop waits for the last. */
  private usageWrites: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly deps: RelayDeps;

  constructor(private readonly client: VoiceRelaySocket, private readonly claim: VoiceRelayClaim, options: Partial<RelayDeps> = {}) {
    this.deps = {
      authorize: authorizeVoiceRelay, finish: finishVoiceRelay,
      openProvider: (session) => new WebSocket(PROVIDER_URL, {
        headers: { Authorization: `Token ${session.token}` }, handshakeTimeout: 10_000,
        maxPayload: 1024 * 1024, perMessageDeflate: false
      }),
      warn: () => undefined,
      recordUsage: (rows) => recordVoiceUsage(rows, (error) => this.deps.warn(error)),
      ...options
    };
    this.usage = new VoiceUsageMeter({
      callId: claim.lease.callId, userId: claim.lease.userId, projectId: claim.projectId,
      provider: "gemini", model: voiceUsageModel(claim.session.model)
    });
    this.deadline = claim.deadline.getTime();
    active.set(claim.lease.callId, this);
    // Attach listeners synchronously: Fastify can deliver the first setup
    // frame while the provider connection or first billing write is pending.
    client.on("message", (data, binary) => this.receiveClient(data, binary));
    client.on("close", () => { void this.stop("disconnected"); });
    client.on("error", () => { void this.stop("disconnected"); });
    client.on("pong", () => { this.pongAt = Date.now(); });
    this.timer = setInterval(() => {
      if (Date.now() >= this.deadline || Date.now() - this.pongAt >= 15_000) void this.stop("connection_expired");
    }, 250);
    this.heartbeat = setInterval(() => {
      if (!this.stopped && client.readyState === WebSocket.OPEN) client.ping();
      if (this.ready) void this.renew();
      if (Date.now() - this.usageFlushedAt >= USAGE_FLUSH_MS) void this.flushUsage();
    }, 5_000);
    this.timer.unref();
    this.heartbeat.unref();
    this.connectProvider();
  }

  /** Close upstream first. Credit release is never allowed to precede that. */
  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    let completed!: () => void;
    // Publish the completion before closing: socket close handlers can reenter
    // synchronously, and shutdown/end callers must await the same settlement.
    this.stopping = new Promise<void>((resolve) => { completed = resolve; });
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.upstream?.terminate();
    // HTTP reasons can contain Unicode longer than a WebSocket close frame.
    if (this.client.readyState === WebSocket.OPEN) this.client.close(4001, "Call ended");
    // Do not leave a closing socket retaining buffers or timers indefinitely.
    const terminate = setTimeout(() => this.client.terminate(), 1000);
    terminate.unref();
    const stoppedAt = new Date(Math.min(Date.now(), this.deadline));
    // Upstream is closed, so no usage report can follow this last segment.
    const usageRecorded = this.flushUsage();
    const settled = this.deps.finish(this.claim.lease, stoppedAt, reason).catch((error: unknown) => this.deps.warn(error));
    void Promise.all([settled, usageRecorded]).finally(() => {
      if (active.get(this.claim.lease.callId) === this) active.delete(this.claim.lease.callId);
      completed();
    });
    return this.stopping;
  }

  /**
   * Hands everything metered since the last segment to the recorder. The meter
   * is emptied before anything is awaited, so a report is never in two
   * segments, and a failing recorder is reported and swallowed.
   */
  private flushUsage(): Promise<void> {
    this.usageFlushedAt = Date.now();
    const rows = this.usage.take();
    if (rows.length === 0) return this.usageWrites;
    this.usageWrites = this.usageWrites
      .then(() => this.deps.recordUsage(rows))
      .catch((error: unknown) => this.deps.warn(error));
    return this.usageWrites;
  }

  private usable(): boolean {
    if (this.stopped) return false;
    // This check also fences a resumed event loop: an expired lease must not
    // forward a queued frame before its overdue interval gets to run.
    if (Date.now() >= this.deadline) { void this.stop("connection_expired"); return false; }
    return true;
  }

  private async renew(): Promise<boolean> {
    if (this.renewing || !this.usable()) return false;
    this.renewing = true;
    try {
      const result = await this.deps.authorize(this.claim.lease);
      if (!this.usable()) return false;
      this.deadline = result.deadline.getTime();
      return this.usable();
    } catch (error) {
      if (error instanceof VoiceRelayError) void this.stop("ended");
      else this.deps.warn(error); // The previous deadline still closes the socket.
      return false;
    } finally { this.renewing = false; }
  }

  private connectProvider(): void {
    if (!this.usable()) return;
    this.ready = false;
    let socket: VoiceRelaySocket;
    try { socket = this.deps.openProvider(this.claim.session); }
    catch (error) { this.deps.warn(error); void this.stop("connect_failed"); return; }
    this.upstream = socket;
    const pending: string[] = [];
    let pendingBytes = 0;
    let authorizing = false;
    socket.on("open", () => {
      if (!this.usable() || this.upstream !== socket) { socket.terminate(); return; }
      socket.send(JSON.stringify({ setup: {
        model: this.claim.session.model.startsWith("models/") ? this.claim.session.model : `models/${this.claim.session.model}`,
        generationConfig: { responseModalities: ["AUDIO"] },
        ...(this.resumeHandle ? { sessionResumption: { handle: this.resumeHandle } } : {})
      } }));
    });
    socket.on("message", (data) => {
      if (!this.usable() || this.upstream !== socket) return;
      const text = data.toString();
      let frame: Record<string, any>;
      try { frame = JSON.parse(text); } catch { void this.stop("provider_error"); return; }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) { void this.stop("provider_error"); return; }
      // Any message may carry the turn's billed usage beside its one payload.
      this.usage.observe(frame);
      if (frame.sessionResumptionUpdate?.resumable === true && typeof frame.sessionResumptionUpdate.newHandle === "string") {
        this.resumeHandle = frame.sessionResumptionUpdate.newHandle;
      }
      if (frame.goAway) { this.resumeProvider(socket); return; }
      if (frame.setupComplete !== undefined) {
        if (authorizing) return;
        authorizing = true;
        void this.renew().then((authorized) => {
          if (!authorized || this.stopped || this.upstream !== socket) { void this.stop("connect_failed"); return; }
          this.ready = true;
          this.sendClient(JSON.stringify({ setupComplete: {} }));
          for (const item of pending) this.sendClient(item);
          pending.length = 0;
        });
        return;
      }
      // Session handles and provider diagnostics stay private to the relay.
      if (!frame.serverContent) return;
      const content = JSON.stringify({ serverContent: frame.serverContent });
      if (!this.ready) {
        pendingBytes += Buffer.byteLength(content);
        if (pendingBytes > 256 * 1024) { void this.stop("provider_overflow"); return; }
        pending.push(content);
      } else this.sendClient(content);
    });
    socket.on("error", () => {
      if (this.upstream === socket) void this.stop("provider_error");
    });
    socket.on("close", () => {
      if (!this.stopped && this.upstream === socket) this.resumeProvider(socket);
    });
  }

  private resumeProvider(socket: VoiceRelaySocket): void {
    if (!this.usable() || this.upstream !== socket) return;
    this.upstream = undefined;
    socket.terminate();
    if (!this.resumeHandle || this.resumes++ >= 4) { void this.stop("provider_disconnected"); return; }
    this.connectProvider();
  }

  private receiveClient(data: RawData, binary: boolean): void {
    if (!this.usable()) return;
    const now = Date.now();
    this.frameBudget = Math.min(100, this.frameBudget + (now - this.frameAt) / 10);
    this.frameAt = now;
    if (--this.frameBudget < 0 || binary || data.toString().length > 96_000) { void this.stop("invalid_audio"); return; }
    let frame: Record<string, any>;
    try { frame = JSON.parse(data.toString()); } catch { void this.stop("invalid_audio"); return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) { void this.stop("invalid_audio"); return; }
    // Retained for the shipped client's protocol. Never forward client setup,
    // text, tools, video, model choices or resumption handles to the provider.
    if (Object.keys(frame).length === 1 && frame.setup) return;
    if (Object.keys(frame).length !== 1 || !frame.realtimeInput || typeof frame.realtimeInput !== "object") {
      void this.stop("invalid_audio"); return;
    }
    const input = frame.realtimeInput;
    if (Object.keys(input).length !== 1) { void this.stop("invalid_audio"); return; }
    let sanitized: object;
    if (input.audioStreamEnd === true) sanitized = { realtimeInput: { audioStreamEnd: true } };
    else {
      const audio = input.audio;
      if (!audio || typeof audio !== "object" || Object.keys(audio).length !== 2 || audio.mimeType !== "audio/pcm;rate=16000" ||
          typeof audio.data !== "string" || audio.data.length > 86_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) {
        void this.stop("invalid_audio"); return;
      }
      const bytes = Buffer.from(audio.data, "base64");
      if (!bytes.length || bytes.length % 2 || bytes.toString("base64") !== audio.data) { void this.stop("invalid_audio"); return; }
      this.audioBudget = Math.min(64_000, this.audioBudget + (now - this.budgetAt) * 32);
      this.budgetAt = now;
      this.audioBudget -= bytes.length;
      if (this.audioBudget < 0) { void this.stop("audio_rate_limit"); return; }
      sanitized = { realtimeInput: { audio: { data: audio.data, mimeType: audio.mimeType } } };
    }
    if (!this.ready || this.upstream?.readyState !== WebSocket.OPEN) return;
    if (this.upstream.bufferedAmount > 128 * 1024) { void this.stop("slow_connection"); return; }
    this.upstream.send(JSON.stringify(sanitized));
  }

  private sendClient(frame: string): void {
    if (!this.usable() || this.client.readyState !== WebSocket.OPEN) return;
    if (this.client.bufferedAmount > 256 * 1024) { void this.stop("slow_connection"); return; }
    this.client.send(frame);
  }
}
