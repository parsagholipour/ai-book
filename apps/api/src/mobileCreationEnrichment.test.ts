import { describe, expect, it } from "vitest";
import type { GenerateWithToolsOptions, ResearchAdapter, TextModelAdapter } from "@book-maker/core";
import {
  deterministicCreationTurn,
  enrichCreationTurnWithSearch,
  runCreationTurn,
  type MobileCreationTurnRequest
} from "./mobileCreation.js";

/** One scripted assistant turn for the tools-enabled creation chat model. */
type ScriptedToolTurn =
  | { toolCalls: Array<{ name: string; arguments: unknown }>; text?: string }
  | { finish: Record<string, unknown> }
  | { text: string }
  | { error: Error }
  | { hang: true };

type ScriptedToolModel = TextModelAdapter & { calls: GenerateWithToolsOptions[] };

function toolModel(turns: ScriptedToolTurn[]): ScriptedToolModel {
  const calls: GenerateWithToolsOptions[] = [];
  let index = 0;
  return {
    calls,
    async generateWithTools(options) {
      calls.push(options);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (!turn) {
        return { text: "", model: "fake", provider: "fake", toolCalls: [] };
      }
      if ("hang" in turn) {
        return new Promise<never>(() => undefined);
      }
      if ("error" in turn) {
        throw turn.error;
      }
      if ("finish" in turn) {
        return {
          text: "",
          model: "fake",
          provider: "fake",
          toolCalls: [{ id: `call_${index}`, name: "finish_turn", arguments: turn.finish }]
        };
      }
      return {
        text: turn.text ?? "",
        model: "fake",
        provider: "fake",
        toolCalls: ("toolCalls" in turn ? turn.toolCalls : []).map((call, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          name: call.name,
          arguments: call.arguments
        }))
      };
    },
    generateText: () => Promise.reject(new Error("not used")),
    generateJson: () => Promise.reject(new Error("not used")),
    // eslint-disable-next-line require-yield
    streamText: async function* () {
      throw new Error("not used");
    }
  };
}

describe("creation turn enrichment", () => {
  const autoRequest: MobileCreationTurnRequest = {
    messages: [{ role: "user", content: "Bedtime story for 5 year olds" }]
  };

  it("throws when enrichment exhausts without a usable finish_turn patch", async () => {
    const request: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "Make a scientific book about a recent discovering" }]
    };
    const model = toolModel([
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] },
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] },
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] },
      { toolCalls: [{ name: "update_settings", arguments: { tone: "curious" } }] }
    ]);

    await expect(
      enrichCreationTurnWithSearch(
        { textModel: model, research: neverSearchAdapter() },
        request,
        deterministicCreationTurn(request)
      )
    ).rejects.toThrow(/no usable patch/i);
  });

  it("keeps the AI reply when the model returns bookLanguage, nulls, or unknown keys", async () => {
    // Real model output observed in production: a good tailored reply was
    // discarded (falling back to the canned interviewer) because the patch
    // used the input field name bookLanguage and carried explicit nulls.
    const model = toolModel([
      {
        finish: {
          assistantMessage: "A bedtime story sounds lovely. What should the bedtime story be about?",
          question: {
            prompt: "What should the bedtime story be about?",
            options: ["A hero", "An animal"],
            allowCustom: true
          },
          bookLanguage: "fa",
          extraneous: "ignored",
          brief: null,
          buildRequested: false
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      autoRequest,
      deterministicCreationTurn(autoRequest)
    );

    expect(patch.assistantMessage).toContain("bedtime story");
    expect(patch.question?.prompt).toBe("What should the bedtime story be about?");
    expect(patch.language).toBe("fa");
    expect(patch.brief).toBeUndefined();
  });
});

function neverSearchAdapter(): ResearchAdapter {
  return {
    search: () => Promise.reject(new Error("search must not run"))
  };
}



describe("creation chat web search", () => {
  const request: MobileCreationTurnRequest = {
    messages: [
      { role: "user", content: "Make a scientific book about a recent discovery" },
      { role: "assistant", content: "What recent discovery would you like to focus on?" },
      { role: "user", content: "Find it on the internet and tell me" }
    ]
  };

  const groundedResearch: ResearchAdapter = {
    async search(query) {
      return {
        query: query.query,
        summary: "Astronomers reported a newly characterized nearby exoplanet.",
        sources: [
          {
            title: "NASA discovery brief",
            url: "https://science.nasa.gov/example",
            summary: "NASA describes the evidence and discovery method."
          }
        ]
      };
    }
  };

  const searchThenAnswer: ScriptedToolTurn[] = [
    { toolCalls: [{ name: "web_search", arguments: { query: "latest credible scientific discovery 2026" } }] },
    {
      finish: {
        assistantMessage: "A promising option is a newly characterized nearby exoplanet.",
        question: {
          prompt: "Should the book focus on how it was detected or why it matters?",
          options: ["How it was detected", "Why it matters"],
          allowCustom: true
        }
      }
    }
  ];

  it("exposes web_search, update_settings, request_build, and finish_turn tools to the model", async () => {
    const model = toolModel([{ finish: { assistantMessage: "Sounds good.", question: null } }]);

    await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "update_settings",
      "request_build",
      "finish_turn"
    ]);
    expect(model.calls[0]!.purpose).toBe("mobile-book-conversation");
  });

  it("applies update_settings from the model tool and confirms in the finish patch", async () => {
    const model = toolModel([
      {
        toolCalls: [
          {
            name: "update_settings",
            arguments: { imagesEnabled: false, bookTypeChoice: "workbook", targetPages: 40 }
          }
        ]
      },
      {
        finish: {
          assistantMessage: "Got it — visuals off, workbook shape, about 40 pages.",
          question: null
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.presets).toMatchObject({
      imagesEnabled: false,
      bookTypeChoice: "workbook",
      targetPages: 40,
      pageCountMode: "custom",
      pageCountSource: "chat"
    });
    expect(patch.assistantMessage).toContain("visuals off");
    expect(patch.buildRequested).toBe(false);
  });

  it("captures a byline and title stated in chat onto the turn", async () => {
    const model = toolModel([
      {
        toolCalls: [
          {
            name: "update_settings",
            arguments: { authorName: "Parsa Gh.", title: "The Lantern" }
          }
        ]
      },
      {
        finish: {
          assistantMessage: "Got it — The Lantern, by Parsa Gh.",
          question: null
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.authorName).toBe("Parsa Gh.");
    expect(patch.title).toBe("The Lantern");
    // The byline belongs to optionalDetails, not to the book brief: copying it
    // into mustInclude is what once made the planner write it into the premise.
    expect(patch.brief?.mustInclude ?? "").not.toContain("Parsa");
  });

  it("ignores a byline the model puts in the finish patch instead of the tool", async () => {
    const model = toolModel([
      {
        finish: {
          assistantMessage: "Sounds good.",
          question: null,
          authorName: "Invented Name"
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.authorName).toBeUndefined();
  });

  it("applies exact cover-only settings from the model tool", async () => {
    const model = toolModel([
      {
        toolCalls: [
          {
            name: "update_settings",
            arguments: { coverEnabled: true, illustrationsEnabled: false }
          }
        ]
      },
      {
        finish: {
          assistantMessage: "Got it — the cover stays and in-book illustrations are off.",
          question: null
        }
      }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.presets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
  });

  it("sets buildRequested only when request_build is called", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "request_build", arguments: {} }] },
      {
        finish: {
          assistantMessage: "Perfect — I'll start building the plan.",
          question: null,
          buildRequested: true
        }
      }
    ]);
    const buildRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: "user" as const, content: "Ok, build it" }
      ]
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      buildRequest,
      deterministicCreationTurn(buildRequest)
    );

    expect(patch.buildRequested).toBe(true);
    expect(patch.question).toBeNull();
  });

  it("does not inherit a deterministic regex build request when enrichment succeeds without request_build", async () => {
    const model = toolModel([
      {
        finish: {
          assistantMessage: "Tell me a bit more about the ending first.",
          question: {
            prompt: "How should it end?",
            options: ["Happy", "Bittersweet"],
            allowCustom: true
          }
        }
      }
    ]);
    const buildish = {
      ...request,
      messages: [
        { role: "user" as const, content: "A story about a fox." },
        { role: "user" as const, content: "Ok, build it" }
      ]
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      buildish,
      deterministicCreationTurn(buildish)
    );

    expect(patch.buildRequested).toBe(false);
    expect(patch.question?.prompt).toContain("end");
  });

  it("searches when the model calls web_search, grounds the answer, and stores structured sources", async () => {
    let searched = "";
    const research: ResearchAdapter = {
      async search(query) {
        searched = query.query;
        return groundedResearch.search(query);
      }
    };
    const model = toolModel(searchThenAnswer);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      request,
      deterministicCreationTurn(request)
    );

    expect(searched).toBe("latest credible scientific discovery 2026");
    // The second model call must see the tool result with the evidence.
    const secondCallMessages = model.calls[1]!.messages;
    const toolResult = secondCallMessages.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("NASA discovery brief");
    expect(toolResult?.toolName).toBe("web_search");
    expect(patch.assistantMessage).toContain("exoplanet");
    expect(patch.research?.sources[0]).toMatchObject({
      title: "NASA discovery brief",
      url: "https://science.nasa.gov/example"
    });
  });

  it("keeps ordinary chat to one model call without searching", async () => {
    let searches = 0;
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        return groundedResearch.search(query);
      }
    };
    const model = toolModel([
      {
        finish: {
          assistantMessage: "Lovely. What mood should the story have?",
          question: { prompt: "What mood should the story have?", options: ["Cozy", "Funny"], allowCustom: true }
        }
      }
    ]);
    const normalRequest: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "A bedtime story about a fox" }]
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      normalRequest,
      deterministicCreationTurn(normalRequest)
    );

    expect(model.calls).toHaveLength(1);
    expect(searches).toBe(0);
    expect(patch.research).toBeUndefined();
    expect(patch.assistantMessage).toContain("mood");
  });

  it("honors a non-English search request from the model", async () => {
    let searches = 0;
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "\u0644\u0637\u0641\u0627\u064b \u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc \u0631\u0627 \u0628\u0631\u0627\u06cc\u0645 \u067e\u06cc\u062f\u0627 \u06a9\u0646" }]
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "\u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc \u0645\u0639\u062a\u0628\u0631 \u06f2\u06f0\u06f2\u06f6" } }] },
      { finish: { assistantMessage: "\u06cc\u06a9 \u06a9\u0634\u0641 \u062a\u0627\u0632\u0647 \u0648 \u0645\u0633\u062a\u0646\u062f \u067e\u06cc\u062f\u0627 \u06a9\u0631\u062f\u0645.", question: null } }
    ]);
    const research: ResearchAdapter = {
      async search(query) {
        searches += 1;
        expect(query.query).toContain("\u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc");
        return groundedResearch.search(query);
      }
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      nonEnglish,
      deterministicCreationTurn(nonEnglish)
    );

    expect(searches).toBe(1);
    expect(patch.research).toBeDefined();
  });

  it("keeps grounded evidence when the model fails after a successful search", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { error: new Error("answer model unavailable") }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.question).toBeNull();
    expect(patch.research?.sources[0]?.title).toBe("NASA discovery brief");
  });

  it("keeps grounded evidence when the follow-up model call times out", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { hang: true }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch, answerTimeoutMs: 5 },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.question).toBeNull();
    expect(patch.research?.sources[0]?.title).toBe("NASA discovery brief");
  });

  it("does not retry timed-out searches, avoiding duplicate provider work", async () => {
    let searches = 0;
    const research: ResearchAdapter = {
      search() {
        searches += 1;
        return new Promise<never>(() => undefined);
      }
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { finish: { assistantMessage: "", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research, searchTimeoutMs: 5 },
      request,
      deterministicCreationTurn(request)
    );

    expect(searches).toBe(1);
    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
  });

  it("keeps a model-authored failure message in the conversation language", async () => {
    const nonEnglish: MobileCreationTurnRequest = {
      messages: [{ role: "user", content: "\u0644\u0637\u0641\u0627\u064b \u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc \u0631\u0627 \u0628\u0631\u0627\u06cc\u0645 \u067e\u06cc\u062f\u0627 \u06a9\u0646" }]
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "\u062c\u062f\u06cc\u062f\u062a\u0631\u06cc\u0646 \u06a9\u0634\u0641 \u0639\u0644\u0645\u06cc" } }] },
      { finish: { assistantMessage: "\u062c\u0633\u062a\u062c\u0648 \u0627\u0644\u0627\u0646 \u06a9\u0627\u0645\u0644 \u0646\u0634\u062f\u061b \u062f\u0648\u0628\u0627\u0631\u0647 \u062a\u0644\u0627\u0634 \u06a9\u0646\u06cc\u062f \u06cc\u0627 \u0645\u0648\u0636\u0648\u0639 \u0631\u0627 \u062f\u0642\u06cc\u0642\u200c\u062a\u0631 \u06a9\u0646\u06cc\u062f.", question: null } }
    ]);
    const research: ResearchAdapter = {
      search: () => Promise.reject(new Error("search unavailable"))
    };

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      nonEnglish,
      deterministicCreationTurn(nonEnglish)
    );

    expect(patch.assistantMessage).toContain("\u062c\u0633\u062a\u062c\u0648 \u0627\u0644\u0627\u0646 \u06a9\u0627\u0645\u0644 \u0646\u0634\u062f");
    expect(patch.question).toBeNull();
    // The failed search must be reported to the model as a tool error result.
    const toolResult = model.calls[1]!.messages.find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("failed");
  });

  it("uses hardcoded recovery when the model returns an empty answer after a failed search", async () => {
    const research: ResearchAdapter = {
      search: () => Promise.reject(new Error("search unavailable"))
    };
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { finish: { assistantMessage: "", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toMatch(/try again|narrow/i);
    expect(patch.assistantMessage).not.toMatch(/can't browse|cannot browse/i);
    expect(patch.question).toBeNull();
  });

  it("uses the grounded summary when the model finishes with an empty answer", async () => {
    const model = toolModel([
      { toolCalls: [{ name: "web_search", arguments: { query: "recent scientific discovery" } }] },
      { finish: { assistantMessage: "", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: groundedResearch },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toContain("nearby exoplanet");
    expect(patch.research).toBeDefined();
  });

  it("recovers a finish payload the model emitted as plain text", async () => {
    const model = toolModel([
      { text: JSON.stringify({ assistantMessage: "Here is a plain-text finish.", question: null }) }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(patch.assistantMessage).toBe("Here is a plain-text finish.");
  });

  it("nudges once when the model chats in plain text, then accepts the finish", async () => {
    const model = toolModel([
      { text: "Let me think about that." },
      { finish: { assistantMessage: "Done thinking - here is my reply.", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.at(-1)?.content).toContain("finish_turn");
    expect(patch.assistantMessage).toBe("Done thinking - here is my reply.");
  });

  it("feeds invalid finish arguments back to the model for repair", async () => {
    const model = toolModel([
      { finish: { assistantMessage: "x".repeat(1000), question: null } },
      { finish: { assistantMessage: "A corrected concise reply.", question: null } }
    ]);

    const patch = await enrichCreationTurnWithSearch(
      { textModel: model, research: neverSearchAdapter() },
      request,
      deterministicCreationTurn(request)
    );

    expect(model.calls).toHaveLength(2);
    const repairPrompt = model.calls[1]!.messages.at(-1);
    expect(repairPrompt?.role).toBe("tool");
    expect(repairPrompt?.content).toContain("Invalid finish_turn arguments");
    expect(patch.assistantMessage).toBe("A corrected concise reply.");
  });

  it("bounds the first model call before any search starts", async () => {
    const model = toolModel([{ hang: true }]);

    await expect(
      enrichCreationTurnWithSearch(
        { textModel: model, research: groundedResearch, classificationTimeoutMs: 5 },
        request,
        deterministicCreationTurn(request)
      )
    ).rejects.toThrow(/creation turn request timed out/i);
  });

  it("falls back to the deterministic turn when the outer budget expires", async () => {
    const turn = await runCreationTurn(request, {
      enrich: () => new Promise<never>(() => undefined),
      timeoutMs: 5
    });

    expect(turn.assistantMessage.length).toBeGreaterThan(0);
  });
});
