/**
 * H3 blind pairs: for every chapter of every book the H3 eval ran, the research notes the writer would be
 * handed under today's pipeline (draw 1) against the merged one, as `loadResearchNotesForGeneration` ranks
 * them and `chapterResearchNotesForPrompt` fits them (computed by `container/h3-material.ts`).
 *
 *   pnpm exec tsx scripts/eval/h3-pairs.ts --set h3.briefs [--books id,id] [--candidate merged|leads]
 * H3b (2026-10-16) is `--candidate leads --set h3b.notes`: today's notes against the lead answers.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, readJson } from "./lib/fixtures.ts";
import { buildPairSet, type PairInput } from "./lib/pairs.ts";

type Result = {
  summary: { projectId: string; title: string };
  chapters: Array<{ index: number; title: string; writerNotes: string[] }>;
};
type StoredPlan = { planningPackage: { title: string; chapters: Array<{ index: number; title: string; summary: string }>; episodes?: { chapters: Array<{ index: number; episodes: Array<{ title: string; why?: string }> }> } }; inputSnapshot: { prompt?: string } };

const argv = process.argv.slice(2);
const arg = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const root = dataDir();
const set = arg("set") ?? "h3.briefs";
const candidate = arg("candidate") ?? "merged";
const dir = join(root, "results", "h3");
const books = (arg("books")?.split(",") ?? readdirSync(dir).filter((file) => file.endsWith(`__${candidate}__d1.json`)).map((file) => file.split("__")[0]!)).sort();

const render = (notes: string[]) => notes.length === 0 ? "(no research notes)" : notes.map((note, index) => `### Note ${index + 1}\n\n${note.trim()}`).join("\n\n");

const pairs: PairInput[] = [];
for (const book of books) {
  const todayPath = join(dir, `${book}__today__d1.json`);
  const mergedPath = join(dir, `${book}__${candidate}__d1.json`);
  if (!existsSync(todayPath) || !existsSync(mergedPath)) continue;
  const today = readJson<Result>(todayPath);
  const merged = readJson<Result>(mergedPath);
  const plan = readJson<StoredPlan>(join(root, "plans", `${book}.json`)).planningPackage;
  // --per-book N: N chapters spread evenly through each book (a screen); all chapters without it.
  const perBook = Number(arg("per-book") ?? "0");
  const picked = perBook > 0 && today.chapters.length > perBook
    ? today.chapters.filter((_, index) => Math.floor((index * perBook) / today.chapters.length) !== Math.floor(((index - 1) * perBook) / today.chapters.length) || index === 0)
    : today.chapters;
  for (const chapter of picked) {
    const other = merged.chapters.find((entry) => entry.index === chapter.index);
    if (!other) continue;
    const planned = plan.chapters.find((entry) => entry.index === chapter.index)!;
    const leads = plan.episodes?.chapters.find((entry) => entry.index === chapter.index)?.episodes ?? [];
    pairs.push({
      pairId: `${book.slice(-8)}-c${String(chapter.index).padStart(2, "0")}`,
      textA: render(chapter.writerNotes),
      textB: render(other.writerNotes),
      labelA: "today",
      labelB: candidate,
      fixtureId: `${book}:${chapter.index}`,
      brief: [
        `Book: "${plan.title}".`,
        `Chapter ${chapter.index}: "${planned.title}". ${planned.summary}`,
        ...(leads.length ? ["The chapter's planned cases and documents:", ...leads.slice(0, 3).map((lead) => `- ${lead.title}${lead.why ? ` — ${lead.why}` : ""}`)] : []),
        "",
        "Each version is the list of research notes the chapter's writer is handed. The writer also receives verbatim source passages separately; judge only these notes."
      ].join("\n")
    });
  }
}
const key = buildPairSet(root, set, "research", pairs, { evalName: candidate === "merged" ? "h3" : "h3b", reference: "today", candidate });
console.log(`pair set ${set}: ${key.pairs.length} pairs, ${key.pairs.filter((pair) => !pair.identical).length} to judge`);
