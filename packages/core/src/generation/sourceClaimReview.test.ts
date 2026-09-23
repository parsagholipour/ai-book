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

it("accepts omitted support only for an explicit insufficient-evidence verdict without retrying", async () => {
  const { model, calls } = scriptedDevelopmentModel([inventory, { claims: [{ id: "c1", status: "insufficient_evidence", reason: "No passage establishes the order." }] }]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.coverage).toMatchObject({ status: "reviewed", checked: 1, unsupported: 1 });
  expect(result.claims[0]?.support).toEqual([]);
  expect(calls).toHaveLength(2);
});

it("isolates a failed verification batch without losing successful claims", async () => {
  const claims = Array.from({ length: 31 }, (_, index) => ({ quote: `External assertion number ${index}.`, searchQuery: `original record ${index}` }));
  const { model, calls } = scriptedDevelopmentModel([]);
  model.generateJson = async (request) => {
    calls.push(request);
    const payload = JSON.parse(request.messages.at(-1)!.content);
    if (payload.phase === "claim_inventory") return { data: request.schema.parse({ complete: true, claims }), text: "", model: "fixture", provider: "fixture" };
    if (payload.claims.some((claim: { id: string }) => claim.id === "c16")) throw new Error("verifier offline for this batch");
    const response = { claims: payload.claims.map((claim: { id: string }) => ({ id: claim.id, status: "supported", reason: "Established in the record.", support: [{ excerptId: excerpt.id, quote: excerpt.text }] })) };
    return { data: request.schema.parse(response), text: "", model: "fixture", provider: "fixture" };
  };
  const result = await reviewSourceClaims({ markdown: claims.map((claim) => claim.quote).join("\n"), excerpts: [excerpt], textModel: model });
  expect(result.coverage).toMatchObject({ status: "incomplete", checked: 31, supported: 16, unsupported: 15 });
  expect(calls.filter((call) => JSON.parse(call.messages.at(-1)!.content).phase === "claim_verification")).toHaveLength(3);
});

it.each(["supported", "contradicted"])("never accepts missing quotations for %s", async (status) => {
  const bad = { claims: [{ id: "c1", status, reason: "Trust me." }] };
  const { model } = scriptedDevelopmentModel([inventory, bad, bad]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.coverage).toMatchObject({ status: "incomplete", supported: 0, contradicted: 0, unsupported: 1 });
});

it("repairs only unlocatable inventory quotes once and rechecks them against the manuscript", async () => {
  const invented = "The original paper lists the authors alphabetically.";
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, claims: [{ quote: invented, searchQuery: "author order" }] },
    { repairs: [{ index: 0, quote }] }, verdict("contradicted")
  ]);
  const result = await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model });
  expect(result.coverage).toMatchObject({ status: "reviewed", contradicted: 1 });
  expect(JSON.parse(calls[1]!.messages.at(-1)!.content).phase).toBe("claim_inventory_quote_repair");
  expect(result.dropped).toEqual([]);
});

it("never calls an incomplete inventory complete just because its bad quotations were repaired", async () => {
  const { model } = scriptedDevelopmentModel([
    { complete: false, claims: [{ quote: "An invented span.", searchQuery: "paper" }] },
    { repairs: [{ index: 0, quote }] }, verdict("contradicted")
  ]);
  expect((await reviewSourceClaims({ markdown: quote, excerpts: [excerpt], textModel: model })).coverage.status).toBe("incomplete");
});

it("re-asks only omitted verdicts while retaining the paid results already returned", async () => {
  const other = "The paper describes a second external assertion.";
  const second = { ...verdict("insufficient_evidence").claims[0], id: "c2" };
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, claims: [{ quote, searchQuery: "paper" }, { quote: other, searchQuery: "paper" }] },
    verdict("contradicted"), { claims: [second] }
  ]);
  const result = await reviewSourceClaims({ markdown: `${quote}\n${other}`, excerpts: [excerpt], textModel: model });
  expect(result.coverage).toMatchObject({ status: "reviewed", checked: 2, contradicted: 1, unsupported: 1 });
  expect(JSON.parse(calls[2]!.messages.at(-1)!.content).claims.map((claim: { id: string }) => claim.id)).toEqual(["c2"]);
});
