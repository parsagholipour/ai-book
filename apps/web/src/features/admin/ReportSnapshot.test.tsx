import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportSnapshotView } from "./ReportSnapshot.js";
import { readReportSnapshot, reportHasPicture } from "./reportSnapshots.js";
import type { ModerationReport } from "./types.js";

function report(targetType: string, targetSnapshot: unknown, overrides: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: "report-7",
    reporterUserId: "user-a",
    reporterEmail: "user-a@example.com",
    projectId: null,
    projectTitle: null,
    imageAssetId: null,
    bookShareId: null,
    targetType,
    targetSnapshot,
    reason: "offensive",
    comment: null,
    status: "pending",
    reviewerUserId: null,
    reviewedAt: null,
    reviewNotes: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides
  };
}

function render(subject: ModerationReport): string {
  return renderToStaticMarkup(<ReportSnapshotView report={subject} />);
}

const PICTURE_SRC = "/api/admin/moderation/reports/report-7/picture";

describe("AI-output report snapshots", () => {
  it("renders a creation-chat reply with what was asked, the question and its sources", () => {
    const markup = render(
      report("creation_chat_message", {
        draftId: "draft-1",
        chatTitle: "A lighthouse story",
        chatMessageId: "m-2",
        reply: "Here is a darker take on the keeper.",
        asked: "Make it scarier",
        question: { prompt: "Who is it for?", options: ["Kids", "Adults"] },
        quickReplies: ["Build it"],
        researchSources: [
          { title: "Lighthouse history", url: "https://example.org/lighthouses" },
          { title: "No link", url: "javascript:alert(1)" }
        ]
      })
    );
    expect(markup).toContain("Creation chat · A lighthouse story");
    expect(markup).toContain("Make it scarier");
    expect(markup).toContain("Here is a darker take on the keeper.");
    expect(markup).toContain("Who is it for?");
    expect(markup).toContain("• Adults");
    expect(markup).toContain('href="https://example.org/lighthouses"');
    // A source that is not an http(s) link stays text.
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain("No link");
  });

  it("renders a book-chat reply in the same shape", () => {
    const markup = render(report("chat_message", { reply: "Changed page 4.", asked: "Fix page four" }));
    expect(markup).toContain("Changed page 4.");
    expect(markup).toContain("Fix page four");
    expect(markup).not.toContain("Creation chat");
  });

  it("renders a plan as its card showed it", () => {
    const markup = render(
      report("book_plan", {
        planId: "plan-1",
        version: 2,
        status: "draft",
        title: "The Lighthouse Cat",
        subtitle: "A bedtime story",
        premise: "A cat keeps the light burning.",
        audience: "Children 4-6",
        chapters: [{ index: 1, title: "Night watch", summary: "The keeper falls asleep." }],
        questions: [{ prompt: "How long?", options: ["Short", "Long"] }]
      })
    );
    expect(markup).toContain("version 2");
    expect(markup).toContain("The Lighthouse Cat — A bedtime story");
    expect(markup).toContain("A cat keeps the light burning.");
    expect(markup).toContain("Children 4-6");
    expect(markup).toContain("Night watch");
    expect(markup).toContain("The keeper falls asleep.");
    expect(markup).toContain("How long?");
  });

  it("renders a character picture through the operator picture route", () => {
    const markup = render(
      report("character_image", {
        characterName: "Mira",
        description: "A brave sailor.",
        appearance: "Red coat, short dark hair.",
        imageId: "img-1",
        fileName: "portrait-1.webp",
        drawnAt: "2026-10-11T09:00:00.000Z",
        rewrittenPrompt: "A sailor in a red coat."
      })
    );
    expect(markup).toContain("Saved character · Mira");
    expect(markup).toContain(PICTURE_SRC);
    expect(markup).toContain("A brave sailor.");
    expect(markup).toContain("Red coat, short dark hair.");
    expect(markup).toContain("A sailor in a red coat.");
  });

  it("says plainly when a Studio suggestion's text came from the app", () => {
    const quick = render(
      report("studio_suggestion", {
        origin: "app",
        assistKind: "rewrite",
        request: { instruction: "Make it vivid", selection: "The sea was calm." },
        suggestion: { type: "text", text: "The sea lay still as glass." }
      })
    );
    expect(quick).toContain("Writing Studio · Rewrite");
    expect(quick).toContain("Sent by the app");
    expect(quick).toContain("Make it vivid");
    expect(quick).toContain("The sea was calm.");
    expect(quick).toContain("The sea lay still as glass.");
    expect(quick).not.toContain(PICTURE_SRC);
  });

  it("renders a stored Studio picture, notes and outline", () => {
    const picture = render(
      report("studio_suggestion", {
        origin: "stored",
        assistKind: "illustrate",
        status: "applied",
        request: { prompt: "Mira on the pier" },
        suggestion: { type: "image", url: "/assets/images/p-1/studio-image-as1.webp", filename: "studio-image-as1.webp", alt: "Mira at dusk" }
      })
    );
    expect(picture).toContain(PICTURE_SRC);
    expect(picture).toContain("Mira on the pier");
    expect(picture).toContain("Mira at dusk");
    expect(picture).not.toContain("Sent by the app");

    const notes = render(
      report("studio_suggestion", {
        origin: "stored",
        assistKind: "chapter_feedback",
        suggestion: { type: "notes", notes: [{ quote: "she ran", note: "Tense slips here." }] }
      })
    );
    expect(notes).toContain("Tense slips here.");
    expect(notes).toContain("she ran");

    const outline = render(
      report("studio_suggestion", {
        origin: "stored",
        assistKind: "outline",
        suggestion: { type: "outline", chapters: [{ title: "Arrival", notes: "Mira reaches the island." }] }
      })
    );
    expect(outline).toContain("Arrival");
    expect(outline).toContain("Mira reaches the island.");
  });

  it("reads a malformed snapshot as nothing recorded, and leaves other kinds alone", () => {
    expect(render(report("book_plan", "not an object"))).toContain("Nothing was recorded");
    expect(render(report("studio_suggestion", { suggestion: { type: "mystery" } }))).toContain("Nothing was recorded");
    expect(readReportSnapshot("project", { title: "x" })).toBeNull();
    expect(readReportSnapshot("book_share", {})).toBeNull();
    expect(render(report("image_asset", {}))).toBe("");
    expect(reportHasPicture(readReportSnapshot("studio_suggestion", { suggestion: { type: "text", text: "x" } }))).toBe(false);
  });
});
