import { expect, it } from "vitest";
import { z } from "zod";
import { reviewSourceClaims } from "./sourceClaimReview.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { dossierExcerptSchema } from "../schemas/episodes.js";

const quote = "Rivest, Shamir and Adleman are listed alphabetically.";
const excerpt = dossierExcerptSchema.parse({ id: "rsa", chapterIndex: 1, documentTitle: "RSA paper", documentUrl: "https://example.org/rsa", text: "The authors are Rivest, Shamir and Adleman.", provenanceVerified: true });
const inventory = { complete: true, claims: [{ quote, searchQuery: "RSA original paper author order" }] };
const verdict = (status: string, support = "The authors are Rivest, Shamir and Adleman.") => ({ claims: [{ id: "c1", status, reason: "This order is not alphabetical.", support: [{ excerptId: "rsa", quote: support }] }] });

it("reviews technical and historical claims without case packets and records the supporting passage", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory, verdict("contradicted")]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.issues[0]).toContain(quote);
  expect(result.coverage).toMatchObject({ status: "reviewed", checked: 1, contradicted: 1, supported: 0 });
  expect(result.claims[0]?.support[0]?.excerptId).toBe("rsa");
  // The live Gemini API rejects a 100-element bound on the nested verdict shape.
  expect(z.toJSONSchema(calls[1]!.schema).properties?.claims).not.toHaveProperty("maxItems");
});

it("does not accept a generated summary or fabricated citation as source support", async () => {
  const { model } = scriptedDevelopmentModel([inventory, verdict("supported", "This invented sentence is not in the paper.")]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.coverage.supported).toBe(0);
  expect(result.claims[0]?.status).toBe("insufficient_evidence");
  expect(result.issues).toHaveLength(1);
});

it("identifies unsupported claims even with an empty dossier", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [], textModel: model });
  expect(calls).toHaveLength(1);
  expect(result.coverage).toMatchObject({ checked: 1, unsupported: 1, supported: 0 });
  expect(result.claims[0]?.searchQuery).toContain("RSA");
});

it("does not count omitted claim verdicts as verified", async () => {
  const { model } = scriptedDevelopmentModel([inventory, { claims: [] }]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.coverage.status).toBe("incomplete");
  expect(result.coverage.supported).toBe(0);
  expect(result.issues).toHaveLength(1);
});

it("records verifier outages rather than passing an unreviewed chapter", async () => {
  const { model } = scriptedDevelopmentModel([new Error("provider unavailable")]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.coverage.status).toBe("unavailable");
});

it("propagates cancellation", async () => {
  const error = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
  const { model } = scriptedDevelopmentModel([error]);
  await expect(reviewSourceClaims({ markdown: quote, excerpts: [], textModel: model })).rejects.toBe(error);
});
