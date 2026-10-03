import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "@book-maker/core";
import type WebSocket from "ws";
vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
const connected = vi.hoisted(() => vi.fn());
vi.mock("./voiceRelayConnection.js", () => ({
  VoiceRelayConnection: class {
    constructor(private socket: WebSocket, claim: unknown) { connected(claim); }
    async stop() { this.socket.terminate(); }
  }
}));
import { claimVoiceRelayCall, VoiceRelayError } from "@book-maker/db/billing";
import { registerMobileVoiceRelayRoutes } from "./routes/voiceRelay.js";
import { registerAuth } from "../auth.js";
import { hashToken } from "../mobileAuth.js";

let app: FastifyInstance;
const ticket = "a".repeat(43);
const path = "/api/mobile/voice/calls/call-1/socket";
const claim = {
  lease: { callId: "call-1", userId: "user-a", leaseId: "lease-1" },
  session: { token: "provider-secret", model: "model", expiresAt: "2026-10-04T12:30:00Z" },
  deadline: new Date()
};
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(claimVoiceRelayCall).mockResolvedValue(claim);
  app = Fastify();
  await app.register(websocket, { options: { handleProtocols: (protocols) => protocols.has("voice.v1") ? "voice.v1" : false } });
  await registerAuth(app, loadConfig({ WEB_PASSWORD: "test-operator-password" }));
  await registerMobileVoiceRelayRoutes(app);
  app.get("/api/mobile/private", async () => ({ secret: true }));
  await app.ready();
});
afterEach(async () => { await app.close(); });

it("authenticates the upgrade with a hashed call-scoped ticket, without a bearer cookie", async () => {
  const socket = await app.injectWS(path, { headers: { "sec-websocket-protocol": `voice.v1, ticket.${ticket}` } });
  expect(claimVoiceRelayCall).toHaveBeenCalledExactlyOnceWith("call-1", hashToken(ticket));
  expect(connected).toHaveBeenCalledExactlyOnceWith(claim);
  socket.terminate();
});

it.each([undefined, "voice.v1", "voice.v1, ticket.bad", `ticket.${ticket}`])("rejects malformed or missing tickets: %s", async (protocol) => {
  await expect(app.injectWS(path, { headers: protocol ? { "sec-websocket-protocol": protocol } : {} })).rejects.toThrow("401");
  expect(claimVoiceRelayCall).not.toHaveBeenCalled();
  expect(connected).not.toHaveBeenCalled();
});

it("rejects a replay before opening a provider connection", async () => {
  vi.mocked(claimVoiceRelayCall).mockRejectedValueOnce(new VoiceRelayError("VOICE_CALL_CLOSED"));
  await expect(app.injectWS(path, { headers: { "sec-websocket-protocol": `voice.v1, ticket.${ticket}` } })).rejects.toThrow("401");
  expect(connected).not.toHaveBeenCalled();
});

it("does not let an upgrade header bypass authentication on any other route", async () => {
  const response = await app.inject({ method: "GET", url: "/api/mobile/private", headers: { upgrade: "websocket" } });
  expect(response.statusCode).toBe(401);
  expect(connected).not.toHaveBeenCalled();
});
