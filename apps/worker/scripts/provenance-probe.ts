/**
 * Provenance probe: which proper nouns in a generated book appear in nothing
 * the writer was given — not the plan, not the research notes, not the user's
 * prompt. Those are the particulars the model supplied itself, and a blind
 * reader cannot tell them from sourced ones. Deterministic, reads the run log
 * through the worker container's storage:
 *
 *   docker exec ai-book-maker-worker-1 pnpm -F @book-maker/worker exec tsx scripts/provenance-probe.ts <projectId> [<label>]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../../../packages/db/src/index.ts";

const projectId = process.argv[2];
const label = process.argv[3];
if (!projectId) {
  console.error("usage: provenance-probe.ts <projectId> [<run label for book.md>]");
  process.exit(1);
}

const STOP = new Set(
  "The A An In On At By For From To With Of And Or But Nor Yet So If When Where While Whether That This These Those It Its They Their Them He She His Her We Our You Your Who Whom Which What How Why Not No Nothing None Neither Either Each Every Some Any All Both Such Only Even Still Again Once Here There Now Then Than After Before During Against Between Among Through Without Within Under Over Above Below Beyond Toward Towards Into Onto Upon About Around Across Along Because Although Though Since Until Unless Whereas Rather Instead However Therefore Thus Hence Also Perhaps Chapter Part Section Page First Second Third Fourth Fifth Sixth Seventh Eighth Ninth Tenth One Two Three Four Five Six Seven Eight Nine Ten Hundred Thousand Million Century Centuries Empire Emperor King Queen Kingdom Republic State States Church Christian Christians Muslim Muslims Jewish Jews Roman Romans Greek Greeks European Europeans African Africans Asian American Americans Indian Indians Arab Arabs Persian Persians Chinese Japanese British English French German Germans Spanish Portuguese Dutch Italian Russian Russians Ottoman Ottomans Mongol Mongols Turkish Turks Egyptian Egyptians Mesopotamian Assyrian Assyrians Babylonian Babylonians Sumerian Sumerians Aztec Aztecs Inca Incas Maya Mayan North South East West Northern Southern Eastern Western Middle Ages Age Medieval Modern Ancient Early Late New Old Great Holy Saint St Mr Mrs Dr Lord Lady Sir General Captain Major Colonel Admiral Bishop Pope Duke Count Prince Princess".split(
    " "
  )
);

function properNouns(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const tokens = sentence.match(/\b[A-Z][a-zA-Z'’-]+(?:\s+(?:of|de|del|della|von|van|al|ibn|le|la|du|des)?\s*[A-Z][a-zA-Z'’-]+)*/g) ?? [];
    for (const [index, token] of tokens.entries()) {
      // Skip a lone sentence-initial capital, which is grammar rather than a name.
      const trimmed = token.trim();
      if (index === 0 && !trimmed.includes(" ") && sentence.trimStart().startsWith(trimmed)) continue;
      const words = trimmed.split(/\s+/).filter((word) => !STOP.has(word));
      if (words.length === 0) continue;
      const key = words.join(" ");
      if (key.length < 4) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const runsDir = `/app/storage/books/${projectId}/runs`;
const logs = readdirSync(runsDir).filter((name) => name.endsWith(".jsonl"));
const given: string[] = [];
let bookText = "";
for (const name of logs) {
  for (const line of readFileSync(join(runsDir, name), "utf8").split("\n")) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.event === "research.search.response") {
      given.push(JSON.stringify(event.result ?? event.response ?? {}));
    }
    if (event.event === "text.generateText.request" || event.event === "text.generateJson.request") {
      const request = event.request as { purpose?: string; messages?: { role: string; content: string }[] } | undefined;
      // Everything the writer was shown counts as given: the payload carries the plan, the notes and the digests.
      if (request?.purpose === "compose-chapter" || request?.purpose === "edit-chapter") {
        for (const message of request.messages ?? []) {
          if (message.role === "user") {
            try {
              const payload = JSON.parse(message.content) as Record<string, unknown>;
              delete payload.draft;
              delete payload.earlierChapters;
              delete payload.previousChapterTail;
              given.push(JSON.stringify(payload));
            } catch {
              given.push(message.content);
            }
          }
        }
      }
    }
  }
}
const plan = await prisma.planVersion.findFirst({ where: { projectId, status: "APPROVED" }, orderBy: { version: "desc" } });
if (plan) {
  given.push(JSON.stringify(plan.planningPackage));
  given.push(JSON.stringify(plan.inputSnapshot ?? {}));
}
const pages = await prisma.page.findMany({ where: { projectId }, orderBy: { index: "asc" }, select: { markdown: true } });
bookText = pages.map((page) => page.markdown).join("\n\n");
if (label) {
  try {
    bookText = readFileSync(`/app/.scratch/composed-chapters/runs/${label}/book.md`, "utf8");
  } catch {
    // fall back to the stored pages
  }
}
const haystack = fold(given.join("\n"));
const nouns = properNouns(bookText);
const unsourced: [string, number][] = [];
let sourcedCount = 0;
for (const [noun, count] of nouns) {
  const key = fold(noun);
  const words = key.split(" ");
  const sourced = haystack.includes(key) || words.every((word) => word.length < 4 || haystack.includes(word));
  if (sourced) sourcedCount += 1;
  else unsourced.push([noun, count]);
}
unsourced.sort((a, b) => b[1] - a[1]);
console.log(
  `${projectId}: ${nouns.size} distinct proper nouns; ${sourcedCount} found in what the writer was given; ${unsourced.length} (${Math.round((100 * unsourced.length) / Math.max(1, nouns.size))}%) supplied by the model`
);
console.log("Most used unsourced:", unsourced.slice(0, 40).map(([noun, count]) => `${noun}×${count}`).join(", "));
await prisma.$disconnect();
process.exit(0);
