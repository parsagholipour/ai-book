import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  email_verified: z.literal(true),
  name: z.string().optional()
});

export type GoogleIdentity = { subject: string; email: string; displayName?: string };
export type GoogleIdentityVerifier = (idToken: string) => Promise<GoogleIdentity>;

/** The Web OAuth client ID is the audience requested by the native app. */
export function createGoogleIdentityVerifier(
  clientId = process.env.GOOGLE_SIGN_IN_CLIENT_ID?.trim()
): GoogleIdentityVerifier | null {
  if (!clientId) return null;
  const client = new OAuth2Client({ transporterOptions: { timeout: 10_000 } });
  return async (idToken) => {
    // Verifies Google's signature, issuer, expiry and our audience. Never use
    // a decoded JWT, client-supplied email or tokeninfo endpoint as identity.
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const identity = identitySchema.parse(ticket.getPayload());
    const displayName = identity.name?.trim().slice(0, 120);
    return {
      subject: identity.sub,
      email: identity.email,
      ...(displayName ? { displayName } : {})
    };
  };
}
