import { expect, it } from "vitest";
import { createSourceClaimReviewer, reviewSourceClaims } from "./sourceClaimReview.js";
import { isDerivedArithmeticClaim } from "./sourceClaimArithmetic.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { dossierExcerptSchema } from "../schemas/episodes.js";

it.each(["15 mod 12 = 3", "17 ≡ 5 (mod 12)"])("does not send the self-contained calculation %s for external evidence", async (quote) => {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, claims: [{ quote, searchQuery: "original source for exact worked example" }] }
  ]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [], textModel: model });
  expect(result.coverage).toEqual({ status: "reviewed", checked: 0, supported: 0, contradicted: 0, unsupported: 0 });
  expect(result.issues).toEqual([]);
  expect(calls).toHaveLength(1);
});

it.each([
  ["15 mod 12 = 3", "In modular arithmetic, 15 mod 12 = 3."],
  ["17 ≡ 5 (mod 12)", "The notation 17 ≡ 5 (mod 12) records that relationship."],
  ["17 ≡ 5 (mod 12)", "The statement 17 ≡ 5 (mod 12) is true."],
  ["In modular arithmetic, 15 mod 12 = 3.", "In modular arithmetic, 15 mod 12 = 3. The modulus sets the circumference."],
  ["\\(5^6\\bmod23=8\\)", "\\(5^6\\bmod23=8\\)."],
  ["\\[128^2=16\\,384.\\]", "\\[128^2=16\\,384.\\]"],
  ["$(2+3)(4-1)=15$", "$(2+3)(4-1)=15$"],
  ["`2+2=4`", "`2+2=4`"]
])("proves the narrow mathematical context for %s", (quote, markdown) => {
  expect(isDerivedArithmeticClaim(quote!, markdown!)).toBe(true);
});

it.each([
  "15 mod 12 = 4", "17 ≡ 5", "17 ≡ 6 (mod 12)", "5^6 mod 23", "x=5^6\\bmod23=8",
  "a+b=c", "2^100000=1", "1.5+1.5=3", "2\\approx2", "\\text{2}=2", "\\mathrm{2}=2",
  "2+2=4 kg", "\\sqrt{4}=2", "-2^2=4", "16 384=6144", "16\\,38=608", "1,000=1000",
  "15 mod 12 + 2 = 1", "5^2=2", "17=5\\pmod{12}", "17\\pmod{12}=5",
  "0^0=1", "(2-2)^(2-2)=1", "1^999999999999999999999999999=1", "(-1)^999999999999999999999999999=-1",
  "-(2)^2=4", "-{2}^2=4", "-(2+3)^2=25", "2+5 mod 3 = 1"
])("keeps wrong, unknown or ambiguous arithmetic %s in external review", (quote) => {
  expect(isDerivedArithmeticClaim(quote, quote)).toBe(false);
});

it.each([
  "Euclid wrote that 15 mod 12 = 3.",
  "The trial found 15 mod 12 = 3 grams of residue.",
  "The paper states: 15 mod 12 = 3.",
  "The paper states:\n\n15 mod 12 = 3",
  "15 mod 12 = 3\n\n— Dr. Euclid",
  "> 15 mod 12 = 3\n> — The original source",
  '"15 mod 12 = 3" — Euclid.',
  "15 mod 12 = 3 [1].",
  "15 mod 12 = 3 is a result measured by the researchers.",
  "The theorem proves 15 mod 12 = 3.",
  "In modular arithmetic, 15 mod 12 = 3. Euclid wrote that 15 mod 12 = 3."
])("retains a numeric fragment inside an attributed, empirical or unrecognized context", (markdown) => {
  expect(isDerivedArithmeticClaim("15 mod 12 = 3", markdown)).toBe(false);
});

it.each(["2+2=4.5", "2+2=4.units were reported."])("does not treat punctuation inside a larger token as the quote's sentence boundary", (markdown) => {
  expect(isDerivedArithmeticClaim("2+2=4.", markdown)).toBe(false);
});

it("retains factual premises and an equation repeated inside an empirical claim", async () => {
  const pure = "15 mod 12 = 3";
  const fact = "The original paper was published in 1976.";
  const mixed = "The trial recorded 15 mod 12 = 3 grams of residue.";
  const excerpt = dossierExcerptSchema.parse({ id: "paper", chapterIndex: 1, documentTitle: "Original paper", documentUrl: "https://example.org/paper", text: fact, provenanceVerified: true });
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, claims: [pure, fact, mixed].map((quote) => ({ quote, searchQuery: "original record" })) },
    { claims: [
      { id: "c1", status: "insufficient_evidence", reason: "The empirical context has no support.", support: [] },
      { id: "c2", status: "supported", reason: "The source establishes the year.", support: [{ excerptId: "paper", quote: fact }] },
      { id: "c3", status: "insufficient_evidence", reason: "The measurement has no support.", support: [] }
    ] }
  ]);
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const review = createSourceClaimReviewer(model, (event, detail) => { events.push({ event, detail }); });
  // Do not let the separate empirical use of the same quote disappear behind its correct math.
  const markdown = `In modular arithmetic, ${pure}.\n\n${fact}\n\n${mixed}`;
  const result = await review({ markdown, excerpts: [excerpt] });
  expect(result.coverage).toMatchObject({ checked: 3, unsupported: 2 });
  expect(events.find((event) => event.event === "claim_arithmetic_exclusions")?.detail).toMatchObject({ excluded: 0, remaining: 3 });
  expect(JSON.parse(calls[1]!.messages.at(-1)!.content).claims.map((claim: { id: string }) => claim.id)).toEqual(["c1", "c2", "c3"]);
  expect(calls).toHaveLength(2);
});

it("excludes only proven calculations before verification while preserving claim ids and factual evidence", async () => {
  const calculation = "15 mod 12 = 3";
  const fact = "The original paper was published in 1976.";
  const excerpt = dossierExcerptSchema.parse({ id: "paper", chapterIndex: 1, documentTitle: "Original paper", documentUrl: "https://example.org/paper", text: fact, provenanceVerified: true });
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, claims: [calculation, fact].map((quote) => ({ quote, searchQuery: "original record" })) },
    { claims: [{ id: "c2", status: "supported", reason: "The source establishes the year.", support: [{ excerptId: "paper", quote: fact }] }] }
  ]);
  const result = await reviewSourceClaims({ markdown: `In modular arithmetic, ${calculation}.\n\n${fact}`, excerpts: [excerpt], textModel: model });
  expect(result.coverage).toEqual({ status: "reviewed", checked: 1, supported: 1, contradicted: 0, unsupported: 0 });
  expect(JSON.parse(calls[1]!.messages.at(-1)!.content).claims.map((claim: { id: string }) => claim.id)).toEqual(["c2"]);
  expect(calls).toHaveLength(2);
});

it("records exclusions without inventing source support and leaves an incomplete inventory incomplete", async () => {
  const quote = "15 mod 12 = 3";
  const { model, calls } = scriptedDevelopmentModel([{ complete: false, claims: [{ quote, searchQuery: "original record" }] }]);
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const review = createSourceClaimReviewer(model, (event, detail) => { events.push({ event, detail }); });
  const result = await review({ markdown: quote, excerpts: [] });
  expect(result.coverage).toEqual({ status: "incomplete", checked: 0, supported: 0, contradicted: 0, unsupported: 0 });
  expect(result.claims).toEqual([]);
  expect(result.dropped).toEqual([]);
  expect(events.find((event) => event.event === "claim_arithmetic_exclusions")?.detail).toMatchObject({ excluded: 1, remaining: 0 });
  expect(calls).toHaveLength(1);
});
