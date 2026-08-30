import { type BookEditIntent } from "../bookEditIntent.js";
import { type ReaderPageNumbering } from "../bookPageNumbering.js";
import { type StructuralCardPlan } from "./pendingEditState.js";
import { type ProjectForChat } from "./projectChat.js";
import {
  MAX_DELETED_PAGES,
  MAX_INSERTED_PAGES,
  MAX_MOVED_PAGES,
  STRUCTURAL_ACTION_PREFIX_PATTERN,
  STRUCTURAL_PAGE_SELECTION_PATTERN,
  STRUCTURAL_WHOLE_BOOK_TAIL_PATTERN,
  isBareStructuralInstruction,
  structuralEditRequiresWholeBookGeneration,
  type ExistingPage,
  type StructuralPageEdit,
  type StructuralPagePlan,
  type StructuralPageRefusal
} from "@book-maker/core";

/**
 * The proposal side of insert / delete / move: what the card says, what it
 * refuses, and how the request is squared against the book before it is priced.
 *
 * Split out of `bookEditIntents.ts` because that file is at its size budget and
 * because this is a seam of its own — every other proposal branch there resolves
 * pages that already exist, and this one is the exception that cannot.
 */

/** The pages the resolver needs, assembled from what the chat already loaded. */
export function structuralPagesOf(project: Pick<ProjectForChat, "pages" | "chapters">): ExistingPage[] {
  // `loadProjectForChat` selects the chapter's *index*, not its id, so the id
  // is recovered here — the resolver keys chapter membership by id because that
  // is what the worker writes back to `Chapter.targetPages`.
  const chapterIdByIndex = new Map(project.chapters.map((chapter) => [chapter.index, chapter.id]));
  return project.pages.map((page) => ({
    id: page.id,
    index: page.index,
    chapterId: page.chapter ? (chapterIdByIndex.get(page.chapter.index) ?? null) : null
  }));
}

/**
 * The edit as it will be resolved, **on the proposal side only**.
 *
 * The default when the intent carries none at all is a one-page append, which
 * is what "add a page" means with nothing else said. Everything sharper than
 * that — including the difference between "at the front" (anchor 0) and "no
 * place named" (anchor null) — is already settled on the intent.
 *
 * Guessing is safe here and nowhere else: a proposal reserves nothing, and the
 * card says what the guess was before anything is charged. The Apply reads
 * `intent.structuralEdit` itself and settles for free when it is missing
 * (`queueChatRestructurePages`) — a confirmed intent comes back through
 * `structuralEditFromMetadata`, which drops a stored edit it cannot parse, and
 * defaulting *that* to an append executes an edit the reader never approved.
 */
export function structuralEditForProposal(intent: BookEditIntent): StructuralPageEdit {
  return intent.structuralEdit ?? { action: "insert", anchorPageIndex: null, pageIndexes: [], pageCount: 1 };
}

/**
 * How many pages the card says the edit covers.
 *
 * Each action names its pages in a different field, and a **move names none of
 * them**: reordering creates nothing and removes nothing, so `newPageIndexes`
 * and `removedPageIds` are both empty and `order` is the whole book rather than
 * the part that travels. Reading either of the first two for a move reported
 * "0 pages", so the count comes from the selection the resolver accepted —
 * deduplicated exactly the way `resolveStructuralPageEdit` deduplicates it, and
 * safe to trust because a plan only exists once that resolver has refused every
 * page it could not find.
 */
function structuralPageCount(plan: StructuralPagePlan, edit: StructuralPageEdit): number {
  switch (plan.action) {
    case "insert":
      return plan.newPageIndexes.length;
    case "delete":
      return plan.removedPageIds.length;
    case "move":
      return new Set(edit.pageIndexes).size;
  }
}

/**
 * The card's numbers, before they are put into the reader's numbering.
 *
 * Only the resolver can work these out, and it needs the book: how long it ends
 * up, and where an insert really lands once an anchor past the end has been
 * clamped. So they are stored on the pending edit rather than recomputed — the
 * card rebuilt from that state has an intent and a quote in hand, never the
 * pages — while the printed numbers are left to be rendered at that moment,
 * through whichever numbering is in force then.
 */
export function structuralCardPlanOf(intent: BookEditIntent, plan: StructuralPagePlan): StructuralCardPlan {
  return {
    action: plan.action,
    pageCount: structuralPageCount(plan, structuralEditForProposal(intent)),
    totalPages: plan.totalPages,
    insertAfterIndex: plan.insertAfterIndex
  };
}

/**
 * Where a structural edit puts its pages — the one answer every surface that
 * says it is drawn from.
 *
 * The placements were written out twice, once as prose in
 * `structuralProposalSummary` (`bookEditCopy.ts`) and once as the wire fields
 * below, and the two had already drifted: the sentence named a move's
 * destination while both fields were gated on `action === "insert"`, so the chip
 * beside "Move page 3 after page 5" named no destination at all. One resolved
 * answer is what stops the next placement — or the next reading of a null
 * anchor — landing in one half of a card only.
 *
 * **An insert's landing place is the resolver's answer; a move's is the
 * request's.** `resolveStructuralPageEdit` reads an anchor past the end of the
 * book as an append and clamps it, so an insert names
 * {@link StructuralCardPlan.insertAfterIndex} rather than what was typed — while
 * a plan that is *not* an insert carries no anchor at all (`insertAfterIndex` is
 * `0` on every one of them), so reading it for a move would put every moved page
 * at the front of the book. A move's own anchor needs no clamping: the resolver
 * refuses a move whose destination the book does not hold.
 *
 * The head of the book is the one placement with **no page to name**: model page
 * 0 is not a page, so it is marked rather than numbered.
 *
 * The number is the **end** of the anchor's printed span: a model page can print
 * across two sheets, and what follows it starts after the last of them.
 * `anchorPageIndexFromDecision` takes `Math.max` over a widened "after" anchor on
 * the way in for the same reason. It is read through `printedPageEnd` rather
 * than `displayPageEnd`, which answers a page the map cannot place with the raw
 * model index — the right degradation inside a *list* of pages and the wrong one
 * for a place, because "after page 8" is read as a printed number and would name
 * a sheet holding something else. A page an earlier, not-yet-recompiled edit
 * added is exactly such a page, so a destination this card cannot name is left
 * out of the sentence and off the wire instead, the same way the applied
 * insert's card drops its clause (`insertedPagesLocation`, `editOperationCopy.ts`).
 */
export type StructuralPlacement =
  /** Model anchor `0`: the pages open the book, and no printed number names that. */
  | { at: "front" }
  /** The request named no place at all, which an insert appends. */
  | { at: "end" }
  /** After a page the reader can see, in printed numbering. */
  | { at: "after"; readerPage: number }
  /**
   * Nothing this surface may name: a delete moves nothing, and an anchor the
   * map cannot place is left out rather than approximated.
   */
  | { at: "unnamed" };

export function structuralPlacementOf(
  edit: StructuralPageEdit,
  plan: StructuralCardPlan | undefined,
  numbering: ReaderPageNumbering
): StructuralPlacement {
  if (edit.action === "delete") {
    return { at: "unnamed" };
  }
  if (edit.action === "insert" && edit.anchorPageIndex === null) {
    // Only the request can say this. The resolver clamps a null anchor to the
    // last page, so its plan is indistinguishable from an explicit "after the
    // last page" — while a move with no anchor is refused outright and has no
    // destination to name at all.
    return { at: "end" };
  }
  // No plan is a card rebuilt from a pending state stored before those numbers
  // were kept: the request's own anchor is all such a row has, which is exactly
  // the copy it has always produced.
  const anchor =
    edit.action === "insert" && plan?.action === "insert" ? plan.insertAfterIndex : edit.anchorPageIndex;
  if (anchor === null || !Number.isInteger(anchor) || anchor < 0) {
    return { at: "unnamed" };
  }
  if (anchor === 0) {
    return { at: "front" };
  }
  const readerPage = numbering.printedPageEnd(anchor);
  return readerPage === undefined ? { at: "unnamed" } : { at: "after", readerPage };
}

/**
 * The resolved structural clause shared by the proposal and the durable
 * instruction. It contains only facts the resolver accepted: action, count,
 * selected pages and canonical destination.
 */
export function structuralActionInstruction(
  intent: BookEditIntent,
  numbering: ReaderPageNumbering,
  plan?: StructuralCardPlan | undefined
): string {
  const edit = intent.structuralEdit;
  if (!edit) {
    return "Change which pages the book has";
  }
  if (edit.action === "delete") {
    return structuralPagesPhrase("Remove", edit.pageIndexes, numbering);
  }
  const placement = structuralPlacementOf(edit, plan, numbering);
  if (edit.action === "move") {
    const moved = structuralPagesPhrase("Move", edit.pageIndexes, numbering);
    switch (placement.at) {
      case "front":
        return `${moved} to the front of the book`;
      case "end":
        return `${moved} to the end of the book`;
      case "after":
        return `${moved} after page ${placement.readerPage}`;
      case "unnamed":
        return moved;
    }
  }
  const pages = edit.pageCount === 1 ? "1 new page" : `${edit.pageCount} new pages`;
  switch (placement.at) {
    case "front":
      return `Add ${pages} at the front of the book`;
    case "end":
      return `Add ${pages} at the end of the book`;
    case "after":
      return `Add ${pages} after page ${placement.readerPage}`;
    case "unnamed":
      return `Add ${pages}`;
  }
}

/**
 * Makes the instruction approved on the card the same instruction persisted
 * on the operation and delivered to the worker.
 *
 * A router instruction is useful for its content requirements, but it is not
 * authoritative about structural coordinates: the resolver may translate a
 * printed "before" target or clamp an anchor beyond the current book. The
 * structural clause above replaces that part. The remaining prose is retained
 * under an explicit content label so a degraded raw request does not collapse
 * to generic placement copy and a rich model instruction does not keep a
 * contradictory destination.
 */
export function canonicalStructuralEditInstruction(options: {
  intent: BookEditIntent;
  numbering: ReaderPageNumbering;
  plan: StructuralCardPlan;
  request?: string | undefined;
}): string {
  const action = structuralActionInstruction(options.intent, options.numbering, options.plan);
  const source = options.intent.editInstruction?.trim() || options.request?.trim() || "";
  const requirements = structuralContentRequirements(source, options.intent.structuralEdit);
  if (!requirements) {
    return action;
  }
  const sentence = /^[a-z]/.test(requirements)
    ? `${requirements[0]?.toUpperCase() ?? ""}${requirements.slice(1)}`
    : requirements;
  return `${action}. Content requirements: ${/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}`;
}

/**
 * Converts a delete/move that also promises prose work into the existing
 * whole-manuscript generation path before the proposal is priced.
 *
 * The structural resolver still supplies the target length: a delete must
 * quote and generate the shorter manuscript, while a move keeps the current
 * count. The original structural edit remains on the intent as durable audit
 * context; `kind` is the execution discriminator and therefore changes.
 */
export function compoundStructuralReplanIntent(
  intent: BookEditIntent,
  plan: StructuralCardPlan
): BookEditIntent | null {
  const edit = intent.structuralEdit;
  const instruction = intent.editInstruction?.trim();
  if (!edit || !instruction || !structuralEditRequiresWholeBookGeneration(edit, instruction)) {
    return null;
  }
  return {
    ...intent,
    kind: "book_replan",
    scope: "all_pages",
    impact: "structural_replan",
    replanSettings: { ...intent.replanSettings, targetPages: plan.totalPages }
  };
}

/**
 * The page grammar and the action clauses this file strips are `@book-maker/core`'s,
 * not a copy of them. They were spelled out here a second time, byte for byte,
 * and the two copies were narrow in the same places: neither read "the final
 * page", so a delete of it kept "of the story" as a content requirement and was
 * repriced from a free row deletion into a whole-book replan.
 *
 * Every one of those patterns ends at a word boundary of its own, so none of
 * the consumers below appends one. Only the insert consumer used to, which is
 * how the delete and move prefixes went on matching "remove a page" out of
 * "remove a pageant scene" — the boundary belongs to the grammar, not to
 * whichever caller remembered it.
 */

/**
 * Removes only the structural directive, leaving prose/content constraints.
 *
 * **A request that says nothing beyond the edit itself carries no requirement,
 * in any language.** Everything below is subtractive — it takes a closed English
 * action clause off the front and reads the remainder as prose — so a request it
 * cannot read at all came back as *entirely* prose. "صفحه ۴ را حذف کن" is a bare
 * delete; read that way it became `Remove page 4. Content requirements: صفحه ۴ را
 * حذف کن.`, which {@link compoundStructuralReplanIntent} then priced as a whole
 * book regenerated. `isBareStructuralInstruction` is the same predicate that
 * classifier reads, so the canonical instruction this builds and the answer that
 * instruction is later classified by cannot disagree.
 *
 * It is asked of deletes and moves only. An insert's remainder is the brief its
 * new pages are drafted from, so blanking a bare-looking one ("صفحه‌ای درباره
 * مینا اضافه کن") would throw the subject away rather than save anyone a charge —
 * and an insert is never repriced by that classifier in the first place.
 *
 * A requirement already behind the canonical marker is taken at its word: the
 * marker means this function has already decided that text is prose, and asking
 * a second time would let a short foreign requirement disappear.
 */
function structuralContentRequirements(
  instruction: string,
  edit: StructuralPageEdit | null | undefined
): string {
  const action = edit?.action;
  const alreadyCanonical = /\bContent requirements:\s*/i.exec(instruction);
  if (alreadyCanonical?.index !== undefined) {
    return cleanRequirement(
      stripEmbeddedStructuralPlacement(
        instruction.slice(alreadyCanonical.index + alreadyCanonical[0].length),
        action
      )
    );
  }
  if (edit && edit.action !== "insert" && isBareStructuralInstruction(edit, instruction)) {
    return "";
  }

  let remainder = instruction.trim();
  if (action === "insert") {
    const insert = new RegExp(`^${STRUCTURAL_ACTION_PREFIX_PATTERN.insert}`, "i").exec(remainder);
    if (insert) {
      remainder = stripLeadingStructuralPlacement(remainder.slice(insert[0].length));
    }
  } else if (action === "delete") {
    const deletion = new RegExp(`^${STRUCTURAL_ACTION_PREFIX_PATTERN.delete}`, "i").exec(remainder);
    if (deletion) {
      // Every regex in this file is built inside the function that uses it, and
      // that is load-bearing rather than lazy: `editOperations.test.ts` mocks
      // `@book-maker/core` with a bare factory, whose proxy throws on any export
      // the factory does not name — so one of these read at module load takes a
      // whole suite down on import with nothing under test having run.
      remainder = remainder
        .slice(deletion[0].length)
        .replace(new RegExp(`^${STRUCTURAL_WHOLE_BOOK_TAIL_PATTERN}`, "i"), "");
    }
  } else if (action === "move") {
    const move = new RegExp(`^${STRUCTURAL_ACTION_PREFIX_PATTERN.move}`, "i").exec(remainder);
    if (move) {
      remainder = stripLeadingMoveOrigin(remainder.slice(move[0].length));
      remainder = stripLeadingStructuralPlacement(remainder);
    }
  }
  return cleanRequirement(stripEmbeddedStructuralPlacement(remainder, action));
}

/**
 * A move may restate the selected page as an origin before naming its actual
 * destination: "move page 2 from page 2 to before page 5". The selected page
 * is already in the canonical action, so this immediate origin is structural
 * too. Keeping the rule anchored here avoids treating a later "from page N"
 * content requirement as placement.
 */
function stripLeadingMoveOrigin(value: string): string {
  const origin = new RegExp(
    `^\\s*from\\s+(?:(?:after|before|following|preceding)\\s+)?${STRUCTURAL_PAGE_SELECTION_PATTERN}`,
    "i"
  ).exec(value);
  return origin ? value.slice(origin[0].length) : value;
}

/**
 * Removes a placement only when it immediately follows the structural action.
 * Page references later in the sentence can be destinations for content being
 * preserved or moved, so a whole-string replacement would silently erase a
 * substantive requirement such as "moving its quote to page 3".
 */
function stripLeadingStructuralPlacement(value: string): string {
  const numbered = new RegExp(
    `^\\s*(?:(?:to\\s+)?(?:after|before|following|preceding)|at|to)\\s+${STRUCTURAL_PAGE_SELECTION_PATTERN}`,
    "i"
  ).exec(value);
  if (numbered) {
    return value.slice(numbered[0].length);
  }
  const edge =
    /^\s*(?:(?:at|to)\s+(?:the\s+)?(?:very\s+)?(?:front|beginning|start|end|back)(?:\s+of\s+(?:the\s+)?book)?|as\s+(?:the\s+)?(?:first|last|opening|closing)\s+pages?)\b/i.exec(
      value
    );
  return edge ? value.slice(edge[0].length) : value;
}

const CONTENT_PAGE_REFERENCE_CUE =
  /\b(?:discuss(?:es|ed|ing)?|mention(?:s|ed|ing)?|quot(?:e|es|ed|ing)|refer(?:s|red|ring)?|the\s+phrase|the\s+words?|what\s+happen(?:s|ed)?|events?)\b/i;

/**
 * Router prose sometimes puts an insert's subject before its destination:
 * "add a page about Mina after page 100". Once the action prefix is gone,
 * that destination is no longer leading, but it is still structural and may
 * contradict the resolver's clamp.
 *
 * Keep this deliberately narrow: only insert-style content noun phrases are
 * eligible, quoted spans are opaque, and prose explicitly discussing a page
 * reference is retained. Generic "to page N" clauses remain content because
 * they commonly describe where a quote or footnote must be copied.
 */
function stripEmbeddedStructuralPlacement(
  value: string,
  action: StructuralPageEdit["action"] | undefined
): string {
  if (action !== "insert") {
    return value;
  }
  const contentPrefix = /^\s*(?:about|on|covering|concerning|focused\s+on|centred\s+on|centered\s+on)\b/i.exec(
    value
  );
  if (!contentPrefix) {
    return value;
  }

  const numbered = new RegExp(
    `\\s+(?:(?:to\\s+)?(?:after|before|following|preceding)|at)\\s+${STRUCTURAL_PAGE_SELECTION_PATTERN}`,
    "gi"
  );
  const edge =
    /\s+(?:(?:at|to)\s+(?:the\s+)?(?:very\s+)?(?:front|beginning|start|end|back)\s+of\s+(?:the\s+)?book|as\s+(?:the\s+)?(?:first|last|opening|closing)\s+pages?)\b/gi;
  const placements = [...value.matchAll(numbered), ...value.matchAll(edge)].sort(
    (left, right) => (left.index ?? 0) - (right.index ?? 0)
  );
  for (const placement of placements) {
    const index = placement.index;
    if (index === undefined || isInsideQuotedSpan(value, index)) {
      continue;
    }
    const prefix = value.slice(contentPrefix[0].length, index);
    if (!prefix.trim() || CONTENT_PAGE_REFERENCE_CUE.test(prefix)) {
      continue;
    }
    return `${value.slice(0, index)}${value.slice(index + placement[0].length)}`;
  }
  return value;
}

/** True when `index` sits inside straight, curly or backtick quotation. */
function isInsideQuotedSpan(value: string, index: number): boolean {
  let straightSingle = false;
  let straightDouble = false;
  let curlySingle = false;
  let curlyDouble = false;
  let backtick = false;
  for (let offset = 0; offset < index; offset += 1) {
    const character = value[offset];
    const previousIsWord = /[\p{L}\p{N}]/u.test(value[offset - 1] ?? "");
    const nextIsWord = /[\p{L}\p{N}]/u.test(value[offset + 1] ?? "");
    if (character === "'" && !(previousIsWord && nextIsWord) && !straightDouble) {
      // A straight apostrophe is not two characters the way the curly pair is,
      // so a plain toggle is wrong in one direction only. `dogs'`, `1990s'` and
      // `James'` are possessives shaped exactly like a *closing* quote — word
      // character behind, space ahead — and each one opened a span nothing
      // could close, so every placement after it read as quoted and
      // `stripEmbeddedStructuralPlacement` kept the "after page 100" it exists
      // to remove. An opening mark needs a word to open onto; a closing one
      // only needs an open span. The intra-word guard above is still what keeps
      // "don't" from closing one from the inside.
      straightSingle = straightSingle ? false : !previousIsWord && nextIsWord;
    } else if (character === '"' && !straightSingle) {
      straightDouble = !straightDouble;
    } else if (character === "‘" && !straightDouble) {
      curlySingle = true;
    } else if (character === "’" && curlySingle) {
      curlySingle = false;
    } else if (character === "“" && !straightSingle) {
      curlyDouble = true;
    } else if (character === "”" && curlyDouble) {
      curlyDouble = false;
    } else if (character === "`") {
      backtick = !backtick;
    }
  }
  return straightSingle || straightDouble || curlySingle || curlyDouble || backtick;
}

function cleanRequirement(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^\s*[,.;:—–-]+\s*/, "")
    // Coordinating glue can be dropped after the action is removed. Keep
    // subordinators such as "while" and "but": they can carry a constraint
    // whose meaning changes if the relationship to the deletion is erased.
    .replace(/^\s*(?:(?:and|then)\s+)+/i, "")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/[,:;—–-]+\s*$/g, "")
    .trim();
}

function structuralPagesPhrase(
  verb: "Remove" | "Move",
  pageIndexes: readonly number[],
  numbering: ReaderPageNumbering
): string {
  const shown = numbering.displayPages(pageIndexes);
  if (shown.length === 1) {
    return `${verb} page ${shown[0]}`;
  }
  if (shown.length > 1) {
    return `${verb} pages ${shown.join(", ")}`;
  }
  const pages = pageIndexes.length === 1 ? "that page" : "those pages";
  return `${verb} ${pages}`;
}

/**
 * The placement as the app reads it.
 *
 * `placement` is the answer; `atFrontOfBook` and `afterReaderPage` are the same
 * answer in the encoding shipped builds already read, and they keep their exact
 * meaning — such a build still draws the front marker and the anchor number, and
 * still reads a card carrying neither as the append that `end` is. The stored
 * transcripts are why both survive: a card written before this existed carries
 * no `placement`, and the app infers one from those two fields rather than
 * losing the place on every proposal ever made.
 */
function structuralPlacementFields(placement: StructuralPlacement): Record<string, unknown> {
  switch (placement.at) {
    case "front":
      return { placement: "front", atFrontOfBook: true };
    case "after":
      return { placement: "after", afterReaderPage: placement.readerPage };
    case "end":
      return { placement: "end" };
    case "unnamed":
      return { placement: "unnamed" };
  }
}

/**
 * The block the app draws on the card: how many pages, and where.
 *
 * The "where" is {@link structuralPlacementOf}'s answer and nothing else, so the
 * chip and the sentence above it cannot name different places — or, as they once
 * did for a move, one place and none.
 */
export function structuralCardBlock(
  intent: BookEditIntent,
  card: StructuralCardPlan,
  numbering: ReaderPageNumbering
): Record<string, unknown> {
  return {
    action: card.action,
    pageCount: card.pageCount,
    totalPages: card.totalPages,
    ...structuralPlacementFields(structuralPlacementOf(structuralEditForProposal(intent), card, numbering)),
    ...(intent.structuralEdit && intent.structuralEdit.pageIndexes.length > 0
      ? { readerPageNumbers: numbering.displayPages(intent.structuralEdit.pageIndexes) }
      : {})
  };
}

/**
 * What the chat says when the book cannot take the change.
 *
 * Every one of these is a free settlement rather than a failure: nothing was
 * reserved, and the reader gets a sentence naming what is in the way instead of
 * a card they would have to cancel.
 */
export function structuralRefusalMessage(
  reason: StructuralPageRefusal,
  intent: BookEditIntent,
  numbering: ReaderPageNumbering
): string {
  const spoken = intent.structuralEdit?.pageIndexes ?? [];
  const named = spoken.length > 0 ? numbering.displayPages(spoken).join(", ") : "";
  switch (reason) {
    case "no_pages":
      return "This book has no pages yet, so there is nothing to add to or remove.";
    case "unknown_pages":
      return named
        ? `I couldn’t find page ${named} in this book any more, so nothing was changed or charged.`
        : "I couldn’t find the pages that edit named any more, so nothing was changed or charged.";
    case "anchor_out_of_range":
      return "I couldn’t tell where in the book those pages should go. Tell me the page they should follow.";
    case "too_many_pages":
      return structuralTooManyPagesMessage(structuralEditForProposal(intent));
    case "would_empty_book":
      return "That would remove every page of the book. Tell me which pages to keep and I’ll take out the rest.";
    case "would_empty_chapter":
      return "That would leave one of the chapters with no pages at all. Ask me to rewrite or replan the chapter instead.";
    case "anchor_inside_selection":
      return "Those pages can’t move to a place inside themselves. Tell me a page they should follow that isn’t one of them.";
    case "undo_history_too_large":
      return "I couldn’t remove those pages without losing older Undo history, so nothing was changed or charged.";
    case "nothing_to_do":
      return structuralNothingToDoMessage(structuralEditForProposal(intent));
  }
}

/**
 * The one refusal the resolver returns for three different requests.
 *
 * `resolveStructuralPageEdit` answers `nothing_to_do` to an **insert of fewer
 * than one page**, to a **delete or move that named no page at all** — the model
 * wrote the instruction and left the list empty, which is what "delete the
 * boring pages" comes back as — and to a **move already in the order it asked
 * for**. Only the last of those is "already where you asked me to put them", so
 * the other two were answered with a sentence about a different edit, and a
 * reader whose deletion named no page was told nothing they could act on.
 *
 * Naming no page is the same miss `forcedStructuralDecision` (`bookEditIntent.ts`)
 * answers once the clarification budget is spent, and these sentences match its
 * wording deliberately: the two paths answer the same request, and a reader who
 * reaches one after the other must not be told two different things. Asking for
 * the page in prose spends nothing of that budget — a refusal reply carries
 * `pendingEditCancelled` and no `pendingEdit`, so `findPendingScopeClarification`
 * never sees it and it cannot become the second question.
 */
function structuralNothingToDoMessage(edit: StructuralPageEdit): string {
  if (edit.action === "insert") {
    return "I couldn’t tell how many pages to add. Tell me how many, and the page they should follow.";
  }
  if (edit.pageIndexes.length === 0) {
    return edit.action === "delete"
      ? "I couldn’t tell which page to remove. Tell me the page number and I’ll take it out."
      : "I couldn’t tell which page to move. Tell me the page number and where it should go.";
  }
  return "Those pages are already where you asked me to put them, so there’s nothing to change.";
}

/**
 * The cap that was reached, named for the action that reached it.
 *
 * Three caps come back as this one refusal — `MAX_INSERTED_PAGES`,
 * `MAX_DELETED_PAGES` and `MAX_MOVED_PAGES` — and only the delete had an arm, so
 * "move pages 1 to 12 to after page 30" was answered "I can add up to 10 pages
 * at a time": the right number by coincidence, since the insert and move caps
 * happen to be equal, and an instruction about an edit the reader never asked
 * for. The numbers are read from the constants for the same reason the resolver
 * reads them from there — a literal in the copy keeps promising ten after a cap
 * has moved.
 *
 * **The advice differs because the retry does.** Added and removed pages
 * *accumulate*: ten new pages stay in the book, twenty removed ones stay gone,
 * so the same request asked a second time finishes what the first started. A
 * move accumulates nothing — carrying ten of twelve pages across leaves the
 * other two somewhere the reader has to find again, and repeating "move pages
 * 1 to 12" would name a different twelve — so the honest ask is a smaller
 * selection, or moves the reader splits and aims themselves.
 */
function structuralTooManyPagesMessage(edit: StructuralPageEdit): string {
  switch (edit.action) {
    case "insert":
      return `I can add up to ${MAX_INSERTED_PAGES} pages at a time. Ask again for more once these are in.`;
    case "delete":
      return `I can remove up to ${MAX_DELETED_PAGES} pages at a time. Try it in smaller batches.`;
    case "move":
      return `I can move up to ${MAX_MOVED_PAGES} pages at a time. Name fewer pages, or split it into separate moves that each say where those pages go.`;
  }
}
