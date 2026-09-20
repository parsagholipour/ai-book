import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviders, loadConfig, type EmbeddingAdapter, type TextModelAdapter } from "@book-maker/core";
import type { WorkerRuntimeJob } from "../runtime/jobPayloads.js";

const mocks = vi.hoisted(() => ({ append: vi.fn(async () => {}), stop: vi.fn(async () => {}), textSources: vi.fn(), decisions: vi.fn() }));
vi.mock("./sourceContext.js", () => ({ withProjectSources: (text: TextModelAdapter, _input: unknown, _project: unknown, embedding: EmbeddingAdapter) => { mocks.textSources(embedding); return text; } }));
vi.mock("./loggedDecisions.js", () => ({ createLoggedDecisions: (_job: unknown, _input: unknown, embedding: EmbeddingAdapter) => { mocks.decisions(embedding); return undefined; } }));
vi.mock("./runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.append }), providerRetryOptions: () => ({ attempts: 1 }) }));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: true } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: mocks.stop }));
import { createLoggedProviders } from "./loggedAdapters.js";

describe("source retrieval embeddings", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.stop.mockResolvedValue(); });
  it("passes the same logged embedding wrapper to text and Jev retrieval", async () => {
    const providers = createProviders({ ...loadConfig(), MOCK_AI: true });
    const embed = vi.spyOn(providers.embedding, "embed");
    const wrapped = createLoggedProviders({ id: "job", name: "generate-book", data: { generationJobId: "job", projectId: "project" } } as WorkerRuntimeJob, providers);
    expect(mocks.textSources).toHaveBeenCalledWith(wrapped.embedding);
    expect(mocks.decisions).toHaveBeenCalledWith(wrapped.embedding);
    expect(wrapped.embedding).not.toBe(providers.embedding);
    await mocks.textSources.mock.calls[0]![0].embed("Evidence query");
    expect(embed).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith("embedding.embed.request", expect.any(Object));
    expect(mocks.append).toHaveBeenCalledWith("embedding.embed.response", expect.any(Object));
    const stop = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
    mocks.stop.mockRejectedValue(stop);
    await expect(mocks.decisions.mock.calls[0]![0].embed("Second query")).rejects.toBe(stop);
    expect(embed).toHaveBeenCalledOnce();
  });
});
