/**
 * The open status event streams (`GET /api/mobile/projects/:id/status/events`)
 * of this API process, per account.
 *
 * Each stream re-reads the whole status — about nine queries, plus a HEAD per
 * export format on a settled book — on every tick, and nothing bounded how many
 * one account could hold: a client that never closed its sockets, or one
 * opening them on purpose, multiplied that work without limit (launch review,
 * 2026-10-13). An account keeps its newest `STATUS_STREAMS_PER_USER`; opening
 * one more *ends the oldest* rather than refusing the new one, because the app
 * legitimately opens a stream per screen and the screen the reader just opened
 * is the one they are looking at. An ended stream is not an error to the app:
 * `_watchProjectStatus` falls back to its three-second poll when the stream
 * ends while the book is still live.
 */

/** Streams one account may hold open in this process. */
export const STATUS_STREAMS_PER_USER = 3;

/**
 * How often a stream re-reads the status, how often it proves the socket is
 * alive, and how often it re-checks the session it was opened with. Mutable
 * only so the suites can run a stream in milliseconds.
 */
export const statusStreamTiming = {
  /** A status is sent only when it changed since the last one sent. */
  pollMs: 3_000,
  /** `: ping` comment lines; the app's SSE parser skips comments. */
  heartbeatMs: 15_000,
  /** A revoked session, a disabled account or an expired access token ends the stream. */
  sessionCheckMs: 60_000
};

export type StatusStreamHandle = {
  /** Ends the stream, telling the client why in an `error` event first. */
  end(code: string): void;
};

const openStreams = new Map<string, StatusStreamHandle[]>();

/**
 * Admits a stream for `userId`, ending that account's oldest streams past the
 * cap first. Returns the release the stream calls once, when it ends.
 */
export function admitStatusStream(userId: string, handle: StatusStreamHandle): () => void {
  const streams = openStreams.get(userId) ?? [];
  openStreams.set(userId, streams);
  while (streams.length >= STATUS_STREAMS_PER_USER) {
    // Taken off the list before it is ended, so its own release finds nothing.
    streams.shift()?.end("STATUS_STREAM_REPLACED");
  }
  streams.push(handle);
  return () => {
    const current = openStreams.get(userId);
    if (!current) return;
    const index = current.indexOf(handle);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) openStreams.delete(userId);
  };
}

export function openStatusStreamCount(userId: string): number {
  return openStreams.get(userId)?.length ?? 0;
}
