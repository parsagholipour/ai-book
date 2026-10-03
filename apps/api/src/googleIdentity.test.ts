import { generateKeyPairSync, sign } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { CertificateFormat } from "google-auth-library/build/src/auth/oauth2client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleIdentityVerifier } from "./googleIdentity.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const audience = "test-client.apps.googleusercontent.com";
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function token(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: audience, sub: "google-user", iat: now - 30,
    exp: now + 3600, email: "Reader@Example.com", email_verified: true, name: " Reader ", ...overrides
  })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
}

function verifier() {
  // Only replace Google's network certificate lookup. Actual JWT signature,
  // issuer, audience and expiry verification still runs in Google's library.
  vi.spyOn(OAuth2Client.prototype, "getFederatedSignonCertsAsync").mockResolvedValue({
    certs: { test: publicKey }, format: CertificateFormat.PEM
  });
  return createGoogleIdentityVerifier(audience)!;
}

describe("Google ID token verification", () => {
  afterEach(() => vi.restoreAllMocks());
  it("is unavailable without an explicitly configured audience", () => {
    expect(createGoogleIdentityVerifier("")).toBeNull();
  });
  it("verifies the signed token and normalizes only verified profile claims", async () => {
    await expect(verifier()(token())).resolves.toEqual({
      subject: "google-user", email: "reader@example.com", displayName: "Reader"
    });
  });
  it.each([
    { aud: "another-app.apps.googleusercontent.com" },
    { iss: "https://attacker.example" },
    { iat: 1, exp: 2 },
    { email_verified: false },
    { email_verified: undefined },
    { sub: "" },
    { email: "invalid" }
  ])("rejects invalid claims %j", async (claims) => {
    await expect(verifier()(token(claims))).rejects.toThrow();
  });
  it("rejects a token signed by a different key", async () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(verifier()(token({}, attacker.privateKey))).rejects.toThrow();
  });
});
