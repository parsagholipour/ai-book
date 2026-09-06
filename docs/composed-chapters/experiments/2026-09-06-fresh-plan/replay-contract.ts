/** Replay the shipped plan contract (planContract.ts) over the stored plans of candidates 2, 3 and 5: what it flags, drops and blanks. `pnpm exec tsx docs/composed-chapters/experiments/2026-09-06-fresh-plan/replay-contract.ts` */
import { readFileSync } from "node:fs";
import { bookEpisodesSchema } from "../../../../packages/core/src/schemas/episodes.js";
import { applyFocusContract, chapterStyleNotes, episodeCollisions, focusContractIssues, focusFeedbackLines, stanceIsMethodShaped } from "../../../../packages/core/src/generation/planContract.js";
const root = "/run/media/parsa/projects/ravanix-book/ai-book-maker";
for (const [name, path] of [["plan-5", `${root}/docs/composed-chapters/experiments/2026-09-06-fresh-plan/plan-5-complete.json`], ["plan-3", `${root}/docs/composed-chapters/experiments/2026-09-05-whole-book/plan-3-complete.json`], ["plan-2", `${root}/docs/composed-chapters/experiments/2026-09-05-whole-book/plan-2-complete.json`]]) {
  const p = JSON.parse(readFileSync(path, "utf8"));
  const eps = bookEpisodesSchema.parse(p.episodes);
  const issues = focusContractIssues(eps);
  const coll = episodeCollisions(eps);
  const applied = applyFocusContract(eps);
  const byKind = issues.reduce((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {} as Record<string, number>);
  console.log(`## ${name}: issues ${JSON.stringify(byKind)}; collisions ${coll.map((c) => `${c.earlier.chapterIndex}~${c.later.chapterIndex}[${c.shared.join(",")}]`).join(" ")}`);
  console.log(`   stanceMethodShaped=${stanceIsMethodShaped(p.authorStance)}; styleNotes kept ${chapterStyleNotes(p.voiceGuide).length}/${p.voiceGuide.length}`);
  console.log(`   applied: dropped ${applied.dropped.map((d) => `ch${d.chapterIndex}:"${d.title.slice(0, 30)}"`).join(", ") || "none"}; blanked ${applied.blanked.length}; parses=${bookEpisodesSchema.safeParse(applied.episodes).success}`);
  const fb = focusFeedbackLines(issues, coll);
  console.log(`   feedback lines: ${fb.length}; first: ${fb[0]?.slice(0, 200)}`);
}
const flat = JSON.parse(readFileSync(`${root}/docs/composed-chapters/rubrics/stance-positions-flat.json`, "utf8"));
console.log("flat positions method-shaped?", stanceIsMethodShaped({ thesis: "Violence in history is organised before it is felt.", positions: flat }));
