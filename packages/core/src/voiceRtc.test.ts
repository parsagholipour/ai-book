import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { buildVoiceRtcConfig, resolveVoiceRtcConfig } from "./voiceRtc.js";

describe("voice RTC config", () => {
  it("returns default STUN servers without relay credentials", () => {
    const config = loadConfig({});
    const rtcConfig = buildVoiceRtcConfig(config, new Date("2026-06-09T10:00:00.000Z"));

    expect(rtcConfig).toEqual({
      iceServers: [
        {
          urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"]
        }
      ],
      issuedAt: "2026-06-09T10:00:00.000Z",
      ttlSeconds: 3600,
      relayConfigured: false
    });
  });

  it("adds static TURN credentials for simple deployments", () => {
    const config = loadConfig({
      VOICE_RTC_TURN_URLS: "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349",
      VOICE_RTC_TURN_USERNAME: "static-user",
      VOICE_RTC_TURN_CREDENTIAL: "static-pass"
    });
    const rtcConfig = buildVoiceRtcConfig(config, new Date("2026-06-09T10:00:00.000Z"));

    expect(rtcConfig.relayConfigured).toBe(true);
    expect(rtcConfig.iceServers.at(-1)).toEqual({
      urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
      username: "static-user",
      credential: "static-pass",
      credentialType: "password"
    });
  });

  it("prefers ephemeral TURN credentials from a shared secret", () => {
    const issuedAt = new Date("2026-06-09T10:00:00.000Z");
    const config = loadConfig({
      VOICE_RTC_TURN_URLS: "turn:turn.example.com:3478",
      VOICE_RTC_TURN_USERNAME: "static-user",
      VOICE_RTC_TURN_CREDENTIAL: "static-pass",
      VOICE_RTC_TURN_SHARED_SECRET: "shared-secret",
      VOICE_RTC_TURN_TTL_SECONDS: "120"
    });
    const rtcConfig = buildVoiceRtcConfig(config, issuedAt);
    const username = `${Math.floor(issuedAt.getTime() / 1000) + 120}:voice`;

    expect(rtcConfig.ttlSeconds).toBe(120);
    expect(rtcConfig.iceServers.at(-1)).toEqual({
      urls: ["turn:turn.example.com:3478"],
      username,
      credential: createHmac("sha1", "shared-secret").update(username).digest("base64"),
      credentialType: "password"
    });
  });

  it("uses Cloudflare TURN generated ICE servers when Cloudflare credentials are configured", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 201,
      statusText: "Created",
      text: async () =>
        JSON.stringify({
          iceServers: [
            {
              urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]
            },
            {
              urls: [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turns:turn.cloudflare.com:443?transport=tcp"
              ],
              username: "cloudflare-user",
              credential: "cloudflare-pass"
            }
          ]
        })
    }));
    const config = loadConfig({
      CLOUDFLARE_TURN_TOKEN: "turn-key-id",
      CLOUDFLARE_API_TOKEN: "turn-key-api-token",
      VOICE_RTC_TURN_TTL_SECONDS: "120"
    });

    const rtcConfig = await resolveVoiceRtcConfig(config, new Date("2026-06-09T10:00:00.000Z"), fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate-ice-servers",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer turn-key-api-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ttl: 120 })
      }
    );
    expect(rtcConfig).toEqual({
      iceServers: [
        {
          urls: ["stun:stun.cloudflare.com:3478"]
        },
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
          username: "cloudflare-user",
          credential: "cloudflare-pass",
          credentialType: "password"
        }
      ],
      issuedAt: "2026-06-09T10:00:00.000Z",
      ttlSeconds: 120,
      relayConfigured: true
    });
  });

  it("requires both Cloudflare TURN env vars when either is configured", async () => {
    const config = loadConfig({
      CLOUDFLARE_TURN_TOKEN: "turn-key-id"
    });

    await expect(resolveVoiceRtcConfig(config)).rejects.toThrow(
      "Both CLOUDFLARE_TURN_TOKEN and CLOUDFLARE_API_TOKEN are required"
    );
  });

  it("rejects malformed RTC URLs", () => {
    const config = loadConfig({
      VOICE_RTC_STUN_URLS: "https://not-a-stun-server.example.com"
    });

    expect(() => buildVoiceRtcConfig(config)).toThrow("VOICE_RTC_STUN_URLS contains an invalid RTC URL");
  });
});
