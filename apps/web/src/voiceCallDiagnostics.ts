import type { VoiceCallEventPayload } from "./api.js";

export type VoiceConnectionDiagnostics = Omit<VoiceCallEventPayload, "clientCallId" | "phase" | "attempt" | "elapsedMs" | "metadata">;

export function createVoiceCallId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function retryDelayWithJitter(baseMs: number, random = Math.random): number {
  const jitter = Math.round(baseMs * 0.3 * (random() - 0.5));
  return Math.max(0, baseMs + jitter);
}

export async function collectVoiceConnectionDiagnostics(
  peerConnection: RTCPeerConnection
): Promise<VoiceConnectionDiagnostics> {
  const diagnostics: VoiceConnectionDiagnostics = {
    connectionState: peerConnection.connectionState,
    iceConnectionState: peerConnection.iceConnectionState,
    iceGatheringState: peerConnection.iceGatheringState
  };

  try {
    const stats = await peerConnection.getStats();
    const selectedPair = findSelectedCandidatePair(stats);
    if (selectedPair) {
      const localCandidateId = statString(selectedPair, "localCandidateId");
      const localCandidate = localCandidateId
        ? stats.get(localCandidateId)
        : undefined;
      const candidateType = statString(localCandidate, "candidateType");
      const protocol = statString(localCandidate, "protocol");
      const roundTripSeconds = statNumber(selectedPair, "currentRoundTripTime");
      if (candidateType) {
        diagnostics.candidatePairType = candidateType;
      }
      if (protocol) {
        diagnostics.candidateProtocol = protocol;
      }
      if (roundTripSeconds !== undefined) {
        diagnostics.currentRoundTripTimeMs = Math.round(roundTripSeconds * 1000);
      }
    }

    const inboundAudio = [...stats.values()].find(
      (report) => report.type === "inbound-rtp" && statString(report, "kind") === "audio"
    );
    const packetsLost = statNumber(inboundAudio, "packetsLost");
    const jitterSeconds = statNumber(inboundAudio, "jitter");
    if (packetsLost !== undefined) {
      diagnostics.packetsLost = Math.max(0, Math.round(packetsLost));
    }
    if (jitterSeconds !== undefined) {
      diagnostics.jitterMs = Math.round(jitterSeconds * 1000);
    }
  } catch {
    // Stats collection is best-effort and should never disturb the call.
  }

  return diagnostics;
}

export function buildVoiceCallEventPayload(
  clientCallId: string,
  phase: VoiceCallEventPayload["phase"],
  options: {
    attempt?: number;
    elapsedMs?: number;
    diagnostics?: VoiceConnectionDiagnostics;
    error?: string;
    metadata?: Record<string, string | number | boolean | null>;
  } = {}
): VoiceCallEventPayload {
  const payload: VoiceCallEventPayload = {
    clientCallId,
    phase
  };
  if (options.attempt !== undefined) {
    payload.attempt = options.attempt;
  }
  if (options.elapsedMs !== undefined) {
    payload.elapsedMs = options.elapsedMs;
  }
  if (options.diagnostics) {
    Object.assign(payload, withoutUndefined(options.diagnostics));
  }
  if (options.error !== undefined) {
    payload.error = options.error;
  }
  if (options.metadata !== undefined) {
    payload.metadata = options.metadata;
  }
  return payload;
}

function findSelectedCandidatePair(stats: RTCStatsReport): RTCStats | undefined {
  return [...stats.values()].find(
    (report) =>
      report.type === "candidate-pair" &&
      (statBoolean(report, "selected") ||
        (statString(report, "state") === "succeeded" && statBoolean(report, "nominated")))
  );
}

function statString(report: unknown, key: string): string | undefined {
  const value = statValue(report, key);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function statNumber(report: unknown, key: string): number | undefined {
  const value = statValue(report, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function statBoolean(report: unknown, key: string): boolean {
  return statValue(report, key) === true;
}

function statValue(report: unknown, key: string): unknown {
  return report && typeof report === "object" ? (report as Record<string, unknown>)[key] : undefined;
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
