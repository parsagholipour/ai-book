import { describe, expect, it } from "vitest";
import type { ChatMessage, GenerateWithToolsOptions, ResearchAdapter, TextModelAdapter } from "@book-maker/core";
import {
  CREATION_CHAT_WEB_SEARCHES_PER_TURN,
  CREATION_SEARCH_BUDGET_SPENT_RESULT,
  deterministicCreationTurn,
  enrichCreationTurnWithSearch,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

/** Each round is the list of tool calls one model response names; `finish` ends the turn. */
type Round = { searches: string[] } | { finish: string };

function scriptedModel(rounds: Round[]): TextModelAdapter & { calls: GenerateWithToolsOptions[] } {
  const calls: GenerateWithToolsOptions[] = [];
  let index = 0;
  return {
    calls,
    async generateWithTools(options) {
      calls.push(options);
      const round = rounds[index % rounds.length]!;
      index += 1;
      if ("finish" in round) {
        return {
          text: "",
          model: "fake",
          provider: "fake",
          toolCalls: [{ id: `finish_${index}`, name: "finish_turn", arguments: { assistantMessage: round.finish, question: null } }]
        };
      }
      return {
        text: "",
        model: "fake",
        provider: "fake",
        toolCalls: round.searches.map((query, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          name: "web_search",
          arguments: { query }
        }))
      };
    },
    generateText: () => Promise.reject(new Error("not used")),
    async generateJson(options) {
      const data = options.schema.parse({ language: "en" });
      return { data, text: JSON.stringify(data), model: "fake", provider: "fake" };
    },
    // eslint-disable-next-line require-yield
    streamText: async function* () {
      throw new Error("not used");
    }
  };
}

function countingResearch(): ResearchAdapter & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query.query);
      return {
        query: query.query,
        summary: `Findings about ${query.query}.`,
        sources: [{ title: `Source for ${query.query}`, url: "https://example.org/source", summary: "Evidence." }]
      };
    }
  };
}

function toolResults(messages: ChatMessage[]): string[] {
  return messages.filter((message) => message.role === "tool" && message.toolName === "web_search").map((message) => message.content);
}

const request: MobileCreationTurnRequest = {
  messages: [{ role: "user", content: "Look up the five biggest discoveries of 2026 on the internet" }]
};

describe("creation chat web search budget", () => {
  it("is two grounded searches per turn", () => {
    expect(CREATION_CHAT_WEB_SEARCHES_PER_TURN).toBe(2);
  });

  it("runs only the budget of five parallel web_search calls in one response", async () => {
    const research = countingResearch();
    const model = scriptedModel([
      { searches: ["one", "two", "three", "four", "five"] },
      { finish: "Here is what I found." }
    ]);

    const patch = await enrichCreationTurnWithSearch({ textModel: model, research }, request, deterministicCreationTurn(request));

    expect(research.queries).toEqual(["one", "two"]);
    const results = toolResults(model.calls[1]!.messages);
    expect(results).toHaveLength(5);
    expect(results.slice(0, 2).every((content) => content.includes("Findings about"))).toBe(true);
    expect(results.slice(2)).toEqual([
      CREATION_SEARCH_BUDGET_SPENT_RESULT,
      CREATION_SEARCH_BUDGET_SPENT_RESULT,
      CREATION_SEARCH_BUDGET_SPENT_RESULT
    ]);
    // A spent budget is not a failed search: the grounded answer stands.
    expect(patch.assistantMessage).toBe("Here is what I found.");
    expect(patch.research?.query).toBe("two");
  });

  it("counts searches across consecutive rounds of the same turn", async () => {
    const research = countingResearch();
    const model = scriptedModel([
      { searches: ["first"] },
      { searches: ["second"] },
      { searches: ["third", "fourth", "fifth"] },
      { finish: "Done searching." }
    ]);

    const patch = await enrichCreationTurnWithSearch({ textModel: model, research }, request, deterministicCreationTurn(request));

    expect(research.queries).toEqual(["first", "second"]);
    expect(model.calls).toHaveLength(4);
    expect(toolResults(model.calls[3]!.messages).slice(2)).toEqual([
      CREATION_SEARCH_BUDGET_SPENT_RESULT,
      CREATION_SEARCH_BUDGET_SPENT_RESULT,
      CREATION_SEARCH_BUDGET_SPENT_RESULT
    ]);
    expect(patch.assistantMessage).toBe("Done searching.");
  });

  it("gives every turn a fresh budget", async () => {
    const research = countingResearch();
    const rounds: Round[] = [{ searches: ["alpha", "beta", "gamma"] }, { finish: "Found it." }];

    await enrichCreationTurnWithSearch({ textModel: scriptedModel(rounds), research }, request, deterministicCreationTurn(request));
    await enrichCreationTurnWithSearch({ textModel: scriptedModel(rounds), research }, request, deterministicCreationTurn(request));

    expect(research.queries).toEqual(["alpha", "beta", "alpha", "beta"]);
  });
});
