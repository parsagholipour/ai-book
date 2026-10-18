import Fastify from "fastify";
import cors from "@fastify/cors";
import { describe, expect, it } from "vitest";
import { corsOptionsFor } from "./cors.js";

describe("production browser origins", () => {
  it("allows the Flutter origin and exposes export identity without admitting other origins", async () => {
    const app = Fastify();
    await app.register(cors, corsOptionsFor({ NODE_ENV: "production", PUBLIC_API_URL: "https://tomeza.ravanix.app" }));
    app.get("/asset", async (_request, reply) => reply.header("X-Export-Content-Revision", "7").send("book"));
    try {
      const allowed = await app.inject({ url: "/asset", headers: { origin: "https://app.tomeza.ravanix.app" } });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.tomeza.ravanix.app");
      expect(allowed.headers["access-control-expose-headers"]).toContain("X-Export-Content-Revision");
      const denied = await app.inject({ url: "/asset", headers: { origin: "https://evil.example" } });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
      const preflight = await app.inject({ method: "OPTIONS", url: "/asset", headers: {
        origin: "https://app.tomeza.ravanix.app", "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type"
      } });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    } finally {
      await app.close();
    }
  });
});
