import { createSign } from "node:crypto";

/**
 * The OAuth half of a Google service account, shared by every Google API this
 * process calls with one: the Play Developer API (subscription verification)
 * and Firebase Cloud Messaging (push). Each caller names its own scope and
 * keeps its own token cache and errors; only the key handling lives here.
 */
export type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string | undefined;
  project_id?: string | undefined;
};

export const DEFAULT_GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** The key's fields this process uses, or null when it lacks the two it cannot work without. */
export function parseServiceAccountCredentials(raw: string): ServiceAccountCredentials | null {
  const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key) {
    return null;
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri,
    project_id: parsed.project_id
  };
}

/** The RS256 assertion exchanged at `tokenUri` for an access token carrying `scope`. */
export function signServiceAccountJwt(credentials: ServiceAccountCredentials, scope: string, tokenUri: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claim = base64UrlJson({
    iss: credentials.client_email,
    scope,
    aud: tokenUri,
    exp: nowSeconds + 3600,
    iat: nowSeconds
  });
  const unsigned = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
