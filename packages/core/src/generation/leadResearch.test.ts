import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/mediaSettings.js";
import { RESEARCH_BRIEF_TITLE, RESEARCH_SOURCES_PER_QUERY } from "./planner.js";
import { createLeadResearch, leadResearchNote, leadResearchRows, researchQueriesByChapter, researchScopeBeyondLeads, scopedResearchPlan } from "./leadResearch.js";

const answer = [
  "The official final report of the CPI da Pandemia is available through the Senate's channels.",
  "**Verified Facts:**",
  "*   The final report was approved on October 26, 2021.",
  "*   URL: [https://www25.senado.leg.br/web/atividade/comissoes/cpi](https://www25.senado.leg.br/web/atividade/comissoes/cpi)",
  "*   **Relatório Final (PDF):** [the final report](https://example.org/relatorio.pdf) recommends 80 indictments.",
  "*   The data portal is at https://stats.unctad.org/teu. (Navigate to \"Ports\".)",
  "**Original Document URLs:**"
].join("\n");

describe("leadResearchNote", () => {
  it("opens with the lead's title and keeps no web address", () => {
    const note = leadResearchNote("The CPI da Pandemia final report", answer);
    expect(note.startsWith("The CPI da Pandemia final report: The official final report")).toBe(true);
    expect(note).not.toMatch(/https?:|www\./);
    expect(note).toContain("approved on October 26, 2021");
    expect(note).toContain("**Relatório Final (PDF):** the final report recommends 80 indictments.");
    // A line whose only content was its address goes; a label that labelled nothing but an address goes with it.
    expect(note).not.toMatch(/URL:\s*$/m);
    expect(note).toContain("(Navigate to \"Ports\".)");
    // A header that never held an address is untouched.
    expect(note).toContain("**Original Document URLs:**");
  });

  it("is plain prose without a lead, and nothing when only addresses were left", () => {
    expect(leadResearchNote(undefined, "Plain fact.")).toBe("Plain fact.");
    expect(leadResearchNote("Lead", "https://example.org/a\n[https://example.org/b](https://example.org/b)")).toBe("");
  });
});

describe("leadResearchRows", () => {
  const sources = Array.from({ length: RESEARCH_SOURCES_PER_QUERY + 2 }, (_, index) => ({ title: `site${index}.org`, url: `https://site${index}.org/doc`, summary: `Excerpt ${index}.` }));
  const result = { query: "CPI da Pandemia relatório final 2021 PDF", summary: answer, sources: [{ title: "Gemini grounded summary", summary: "x" }, ...sources] };

  it("stores the answer as an untitled brief under a query carrying the chapter's title, then the cited sources", () => {
    const rows = leadResearchRows({ chapterTitle: "The COVID-19 Presidency", lead: "The CPI report", result });
    expect(rows[0]).toMatchObject({ query: "The COVID-19 Presidency: CPI da Pandemia relatório final 2021 PDF", title: RESEARCH_BRIEF_TITLE });
    expect(rows[0]!.url).toBeUndefined();
    expect(rows[0]!.summary.startsWith("The CPI report: ")).toBe(true);
    expect(rows.slice(1)).toHaveLength(RESEARCH_SOURCES_PER_QUERY);
    expect(rows.slice(1).every((row) => row.url && row.query.includes("The COVID-19 Presidency"))).toBe(true);
  });

  it("keeps a truncated answer's sources and drops its text", () => {
    const rows = leadResearchRows({ chapterTitle: "Ch", lead: "Lead", result: { ...result, truncated: true } });
    expect(rows.some((row) => row.title === RESEARCH_BRIEF_TITLE)).toBe(false);
    expect(rows).toHaveLength(RESEARCH_SOURCES_PER_QUERY);
  });
});

describe("createLeadResearch", () => {
  it("answers the dossier with web addresses and keeps every answer as its chapter's rows, a shared source once", async () => {
    const shared = { title: "gov", url: "https://gov.example/doc", summary: "Shared." };
    const research = createLeadResearch(async (query) => ({ query, summary: `About ${query}.`, sources: [shared, { title: "own", url: `https://own.example/${encodeURIComponent(query)}`, summary: "Own." }] }));
    const second = research.searchFor({ index: 2, title: "Second" });
    const first = research.searchFor({ index: 1, title: "First" });
    expect(await second("b query", "Lead B")).toEqual([{ title: "gov", url: shared.url }, { title: "own", url: "https://own.example/b%20query" }]);
    await first("a query", "Lead A");
    await first("c query", "Lead C");
    const rows = research.rows();
    expect(rows.map((row) => row.query.split(":")[0])).toEqual(["First", "First", "First", "First", "First", "Second", "Second", "Second"]);
    expect(rows.filter((row) => row.url === shared.url)).toHaveLength(2);
    expect(rows.filter((row) => row.title === RESEARCH_BRIEF_TITLE).map((row) => row.summary)).toEqual(["Lead A: About a query.", "Lead C: About c query.", "Lead B: About b query."]);
    expect(research.report()).toEqual({ answers: 3, truncated: 0, notes: 3 });
  });
});

describe("researchScopeBeyondLeads", () => {
  const input = createProjectSchema.parse({ prompt: "A history of Brazil's pension reform", category: "HISTORY", targetPages: 30, language: "en" });
  const base = makeFallbackPlan(input);
  const plan = {
    ...base,
    title: "Bolsonaro in Power",
    chapters: [
      { ...base.chapters[0]!, index: 1, title: "Promises, Reform, and the Economy", summary: "Assesses the pension reform and its fiscal savings in Congress." },
      { ...base.chapters[1]!, index: 2, title: "Environment and Indigenous Rights", summary: "Examines Amazon deforestation enforcement and Indigenous land policy." }
    ],
    researchQueries: [
      "Brazil 2019 pension reform legislation and assessments of fiscal savings in Congress",
      "Brazil Amazon deforestation enforcement and Indigenous land records",
      "Competing assessments of the presidential record from scholars"
    ]
  };

  it("folds a query restating a chapter into it and leaves the rest unmatched", () => {
    const { byChapter, unmatched } = researchQueriesByChapter(plan);
    expect(byChapter.get(1)).toEqual([plan.researchQueries[0]]);
    expect(byChapter.get(2)).toEqual([plan.researchQueries[1]]);
    expect(unmatched).toEqual([plan.researchQueries[2]]);
  });

  it("owes research only for chapters without lead notes and for queries no covered chapter restates", () => {
    expect(researchScopeBeyondLeads(plan, new Set([1]))).toEqual({ chapterIndexes: [2], researchQueries: [plan.researchQueries[2], plan.researchQueries[1]] });
    expect(researchScopeBeyondLeads(plan, new Set([1, 2]))).toEqual({ chapterIndexes: [], researchQueries: [plan.researchQueries[2]] });
  });

  it("narrows the plan an expansion searches and changes nothing else", () => {
    const scoped = scopedResearchPlan(plan, { chapterIndexes: [2], researchQueries: [] });
    expect(scoped.chapters.map((chapter) => chapter.index)).toEqual([2]);
    expect(scoped.researchQueries).toEqual([]);
    expect(scoped.title).toBe(plan.title);
    expect(scoped.researchNotes).toBe(plan.researchNotes);
  });
});
