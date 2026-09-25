import { describe, expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";

const pages = Array.from({ length: 30 }, (_, index) => ({ index: index + 1, title: `Page ${index + 1}`,
  markdown: `Rabbit and Wise Turtle carry lantern ${index + 1} toward the village.`, summary: `Scene ${index + 1}.` }));
const checks = { pageModelReview: true, storyExtractAudit: true, styleAuditor: true };
const response = () => ({ pages: pages.map((page) => ({ pageIndex: page.index, score: 96, findings: [],
  storyExtract: { storyDelta: {}, contradictions: [] }, styleAudit: { styleOk: true, styleIssues: [], evidence: [] } })) });
const setup = (answer: unknown = response()) => {
  const generateJson = vi.fn(async <T>(options: GenerateJsonOptions<T>) => ({
    data: parseSchemaWithContext("Fixture", options.schema, answer, options.purpose, JSON.stringify(answer))
  }));
  const options = { input: { category: "KIDS", targetPages: 30, prompt: "Recover all four lanterns before moonrise. Both Rabbit and Wise Turtle grow.", language: "en", mediaSettings: {} },
    plan: { title: "The Lantern Path", premise: "A lantern search.", audience: "children", chapters: [], characters: [], promises: [], voiceGuide: [] },
    pages, chapterBriefs: [], checks, textModel: { generateJson } as unknown as TextModelAdapter } as unknown as Parameters<typeof reviewPictureBookManuscript>[0];
  return { options, generateJson };
};

describe("complete picture-book review", () => {
  it("uses one configured reviewer call for thirty pages and every enabled check", async () => {
    const { options, generateJson } = setup();
    options.plan.continuityRules = ["Turtle initially refuses the short route; tests Rabbit's idea at the fork; later trusts Rabbit to lead."];
    const result = await reviewPictureBookManuscript(options);
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(generateJson.mock.calls[0]![0]).toMatchObject({ purpose: "review-page", maxTokens: 24_000 });
    expect(result).toHaveLength(30);
    expect(result.every((page) => page.report.approved && page.storyExtract !== null && page.styleAudit !== null)).toBe(true);
    expect(result[0]).toMatchObject({ draftMarkdown: pages[0]!.markdown, completedChecks: checks });
    const prompt = generateJson.mock.calls[0]![0].messages.map((message) => message.content).join("\n");
    expect(prompt).toContain(options.input.prompt);
    expect(prompt).toContain(pages[29]!.markdown);
    expect(prompt).toContain("not facts about later chronology");
    expect(prompt).toContain("each named protagonist's distinct requested growth");
    expect(prompt).toContain("Before assigning page verdicts");
    expect(prompt).toContain("already helpful mentor");
    expect(prompt).toContain("removing a repeated scene");
    expect(JSON.parse(generateJson.mock.calls[0]![0].messages.find((message) => message.role === "user")!.content).book.continuityRules).toEqual(options.plan.continuityRules);
  });

  it("accepts explicit compact clean checks without permitting omitted checks", async () => {
    const answer = response();
    for (const page of answer.pages) Object.assign(page, { storyExtract: "no_changes", styleAudit: "clean" });
    const { options, generateJson } = setup(answer);
    const result = await reviewPictureBookManuscript(options);
    expect(result.every((page) => page.storyExtract?.contradictions.length === 0 && page.styleAudit?.styleOk)).toBe(true);
    expect(JSON.stringify(answer).length).toBeLessThan(3_500);
    expect(generateJson.mock.calls[0]![0].messages[0]!.content).toContain("never retell or quote clean prose");
  });

  it("leaves editorial judgment with the contextual reviewer when questions recur", async () => {
    const { options, generateJson } = setup();
    options.pages = pages.map((page) => ({ ...page, markdown: `${page.markdown} “Which way now?”` }));
    const result = await reviewPictureBookManuscript(options);
    expect(result.every((page) => page.report.approved)).toBe(true);
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(generateJson.mock.calls[0]![0].messages[0]!.content).toContain("not defects by frequency alone");
    const payload = JSON.parse(generateJson.mock.calls[0]![0].messages.find((message) => message.role === "user")!.content);
    expect(payload.pageTurnSignals.questionEndingPageIndexes).toEqual(pages.map((page) => page.index));
  });

  it("points to question endings across writing systems without treating interior questions as endings", async () => {
    const { options, generateJson } = setup();
    const endings = ["Where next?", "«کجا؟»", "「どこ？」", "**Which way?**", "Where now? Rabbit chose the bridge."];
    options.pages = pages.map((page, i) => ({ ...page, markdown: endings[i] ?? page.markdown }));
    await reviewPictureBookManuscript(options);
    const payload = JSON.parse(generateJson.mock.calls[0]![0].messages.find((message) => message.role === "user")!.content);
    expect(payload.pageTurnSignals.questionEndingPageIndexes).toEqual([1, 2, 3, 4]);
  });

  it("does not add the development review or plan contracts when only story extraction is enabled", async () => {
    const answer = response();
    for (const page of answer.pages) Object.assign(page, { styleAudit: null });
    const { options, generateJson } = setup(answer);
    options.checks = { pageModelReview: false, storyExtractAudit: true, styleAuditor: false };
    options.plan.continuityRules = ["A proposed character arc."];
    await reviewPictureBookManuscript(options);
    const request = generateJson.mock.calls[0]![0];
    expect(request.purpose).toBe("extract-story-state");
    expect(request.messages[0]!.content).not.toContain("Before assigning page verdicts");
    expect(JSON.parse(request.messages.find((message) => message.role === "user")!.content).book).not.toHaveProperty("continuityRules");
    expect(JSON.parse(request.messages.find((message) => message.role === "user")!.content)).not.toHaveProperty("pageTurnSignals");
  });

  it("rejects a cached generic approval as proof of sentence-repair meaning preservation", async () => {
    const { options, generateJson } = setup();
    const reviews = await reviewPictureBookManuscript(options);
    generateJson.mockClear();
    await expect(reviewPictureBookManuscript({ ...options,
      repairContext: { sentenceOnly: true, issues: [], changes: [{ pageIndex: 1, originalMarkdown: "An earlier sentence.", reason: "Split a sentence." }] },
      resume: { version: 2, reviews, unresolvedPageIndexes: [], validationIssues: [], protocolIssues: [],
        roundsStarted: 1, attemptsUsed: 1, outputWidened: false }
    })).rejects.toThrow("does not match");
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("normalizes Premium's misplaced unansweredResolved without retrying thirty reviews", async () => {
    const answer = response();
    Object.assign(answer.pages[25]!.storyExtract, { unansweredResolved: ["Where is the sixth lantern?"], unansweredAdded: ["Can everyone reach the picnic?"] });
    const { options, generateJson } = setup(answer);
    const result = await reviewPictureBookManuscript(options);
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(result[25]!.storyExtract?.storyDelta.unansweredResolved).toEqual(["Where is the sixth lantern?"]);
    expect(result[25]!.storyExtract?.storyDelta.unansweredAdded).toEqual(["Can everyone reach the picnic?"]);
  });

  it.each(["conflicting", "unknown"])("keeps %s extraction fields invalid", async (kind) => {
    const answer = response();
    if (kind === "conflicting") Object.assign(answer.pages[25]!.storyExtract, {
      unansweredResolved: ["First question"], storyDelta: { unansweredResolved: ["Different question"] }
    });
    else Object.assign(answer.pages[25]!.storyExtract, { answered: ["Unknown alias"] });
    await expect(reviewPictureBookManuscript(setup(answer).options)).rejects.toThrow();
  });

  it("keeps proven object-count contradictions and omitted requested character growth actionable", async () => {
    const answer = response();
    const current = answer.pages[14]!;
    Object.assign(current, { findings: [{ domain: "prose", basis: "cross_page", requirementQuote: null, category: "continuity",
      message: "The story calls another recovered lantern the first one.", guidance: "Keep the previously recovered lantern in the count.",
      quote: pages[14]!.markdown, relatedEvidence: [{ pageIndex: 12, quote: pages[11]!.markdown }] }] });
    Object.assign(answer.pages[29]!, { findings: [{ domain: "prose", basis: "missing_requirement", requirementQuote: "Both Rabbit and Wise Turtle grow.", category: "arc",
      message: "Wise Turtle's requested change has no payoff.", guidance: "Give Turtle a distinct changed choice in the final scene.",
      quote: pages[29]!.markdown, relatedEvidence: [] }] });
    const { options } = setup(answer);
    const result = await reviewPictureBookManuscript(options);
    expect(result.filter((page) => !page.report.approved).map((page) => page.pageIndex)).toEqual([15, 30]);
    expect(result[29]!.report.requiredRevisions).toContain("Give Turtle a distinct changed choice in the final scene.");
    expect(result[14]!.report.checks.progressionOk).toBe(false);
    expect(result[14]!.report.issues[0]).toContain(pages[11]!.markdown);
    expect(result[29]!.report.issues[0]).toContain("Both Rabbit and Wise Turtle grow.");
  });

  it("keeps clean original recovery scenes while locating the real later neighbor reset", async () => {
    // Minimal original-draft excerpts from the premium acceptance fixture. The
    // old per-page polish introduced a first-lantern contradiction on page 14.
    const originals = [
      { index: 12, markdown: "Wise Turtle returned to Rabbit and pointed out the bent ferns. “I think the wind pushed lights downhill,” Turtle said. “I’m not sure yet.”" },
      { index: 14, markdown: "Rabbit eased the lantern handle from beneath the root. It slid free with a soft scrape. “Got it!” Rabbit called, lifting it clear of the leaves." },
      { index: 24, markdown: "The neighbors kept the path clear while Rabbit returned to the bank. Rabbit moved the reeds aside." },
      { index: 27, markdown: "Rabbit returned to Creek Hollow and pointed to the lit path. The neighbors gathered their baskets and followed." }
    ].map((page) => ({ ...page, title: `Page ${page.index}`, summary: "" }));
    const answer = { pages: originals.map((page) => ({ pageIndex: page.index, score: 95, findings: page.index === 27 ? [{
      domain: "prose", basis: "cross_page", requirementQuote: null, category: "continuity", message: "The neighbors reset to Creek Hollow without returning.",
      guidance: "Continue with the neighbors already at the bank; establish any necessary return.", quote: page.markdown,
      relatedEvidence: [{ pageIndex: 24, quote: originals[2]!.markdown }]
    }] : [], storyExtract: "no_changes", styleAudit: "clean" })) };
    const { options } = setup(answer); options.pages = originals;
    const result = await reviewPictureBookManuscript(options);
    expect(result.filter((page) => !page.report.approved).map((page) => page.pageIndex)).toEqual([27]);
    expect(result.slice(0, 2).map((page) => page.draftMarkdown)).toEqual(originals.slice(0, 2).map((page) => page.markdown));
    expect(result[3]!.report.issues[0]).toContain(originals[2]!.markdown);
  });

  it.each(["missing", "duplicate", "unquoted", "inventedRequirement", "missingStyleAssessment"])("rejects %s evidence instead of filling in approval", async (kind) => {
    const answer = response();
    if (kind === "missing") answer.pages.pop();
    else if (kind === "duplicate") answer.pages[29]!.pageIndex = 1;
    else if (kind === "missingStyleAssessment") Object.assign(answer.pages[0]!, { styleAudit: {} });
    else Object.assign(answer.pages[0]!, { findings: [{ domain: "prose", basis: kind === "inventedRequirement" ? "missing_requirement" : "page_prose",
      requirementQuote: kind === "inventedRequirement" ? "A dragon must appear." : null, category: "plot",
      message: "Invented defect", guidance: "Change the story", quote: kind === "unquoted" ? "This sentence does not exist in the book." : pages[0]!.markdown, relatedEvidence: [] }] });
    const { options, generateJson } = setup(answer);
    await expect(reviewPictureBookManuscript(options)).rejects.toThrow();
    expect(generateJson.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("requires enabled extraction results and refuses to claim a disabled check ran", async () => {
    const answer = response();
    Object.assign(answer.pages[0]!, { storyExtract: null });
    await expect(reviewPictureBookManuscript(setup(answer).options)).rejects.toThrow();
    const noExtract = setup(response());
    noExtract.options.checks = { ...checks, storyExtractAudit: false };
    await expect(reviewPictureBookManuscript(noExtract.options)).rejects.toThrow();
  });

  it("propagates cancellation without a repair request", async () => {
    const { options, generateJson } = setup();
    generateJson.mockRejectedValue(Object.assign(new Error("stopped"), { name: "AbortError" }));
    await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "AbortError" });
    expect(generateJson).toHaveBeenCalledTimes(1);
  });
});
