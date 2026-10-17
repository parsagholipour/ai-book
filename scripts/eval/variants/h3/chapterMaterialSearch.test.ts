// node --import tsx --test scripts/eval/variants/h3/*.test.ts
import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { RESEARCH_BRIEF_TITLE } from "../../../../packages/core/src/generation/planner.ts";
import { chapterResearchQuery, createChapterMaterialSearch, researchQueriesByChapter, type MaterialQuery as ResearchQuery, type MaterialResult as ResearchResult } from "./chapterMaterialSearch.ts";

type Section = { key: string; text: string; urls: string[] };

const source = (url: string) => ({ title: `Title ${url}`, url: `https://${url}`, summary: `about ${url}` });

/** A research adapter whose material answers are scripted per call; other purposes answer with one source named after the query. */
function scriptedResearch(material: Array<Section[] | Error>) {
  const calls: ResearchQuery[] = [];
  let next = 0;
  return {
    calls,
    adapter: {
      async search(query: ResearchQuery): Promise<ResearchResult> {
        calls.push(query);
        if (query.purpose === "chapter-material-search") {
          const answer = material[next++];
          if (!answer) throw new Error("unscripted material call");
          if (answer instanceof Error) throw answer;
          const sources = answer.flatMap((section) => section.urls.map(source));
          return {
            query: query.query,
            summary: answer.map((section) => section.text).join("\n"),
            grounding: { searchQueries: 3, webSources: sources.length },
            sources,
            sections: answer.map((section) => ({ key: section.key, text: section.text, sources: section.urls.map(source) }))
          };
        }
        return { query: query.query, summary: `${query.purpose} brief for ${query.query}`, sources: [source(`${query.purpose}/${query.query.replace(/\W+/g, "-")}`)] };
      }
    }
  };
}

describe("createChapterMaterialSearch", () => {
  it("sends a round's leads in pairs, the background only in the chapter's first prompt", async () => {
    const research = scriptedResearch([
      [{ key: "background", text: "Background prose.", urls: ["bg/1"] }, { key: "lead1", text: "Lead one prose.", urls: ["a/1", "a/2"] }, { key: "lead2", text: "Lead two.", urls: ["b/1"] }],
      [{ key: "lead1", text: "Lead three.", urls: ["c/1"] }],
      [{ key: "lead1", text: "Round two lead.", urls: ["d/1"] }]
    ]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Book Chapter one", alsoCover: ["A plan query"], projectId: "p1" });
    const search = material.forRound(["first lead", "second lead", "third lead"]);
    expect(await Promise.all(["first lead", "second lead", "third lead"].map((lead) => search(lead)))).toEqual([
      [{ title: "Title a/1", url: "https://a/1" }, { title: "Title a/2", url: "https://a/2" }],
      [{ title: "Title b/1", url: "https://b/1" }],
      [{ title: "Title c/1", url: "https://c/1" }]
    ]);
    await material.forRound(["round two lead"])("round two lead");
    expect(research.calls.map((call) => [call.purpose, call.query, call.material])).toEqual([
      ["chapter-material-search", "Book Chapter one", { background: { alsoCover: ["A plan query"] }, leads: ["first lead", "second lead"] }],
      ["chapter-material-search", "Book Chapter one", { leads: ["third lead"] }],
      ["chapter-material-search", "Book Chapter one", { leads: ["round two lead"] }]
    ]);
    expect(research.calls.every((call) => call.projectId === "p1")).toBe(true);
    expect(material.report()).toMatchObject({ prompts: 3, failed: 0, leadFallbacks: 0, briefFallback: false });
  });

  it("searches a lead alone when its section cited nothing, once however often it is asked", async () => {
    const research = scriptedResearch([[{ key: "background", text: "Background.", urls: ["bg/1"] }, { key: "lead1", text: "Nothing found.", urls: [] }]]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Topic" });
    const search = material.forRound(["quiet lead"]);
    const [first, second] = await Promise.all([search("quiet lead"), search("quiet lead")]);
    expect(first).toEqual([{ title: "Title case-source-search/quiet-lead", url: "https://case-source-search/quiet-lead" }]);
    expect(second).toEqual(first);
    expect(research.calls.filter((call) => call.purpose === "case-source-search")).toHaveLength(1);
    expect(material.report()).toMatchObject({ leadFallbacks: 1, perLead: [{ lead: "quiet lead", sources: 0 }, { lead: "quiet lead", sources: 0 }] });
  });

  it("falls back to today's searches when the material prompt fails: each lead alone, the brief from chapter-research", async () => {
    const research = scriptedResearch([new Error("socket hang up")]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Topic", alsoCover: ["Plan query"] });
    const search = material.forRound(["lead a", "lead b"]);
    expect(await search("lead a")).toHaveLength(1);
    expect(await search("lead b")).toHaveLength(1);
    const rows = await material.research();
    expect(rows.filter((row) => row.title === RESEARCH_BRIEF_TITLE).map((row) => [row.query, row.summary])).toEqual([
      ["Topic", "chapter-research brief for Topic"],
      ["Plan query", "chapter-research brief for Plan query"]
    ]);
    expect(material.report()).toMatchObject({ prompts: 1, failed: 1, leadFallbacks: 2, briefFallback: true });
  });

  it("rethrows a stop rather than falling back", async () => {
    const stop = Object.assign(new Error("Generation stop requested"), { name: "StopRequestedError" });
    const research = scriptedResearch([stop]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Topic" });
    await expect(material.forRound(["lead"])("lead")).rejects.toBe(stop);
    expect(research.calls).toHaveLength(1);
  });

  it("answers a query that is not one of the round's leads by searching it alone", async () => {
    const research = scriptedResearch([[{ key: "background", text: "B.", urls: ["bg/1"] }, { key: "lead1", text: "L.", urls: ["a/1"] }]]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Topic" });
    await material.forRound(["lead"])("something else");
    expect(research.calls.map((call) => call.purpose)).toEqual(["chapter-material-search", "case-source-search"]);
  });

  it("stores every answered section as a brief and the cited sources once each, under the chapter topic", async () => {
    const many = Array.from({ length: 12 }, (_, index) => `x/${index}`);
    const research = scriptedResearch([
      [{ key: "background", text: "Background prose.", urls: ["bg/1", "a/1"] }, { key: "lead1", text: "Lead prose.", urls: ["a/1", ...many] }, { key: "lead2", text: "  ", urls: [] }],
      [{ key: "lead1", text: "Third lead prose.", urls: ["a/1", "c/1"] }]
    ]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Topic" });
    const search = material.forRound(["l1", "l2", "l3"]);
    await Promise.all(["l1", "l2", "l3"].map((lead) => search(lead)));
    const rows = await material.research();
    expect(rows.every((row) => row.query === "Topic")).toBe(true);
    expect(rows.filter((row) => row.title === RESEARCH_BRIEF_TITLE).map((row) => row.summary)).toEqual(["Background prose.", "Lead prose.", "Third lead prose."]);
    const urls = rows.flatMap((row) => (row.url ? [row.url] : []));
    expect(new Set(urls).size).toBe(urls.length);
    // Eight per answer: the first answer's fifteen citations stop at eight, the second adds its one new address.
    expect(urls).toHaveLength(9);
    expect(urls.at(-1)).toBe("https://c/1");
    expect(material.report().briefFallback).toBe(false);
  });

  it("asks chapter-research for the background when no prompt ran, as when the dossier's deadline passed first", async () => {
    const research = scriptedResearch([]);
    const material = createChapterMaterialSearch({ research: research.adapter, topic: "Topic" });
    const rows = await material.research();
    expect(research.calls.map((call) => call.purpose)).toEqual(["chapter-research"]);
    expect(rows[0]).toMatchObject({ query: "Topic", title: RESEARCH_BRIEF_TITLE });
  });
});

describe("researchQueriesByChapter", () => {
  const plan = {
    title: "Bolsonaro in Power",
    researchQueries: [
      "Brazil 2019 pension reform legislation and assessments of its provisions and economic effects",
      "Competing assessments of the presidential record from scholars",
      "Current verified status of legal proceedings concerning Bolsonaro",
      "Brazil 2019 pension reform legislation and assessments of its provisions and economic effects"
    ],
    chapters: [
      { index: 1, title: "The Political Career", summary: "Military background and decades in elected office.", keyBeats: [], targetPages: 6 },
      { index: 4, title: "Promises, Reform, and the Economy", summary: "Assesses the economic program: the pension reform achieved and the plans constrained.", keyBeats: [], targetPages: 6 }
    ]
  };

  it("folds a query into the chapter it restates and leaves the rest to their own search", () => {
    const { byChapter, unmatched } = researchQueriesByChapter(plan as never);
    expect([...byChapter]).toEqual([[4, ["Brazil 2019 pension reform legislation and assessments of its provisions and economic effects"]]]);
    expect(unmatched).toEqual(["Competing assessments of the presidential record from scholars", "Current verified status of legal proceedings concerning Bolsonaro"]);
  });

  it("drops a query that is a chapter's own research topic", () => {
    const own = chapterResearchQuery(plan, plan.chapters[1]!);
    const { byChapter, unmatched } = researchQueriesByChapter({ ...plan, researchQueries: [own] } as never);
    expect(byChapter.size).toBe(0);
    expect(unmatched).toEqual([]);
  });
});
