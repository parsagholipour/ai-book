import { describe, expect, it } from "vitest";
import { CASE_EVIDENCE_REVIEW_VERSION, buildCaseEvidence, caseEvidenceIssues, reviewChapterCaseEvidence } from "./caseEvidence.js";
import { caseEvidenceReviewIssues } from "./caseEvidenceReview.js";
import { caseEvidencePacketSchema, chapterEpisodeSchema } from "../schemas/episodes.js";
import { evidenceFixture, scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const packet = evidenceFixture();
const candidate = { claims: packet.claims, disagreements: [], unknowns: packet.unknowns };
const verdict = { caseMatch: { supported: true, reason: "The passage documents the trial", canonicalEpisode: packet.episode, anchors: [{ excerptId: packet.excerpts[0]!.id, quote: packet.excerpts[0]!.text }] }, disagreementsReason: "No disagreement asserted", unknownsReason: "No dialogue in the passage", claims: packet.claims.map(({ id }) => ({ id, supported: true, reason: "Supported by the record" })), disagreementsSupported: true, unknownsAccurate: true };
const costs = { id: "costs", kind: "fact" as const, text: "The losing party paid the costs of both trials.", excerptIds: ["record"] };
const rejectCosts = { ...verdict, claims: [...verdict.claims, { id: "costs", supported: false, reason: "The record says nothing about costs." }] };

function build(responses: unknown[], excerpts = packet.excerpts) {
  const { model, calls } = scriptedDevelopmentModel(responses);
  return { calls, result: buildCaseEvidence({ id: packet.id, chapterIndex: 1, episode: packet.episode, excerpts, textModel: model }) };
}

describe("reviewed case evidence", () => {
  it("will not substitute a model's memory for a missing retrieved passage", async () => {
    const { result, calls } = build([], []);
    expect(await result).toEqual({ failure: "no retrieved passage about this case" });
    expect(calls).toHaveLength(0);
  });

  it("retains exact source text, temporal claims and unknowns after a complete independent review, and asks for no separate chronology", async () => {
    const { result, calls } = build([candidate, verdict]);
    expect(await result).toEqual({ packet });
    expect(packet.reviewVersion).toBe(CASE_EVIDENCE_REVIEW_VERSION);
    expect(calls.map((call) => call.purpose)).toEqual(["build-case-evidence", "verify-case-evidence"]);
    expect(JSON.parse(calls[0]!.messages[1]!.content).outputContract).not.toHaveProperty("sequence");
    const review = JSON.parse(calls[1]!.messages[1]!.content);
    expect(review.excerpts).toEqual(packet.excerpts);
    expect(review.outputContract).not.toHaveProperty("sequenceSupported");
  });

  it("rejects the reversed verdict that a plausible narrative could otherwise repeat", async () => {
    const { result } = build([
      { ...candidate, claims: [{ ...packet.claims[0]!, text: "The first jury found for the insurers." }, packet.claims[1]] },
      { ...verdict, claims: [{ id: "initial", supported: false, reason: "The record says shipowners, not insurers." }, verdict.claims[1]] }
    ]);
    expect((await result).failure).toContain("shipowners, not insurers");
  });

  it("excises a claim the repaired packet still overstates instead of losing the case", async () => {
    const overstated = { ...candidate, claims: [...packet.claims, costs] };
    const { result, calls } = build([overstated, rejectCosts, overstated, rejectCosts]);
    expect(await result).toEqual({ packet });
    expect(calls.map((call) => call.purpose)).toEqual(["build-case-evidence", "verify-case-evidence", "build-case-evidence", "verify-case-evidence"]);
    expect(JSON.parse(calls[2]!.messages[1]!.content).repair.issues).toEqual(["Claim costs: The record says nothing about costs."]);
  });

  it("fails the case when fewer than two supported claims would remain", async () => {
    const reject = { ...verdict, claims: [{ id: "initial", supported: false, reason: "The record says shipowners, not insurers." }, verdict.claims[1]] };
    const { result } = build([candidate, reject, candidate, reject]);
    expect((await result).failure).toContain("shipowners, not insurers");
  });

  it("rejects an incidental biography even when its individual claims are true", async () => {
    const { result } = build([candidate, {
      ...verdict,
      caseMatch: { supported: false, reason: "The passages concern the author's biography, not the proposed trial.", canonicalEpisode: packet.episode, anchors: [] }
    }]);
    expect((await result).failure).toContain("not the proposed trial");
  });

  it("requires the case review's anchors to resolve to the actual passage", async () => {
    const invalid = { ...verdict, caseMatch: { ...verdict.caseMatch, anchors: [{ excerptId: "record", quote: "The source never said this." }] } };
    const { result } = build([candidate, invalid, invalid]);
    expect((await result).failure).toContain("exact source passages");
  });

  it("is grounded by one exact anchor and ignores a second one an OCR page header broke", async () => {
    const anchors = [{ excerptId: "record", quote: "The first jury found for the 12 COURT RECORDS shipowners." }, { excerptId: "record", quote: "The court later ordered another trial." }];
    const { result, calls } = build([candidate, { ...verdict, caseMatch: { ...verdict.caseMatch, anchors } }]);
    expect((await result).packet).toEqual(packet);
    expect(calls).toHaveLength(2);
  });

  it("retries an unresolvable review quote against the same unchanged packet", async () => {
    const bad = { ...verdict, caseMatch: { ...verdict.caseMatch, anchors: [{ excerptId: "record", quote: "The first jury found for the owner." }] } };
    const { result, calls } = build([candidate, bad, verdict]);
    expect((await result).packet).toEqual(packet);
    expect(calls.map((call) => call.purpose)).toEqual(["build-case-evidence", "verify-case-evidence", "verify-case-evidence"]);
    expect(JSON.parse(calls[2]!.messages[1]!.content).reviewFeedback).toContain("Case identity: the supporting anchors do not resolve to exact source passages");
  });

  it("rejects a temporal claim the passage does not order and accepts the narrowed repair", async () => {
    const ordered = { ...packet.claims[1]!, text: "After the costs were paid, the court ordered another trial." };
    const { result, calls } = build([
      { ...candidate, claims: [packet.claims[0], ordered] },
      { ...verdict, claims: [verdict.claims[0], { id: "appeal", supported: false, reason: "The record does not say the costs came first; that order is inferred." }] },
      candidate, verdict
    ]);
    expect((await result).packet).toEqual(packet);
    expect(calls.map((call) => call.purpose)).toEqual(["build-case-evidence", "verify-case-evidence", "build-case-evidence", "verify-case-evidence"]);
    expect(JSON.parse(calls[2]!.messages[1]!.content).repair.issues).toContain("Claim appeal: The record does not say the costs came first; that order is inferred.");
  });

  it("never accepts a model-ordered chain, whichever version wrote it", () => {
    const legacy = caseEvidencePacketSchema.parse({ ...packet, reviewVersion: 1, sequence: ["initial", "appeal"] });
    expect(caseEvidenceIssues(legacy)).toEqual([]);
    expect(caseEvidenceReviewIssues(legacy, verdict)).toEqual(["Chronology: a model-ordered sequence is not accepted; chronology belongs inside individually supported claims"]);
    expect(caseEvidenceIssues({ ...packet, sequence: ["initial"] })).toContain("a model-ordered sequence is not accepted; chronology belongs inside supported claims");
  });

  it("reviews the repaired packet against the corrected episode, so a provenance unknown cannot go stale", async () => {
    const corrected = { ...packet.episode, person: "Test clerk", document: "The actual appeal record" };
    const stale = { ...candidate, unknowns: ["These passages come from the appeal record, not the proposed court record."] };
    const { result, calls } = build([
      stale,
      { ...verdict, caseMatch: { ...verdict.caseMatch, canonicalEpisode: corrected }, unknownsAccurate: false, unknownsReason: "Provenance is metadata, not an unknown." },
      candidate,
      { ...verdict, caseMatch: { ...verdict.caseMatch, canonicalEpisode: corrected } }
    ]);
    const kept = (await result).packet!;
    const repair = JSON.parse(calls[2]!.messages[1]!.content);
    expect(repair.episode).toEqual(corrected);
    expect(repair.repair.issues).toEqual(["Unknowns: Provenance is metadata, not an unknown."]);
    expect(JSON.parse(calls[3]!.messages[1]!.content).episode).toEqual(corrected);
    expect(kept.episode).toEqual(corrected);
    expect(kept.unknowns).toEqual(packet.unknowns);
    expect(kept.excerpts[0]!.episodeTitle).toBe(corrected.title);
  });

  it("accepts an empty disagreement list even if the reviewer labels the absence false", async () => {
    const { result } = build([candidate, { ...verdict, disagreementsSupported: false, disagreementsReason: "No source disagreement is supplied" }]);
    expect((await result).packet).toEqual(packet);
  });

  it("corrects the source metadata for the same case and keeps excerpt ownership consistent", async () => {
    const episode = { ...packet.episode, title: "The shipping appeal", document: "The actual appeal record" };
    const { result } = build([candidate, { ...verdict, caseMatch: { ...verdict.caseMatch, canonicalEpisode: episode } }]);
    const kept = (await result).packet!;
    expect(kept.episode).toEqual(episode);
    expect(kept.excerpts[0]!.episodeTitle).toBe(episode.title);
    expect(kept.excerpts[0]!.text).toBe(packet.excerpts[0]!.text);
  });

  it.each([
    { ...verdict, claims: verdict.claims.slice(0, 1) },
    { ...verdict, claims: [verdict.claims[0], verdict.claims[0]] },
    { ...verdict, caseMatch: { ...verdict.caseMatch, supported: false } },
    { ...verdict, unknownsAccurate: false }
  ])("rejects incomplete or negative adjudication %#", async (review) => {
    expect((await build([candidate, review]).result).packet).toBeUndefined();
  });

  it("rejects missing source references before spending on a review", async () => {
    const changed = { ...candidate, claims: candidate.claims.map((claim) => ({ ...claim, excerptIds: ["invented"] })) };
    const { result, calls } = build([changed]);
    expect((await result).failure).toContain("missing passage");
    expect(calls).toHaveLength(1);
    expect(caseEvidenceIssues({ ...packet, sequence: ["invented"] })).toContain("the sequence references a missing claim");
  });

  it("propagates cancellation rather than treating it as a reason to research a replacement", async () => {
    const stopped = new Error("aborted"); stopped.name = "AbortError";
    await expect(build([stopped]).result).rejects.toThrow("aborted");
  });

  it("reads a reviewer's null metadata field as empty rather than paying for a retry", () => {
    expect(chapterEpisodeSchema.parse({ title: "The trial", date: null, place: null })).toMatchObject({ date: "", place: "" });
    expect(chapterEpisodeSchema.safeParse({ title: null }).success).toBe(false);
  });

  it("checks edited prose, asks once for an exact re-quote, then drops a finding nobody can locate", async () => {
    const markdown = "The first jury found for the insurers.";
    const { model, calls } = scriptedDevelopmentModel([{ issues: [{ caseId: packet.id, quote: markdown, reason: "The verdict favored shipowners." }] }]);
    expect(await reviewChapterCaseEvidence({ markdown, packets: [packet], textModel: model })).toEqual({ issues: [`“${markdown}”: The verdict favored shipowners.`], dropped: [] });
    expect(calls[0]!.messages[1]!.content).toContain(packet.excerpts[0]!.text);
    const bad = scriptedDevelopmentModel([
      { issues: [{ caseId: packet.id, quote: "Words absent from the chapter", reason: "Unsupported" }] },
      { issues: [{ caseId: packet.id, quote: "The first jury found for the insurers.", reason: "Unsupported" }, { caseId: "case-unknown", quote: markdown, reason: "Wrong case" }] }
    ]);
    expect(await reviewChapterCaseEvidence({ markdown, packets: [packet], textModel: bad.model })).toEqual({ issues: [`“${markdown}”: Unsupported`], dropped: [`“${markdown}”: Wrong case`] });
    expect(JSON.parse(bad.calls[1]!.messages[1]!.content).reviewFeedback[0]).toContain("Words absent from the chapter");
    expect(bad.calls).toHaveLength(2);
  });
});
