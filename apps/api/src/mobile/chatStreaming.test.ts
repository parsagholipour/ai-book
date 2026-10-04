import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { sendChatPayload, withChatStreaming } from "./chatStreaming.js";

describe("chat event transport", () => {
  it("delivers text before persistence, preserves headers and serializes the saved reply", async () => {
    const app = Fastify();
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    app.post("/chat", { schema: { response: { 200: { type: "object", properties: { reply: { type: "string" } } } } } },
      withChatStreaming(async (_request, reply, onText) => {
        reply.header("Access-Control-Allow-Origin", "https://app.example");
        onText?.("Hel");
        await gate;
        return { reply: "Hello, saved", privateField: "must be stripped" };
      }));
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${address}/chat`, { method: "POST", headers: { accept: "text/event-stream" } });
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: text\ndata: {"text":"Hel"}');
      expect(first).not.toContain("done");
      complete();
      let rest = "";
      while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
      expect(rest).toContain('event: done\ndata: {"reply":"Hello, saved"}');
      expect(rest).not.toContain("privateField");
    } finally {
      complete();
      await reader?.cancel();
      await app.close();
    }
  });

  it("keeps JSON clients and pre-stream errors on the ordinary HTTP path", async () => {
    const app = Fastify();
    app.post("/chat", withChatStreaming(async (_request, _reply, onText) => { onText?.("Hi"); return { reply: "Hi" }; }));
    app.post("/denied", withChatStreaming(async (_request, reply) => sendChatPayload(reply, 409, { error: { code: "SESSION_CONFLICT" } })));
    expect((await app.inject({ method: "POST", url: "/chat" })).json()).toEqual({ reply: "Hi" });
    const error = await app.inject({ method: "POST", url: "/denied", headers: { accept: "text/event-stream" } });
    expect(error.statusCode).toBe(409);
    expect(error.json().error.code).toBe("SESSION_CONFLICT");
    await app.close();
  });

  it("finishes accepted work after the reader disconnects", async () => {
    const app = Fastify();
    let release!: () => void;
    let persisted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saved = new Promise<void>((resolve) => { persisted = resolve; });
    app.post("/chat", withChatStreaming(async (_request, _reply, onText) => {
      onText?.("Partial");
      await gate;
      onText?.("Complete");
      persisted();
      return { reply: "Complete" };
    }));
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/chat`, { method: "POST", headers: { accept: "text/event-stream" } });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      release();
      await saved;
    } finally {
      release();
      await app.close();
    }
  });

  it("sends actionable errors after streaming starts and ignores late timed-out callbacks", async () => {
    const app = Fastify();
    let late: ((text: string) => void) | undefined;
    app.post("/chat", withChatStreaming(async (_request, reply, onText) => {
      late = onText;
      onText?.("Uncommitted");
      return sendChatPayload(reply, 409, { error: { code: "SESSION_CONFLICT", message: "Reload" } });
    }));
    const response = await app.inject({ method: "POST", url: "/chat", headers: { accept: "text/event-stream" } });
    expect(response.body).toContain('event: error\ndata: {"error":{"code":"SESSION_CONFLICT","message":"Reload"},"statusCode":409}');
    expect(response.body).not.toContain("event: done");
    expect(() => late?.("Too late")).not.toThrow();
    await app.close();
  });
});
