import { expect, it } from "vitest";
import { createSourceClaimReviewer } from "./sourceClaimReview.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { dossierExcerptSchema } from "../schemas/episodes.js";

const quote = "The original paper lists three authors.";
const inventory = { complete: true, claims: [{ quote, searchQuery: "original paper authors" }] };
const excerpt = dossierExcerptSchema.parse({ id: "paper", chapterIndex: 1, documentUrl: "https://example.org/paper", documentTitle: "Paper", text: quote, provenanceVerified: true });
const verdict = { claims: [{ id: "c1", status: "supported", reason: "The record lists them.", support: [{ excerptId: "paper", quote }] }] };

it("reuses an unchanged inventory when evidence arrives, and caches unchanged verification", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory, verdict]);
  const review = createSourceClaimReviewer(model);
  expect((await review({ markdown: quote, excerpts: [] })).coverage.unsupported).toBe(1);
  expect((await review({ markdown: quote, excerpts: [excerpt] })).coverage.supported).toBe(1);
  expect((await review({ markdown: quote, excerpts: [excerpt] })).coverage.supported).toBe(1);
  expect(calls.map((call) => call.purpose)).toEqual(["inventory-chapter-claims", "review-chapter-evidence"]);
});

it("invalidates verdicts when source text or provenance changes even with the same excerpt ID", async () => {
  const missing = { claims: [{ id: "c1", status: "insufficient_evidence", reason: "The new passage says nothing about authors." }] };
  const { model, calls } = scriptedDevelopmentModel([inventory, verdict, missing]);
  const review = createSourceClaimReviewer(model);
  expect((await review({ markdown: quote, excerpts: [excerpt] })).coverage.supported).toBe(1);
  expect((await review({ markdown: quote, excerpts: [{ ...excerpt, text: "A completely different passage." }] })).coverage.supported).toBe(0);
  expect((await review({ markdown: quote, excerpts: [{ ...excerpt, provenanceVerified: false }] })).coverage.supported).toBe(0);
  expect(calls).toHaveLength(3);
});

it("rechecks when counterevidence is added and reinventories any edited prose", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory, verdict, verdict, inventory, verdict]);
  const review = createSourceClaimReviewer(model);
  await review({ markdown: quote, excerpts: [excerpt] });
  await review({ markdown: quote, excerpts: [excerpt, { ...excerpt, id: "correction", text: "The apparent third author is an editor." }] });
  await review({ markdown: `${quote} More context.`, excerpts: [excerpt] });
  expect(calls.map((call) => call.purpose)).toEqual([
    "inventory-chapter-claims", "review-chapter-evidence", "review-chapter-evidence", "inventory-chapter-claims", "review-chapter-evidence"
  ]);
});

it("retries a failed batch in a later review without repeating the successful batches", async () => {
  const claims = Array.from({ length: 16 }, (_, index) => ({ quote: `Assertion ${index}.`, searchQuery: "record" }));
  const first = { claims: claims.slice(0, 15).map((_, index) => ({ id: `c${index + 1}`, status: "supported", reason: "Evidence.", support: [{ excerptId: "paper", quote }] })) };
  const last = { claims: [{ ...verdict.claims[0], id: "c16" }] };
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, claims }, first, new Error("offline"), last]);
  const review = createSourceClaimReviewer(model);
  const options = { markdown: claims.map((claim) => claim.quote).join("\n"), excerpts: [excerpt] };
  expect((await review(options)).coverage).toMatchObject({ status: "incomplete", supported: 15 });
  expect((await review(options)).coverage).toMatchObject({ status: "reviewed", supported: 16 });
  expect(calls).toHaveLength(4);
});

it("never caches a missing, duplicate or fabricated supporting verdict as complete", async () => {
  const bad = { claims: [{ ...verdict.claims[0], support: [{ excerptId: "paper", quote: "Invented evidence that is not in the document." }] }] };
  const { model, calls } = scriptedDevelopmentModel([inventory, bad, verdict]);
  const review = createSourceClaimReviewer(model);
  const options = { markdown: quote, excerpts: [excerpt] };
  expect((await review(options)).coverage).toMatchObject({ status: "incomplete", supported: 0 });
  expect((await review(options)).coverage).toMatchObject({ status: "reviewed", supported: 1 });
  expect(calls).toHaveLength(3);
});

it("lets cancellation interrupt a later batch without starting any more paid calls", async () => {
  const claims = Array.from({ length: 31 }, (_, index) => ({ quote: `Assertion ${index}.`, searchQuery: "record" }));
  const first = { claims: claims.slice(0, 15).map((_, index) => ({ id: `c${index + 1}`, status: "supported", reason: "Evidence.", support: [{ excerptId: "paper", quote }] })) };
  const stopped = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, claims }, first, stopped]);
  await expect(createSourceClaimReviewer(model)({ markdown: claims.map((claim) => claim.quote).join("\n"), excerpts: [excerpt] })).rejects.toBe(stopped);
  expect(calls).toHaveLength(3);
});
