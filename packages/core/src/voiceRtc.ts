import { createHmac } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "./config.js";

export type VoiceRtcIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
};

export type VoiceRtcConfigResponse = {
  iceServers: VoiceRtcIceServer[];
  issuedAt: string;
  ttlSeconds: number;
  relayConfigured: boolean;
};

type VoiceRtcFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};

export type VoiceRtcFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<VoiceRtcFetchResponse>;

const RTC_URL_PATTERN = /^(?:stun|stuns|turn|turns):[^,\s]+$/i;
const RTC_ALTERNATE_PORT_53_PATTERN = /^(?:stun|stuns|turn|turns):[^,\s:]+:53(?:[/?#]|$)/i;
const cloudflareIceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
  credentialType: z.literal("password").optional()
});
const cloudflareTurnCredentialsSchema = z.object({
  iceServers: z.array(cloudflareIceServerSchema).min(1)
});

const defaultFetch: VoiceRtcFetch = (url, init) => fetch(url, init);

export async function resolveVoiceRtcConfig(
  config: AppConfig,
  issuedAt = new Date(),
  fetchImpl: VoiceRtcFetch = defaultFetch
): Promise<VoiceRtcConfigResponse> {
  const cloudflareIceServers = await fetchCloudflareTurnIceServers(config, fetchImpl);
  if (cloudflareIceServers) {
    return {
      iceServers: cloudflareIceServers,
      issuedAt: issuedAt.toISOString(),
      ttlSeconds: config.VOICE_RTC_TURN_TTL_SECONDS,
      relayConfigured: cloudflareIceServers.some(hasTurnCredentials)
    };
  }

  return buildVoiceRtcConfig(config, issuedAt);
}

export function buildVoiceRtcConfig(config: AppConfig, issuedAt = new Date()): VoiceRtcConfigResponse {
  const stunUrls = parseRtcUrls(config.VOICE_RTC_STUN_URLS, "VOICE_RTC_STUN_URLS");
  const turnUrls = parseRtcUrls(config.VOICE_RTC_TURN_URLS ?? "", "VOICE_RTC_TURN_URLS");
  const iceServers: VoiceRtcIceServer[] = [];

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  const turnServer = buildTurnServer(config, turnUrls, issuedAt);
  if (turnServer) {
    iceServers.push(turnServer);
  }

  return {
    iceServers,
    issuedAt: issuedAt.toISOString(),
    ttlSeconds: config.VOICE_RTC_TURN_TTL_SECONDS,
    relayConfigured: Boolean(turnServer)
  };
}

function buildTurnServer(
  config: AppConfig,
  turnUrls: string[],
  issuedAt: Date
): VoiceRtcIceServer | null {
  if (turnUrls.length === 0) {
    return null;
  }

  const sharedSecret = config.VOICE_RTC_TURN_SHARED_SECRET?.trim();
  if (sharedSecret) {
    const expiresAtSeconds = Math.floor(issuedAt.getTime() / 1000) + config.VOICE_RTC_TURN_TTL_SECONDS;
    const username = `${expiresAtSeconds}:voice`;
    return {
      urls: turnUrls,
      username,
      credential: createHmac("sha1", sharedSecret).update(username).digest("base64"),
      credentialType: "password"
    };
  }

  const username = config.VOICE_RTC_TURN_USERNAME?.trim();
  const credential = config.VOICE_RTC_TURN_CREDENTIAL?.trim();
  if (username && credential) {
    return {
      urls: turnUrls,
      username,
      credential,
      credentialType: "password"
    };
  }

  return null;
}

async function fetchCloudflareTurnIceServers(
  config: AppConfig,
  fetchImpl: VoiceRtcFetch
): Promise<VoiceRtcIceServer[] | null> {
  const turnToken = config.CLOUDFLARE_TURN_TOKEN?.trim();
  const apiToken = config.CLOUDFLARE_API_TOKEN?.trim();

  if (!turnToken && !apiToken) {
    return null;
  }
  if (!turnToken || !apiToken) {
    throw new Error("Both CLOUDFLARE_TURN_TOKEN and CLOUDFLARE_API_TOKEN are required for Cloudflare TURN");
  }

  const response = await fetchImpl(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
      turnToken
    )}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl: config.VOICE_RTC_TURN_TTL_SECONDS })
    }
  );
  const body = await response.text();

  if (!response.ok) {
    const details = body.trim() || response.statusText;
    throw new Error(`Cloudflare TURN credential generation failed (${response.status}): ${details}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Cloudflare TURN credential generation returned invalid JSON");
  }

  const parsed = cloudflareTurnCredentialsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Cloudflare TURN credential response did not include valid ICE servers");
  }

  const iceServers = normalizeCloudflareIceServers(parsed.data.iceServers);
  if (!iceServers.some(hasTurnCredentials)) {
    throw new Error("Cloudflare TURN credential response did not include TURN relay credentials");
  }

  return iceServers;
}

function normalizeCloudflareIceServers(
  iceServers: z.infer<typeof cloudflareIceServerSchema>[]
): VoiceRtcIceServer[] {
  return iceServers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => {
      validateRtcUrl(url, "Cloudflare TURN credential response");
      return !RTC_ALTERNATE_PORT_53_PATTERN.test(url);
    });

    if (urls.length === 0) {
      return [];
    }

    const normalized: VoiceRtcIceServer = { urls };
    if (server.username && server.credential) {
      normalized.username = server.username;
      normalized.credential = server.credential;
      normalized.credentialType = "password";
    }
    return [normalized];
  });
}

function parseRtcUrls(value: string, envName: string): string[] {
  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  urls.forEach((url) => validateRtcUrl(url, envName));
  return urls;
}

function validateRtcUrl(url: string, envName: string): void {
  if (!RTC_URL_PATTERN.test(url)) {
    throw new Error(`${envName} contains an invalid RTC URL: ${url}`);
  }
}

function hasTurnCredentials(server: VoiceRtcIceServer): boolean {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some((url) => /^turns?:/i.test(url)) && Boolean(server.username && server.credential);
}
