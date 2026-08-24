import { describe, expect, it } from "vitest";
import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  compilePublicationPolicyIdentity,
  normalizedCompilePublicationPolicy
} from "./compilePublicationPolicy.js";

const normal = compilePublicationPolicyFromPayload({
  exportPublicationProjectStatus: "GENERATING"
});
const presentation = compilePublicationPolicyFromPayload({
  skipFinalReview: true,
  exportPublicationProjectStatus: "EDITING",
  presentationOnlyRecompile: true,
  presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
});
const detached = compilePublicationPolicyFromPayload({
  skipFinalReview: true,
  exportPublicationProjectStatus: "COMPLETE",
  detachedFromProjectLifecycle: true,
  exportRepairFormat: "pdf"
});
const withoutVerdict = compilePublicationPolicyFromPayload({
  skipFinalReview: true,
  exportPublicationProjectStatus: "EDITING",
  markdownRecompileWithoutVerdict: true
});

describe("compile publication policy", () => {
  it("round-trips every field that affects review, publication, verdict, or settlement", () => {
    for (const [policy, status] of [
      [normal, "GENERATING"],
      [presentation, "EDITING"],
      [detached, "COMPLETE"],
      [withoutVerdict, "EDITING"]
    ] as const) {
      expect(
        compilePublicationPolicyFromPayload(compilePolicyPayload(policy, status))
      ).toEqual(policy);
    }
  });

  it("gives normal, presentation, detached, and no-verdict work distinct identities", () => {
    const identities = [
      compilePublicationPolicyIdentity(normal, "GENERATING"),
      compilePublicationPolicyIdentity(presentation, "EDITING"),
      compilePublicationPolicyIdentity(detached, "COMPLETE"),
      compilePublicationPolicyIdentity(withoutVerdict, "EDITING")
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("makes exact duplicates idempotent while revision and policy create successors", () => {
    const key = (contentRevision: number, policy = normal) =>
      compilePublicationDedupeKey({
        projectId: "project-1",
        planId: "plan-1",
        contentRevision,
        policy,
        projectStatus: policy === normal ? "GENERATING" : "EDITING",
        contentFingerprint: "same-pages"
      });

    expect(key(7)).toBe(key(7));
    expect(key(8)).not.toBe(key(7));
    expect(key(7, presentation)).not.toBe(key(7));
    expect(key(7, withoutVerdict)).not.toBe(key(7));
  });

  it("names skip vs required review, detached vs outcome, and presentation vs outcome as distinct behavior", () => {
    expect(normal.review.skipFinalReview).toBe(false);
    expect(normal.ownership).toEqual({ kind: "outcome" });
    expect(presentation.review.skipFinalReview).toBe(true);
    expect(presentation.ownership).toEqual({
      kind: "presentation",
      fallbackStatus: "REVIEW_REQUIRED"
    });
    expect(detached.review.skipFinalReview).toBe(true);
    expect(detached.ownership).toEqual({ kind: "detached", repairFormat: "pdf" });
    expect(withoutVerdict.review).toEqual({ skipFinalReview: true, withoutQualityVerdict: true });
    expect(withoutVerdict.ownership).toEqual({ kind: "outcome" });
  });

  it("lets detached ownership win when a payload also claims to be a presentation reprint", () => {
    expect(
      compilePublicationPolicyFromPayload({
        skipFinalReview: true,
        detachedFromProjectLifecycle: true,
        exportRepairFormat: "epub",
        presentationOnlyRecompile: true,
        presentationRecompileFallbackStatus: "REVIEW_REQUIRED"
      }).ownership
    ).toEqual({ kind: "detached", repairFormat: "epub" });
  });

  it("fills a missing publication status from the live project, matching dispatch stamps", () => {
    // compileExport used to treat skipFinalReview as "claim EDITING" when the
    // payload omitted the stamp. Dispatch's compilePolicyPayload uses this
    // fallback instead: a valid project status wins, so the two paths cannot
    // CAS against different rows for the same unstamped job.
    expect(
      normalizedCompilePublicationPolicy(
        compilePublicationPolicyFromPayload({ skipFinalReview: true }),
        "COMPLETE"
      ).expectedProjectStatus
    ).toBe("COMPLETE");
    expect(
      normalizedCompilePublicationPolicy(compilePublicationPolicyFromPayload({}), "EDITING")
        .expectedProjectStatus
    ).toBe("EDITING");
  });

  it("keeps skip-review as EDITING only when the live status is not a publication status", () => {
    expect(
      normalizedCompilePublicationPolicy(
        compilePublicationPolicyFromPayload({ skipFinalReview: true }),
        "FAILED"
      ).expectedProjectStatus
    ).toBe("EDITING");
    expect(
      normalizedCompilePublicationPolicy(compilePublicationPolicyFromPayload({}), "FAILED")
        .expectedProjectStatus
    ).toBe("GENERATING");
  });
});
