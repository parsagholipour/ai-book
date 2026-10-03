import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
import { VoiceRelayConnection, stopLocalVoiceRelay, type VoiceRelayClaim, type VoiceRelaySocket } from "./voiceRelayConnection.js";
import { VoiceRelayError } from "@book-maker/db/billing";

class Socket extends EventEmitter implements VoiceRelaySocket {
  readyState: 0 | 1 | 2 | 3 = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  respondsToPing = true;
  send(data: unknown) { this.sent.push(String(data)); }
  close(_code?: number, reason?: string | Buffer) {
    if (reason && Buffer.byteLength(reason) > 123) throw new Error("WebSocket close reason too long");
    this.terminate();
  }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  ping() { if (this.respondsToPing) this.emit("pong"); }
  receive(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame)), false); }
}
const meter = { callId: "call-1", elapsedSeconds: 0, secondsRemaining: 180, chargedCredits: 0, endingSoon: false, endingReason: null };
let connections: VoiceRelayConnection[];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T12:00:00Z")); connections = []; });
afterEach(async () => { await Promise.all(connections.map((connection) => connection.stop("test_end"))); vi.clearAllTimers(); vi.useRealTimers(); });

function setup() {
  const client = new Socket();
  const provider = new Socket();
  const claim: VoiceRelayClaim = {
    lease: { callId: "call-1", userId: "user-a", leaseId: "owner-1" },
    session: { token: "secret-provider-token", model: "funded-model", expiresAt: new Date(Date.now() + 1800_000).toISOString() },
    deadline: new Date(Date.now() + 15_000)
  };
  const authorize = vi.fn(async () => ({ deadline: new Date(Date.now() + 15_000), meter }));
  const finish = vi.fn(async () => {
    // The security ordering: no refund while either side can still forward.
    expect(provider.readyState).toBe(WebSocket.CLOSED);
    expect(client.readyState).toBe(WebSocket.CLOSED);
    return meter;
  });
  const openProvider = vi.fn(() => provider);
  const warn = vi.fn();
  const connection = new VoiceRelayConnection(client, claim, { authorize, finish, openProvider, warn });
  connections.push(connection);
  provider.emit("open");
  async function ready() {
    provider.receive({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);
  }
  return { client, provider, connection, claim, authorize, finish, ready, openProvider, warn };
}
const audio = (bytes = 3200) => ({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: Buffer.alloc(bytes).toString("base64") } } });

describe("server-owned voice connection", () => {
  it("renews funded access for ten minutes with no HTTP heartbeat", async () => {
    const relay = setup(); await relay.ready();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(relay.authorize).toHaveBeenCalledTimes(121);
    expect(relay.finish).not.toHaveBeenCalled();
    relay.client.receive(audio());
    expect(JSON.parse(relay.provider.sent.at(-1)!)).toEqual(audio());
  });

  it("closes upstream before settlement when funded time expires", async () => {
    const relay = setup();
    const fundedUntil = Date.now() + 180_000;
    relay.authorize.mockImplementation(async () => ({ deadline: new Date(Math.min(fundedUntil, Date.now() + 15_000)), meter }));
    await relay.ready();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(relay.finish).toHaveBeenCalledExactlyOnceWith(relay.claim.lease, new Date(fundedUntil), "connection_expired");
    expect(relay.warn).not.toHaveBeenCalled();
    const sent = relay.provider.sent.length;
    relay.client.receive(audio());
    expect(relay.provider.sent).toHaveLength(sent);
  });

  it("fails closed on the last authorized deadline if the database stops answering", async () => {
    const relay = setup(); await relay.ready();
    relay.authorize.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("rejects queued frames after expiry even before an overdue timer can run", async () => {
    const relay = setup(); await relay.ready();
    vi.setSystemTime(Date.now() + 20_000);
    relay.client.receive(audio());
    expect(relay.provider.sent).toHaveLength(1); // Only the server setup.
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("stops immediately on device disconnect or local HTTP end", async () => {
    const relay = setup(); await relay.ready();
    await stopLocalVoiceRelay("call-1", "ended");
    relay.client.emit("close");
    expect(relay.finish).toHaveBeenCalledOnce();
    expect(relay.warn).not.toHaveBeenCalled();
  });

  it("waits for settlement on reentrant end requests and accepts Unicode HTTP reasons", async () => {
    const relay = setup(); await relay.ready();
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    relay.finish.mockImplementation(async () => { await gate; return meter; });
    const first = relay.connection.stop("😃".repeat(30));
    let finished = false;
    const second = stopLocalVoiceRelay("call-1").then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(relay.provider.readyState).toBe(WebSocket.CLOSED);
    settle();
    await Promise.all([first, second]);
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("stops when another instance has requested an end or disabled the user", async () => {
    const relay = setup(); await relay.ready();
    relay.authorize.mockRejectedValue(new VoiceRelayError("VOICE_CALL_CLOSED"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("detects a dead device independently of application heartbeats", async () => {
    const relay = setup(); await relay.ready();
    relay.client.respondsToPing = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("keeps credentials, session handles and caller configuration out of the forwarded wire", async () => {
    const relay = setup(); await relay.ready();
    relay.client.receive({ setup: { model: "expensive-model", systemInstruction: "override", tools: [{}] } });
    relay.provider.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "private-handle" } });
    relay.provider.receive({ serverContent: { outputTranscription: { text: "hello" } } });
    expect(relay.provider.sent).toHaveLength(1);
    expect(relay.provider.sent[0]).toContain("funded-model");
    expect(relay.client.sent.join()).not.toMatch(/secret-provider-token|private-handle/);
    expect(relay.client.sent.at(-1)).toContain("hello");
  });

  it.each([
    { clientContent: { turns: [{ parts: [{ text: "unbounded prompt" }] }] } },
    { realtimeInput: { video: { data: "AA==" } } },
    { realtimeInput: { audio: { mimeType: "audio/pcm;rate=48000", data: "AAAA" } } },
    { realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "not base64" } } }
  ])("rejects inputs outside the funded PCM audio protocol: %j", async (frame) => {
    const relay = setup(); await relay.ready();
    relay.client.receive(frame);
    expect(relay.provider.sent).toHaveLength(1);
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("limits audio to real-time sample throughput with a small jitter allowance", async () => {
    const relay = setup(); await relay.ready();
    relay.client.receive(audio(32_000));
    relay.client.receive(audio(32_000));
    relay.client.receive(audio(32_000));
    expect(relay.provider.sent).toHaveLength(3); // setup + two-second burst.
    expect(relay.finish).toHaveBeenCalledOnce();
  });

  it("resumes provider go-away privately without handing the device another ticket", async () => {
    const relay = setup(); await relay.ready();
    const next = new Socket();
    relay.openProvider.mockReturnValueOnce(next);
    relay.provider.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "private-handle" } });
    relay.provider.receive({ goAway: { timeLeft: "10s" } });
    next.emit("open"); next.receive({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(next.sent[0]).toContain("private-handle");
    expect(relay.client.sent.join()).not.toContain("private-handle");
    expect(relay.finish).not.toHaveBeenCalled();
    await relay.connection.stop("ended");
    expect(next.readyState).toBe(WebSocket.CLOSED);
  });
});
