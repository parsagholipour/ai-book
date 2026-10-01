import { exampleCastMemberSchema, type ExampleCastMember } from "../schemas/exampleCast.js";
import { isRecord } from "../schemas/jsonCoercion.js";

/**
 * The recurring example people of a guide or a workbook, planned once with the
 * chapter forms and handed to every chapter.
 *
 * Each chapter used to invent its own example people, so a name came back in
 * a later chapter as somebody else: "Lena is an illustrator in chapter 1 and a
 * translator in chapter 6", "Maya is preparing a customer launch in chapter 2,
 * then a product designer on an onboarding redesign in chapter 3" — blind
 * readers named it in four of the 2026-09-30 Quick Draft books. A cast is a
 * content assignment, the lever that moves here: two to four people, each with
 * one fixed role, named by the sections that use them. Only surface
 * consistency is asked for — a name keeps its job — not a biography.
 */
export { exampleCastMemberSchema, exampleCastSchema, type ExampleCastMember } from "../schemas/exampleCast.js";

const MAX_CAST = 4;

export const EXAMPLE_CAST_RULE =
  "Also return cast: two to four recurring example people this book's scenarios and worked examples follow, each {name, role}, where role is one fixed situation stated in a clause — a job, a business, a household. A section that uses an example person names them from cast in its owns, and a person keeps the same role in every chapter. A one-off example person gets a name not in cast.";

export const FIXED_EXAMPLE_CAST_RULE =
  "exampleCast is the cast the book's earlier chapters already use: keep every person in the same role, name them in owns where a section uses them, and return exampleCast unchanged as cast.";

/** The cast in a planner reply: at most four, unique names, each with a role; anything unreadable is no cast. */
export function exampleCastFrom(raw: unknown): ExampleCastMember[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.cast)) return undefined;
  const seen = new Set<string>();
  const cast: ExampleCastMember[] = [];
  for (const entry of raw.cast) {
    const member = exampleCastMemberSchema.safeParse(entry);
    if (!member.success) continue;
    const key = member.data.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cast.push(member.data);
    if (cast.length === MAX_CAST) break;
  }
  return cast.length > 0 ? cast : undefined;
}

/** The writer's and the editor's line: the cast, each in the one role they keep. */
export function exampleCastLines(cast: readonly ExampleCastMember[] | undefined): string[] {
  if (!cast?.length) return [];
  return [
    `The book's recurring example people, each in one fixed role in every chapter: ${cast.map((member) => `${member.name} (${member.role})`).join("; ")}. When an example needs a person, use one of them in that role; never give one of these names a different job, business or situation. A one-off person gets a name not on this list.`
  ];
}

/**
 * A toolkit chapter's cast line (`instructionalBook.ts`): whom the reader meets
 * here, with their role said once, and whom they already know by name alone.
 * One workbook introduced "Lena, a freelance illustrator" six times.
 */
export function exampleCastLinesForChapter(cast: readonly ExampleCastMember[] | undefined, chapterIndex: number): string[] {
  if (!cast?.length) return [];
  const described = cast.map((member) => {
    const introduced = member.introducedIn ?? 1;
    const when = introduced === chapterIndex
      ? "the reader meets them in this chapter: say who they are once, where they first appear"
      : introduced < chapterIndex
        ? "the reader already knows them: use the name alone and never re-introduce them"
        : "introduced in a later chapter: do not use them here";
    return `${member.name} (${member.role.replace(/[.\s]+$/u, "")}; ${when})`;
  });
  return [
    `The book's recurring example people, each in one fixed role in every chapter: ${described.join("; ")}. When an example needs a person, use one of them in that role; never give one of these names a different job, business or situation. A one-off person gets a name not on this list.`
  ];
}
