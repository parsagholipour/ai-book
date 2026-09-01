import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
  QUALITY_EFFORT_TIERS,
  QUALITY_FEATURE_DEFAULTS,
  qualityFeatureEnabled,
  type QualityFeatureSettings
} from "@book-maker/core";
import { adminGenerationQualityRoutes } from "./adminGenerationQuality.js";

const mockPrisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  generationQualityRevision: {
    findFirst: vi.fn(),
    create: vi.fn()
  }
}));

const mockRequireOperatorActor = vi.hoisted(() => vi.fn());

vi.mock("@book-maker/db", () => ({ prisma: mockPrisma }));
vi.mock("../requestAuth.js", () => ({
  requireOperatorActor: mockRequireOperatorActor
}));

/** The revision the route reads as "current", plus a create that echoes what it wrote. */
function mockStoredRevision(current: { version: number; settings?: unknown } | null): void {
  mockPrisma.generationQualityRevision.findFirst.mockResolvedValue(current);
  mockPrisma.generationQualityRevision.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "quality-next",
      note: null,
      updatedBy: "operator-console",
      createdAt: new Date("2026-08-23T09:00:00.000Z"),
      ...data
    })
  );
}

function settingsOf(
  response: { json: () => unknown }
): QualityFeatureSettings & Record<string, string[]> {
  return (response.json() as { settings: QualityFeatureSettings & Record<string, string[]> }).settings;
}

describe("admin generation quality settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
    process.env.DEEPINFRA_API_KEY = "deepinfra-test-key";
    process.env.GEMINI_API_KEY = "gemini-test-key";
    process.env.ALIBABA_API_KEY = "alibaba-test-key";
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.MOCK_AI = "false";
    mockRequireOperatorActor.mockResolvedValue({ kind: "operator", userId: "local-admin" });
    mockPrisma.$transaction.mockImplementation(
      async (operation: (tx: typeof mockPrisma) => Promise<unknown>) => operation(mockPrisma)
    );
  });

  it("refuses mobile bearers, including unknown-key bodies, before database access", async () => {
    mockRequireOperatorActor.mockImplementation(async (_request, reply) => {
      reply.code(403).send({ error: "Operator access required" });
      return null;
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const headers = { authorization: "Bearer mobile-access-token" };
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/admin/generation-quality", headers }),
      app.inject({
        method: "PATCH",
        url: "/api/admin/generation-quality",
        headers,
        payload: { styleAuditor: ["ultra"] }
      }),
      app.inject({
        method: "POST",
        url: "/api/admin/generation-quality/reset",
        headers,
        payload: {}
      }),
      app.inject({
        method: "PATCH",
        url: "/api/admin/generation-quality",
        headers,
        payload: { unknownFeature: ["ultra"] }
      }),
      app.inject({
        method: "POST",
        url: "/api/admin/generation-quality/reset",
        headers,
        payload: { unknownField: true }
      })
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403]);
    expect(mockRequireOperatorActor).toHaveBeenCalledTimes(5);
    expect(mockPrisma.generationQualityRevision.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns compiled defaults when no revision rows exist", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue(null);
    const app = Fastify();
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/generation-quality"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 0,
      usingCompiledDefaults: true,
      settings: QUALITY_FEATURE_DEFAULTS,
      pageReviewPromptModes: PAGE_REVIEW_PROMPT_MODE_DEFAULTS,
      models: {
        fastJudgments: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
        fastJudgmentsFallback: {
          provider: "deepinfra",
          model: "deepseek-ai/DeepSeek-V4-Flash",
          thinkingEnabled: false
        }
      }
    });
    const body = response.json() as {
      modelOptions: Array<{ provider: string }>;
      features: Array<{ id: string; label: string; summary: string }>;
    };
    expect(new Set(body.modelOptions.map((option) => option.provider))).toEqual(
      new Set(["deepseek", "deepinfra", "gemini", "alibaba", "openai"])
    );
    expect(body.features).toContainEqual({
      id: "smartUnslop",
      label: "Smart unslop",
      summary: expect.any(String)
    });
    expect(body.features).toContainEqual({
      id: "compactPageDraftContext",
      label: "Compact page-draft context",
      summary: expect.any(String)
    });
    await app.close();
  });

  it("writes an append-only revision for the full feature map", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue({ version: 2 });
    mockPrisma.generationQualityRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-3",
        note: null,
        updatedBy: null,
        createdAt: new Date("2026-08-14T09:00:00.000Z"),
        ...data
      })
    );
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {
        ...QUALITY_FEATURE_DEFAULTS,
        styleAuditor: ["ultra"],
        note: "Premium style audit off"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 3,
      usingCompiledDefaults: false,
      settings: {
        ...QUALITY_FEATURE_DEFAULTS,
        styleAuditor: ["ultra"]
      },
      note: "Premium style audit off"
    });
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 3,
        updatedBy: "operator-console"
      })
    });
    await app.close();
  });

  it("stores an empty finalBookQa assignment as disabled", async () => {
    mockPrisma.generationQualityRevision.findFirst.mockResolvedValue({ version: 1 });
    mockPrisma.generationQualityRevision.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-2",
        note: null,
        updatedBy: "operator-console",
        createdAt: new Date("2026-08-14T10:00:00.000Z"),
        ...data
      })
    );
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { finalBookQa: [] }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response).finalBookQa).toEqual([]);
    expect(qualityFeatureEnabled(settingsOf(response), "finalBookQa", "balanced")).toBe(false);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ settings: expect.objectContaining({ finalBookQa: [] }) })
    });
    await app.close();
  });

  /**
   * The failure the PATCH's hook was written for, one route over. AJV strips
   * the misspelled key under `additionalProperties: false`, `attachValidation`
   * means its verdict is never read, and `{}` is exactly the body a reset is
   * supposed to take — so `safeParse` succeeded and the revision was minted
   * with the canned note. The operator was told their save worked and their
   * words were stored nowhere, which is the same 200 the PATCH used to give.
   */
  it("names a field the reset does not take rather than storing the canned note", async () => {
    mockStoredRevision({ version: 4 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/reset",
      payload: { not: "tuning the auditor down for the week" }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^not:/);
    expect(error).not.toMatch(/feature this build knows/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The key sets are per route, not one union: a reset restores every compiled
   * default, so a body naming a feature is asking for something the route does
   * not do. Accepting it because the PATCH would is the same silent lie by a
   * different road — the reset ignores the assignment and answers 200.
   */
  it("refuses a feature id on the reset, which resets every feature anyway", async () => {
    mockStoredRevision({ version: 4 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/reset",
      payload: { styleAuditor: ["ultra"], note: "Auditor back to defaults" }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toMatch(/^styleAuditor:/);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /** The same answer with the strip switched off, as on the PATCH. */
  it("gives the same reset refusal when AJV has not stripped the key", async () => {
    mockStoredRevision({ version: 4 });
    const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/reset",
      payload: { nte: "auditor down for the week", note: "the real one" }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toMatch(/^nte:/);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /** The note the hook exists to protect still reaches the revision. */
  it("resets with the operator's own note when the key is spelled right", async () => {
    mockStoredRevision({ version: 4 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/reset",
      payload: { note: "Tuning the auditor down for the week" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 5,
      settings: QUALITY_FEATURE_DEFAULTS,
      note: "Tuning the auditor down for the week"
    });
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ note: "Tuning the auditor down for the week" })
    });
    await app.close();
  });

  /**
   * The console bundle an operator still has open is the client one release
   * behind: it knows ten features and the build knows eleven. Required keys
   * 400'd that save outright; optional ones let it name what it means, and the
   * feature it never heard of keeps whatever the last save left it — the
   * compiled default is what a *read* falls back to, and using it here would
   * silently re-check a box someone had unchecked.
   */
  it("keeps a feature the body never named at its stored value", async () => {
    mockStoredRevision({
      version: 7,
      settings: { ...QUALITY_FEATURE_DEFAULTS, beatDedup: [], claimRetrieve: ["ultra", "premium"] }
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const { beatDedup: _unknownToThisClient, ...knownToThisClient } = QUALITY_FEATURE_DEFAULTS;
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { ...knownToThisClient, styleAuditor: ["ultra"] }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response).beatDedup).toEqual([]);
    expect(settingsOf(response).styleAuditor).toEqual(["ultra"]);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 8,
        settings: expect.objectContaining({ beatDedup: [], styleAuditor: ["ultra"] })
      })
    });
    await app.close();
  });

  it("names one feature and leaves the other ten alone", async () => {
    mockStoredRevision({ version: 1, settings: { ...QUALITY_FEATURE_DEFAULTS, writerTools: [] } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { pageMapCritic: ["ultra"], note: "Page-map critic to Ultra only" }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response)).toEqual({
      ...QUALITY_FEATURE_DEFAULTS,
      writerTools: [],
      pageMapCritic: ["ultra"]
    });
    await app.close();
  });

  it("preserves a future feature when an older replica patches another gate", async () => {
    const futureFeature = ["glacial", "ultra"];
    mockStoredRevision({
      version: 8,
      settings: { ...QUALITY_FEATURE_DEFAULTS, futureContinuityGate: futureFeature }
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: [] }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response).futureContinuityGate).toEqual(futureFeature);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settings: expect.objectContaining({ futureContinuityGate: futureFeature, styleAuditor: [] })
      })
    });
    await app.close();
  });

  it("preserves future tiers on an untouched known feature", async () => {
    const futureTiers = ["ultra", "glacial", "premium"];
    mockStoredRevision({
      version: 8,
      settings: { ...QUALITY_FEATURE_DEFAULTS, planCritic: futureTiers }
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: [] }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response).planCritic).toEqual(futureTiers);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settings: expect.objectContaining({ planCritic: futureTiers, styleAuditor: [] })
      })
    });
    await app.close();
  });

  it("falls back to the compiled default for a feature no revision has ever set", async () => {
    mockStoredRevision(null);
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: [] }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response)).toEqual({ ...QUALITY_FEATURE_DEFAULTS, styleAuditor: [] });
    await app.close();
  });

  /**
   * Optional feature keys made a partial body legal, and `{}` with it: the
   * merge handed back the stored settings and the insert still minted version
   * N+1, so a stray curl or a client that posted before it loaded filled the
   * history the console renders with rows recording nothing. A save claims
   * something or it is refused — and `{ styleAuditor: [] }` above is a claim,
   * because a feature switched off is still a feature named.
   */
  it("refuses a PATCH that claims nothing rather than minting a no-op revision", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    // It says what was missing, rather than blaming the tier lists it was sent none of.
    expect((response.json() as { error: string }).error).toMatch(/at least one/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /** Blank once trimmed, a note stores as `null` — the empty body in a hat. */
  it("refuses a note that is only whitespace", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { note: "   " }
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toMatch(/at least one/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The shape that made this route's one sentence a lie. A note over the cap
   * arrives as `too_big` at `["note"]`, the refinement never runs, and the
   * operator used to be told to send lists of effort tiers — pointing at the
   * eleven checkbox rows, every one of which was valid, and naming the one
   * field that was not nowhere at all.
   */
  it("names the note when a change note is over the length cap", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: ["ultra"], note: "x".repeat(600) }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^note:/);
    expect(error).toContain("500");
    expect(error).not.toMatch(/effort tier/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * A note is content on the revision rather than metadata about a settings
   * change — the GET returns it and the console prints it beside the version —
   * so an operator recording why the current settings stand has saved
   * something. It mints a revision, carrying the stored settings forward
   * untouched, because there is no other way to write that down without moving
   * a box you did not mean to move.
   */
  it("mints a revision for a body carrying only a note", async () => {
    mockStoredRevision({
      version: 3,
      settings: { ...QUALITY_FEATURE_DEFAULTS, writerTools: [] }
    });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { note: "Writer tools stay off until the retry budget lands" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 4,
      note: "Writer tools stay off until the retry budget lands"
    });
    expect(settingsOf(response)).toEqual({ ...QUALITY_FEATURE_DEFAULTS, writerTools: [] });
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 4,
        note: "Writer tools stay off until the retry budget lands"
      })
    });
    await app.close();
  });

  /**
   * This used to answer 200: AJV strips the unknown key under
   * `additionalProperties: false` before Zod sees the body, so the save landed
   * with the id discarded and nothing said. The rest of the body was valid, so
   * "it never lands" was true and useless — the operator was told the save they
   * meant had happened. The hook reads the keys while the typo is still there,
   * and the refusal takes the whole body with it, ten valid features included.
   */
  it("names a feature id this build does not know rather than dropping it in silence", async () => {
    mockStoredRevision({ version: 1 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { ...QUALITY_FEATURE_DEFAULTS, retiredFeature: ["ultra"] }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^retiredFeature:/);
    expect(error).not.toMatch(/effort tier/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The same answer with the strip switched off, which is the point of reading
   * the keys in a `preValidation` hook rather than leaving it to `.strict()`:
   * what an operator is told about a typo no longer depends on how AJV happens
   * to be configured. `styleAuditor`, the one feature this body did name, is
   * valid — so the sentence about tiers would be blaming the wrong half.
   */
  it("gives the same refusal for an unknown id when AJV has not stripped it", async () => {
    mockStoredRevision({ version: 1 });
    const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: ["ultra"], retiredFeature: ["ultra"] }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^retiredFeature:/);
    expect(error).not.toMatch(/effort tier/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The body that made the empty-claim refusal a lie. One feature, spelled
   * wrong, is stripped to `{}` — so the operator who named exactly one feature
   * was told to name at least one, with the misspelling they could have fixed
   * printed nowhere.
   */
  it("names the misspelled feature rather than calling the body empty", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAudito: ["fast"] }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^styleAudito:/);
    expect(error).not.toMatch(/at least one/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /** Every unknown id in one sentence, so a second save does not find a second one. */
  it("names every unknown id a body carries", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: ["fast"], beatDedupp: [], planCriticc: ["ultra"] }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^beatDedupp, planCriticc:/);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * A body that is not an object has no keys to misspell, and reading its
   * indexes as ids would answer a JSON array with "0: not a feature this build
   * knows". Zod owns that shape.
   */
  it("leaves a body that is not an object to the schema", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: ["ultra"]
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).not.toMatch(/this build knows/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The enum is `QUALITY_EFFORT_TIERS` itself, so this case count grows with
   * core's list: a tier added there and not here would 400 every save from a
   * console that renders it, which is the drift the derivation removed.
   */
  it.each(QUALITY_EFFORT_TIERS)("accepts %s, the tier list core compiled", async (tier) => {
    mockStoredRevision({ version: 1 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: [tier] }
    });

    expect(response.statusCode).toBe(200);
    expect(settingsOf(response).styleAuditor).toEqual([tier]);
    await app.close();
  });

  /** A `P2002` the way Prisma raises one for `version Int @unique`. */
  function versionAlreadyTaken(): Error {
    return Object.assign(new Error("Unique constraint failed on the fields: (`version`)"), {
      code: "P2002",
      meta: { modelName: "GenerationQualityRevision", target: ["version"] }
    });
  }

  /**
   * Both operators save within the same second, so both read version 7 and both
   * write 8. The unique index refuses the second one, which used to arrive as a
   * bare 500 with their unchecked box silently unstored — and a plain retry
   * would be worse, reinserting settings computed against 7 and quietly undoing
   * the box the winner had just unchecked. So the replay re-reads the head and
   * merges onto *that*: both changes are in version 9.
   */
  it("re-merges onto the winner's revision when the version number is lost", async () => {
    const winner = { ...QUALITY_FEATURE_DEFAULTS, planCritic: [] };
    mockPrisma.generationQualityRevision.findFirst
      .mockResolvedValueOnce({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } })
      .mockResolvedValueOnce({ version: 8, settings: winner });
    mockPrisma.generationQualityRevision.create
      .mockRejectedValueOnce(versionAlreadyTaken())
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-9",
        note: null,
        updatedBy: "operator-console",
        createdAt: new Date("2026-08-23T09:30:00.000Z"),
        ...data
      }));
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleExcerpts: [], note: "Style excerpts off" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: 9 });
    // The loser's own change, and the winner's — neither save was lost.
    expect(settingsOf(response).styleExcerpts).toEqual([]);
    expect(settingsOf(response).planCritic).toEqual([]);
    expect(settingsOf(response).styleAuditor).toEqual(QUALITY_FEATURE_DEFAULTS.styleAuditor);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ version: 8 })
    });
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        version: 9,
        settings: expect.objectContaining({ styleExcerpts: [], planCritic: [] })
      })
    });
    await app.close();
  });

  /** The reset path builds its settings differently and replays identically. */
  it("replays a reset that loses the version number", async () => {
    mockPrisma.generationQualityRevision.findFirst
      .mockResolvedValueOnce({ version: 4, settings: { ...QUALITY_FEATURE_DEFAULTS, writerTools: [] } })
      .mockResolvedValueOnce({ version: 5, settings: { ...QUALITY_FEATURE_DEFAULTS, writerTools: [] } });
    mockPrisma.generationQualityRevision.create
      .mockRejectedValueOnce(versionAlreadyTaken())
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "quality-6",
        updatedBy: "operator-console",
        createdAt: new Date("2026-08-23T09:40:00.000Z"),
        ...data
      }));
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/generation-quality/reset",
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    // A reset names every feature, so the winner's revision is what it replaces
    // rather than what it merges onto — compiled defaults, at version 6.
    expect(response.json()).toMatchObject({ version: 6, settings: QUALITY_FEATURE_DEFAULTS });
    await app.close();
  });

  /**
   * One replay, like `applyStructuralPageChange`'s. Losing twice means saves are
   * arriving faster than the table can number them, and the operator's move is
   * to reload — which a 409 says and a 500 does not.
   */
  it("answers 409 rather than 500 when the replay loses the number too", async () => {
    mockPrisma.generationQualityRevision.findFirst
      .mockResolvedValueOnce({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } })
      .mockResolvedValueOnce({ version: 8, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    mockPrisma.generationQualityRevision.create
      .mockRejectedValueOnce(versionAlreadyTaken())
      .mockRejectedValueOnce(versionAlreadyTaken());
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleExcerpts: [] }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ currentVersion: 8 });
    // The remedy has to be re-sending rather than reloading: this body named one
    // feature, so it is still the right body for the newer head, and a client
    // with no page to reload (a curl, a script) has to be told something it can
    // actually do.
    expect((response.json() as { error: string }).error).toMatch(/Re-send/);
    expect((response.json() as { error: string }).error).not.toMatch(/Reload/);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does not replay a failure that is not a unique-index conflict", async () => {
    mockStoredRevision({ version: 7, settings: { ...QUALITY_FEATURE_DEFAULTS } });
    mockPrisma.generationQualityRevision.create.mockRejectedValue(new Error("connection terminated"));
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleExcerpts: [] }
    });

    expect(response.statusCode).toBe(500);
    expect(mockPrisma.generationQualityRevision.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("refuses an effort tier core never compiled", async () => {
    mockStoredRevision({ version: 1 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: ["turbo"] }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    // The entry that was refused, not just the feature holding it.
    expect(error).toMatch(/^styleAuditor\[0\]:/);
    expect(error).toContain(QUALITY_EFFORT_TIERS.join(", "));
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The same sentence one level up, where the value is not a list at all. A
   * console sending its checkbox state as a map rather than a list is the way
   * there: AJV's `coerceTypes: "array"` wraps a bare `"ultra"` into `["ultra"]`
   * before Zod sees it, so a scalar never gets this far, and an object does.
   */
  it("names the feature whose value is not a list of tiers", async () => {
    mockStoredRevision({ version: 1 });
    const app = Fastify({ logger: false });
    await app.register(adminGenerationQualityRoutes);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/generation-quality",
      payload: { styleAuditor: { ultra: true } }
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json() as { error: string };
    expect(error).toMatch(/^styleAuditor:/);
    expect(error).toMatch(/lists of effort tiers/i);
    expect(mockPrisma.generationQualityRevision.create).not.toHaveBeenCalled();
    await app.close();
  });
});
