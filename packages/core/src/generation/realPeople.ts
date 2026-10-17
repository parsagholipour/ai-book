/**
 * What every planner prompt has to be told about a real person the reader names, because no
 * prompt said anything and the models filled the silence with a rename. "A 10 page book about
 * Neymar and a poor girl, she's a waitress" (2026-10-17) came back from the creation chat as
 * "I'll write the footballer as a fictional star inspired by that world", the brief's mustInclude
 * said he was not a real person, and the planner obeyed it: the book's footballer became "Rafael
 * Vale", under four rules forbidding Neymar's name. The owner's decision is that a reader may have
 * a story about a real person, a romance included, under that person's own name. The page writers
 * already tell an invented scene from a stated fact (`pagesShared.ts`, `claimVerifier.ts`), so this
 * only has to stop the rename. The creation chat and the brief advisor carry their own wording of
 * it (`apps/api/src/mobileCreation.ts`, `mobileCreationAdvisor.ts`), since they write a brief, not
 * a plan.
 */
export const REAL_PEOPLE_KEEP_THEIR_NAMES_RULE =
  "A real person the request names - an athlete, a singer, an actor, a politician, any public figure - is that person in this book, under the same name, in fiction and romance as much as in nonfiction. Never replace them with an invented stand-in, give them another name, or add a voice, style, continuity or illustration rule against using their name; do that only when the request itself asks for a fictional version. Invented scenes, dialogue and relationships with them are the story the reader asked for; anything the book states as a fact about their real life must still be true.";
