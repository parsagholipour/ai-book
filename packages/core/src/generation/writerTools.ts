import { z } from "zod";
import { isStopOrAbortError } from "../adapters/retry.js";
import { runToolLoop, type ToolLoopTool } from "../adapters/toolLoop.js";
import { pageDraftSchema, type PageDraft } from "../schemas/book.js";
import { buildPageDraftMessages } from "./pageDraftMessages.js";
import type { GeneratePageOptions } from "./pagesShared.js";
import type { StoryState } from "./storyState.js";

const lookupPageArgsSchema = z.object({
  pageIndex: z.coerce.number().int().positive()
});

const lookupEntityArgsSchema = z.object({
  name: z.string().min(1)
});

// `search_research` and `search_memory` search different corpora, but both take
// the same argument: one non-empty search string.
const searchQueryArgsSchema = z.object({
  query: z.string().min(1)
});

/**
 * The two draft options that decide what `search_memory` could reach: the
 * recency window already in the prompt, and the callback that reaches past it.
 * Picked off `GeneratePageOptions` so the injected signature is written once.
 */
type StoredMemoryReach = Pick<GeneratePageOptions, "previousPages" | "searchStoredMemory">;

/**
 * Skip the loop when nothing it could register has an answer to give.
 *
 * `lookup_entity` reads `storyState` and `search_research` reads
 * `researchNotes`, so with both empty the loop used to be pure overhead: extra
 * model calls to be told twice that there is nothing there. `search_memory` is
 * the tool that broke that equivalence — it reaches stored pages *outside* this
 * prompt through the injected `searchStoredMemory`, which the empty story state
 * of a long unresearched novel says nothing about, so page 200 of exactly the
 * book the long-range search exists for was answering `shouldSkipWriterTools`
 * with the state of a book that has no memory at all.
 *
 * Its presence alone is not the reason to run, though. The caller injects one
 * callback for every page it drafts, and the recency window it loaded is
 * already in the draft prompt — so while that window still reaches page 1, the
 * whole past of the book is in front of the model and a search can only hand
 * back what it can already read. **The window starting above page 1 is what
 * says older pages exist**, and it is the same boundary the worker crosses
 * before it will spend an embedding call on long-range retrieval at all
 * (`pastRecencyWindow`, `apps/worker/src/handlers/generatePage.ts`) — read off
 * the window itself rather than copied as a page number, because
 * `RECENT_PAGE_WINDOW` lives on the far side of `apps/* → packages/db →
 * packages/core` and a second copy of it here could only drift. That keeps the
 * loop off the opening pages of every book, which is where paying for it would
 * buy nothing.
 */
export function shouldSkipWriterTools(
  options: StoredMemoryReach & {
    storyState: StoryState;
    researchNotes: string[];
  }
): boolean {
  const stateEmpty =
    options.storyState.promises.length === 0 &&
    options.storyState.facts.length === 0 &&
    Object.keys(options.storyState.entities).length === 0 &&
    options.storyState.unanswered.length === 0;
  return stateEmpty && options.researchNotes.length === 0 && !hasSearchableStoredMemory(options);
}

/** Can `search_memory` reach an earlier page the draft prompt does not already carry? */
function hasSearchableStoredMemory(options: StoredMemoryReach): boolean {
  if (!options.searchStoredMemory) {
    return false;
  }
  const recencyWindow = options.previousPages ?? [];
  // No loaded window is no evidence of a stored past: the worker loads every
  // completed page before this one up to its cap, so an empty window is a page
  // with nothing behind it, not a page whose past went unread.
  return recencyWindow.length > 0 && Math.min(...recencyWindow.map((page) => page.index)) > 1;
}

export async function generatePageDraftWithWriterTools(
  options: GeneratePageOptions & {
    storyState: StoryState;
    fallback: () => Promise<PageDraft>;
  }
): Promise<PageDraft> {
  if (shouldSkipWriterTools(options)) {
    return options.fallback();
  }

  const previousPages = options.previousPages ?? [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolLoopOptions.tools is the same shape.
  const tools: Array<ToolLoopTool<any>> = [
    {
      name: "lookup_page",
      description: "Return a stored earlier page by global index.",
      parameters: lookupPageArgsSchema,
      execute: async ({ pageIndex }) => {
        // Out of range and never written read the same to the model, and they
        // are one sentence so the two branches cannot drift apart.
        const noSuchPage = { error: `No stored page ${pageIndex}.` };
        // Earlier pages only: on a FAILED_QA retry later pages (and this
        // page's stale draft) are COMPLETED.
        if (pageIndex >= options.pageIndex) {
          return noSuchPage;
        }
        // Prefer the already-loaded window; reach into the whole manuscript
        // through the injected callback only when the page is not in context.
        const page =
          previousPages.find((candidate) => candidate.index === pageIndex) ??
          (options.lookupStoredPage ? await options.lookupStoredPage(pageIndex) : null);
        return page
          ? { index: page.index, title: page.title, summary: page.summary, excerpt: page.markdown.slice(0, 900) }
          : noSuchPage;
      }
    },
    {
      name: "lookup_entity",
      description: "Return the current story-state record for a named character or place.",
      parameters: lookupEntityArgsSchema,
      execute: ({ name }) => {
        const entity = options.storyState.entities[name] ??
          Object.entries(options.storyState.entities).find(
            ([key]) => key.toLowerCase() === name.trim().toLowerCase()
          )?.[1];
        return entity ?? { error: `No entity named ${name}.` };
      }
    },
    {
      name: "search_research",
      description: "Search the loaded research notes for this book.",
      parameters: searchQueryArgsSchema,
      execute: ({ query }) => {
        const needle = query.toLowerCase();
        const hits = options.researchNotes.filter((note) => note.toLowerCase().includes(needle)).slice(0, 5);
        return hits.length > 0 ? hits : { error: "No matching research notes." };
      }
    }
  ];

  if (options.searchStoredMemory) {
    const searchStoredMemory = options.searchStoredMemory;
    tools.push({
      name: "search_memory",
      description: "Search earlier pages of this book by meaning or keyword to recall older continuity.",
      parameters: searchQueryArgsSchema,
      execute: async ({ query }) => {
        const hits = await searchStoredMemory(query);
        return hits.length > 0 ? hits : { error: "No matching earlier pages." };
      }
    });
  }

  const toolInstructions = [
    "You may look up an earlier page, an entity, or research notes before finishing.",
    ...(options.searchStoredMemory
      ? ["Use search_memory to recall an earlier page by meaning or keyword when you need older continuity."]
      : []),
    "Finish by submitting the page draft. At most two tool rounds."
  ];

  try {
    const result = await runToolLoop({
      textModel: options.textModel,
      purpose: "write-page-with-tools",
      temperature: options.input.temperature,
      maxTokens: 3000,
      maxModelCalls: 3,
      messages: buildPageDraftMessages(options, toolInstructions),
      tools,
      finishTool: {
        name: "finish_turn",
        description: "Submit the finished page draft.",
        parameters: pageDraftSchema
      }
    });
    if (result.status === "finished" && result.finish) {
      return pageDraftSchema.parse(result.finish);
    }
  } catch (error) {
    // A cancellation is not a failure to recover from: `search_memory` reaches
    // the provider, so the stop the reader asked for surfaces here, and falling
    // back would draft this page a second time and write it against a run that
    // is already over.
    if (isStopOrAbortError(error)) {
      throw error;
    }
    // Fall through to the ordinary draft path; a tool-loop failure must not fail the book.
  }
  return options.fallback();
}
