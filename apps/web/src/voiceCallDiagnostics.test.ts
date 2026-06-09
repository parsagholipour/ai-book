import { describe, expect, it } from "vitest";
import {
  buildVoiceCallEventPayload,
  collectVoiceConnectionDiagnostics,
  retryDelayWithJitter
} from "./voiceCallDiagnostics.js";

describe("voice call diagnostics", () => {
  it("adds bounded jitter to retry delays", () => {
    expect(retryDelayWithJitter(1000, () => 0)).toBe(850);
    expect(retryDelayWithJitter(1000, () => 0.5)).toBe(1000);
    expect(retryDelayWithJitter(1000, () => 1)).toBe(1150);
  });

  it("omits undefined event fields", () => {
    expect(
      buildVoiceCallEventPayload("call-1", "connected", {
        attempt: 1,
        diagnostics: {
          connectionState: "connected"
        }
      })
    ).toEqual({
      clientCallId: "call-1",
      phase: "connected",
      attempt: 1,
      connectionState: "connected"
    });
  });

  it("collects selected candidate and audio stats", async () => {
    const reports = new Map<string, Record<string, unknown>>([
      [
        "pair-1",
        {
          id: "pair-1",
          type: "candidate-pair",
          selected: true,
          localCandidateId: "local-1",
          currentRoundTripTime: 0.083
        }
      ],
      [
        "local-1",
        {
          id: "local-1",
          type: "local-candidate",
          candidateType: "relay",
          protocol: "udp"
        }
      ],
      [
        "audio-1",
        {
          id: "audio-1",
          type: "inbound-rtp",
          kind: "audio",
          packetsLost: 2,
          jitter: 0.011
        }
      ]
    ]);
    const peerConnection = {
      connectionState: "connected",
      iceConnectionState: "connected",
      iceGatheringState: "complete",
      getStats: async () => reports
    } as unknown as RTCPeerConnection;

    await expect(collectVoiceConnectionDiagnostics(peerConnection)).resolves.toEqual({
      connectionState: "connected",
      iceConnectionState: "connected",
      iceGatheringState: "complete",
      candidatePairType: "relay",
      candidateProtocol: "udp",
      currentRoundTripTimeMs: 83,
      packetsLost: 2,
      jitterMs: 11
    });
  });
});
