import type { FastifyInstance } from "fastify";
import { claimVoiceRelayCall, VoiceRelayError } from "@book-maker/db/billing";
import { hashToken } from "../../mobileAuth.js";
import { sendMobileError } from "../httpErrors.js";
import { VoiceRelayConnection, type VoiceRelayClaim } from "../voiceRelayConnection.js";

declare module "fastify" {
  interface FastifyContextConfig { voiceRelay?: boolean }
  interface FastifyRequest { voiceRelayClaim?: VoiceRelayClaim }
}

export async function registerMobileVoiceRelayRoutes(app: FastifyInstance): Promise<void> {
  const connections = new Set<VoiceRelayConnection>();
  app.addHook("onClose", async () => {
    await Promise.all([...connections].map((connection) => connection.stop("server_shutdown")));
  });
  app.get<{ Params: { callId: string } }>("/api/mobile/voice/calls/:callId/socket", {
    websocket: true, config: { voiceRelay: true },
    preValidation: async (request, reply) => {
      if (request.headers.upgrade?.toLowerCase() !== "websocket") return sendMobileError(reply, 426, "VOICE_RELAY_REQUIRED", "Open a voice connection.");
      const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim()) ?? [];
      const ticket = protocols.find((part) => /^ticket\.[A-Za-z0-9_-]{43}$/.test(part))?.slice(7);
      if (!protocols.includes("voice.v1") || !ticket) return sendMobileError(reply, 401, "AUTH_REQUIRED", "Start a new call.");
      try { request.voiceRelayClaim = await claimVoiceRelayCall(request.params.callId, hashToken(ticket)); }
      catch (error) {
        if (error instanceof VoiceRelayError) return sendMobileError(reply, 401, error.code, error.message);
        throw error;
      }
    }
  }, (socket, request) => {
    const claim = request.voiceRelayClaim;
    if (!claim) { socket.close(4001, "Call ended"); return; }
    const connection = new VoiceRelayConnection(socket, claim, {
      warn: (error) => request.log.warn({ err: error, callId: claim.lease.callId }, "Voice relay billing failed")
    });
    connections.add(connection);
    socket.on("close", () => {
      void connection.stop("disconnected").finally(() => connections.delete(connection));
    });
  });
}
