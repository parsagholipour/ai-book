import { describe, expect, it } from "vitest";
import {
  compilePolicyPayload,
  compilePublicationDedupeKey,
  compilePublicationPolicyFromPayload,
  compilePublicationPolicyIdentity,
  editRecompilePolicy,
  freeEditRecompilePolicy,
  normalizedCompilePublicationPolicy
} from "./compilePublicationPolicy.js";
import { freeRecompileFallbackStatus, jobOwnsQualityVerdict, payloadOwnsProjectOutcome } from "./jobScope.js";
import { generationJobPlacement } from "./jobLanes.js";

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
const freeEdit = freeEditRecompilePolicy("REVIEW_REQUIRED");

describe("compile publication policy", () => {
  it("round-trips every field that affects review, publication, verdict, or settlement", () => {
    for (const [policy, status] of [
      [normal, "GENERATING"],
      [presentation, "EDITING"],
      [detached, "COMPLETE"],
      [withoutVerdict, "EDITING"],
      [freeEdit, "EDITING"]
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
      compilePublicationPolicyIdentity(withoutVerdict, "EDITING"),
      compilePublicationPolicyIdentity(freeEdit, "EDITING"),
      compilePublicationPolicyIdentity(freeEditRecompilePolicy("COMPLETE"), "EDITING"),
      compilePublicationPolicyIdentity(
        compilePublicationPolicyFromPayload({ skipFinalReview: true, exportPublicationProjectStatus: "EDITING" }),
        "EDITING"
      )
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("gives each repairable format its own detached identity, keeping the PDF and EPUB letters", () => {
    const repair = (exportRepairFormat: string) =>
      compilePublicationPolicyIdentity(
        compilePublicationPolicyFromPayload({
          skipFinalReview: true,
          exportPublicationProjectStatus: "COMPLETE",
          detachedFromProjectLifecycle: true,
          exportRepairFormat
        }),
        "COMPLETE"
      );
    expect(repair("pdf")).toMatch(/odp$/);
    expect(repair("epub")).toMatch(/ode$/);
    expect(repair("docx")).toMatch(/odd$/);
    expect(new Set([repair("pdf"), repair("epub"), repair("docx")]).size).toBe(3);
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

describe("a free edit's recompile", () => {
  const payload = { planId: "plan-1", contentRevision: 4, ...compilePolicyPayload(freeEdit, "EDITING") };

  it("compiles like an edit's skip-review recompile but settles alone, back to its pre-edit status", () => {
    expect(freeEdit).toEqual({
      review: { skipFinalReview: true, withoutQualityVerdict: false },
      expectedProjectStatus: "EDITING",
      ownership: { kind: "freeEdit", fallbackStatus: "REVIEW_REQUIRED" }
    });
    expect(payload).toMatchObject({
      skipFinalReview: true,
      exportPublicationProjectStatus: "EDITING",
      freeEditRecompile: true,
      preEditProjectStatus: "REVIEW_REQUIRED"
    });
    // B3: a failure or a delete must not reach the book's own charge or its FAILED.
    expect(payloadOwnsProjectOutcome(payload)).toBe(false);
    expect(freeRecompileFallbackStatus(payload)).toBe("REVIEW_REQUIRED");
  });

  it("still owns the quality verdict, because its prose moved", () => {
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", payload)).toBe(true);
  });

  it("falls back to COMPLETE when the stamp is missing, and never outranks a detached repair", () => {
    expect(freeRecompileFallbackStatus({ freeEditRecompile: true })).toBe("COMPLETE");
    const repair = { freeEditRecompile: true, detachedFromProjectLifecycle: true, exportRepairFormat: "pdf" };
    expect(compilePublicationPolicyFromPayload(repair).ownership.kind).toBe("detached");
    expect(freeRecompileFallbackStatus(repair)).toBeNull();
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", repair)).toBe(false);
  });
});

describe("a paid edit's recompile", () => {
  const rewrite = editRecompilePolicy("REVIEW_REQUIRED");
  const picture = editRecompilePolicy("COMPLETE", { skipFinalReview: true, withoutQualityVerdict: true });
  const restructure = editRecompilePolicy("REVIEW_REQUIRED", { skipFinalReview: false, withoutQualityVerdict: false });

  it("keeps each edit's review and settles alone, back to its pre-edit status", () => {
    for (const policy of [rewrite, picture, restructure]) {
      const payload = compilePolicyPayload(policy, "EDITING");
      expect(compilePublicationPolicyFromPayload(payload)).toEqual(policy);
      expect(payloadOwnsProjectOutcome(payload)).toBe(false);
      expect(freeRecompileFallbackStatus(payload)).toBe(policy.ownership.kind === "freeEdit" ? policy.ownership.fallbackStatus : null);
      // A reader is in the chat waiting on it, whatever review it runs.
      expect(generationJobPlacement("COMPILE_EXPORT", payload).lane).toBe("interactive");
    }
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", compilePolicyPayload(rewrite, "EDITING"))).toBe(true);
    expect(jobOwnsQualityVerdict("COMPILE_EXPORT", compilePolicyPayload(picture, "EDITING"))).toBe(false);
    expect(compilePolicyPayload(restructure, "EDITING")).not.toHaveProperty("skipFinalReview");
  });

  it("is the free edit's policy at its default review, so a free edit's identity never moved", () => {
    expect(freeEditRecompilePolicy("COMPLETE")).toEqual(editRecompilePolicy("COMPLETE"));
    expect(compilePublicationPolicyIdentity(freeEditRecompilePolicy("REVIEW_REQUIRED"), "EDITING")).toBe(
      compilePublicationPolicyIdentity(rewrite, "EDITING")
    );
  });
});
