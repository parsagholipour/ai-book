import { describe, expect, it, vi } from "vitest";
import { auditPageStyle, styleAuditedScoreBeats, withStyleAudit } from "./styleAuditor.js";
import type { PageQualityReport } from "../schemas/book.js";
import type { TextModelAdapter } from "../adapters/types.js";

const report = (overrides: Partial<PageQualityReport> = {}): PageQualityReport => ({
  approved: true,
  score: 90,
  issues: [],
  requiredRevisions: [],
  notes: "ok",
  groundedOk: true,
  unsupportedClaims: [],
  checks: {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  },
  ...overrides
});

describe("withStyleAudit", () => {
  it("flips approval and records the penalty beside the score, never inside it", () => {
    const audited = withStyleAudit(report(), {
      styleOk: false,
      styleIssues: ["Register shifts into lecture mode.", "Ignores the pinned excerpts' rhythm."]
    });

    expect(audited.approved).toBe(false);
    expect(audited.checks.styleNatural).toBe(false);
    expect(audited.issues).toContain("Register shifts into lecture mode.");
    expect(audited.requiredRevisions).toContain("Revise style: Ignores the pinned excerpts' rhythm.");
    // The reviewer's score stays comparable against unaudited candidates; the
    // audit's cost travels as its own field for `styleAuditedScoreBeats`.
    expect(audited.score).toBe(90);
    expect(audited.stylePenalty).toBe(30);
  });

  it("stamps a clean audit with penalty zero so the report reads as audited", () => {
    const audited = withStyleAudit(report(), { styleOk: true, styleIssues: [] });

    expect(audited.approved).toBe(true);
    expect(audited.score).toBe(90);
    expect(audited.stylePenalty).toBe(0);
  });

  it("charges at least one finding's penalty when styleOk is false with no issues listed", () => {
    const audited = withStyleAudit(report(), { styleOk: false, styleIssues: [] });

    expect(audited.approved).toBe(false);
    expect(audited.stylePenalty).toBe(15);
  });

  it("charges duplicate model findings only once", () => {
    const audited = withStyleAudit(report(), {
      styleOk: false,
      styleIssues: ["Register drifts.", " Register drifts. "]
    });

    expect(audited.stylePenalty).toBe(15);
    expect(audited.issues).toEqual(["Register drifts."]);
    expect(audited.requiredRevisions).toEqual(["Revise style: Register drifts."]);
  });
});

describe("auditPageStyle", () => {
  const modelAnswering = (data: { styleOk: boolean; styleIssues: string[] }) => {
    const generateJson = vi.fn(async () => ({ data }));
    return { model: { generateJson } as unknown as TextModelAdapter, generateJson };
  };

  const sentTo = (generateJson: ReturnType<typeof vi.fn>) => {
    const options = generateJson.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    return {
      system: options.messages.find((message) => message.role === "system")!.content,
      user: JSON.parse(options.messages.find((message) => message.role === "user")!.content) as Record<string, unknown>
    };
  };

  const auditOptions = {
    markdown: "The storm took the roof off.",
    voiceGuide: ["Warm and plain."],
    styleExcerpts: ["Opening voice.", "Second page voice."]
  };

  it("rejects sudden register shifts on a page nobody asked to change", async () => {
    const { model, generateJson } = modelAnswering({ styleOk: true, styleIssues: [] });

    await auditPageStyle({ textModel: model, ...auditOptions });

    const { system, user } = sentTo(generateJson);
    expect(system).toContain("sudden register shifts");
    expect(user).not.toHaveProperty("userRequest");
  });

  it("treats a shift the reader asked for as intended rather than as drift", async () => {
    // The excerpts are the book's *opening* pages, so "make page 12 more
    // dramatic" is a register shift by construction: judged by the plain rules
    // the audit rejected the edit it was asked for, flipped the reviewer's
    // approval, and the chat edit's small revision budget went on pulling the
    // page back toward the voice the reader had just asked it to leave.
    const { model, generateJson } = modelAnswering({ styleOk: true, styleIssues: [] });

    await auditPageStyle({ textModel: model, ...auditOptions, userRequest: "make page 12 more dramatic" });

    const { system, user } = sentTo(generateJson);
    expect(user.userRequest).toBe("make page 12 more dramatic");
    expect(system).not.toContain("sudden register shifts");
    expect(system).toContain("INTENDED");
    // Everything the audit is actually for survives the exemption.
    expect(system).toContain("generic scaffold prose");
    expect(system).toContain("antiAiRules");
    expect(system).toContain("Report only drift the request did not ask for.");
  });

  it("ignores a blank request rather than claiming one was made", async () => {
    const { model, generateJson } = modelAnswering({ styleOk: true, styleIssues: [] });

    await auditPageStyle({ textModel: model, ...auditOptions, userRequest: "   " });

    const { system, user } = sentTo(generateJson);
    expect(user).not.toHaveProperty("userRequest");
    expect(system).toContain("sudden register shifts");
  });

  it("reports styleOk false whenever the model listed an issue", async () => {
    const { model } = modelAnswering({ styleOk: true, styleIssues: ["Rhythm ignores the opening."] });

    await expect(auditPageStyle({ textModel: model, ...auditOptions })).resolves.toEqual({
      styleOk: false,
      styleIssues: ["Rhythm ignores the opening."]
    });
  });
});

describe("styleAuditedScoreBeats", () => {
  it("never lets an unaudited rejected rewrite beat an audited draft on the penalty alone", () => {
    // The generatePage shape: the initial draft reviews at 80, the style audit
    // finds two issues, and revision 2 reviews at 60 and is rejected — so it
    // is never audited. Folding the 30-point penalty into `score` made the
    // worse rewrite the keeper.
    const auditedDraft = withStyleAudit(report({ score: 80 }), {
      styleOk: false,
      styleIssues: ["Register drifts.", "Rhythm ignored."]
    });
    const rejectedRewrite = report({ approved: false, score: 60 });

    expect(styleAuditedScoreBeats(rejectedRewrite, auditedDraft)).toBe(false);
    expect(styleAuditedScoreBeats(auditedDraft, rejectedRewrite)).toBe(true);
  });

  it("compares penalty-adjusted scores when both candidates were audited", () => {
    const dirtier = withStyleAudit(report({ score: 85 }), {
      styleOk: false,
      styleIssues: ["One.", "Two.", "Three."]
    });
    const cleaner = withStyleAudit(report({ score: 80 }), {
      styleOk: false,
      styleIssues: ["One."]
    });

    // 85 - 45 = 40 against 80 - 15 = 65: the cleaner draft wins despite the
    // lower reviewer score, because here the penalties are comparable.
    expect(styleAuditedScoreBeats(cleaner, dirtier)).toBe(true);
    expect(styleAuditedScoreBeats(dirtier, cleaner)).toBe(false);
  });

  it("keeps the incumbent on a raw-score tie between unaudited candidates", () => {
    expect(styleAuditedScoreBeats(report({ score: 70 }), report({ score: 70 }))).toBe(false);
    expect(styleAuditedScoreBeats(report({ score: 71 }), report({ score: 70 }))).toBe(true);
  });
});
