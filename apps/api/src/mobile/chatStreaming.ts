import type { FastifyReply, FastifyRequest } from "fastify";

export type ChatTextObserver = ((text: string) => void) | undefined;
const streams = new WeakMap<FastifyReply, ChatStream>();

/** Opt-in transport around the existing turn, including its persistence and billing. */
export function withChatStreaming(
  handler: (request: FastifyRequest, reply: FastifyReply, onAssistantText: ChatTextObserver) => Promise<unknown>
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!request.headers.accept?.includes("text/event-stream")) return handler(request, reply, undefined);
    const stream = new ChatStream(reply);
    streams.set(reply, stream);
    try {
      const result = await handler(request, reply, (text) => stream.text(text));
      if (!stream.started) return result;
      if (!stream.closed) stream.end("done", String(reply.serialize(result)));
      return reply;
    } catch (error) {
      if (!stream.started) throw error;
      request.log.error({ err: error }, "Chat stream failed");
      stream.end("error", JSON.stringify({ statusCode: 500, error: {
        code: "CHAT_FAILED", message: "The reply could not be completed. Please try again."
      } }));
      return reply;
    } finally {
      stream.dispose();
      streams.delete(reply);
    }
  };
}

/** Errors after headers have gone out retain their normal code and details in an event. */
export function sendChatPayload(reply: FastifyReply, statusCode: number, payload: unknown): FastifyReply {
  reply.code(statusCode);
  const stream = streams.get(reply);
  if (!stream?.started) return reply.send(payload);
  stream.end(statusCode >= 400 ? "error" : "done", JSON.stringify({
    ...(payload as Record<string, unknown>), ...(statusCode >= 400 ? { statusCode } : {})
  }));
  return reply;
}

class ChatStream {
  started = false;
  closed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly onClose = () => this.dispose();
  constructor(private readonly reply: FastifyReply) { reply.raw.once("close", this.onClose); }

  text(text: string): void {
    if (this.closed) return;
    if (!this.started) {
      this.started = true;
      this.reply.hijack();
      const headers: import("node:http").OutgoingHttpHeaders = Object.fromEntries(
        Object.entries(this.reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined)
      );
      delete headers["content-length"];
      this.reply.raw.writeHead(200, { ...headers,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"
      });
      this.heartbeat = setInterval(() => this.write(": heartbeat\n\n"), 10_000);
      this.heartbeat.unref();
    }
    this.write(`event: text\ndata: ${JSON.stringify({ text })}\n\n`);
  }

  end(event: string, json: string): void {
    if (this.closed) return;
    this.write(`event: ${event}\ndata: ${json}\n\n`);
    this.reply.raw.end();
    this.dispose();
  }

  private write(data: string): void {
    if (this.closed) return;
    // A disconnected or slow reader must not retain unbounded output or stop
    // the accepted turn from being saved for request-id replay.
    if (this.reply.raw.destroyed || this.reply.raw.writableLength > 256 * 1024) {
      this.reply.raw.destroy();
      this.dispose();
      return;
    }
    this.reply.raw.write(data);
  }

  dispose(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reply.raw.off("close", this.onClose);
  }
}
