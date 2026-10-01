import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharingFunnel } from "./OverviewScreen.js";
import {
  rankedProbabilities,
  readCaptionVerdict,
  readShareSnapshot,
  shareActionAvailability,
  shareModerationBody
} from "./shareModeration.js";
import { ShareReview } from "./ShareReview.js";
import type { AdminShare, ModerationReport, ShareModerationAction } from "./types.js";
import { postShareModeration } from "./useAdminData.js";

const verdict = {
  surface: "book_share_caption",
  verdict: "undecided",
  reason: "provider_failure",
  decidedAt: "2026-09-29T10:00:00.000Z",
  attempts: [
    {
      role: "primary",
      provider: "jev",
      model: "jev-decide-1",
      durationMs: 812,
      selectedOption: "allowed",
      probabilities: { spam_or_scam: 0.31, allowed: 0.62, sexual: 0.07 },
      escalationReason: "low_probability"
    },
    { role: "fallback", provider: "openai", model: "gpt-fallback", durationMs: 25_000, error: "timed out" }
  ]
};

function share(overrides: Partial<AdminShare> = {}): AdminShare {
  return {
    id: "share-1",
    slug: "k3v9q",
    url: "https://tomeza.example/s/k3v9q",
    projectId: "project-1",
    mode: "preview",
    previewPages: 6,
    status: "active",
    caption: "A bedtime story about a lighthouse keeper's cat.",
    captionStatus: "pending_review",
    captionVerdict: verdict,
    takedownReason: null,
    viewCount: 41,
    ...overrides
  };
}

function report(overrides: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: "report-1",
    reporterUserId: null,
    reporterEmail: null,
    projectId: "project-1",
    projectTitle: "The Lighthouse Cat",
    imageAssetId: null,
    bookShareId: "share-1",
    targetType: "book_share",
    targetSnapshot: { kind: "caption_review", slug: "k3v9q", title: "The Lighthouse Cat", caption: "A bedtime story about a lighthouse keeper's cat.", verdict },
    share: share(),
    reason: "other",
    comment: null,
    status: "pending",
    reviewerUserId: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    ...overrides
  };
}

function render(subject: ModerationReport, busyAction: ShareModerationAction | null = null): string {
  return renderToStaticMarkup(
    <ShareReview report={subject} busyAction={busyAction} locked={false} onAction={() => Promise.resolve(true)} />
  );
}

/** The opening tag of the button whose label is `label`. */
function buttonTag(markup: string, label: string): string {
  const chunk = markup.split("<button").find((part) => part.includes(`${label}</button>`));
  if (!chunk) throw new Error(`no button labelled ${label}`);
  return chunk.slice(0, chunk.indexOf(">"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("share moderation helpers", () => {
  it("ranks a distribution highest first and drops values that are not probabilities", () => {
    expect(rankedProbabilities({ b: 0.2, a: 0.2, c: 0.6, broken: Number.NaN, over: 3 })).toEqual([
      { option: "c", probability: 0.6 },
      { option: "a", probability: 0.2 },
      { option: "b", probability: 0.2 }
    ]);
    expect(rankedProbabilities(undefined)).toEqual([]);
  });

  it("offers caption actions only on a share with a note, and take-down only once", () => {
    expect(shareActionAvailability(share())).toEqual({
      approve_caption: { enabled: true, why: null },
      remove_caption: { enabled: true, why: null },
      take_down: { enabled: true, why: null }
    });
    const bare = shareActionAvailability(share({ caption: null, captionStatus: "none" }));
    expect(bare.approve_caption.enabled).toBe(false);
    expect(bare.remove_caption.enabled).toBe(false);
    expect(bare.take_down.enabled).toBe(true);
    const down = shareActionAvailability(share({ status: "taken_down", takedownReason: "Spam" }));
    expect(down.take_down).toEqual({ enabled: false, why: "Already taken down." });
    expect(down.approve_caption.enabled).toBe(true);
  });

  it("sends a trimmed reason and the report it was taken from, and omits what is empty", () => {
    expect(shareModerationBody("take_down", "  Links to a scam site  ", "report-1")).toEqual({
      action: "take_down",
      reason: "Links to a scam site",
      reportId: "report-1"
    });
    expect(shareModerationBody("approve_caption", "   ", undefined)).toEqual({ action: "approve_caption" });
    expect(shareModerationBody("take_down", "x".repeat(600), undefined).reason).toHaveLength(500);
  });

  it("reads a verdict record defensively and keeps the operator's decision", () => {
    expect(readCaptionVerdict(null)).toBeNull();
    expect(readCaptionVerdict({ verdict: "maybe" })).toBeNull();
    const read = readCaptionVerdict({
      ...verdict,
      attempts: [...verdict.attempts, { role: "judge" }, "junk"],
      operator: { action: "approve_caption", reviewerUserId: "op-1", at: "2026-09-29T11:00:00.000Z" }
    });
    expect(read?.attempts).toHaveLength(2);
    expect(read?.attempts[0]?.probabilities).toEqual({ spam_or_scam: 0.31, allowed: 0.62, sexual: 0.07 });
    expect(read?.operator).toEqual({ action: "approve_caption", reviewerUserId: "op-1", at: "2026-09-29T11:00:00.000Z", reason: null });
    expect(readShareSnapshot({ kind: "public_report", caption: "Hi" })).toMatchObject({ kind: "public_report", caption: "Hi" });
    expect(readShareSnapshot("junk").kind).toBeNull();
  });
});

describe("ShareReview", () => {
  it("shows the note, the book link and every attempt's distribution highest first", () => {
    const markup = render(report());

    expect(markup).toContain("A bedtime story about a lighthouse keeper&#x27;s cat.");
    expect(markup).toContain('href="https://tomeza.example/s/k3v9q"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("pending review");
    expect(markup).toContain("preview · 6 pages");
    expect(markup).toContain("Gate: no verdict — provider failure");
    expect(markup).toContain("jev/jev-decide-1");
    expect(markup).toContain("Escalated: low probability");
    expect(markup).toContain("timed out");
    const allowed = markup.indexOf("62.0%");
    const spam = markup.indexOf("31.0%");
    const sexual = markup.indexOf("7.0%");
    expect(allowed).toBeGreaterThan(-1);
    expect(allowed).toBeLessThan(spam);
    expect(spam).toBeLessThan(sexual);
    expect(markup).toContain('<li class="is-chosen"><span>allowed</span>');
  });

  it("enables all three actions on a live share with a note", () => {
    const markup = render(report());
    for (const label of ["Approve caption", "Remove caption", "Take down share…"]) {
      expect(buttonTag(markup, label)).not.toContain("disabled");
    }
  });

  it("disables the caption actions when the share has no note", () => {
    const markup = render(report({ share: share({ caption: null, captionStatus: "none", captionVerdict: null }) }));
    expect(markup).toContain("No note on this share.");
    expect(buttonTag(markup, "Approve caption")).toContain("disabled");
    expect(buttonTag(markup, "Remove caption")).toContain("disabled");
    expect(buttonTag(markup, "Take down share…")).not.toContain("disabled");
  });

  it("disables take-down on a share that is already down and shows why it went", () => {
    const markup = render(report({ share: share({ status: "taken_down", takedownReason: "Scam link in the note" }) }));
    expect(buttonTag(markup, "Take down share…")).toContain("disabled");
    expect(buttonTag(markup, "Approve caption")).not.toContain("disabled");
    expect(markup).toContain("Scam link in the note");
  });

  it("locks every action while one is in flight", () => {
    const markup = render(report(), "approve_caption");
    expect(markup).toContain("Approving…");
    expect(buttonTag(markup, "Remove caption")).toContain("disabled");
    expect(buttonTag(markup, "Take down share…")).toContain("disabled");
  });

  it("says so when the share is gone, and offers no share actions", () => {
    const markup = render(report({ share: null }));
    expect(markup).toContain("This share no longer exists");
    expect(markup).toContain("Note when reported");
    expect(markup).not.toContain("Approve caption");
  });
});

describe("postShareModeration", () => {
  it("posts the action, reason and report to the share's moderation route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ share: share({ status: "taken_down" }) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await postShareModeration("share/1", "take_down", " Spam ", "report-1");

    expect(result.status).toBe("taken_down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/admin\/shares\/share%2F1\/moderation$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "take_down", reason: "Spam", reportId: "report-1" });
  });
});

describe("SharingFunnel", () => {
  it("reads the funnel from share to remix book", () => {
    const markup = renderToStaticMarkup(
      <SharingFunnel
        sharing={{ sharesCreated: 12, previewShares: 9, fullShares: 3, pdfViews: 480, remixDrafts: 8, remixBooks: 2 }}
        windowLabel="last 30 days"
      />
    );
    expect(markup).toContain("Sharing");
    expect(markup).toContain("12 · 9 preview / 3 full");
    expect(markup).toContain("480");
    expect(markup).toContain("2 · 25% of drafts");
  });
});
