import { z } from "zod";
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

const searchResearchArgsSchema = z.object({
  query: z.string().min(1)
});

export function shouldSkipWriterTools(options: {
  storyState: StoryState;
  researchNotes: string[];
}): boolean {
  const stateEmpty =
    options.storyState.promises.length === 0 &&
    options.storyState.facts.length === 0 &&
    Object.keys(options.storyState.entities).length === 0 &&
    options.storyState.unanswered.length === 0;
  return stateEmpty && options.researchNotes.length === 0;
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
      execute: ({ pageIndex }) => {
        const page = previousPages.find((candidate) => candidate.index === pageIndex);
        return page
          ? { index: page.index, title: page.title, summary: page.summary, excerpt: page.markdown.slice(0, 900) }
          : { error: `No stored page ${pageIndex}.` };
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
      parameters: searchResearchArgsSchema,
      execute: ({ query }) => {
        const needle = query.toLowerCase();
        const hits = options.researchNotes.filter((note) => note.toLowerCase().includes(needle)).slice(0, 5);
        return hits.length > 0 ? hits : { error: "No matching research notes." };
      }
    }
  ];

  try {
    const result = await runToolLoop({
      textModel: options.textModel,
      purpose: "write-page-with-tools",
      temperature: 0.6,
      maxTokens: 3000,
      maxModelCalls: 3,
      messages: buildPageDraftMessages(options, [
        "You may look up an earlier page, an entity, or research notes before finishing.",
        "Finish by submitting the page draft. At most two tool rounds."
      ]),
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
  } catch {
    // Fall through to the ordinary draft path; a tool-loop failure must not fail the book.
  }
  return options.fallback();
}
