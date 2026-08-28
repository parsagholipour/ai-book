import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two render passes, live at once, over one cast.
 *
 * That state is ordinary now that the renders sit outside the advisory lock:
 * the lease is deliberately not renewed, so a waiter that sees it expire
 * re-claims and renders alongside a first pass that is still going. Both then
 * arrive at the commit, and these tests are about which of the two answers the
 * plan keeps — which may not be "whoever got here first", because one of the
 * answers a pass can carry is a refusal, and a refusal is permanent.
 *
 * They drive the real interleaving through the lease's only caller rather than
 * a stand-in: two `ensureCharacterReferenceAssets` calls against one in-memory
 * store, each with its own image model.
 */

const mocks = vi.hoisted(() => ({
  imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  planVersion: { findUnique: vi.fn(), updateMany: vi.fn() },
  executeRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  executeRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  projectFindUnique: vi.fn(),
  updateJobProgress: vi.fn(),
  assertJobNotStopped: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}));

const tx = {
  imageAsset: mocks.imageAsset,
  planVersion: mocks.planVersion,
  $executeRaw: mocks.executeRaw,
  $queryRawUnsafe: mocks.queryRawUnsafe,
  $executeRawUnsafe: mocks.executeRawUnsafe
};

vi.mock("@book-maker/db", () => ({
  prisma: {
    imageAsset: mocks.imageAsset,
    planVersion: mocks.planVersion,
    project: { findUnique: mocks.projectFindUnique },
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $executeRawUnsafe: mocks.executeRawUnsafe
  },
  Prisma: { DbNull: "DbNull" }
}));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/tmp/images", BOOK_STORAGE_DIR: "/tmp/books", PUBLIC_API_URL: "http://api.test" }
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  updateJobProgress: mocks.updateJobProgress,
  assertJobNotStopped: mocks.assertJobNotStopped
}));
vi.mock("./bookHelpers.js", () => ({ imageGenerationMetadata: () => ({}), imageStorageMetadata: () => ({}) }));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  appendFile: mocks.appendFile,
  rm: mocks.rm,
  stat: mocks.stat
}));
vi.mock("@book-maker/core", () => ({
  shouldGenerateCharacterReferences: () => true,
  shouldUseCharacterReferenceImages: () => true,
  buildCharacterReferencePrompt: ({ character }: { character: { name: string } }) => `draw ${character.name}`,
  optimizeImageForStorage: async () => ({ bytes: Buffer.from(""), extension: "png" }),
  publicAssetUrl: (_base: string, path: string) => `http://api.test${path}`,
  selectCharacterReferenceAssets: () => [],
  libraryCharactersFromMediaSettings: () => [],
  matchLibraryCharacter: () => null,
  libraryCharacterDiskPath: () => null,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  isImageContentRefusalError: (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as Record<string, unknown>).imageContentRefused === true),
  imageRefusalReason: (error: unknown) => String((error as Record<string, unknown>)?.reason ?? "refused"),
  safePathPart: (value: string) => value,
  foldCharacterName: (value: string) => value.trim().toLowerCase(),
  characterReferenceSeedInstruction: (source: string) => `seed:${source}`,
  imageAdapterCapabilities: (image: { capabilities: () => unknown }) => image.capabilities(),
  libraryCharacterFaceInstruction: () => ""
}));

import { ensureCharacterReferenceAssets } from "./characterReferences.js";
import {
  CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS,
  CHARACTER_REFERENCE_LEASE_MS
} from "./characterReferenceRenderLease.js";

/** The wait polls at this cadence, so two of them is "let it look again". */
const TWO_POLLS_MS = 4_000;

type StoredAsset = { id: string; path: string; metadata: Record<string, unknown> };

/**
 * The rows and columns the two passes share: this plan's sheets, its settlement
 * column, and the lease they take turns claiming.
 */
const store: {
  assets: StoredAsset[];
  refusals: unknown;
  lease: { token: string; expiresAt: number } | null;
  created: number;
  /** The `PlanVersion` row itself — an undo of a structural edit deletes it. */
  planExists: boolean;
} = { assets: [], refusals: null, lease: null, created: 0, planExists: true };

const plan = {
  characters: [
    { name: "Ada", role: "protagonist", description: "", traits: [], visualRules: [] },
    { name: "Beatrice", role: "sidekick", description: "", traits: [], visualRules: [] }
  ]
} as never;

const image = () => ({ bytes: Buffer.from(""), mimeType: "image/png", provider: "fake", model: "fake" });
const refusalFor = (name: string) =>
  Object.assign(new Error(`the image model refused ${name}`), { imageContentRefused: true, reason: "IMAGE_SAFETY" });

/** Draws everyone but the named characters, whom both providers refuse. */
const refusing = (...names: string[]) =>
  vi.fn(async ({ prompt }: { prompt: string }) => {
    const refused = names.find((name) => prompt.includes(name));
    if (refused) {
      throw refusalFor(refused);
    }
    return image();
  });

/** The lever the test holds a pass on. `Promise.withResolvers` is past this tsconfig's lib. */
const openGate = (): { promise: Promise<void>; open: () => void } => {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => {
      resolve();
    };
  });
  return { promise, open };
};

/** Draws everyone, but not until the test lets it — the slow pass. */
const gatedBy = (gate: Promise<void>, ...refused: string[]) => {
  const render = refusing(...refused);
  return vi.fn(async (args: { prompt: string }) => {
    await gate;
    return render(args);
  });
};

const optionsFor = (generateImageBytes: unknown) =>
  ({
    projectId: "project-1",
    planId: "plan-1",
    input: {},
    plan,
    providers: { image: { capabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 3 }) } },
    strategy: { generateImageBytes },
    generationJobId: "gj-1"
  }) as never;

/** Everything the mocks do resolves in microtasks, so this drains the pass. */
const drain = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
};

const sheetNames = () =>
  store.assets.map((asset) => String((asset.metadata as { characterName: string }).characterName)).sort();
const sheetFiles = () => store.assets.map((asset) => String((asset.metadata as { fileName: string }).fileName)).sort();

describe("two live character reference render passes", () => {
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.assets = [];
    store.refusals = null;
    store.lease = null;
    store.created = 0;
    store.planExists = true;
    mocks.assertJobNotStopped.mockResolvedValue(undefined);

    // `pg_advisory_xact_lock` is taken at the top of every one of these, so two
    // passes are never inside one together — which is the whole reason the
    // second one's re-read sees what the first one committed.
    let held: Promise<unknown> = Promise.resolve();
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      const run = held.then(() => callback(tx));
      held = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    });
    mocks.executeRaw.mockResolvedValue(1);

    // The lease, as `takeRenderLease` writes it: one compare-and-set that a
    // free or expired lease satisfies and a live one does not.
    mocks.queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('UPDATE "PlanVersion"')) {
        const token = String(params[1]);
        const ttlMs = Number(params[2]);
        // A `WHERE "id" = $1` over a row that is not there matches nothing, for
        // every caller alike — which is the whole of the case below.
        if (!store.planExists || (store.lease && store.lease.expiresAt > Date.now())) {
          return [];
        }
        store.lease = { token, expiresAt: Date.now() + ttlMs };
        return [{ characterReferenceLeaseExpiresAt: new Date(store.lease.expiresAt) }];
      }
      return store.planExists
        ? [
            {
              live: Boolean(store.lease && store.lease.expiresAt > Date.now()),
              token: store.lease?.token ?? null
            }
          ]
        : [];
    });
    // Only ever its own: a pass that lost the lease may not clear the new owner's.
    mocks.executeRawUnsafe.mockImplementation(async (_sql: string, ...params: unknown[]) => {
      if (store.lease?.token === String(params[1])) {
        store.lease = null;
      }
      return 1;
    });

    mocks.imageAsset.findMany.mockImplementation(async () => store.assets.map((asset) => ({ ...asset })));
    mocks.imageAsset.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      store.created += 1;
      const row = { id: `asset-${store.created}`, path: String(data.path), metadata: data.metadata as Record<string, unknown> };
      store.assets.push(row);
      return { ...row };
    });
    mocks.imageAsset.deleteMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      const removed = new Set(where.id.in);
      store.assets = store.assets.filter((asset) => !removed.has(asset.id));
      return { count: removed.size };
    });
    mocks.planVersion.findUnique.mockImplementation(async () =>
      store.planExists ? { id: "plan-1", characterReferenceRefusals: store.refusals } : null
    );
    mocks.planVersion.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (!store.planExists) {
        return { count: 0 };
      }
      store.refusals = data.characterReferenceRefusals === "DbNull" ? null : data.characterReferenceRefusals;
      return { count: 1 };
    });
    mocks.projectFindUnique.mockResolvedValue({ userId: "user-1" });
    mocks.stat.mockRejectedValue(new Error("no file"));
  });

  afterEach(() => {
    consoleWarn.mockRestore();
    vi.useRealTimers();
  });

  /** Starts a pass and leaves it inside its renders, holding a live lease. */
  const startSlowPass = async (generateImageBytes: { mock: { calls: unknown[] } }) => {
    // Wrapped, never returned bare: an `async` function awaits a promise it
    // returns, and this one is deliberately still rendering.
    const pending = ensureCharacterReferenceAssets(optionsFor(generateImageBytes));
    await drain();
    expect(generateImageBytes.mock.calls).toHaveLength(2);
    expect(store.lease).not.toBeNull();
    return { pending };
  };

  /**
   * Starts a pass, waits until it is inside its renders, then expires the lease
   * under it — the five minutes passing while a slow cast is still drawing.
   */
  const startSlowPassAndExpireItsLease = async (generateImageBytes: { mock: { calls: unknown[] } }) => {
    const started = await startSlowPass(generateImageBytes);
    store.lease = { token: store.lease!.token, expiresAt: Date.now() - 1 };
    return started;
  };

  it("keeps the sheet a losing pass drew over a refusal that committed first", async () => {
    // The failure this is written for: the slow pass drew the whole cast, the
    // pass that re-claimed the expired lease was refused Beatrice, and the
    // refusal got to the commit first. Standing down for it made "Beatrice has
    // no sheet" the plan's permanent answer — nothing re-renders a settled set
    // — so a drawing that existed and was paid for was thrown away because it
    // lost a race.
    const gate = openGate();
    const slow = gatedBy(gate.promise);
    const { pending } = await startSlowPassAndExpireItsLease(slow);

    const refusedPass = await ensureCharacterReferenceAssets(optionsFor(refusing("Beatrice")));
    expect(refusedPass).toHaveLength(1);
    expect(store.refusals).toEqual([{ name: "Beatrice", reason: "IMAGE_SAFETY" }]);

    gate.open();
    const drawnPass = await pending;

    expect(drawnPass.map((asset) => (asset.metadata as { characterName: string }).characterName).sort()).toEqual([
      "Ada",
      "Beatrice"
    ]);
    expect(sheetNames()).toEqual(["Ada", "Beatrice"]);
    // And the refusal is taken back rather than left standing beside a sheet
    // for the same character.
    expect(store.refusals).toBeNull();
    // Every published row names a file this pass wrote, so the superseded
    // pass's sheet is replaced rather than half-kept.
    const written = new Set(mocks.writeFile.mock.calls.map(([path]) => String(path).split("/").pop()));
    expect(sheetFiles().every((file) => written.has(file))).toBe(true);
  });

  it("leaves two answers that both drew the cast with whoever committed first", async () => {
    // A tie is the one thing arrival order settles well: the second pass adds
    // nothing, so it stands down instead of rewriting rows a page render may
    // already be attaching.
    const gate = openGate();
    const slow = gatedBy(gate.promise);
    const { pending } = await startSlowPassAndExpireItsLease(slow);

    const winner = await ensureCharacterReferenceAssets(optionsFor(refusing()));
    const winnerIds = winner.map((asset) => asset.id).sort();

    gate.open();
    const loser = await pending;

    expect(loser.map((asset) => asset.id).sort()).toEqual(winnerIds);
    expect(store.assets.map((asset) => asset.id).sort()).toEqual(winnerIds);
    expect(mocks.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(store.refusals).toBeNull();
  });

  it("names the plan version in the line that says a character was given up on", async () => {
    // A refusal settles the cast for the life of the plan version, and nothing
    // in the tree ever cleared that column — so the recovery is to clear it by
    // hand (`scripts/clear-character-reference-refusals.ts`) and let the next
    // image or cover job redraw. This is the only announcement an operator is
    // looking at when it happens: the run log beside it is a file under the
    // project's own directory. Naming the project and the character but not the
    // plan version named the fact and not the row that holds it.
    await ensureCharacterReferenceAssets(optionsFor(refusing("Beatrice")));

    expect(consoleWarn).toHaveBeenCalledWith(
      "Character reference sheet refused; the book will render without it",
      expect.objectContaining({
        warning: "character_reference_refused",
        projectId: "project-1",
        planId: "plan-1",
        characterName: "Beatrice"
      })
    );
  });

  it("unlinks the sheets a pass wrote when the commit did not keep its answer", async () => {
    // Every stem carries the pass's own render id, so a pass that stands down
    // leaves a whole cast of files no row names — and nothing under
    // `IMAGE_STORAGE_DIR/<projectId>/` is unlinked short of deleting the
    // project. Unswept, that is one permanent cast per lease expiry, per losing
    // supersede and per retry, on a book that renders exactly right.
    const gate = openGate();
    const slow = gatedBy(gate.promise);
    const { pending } = await startSlowPassAndExpireItsLease(slow);

    await ensureCharacterReferenceAssets(optionsFor(refusing()));

    gate.open();
    await pending;

    const written = mocks.writeFile.mock.calls.map(([path]) => String(path));
    const removed = mocks.rm.mock.calls.map(([path]) => String(path));
    const kept = new Set(sheetFiles());
    expect(written).toHaveLength(4);
    // Exactly the files no published row names, and every one of them.
    expect(removed.sort()).toEqual(written.filter((path) => !kept.has(String(path.split("/").pop()))).sort());
    expect(removed).toHaveLength(2);
    expect(mocks.rm.mock.calls.every(([, options]) => options?.force === true)).toBe(true);
  });

  it("keeps the sheets of a commit whose rows landed under a dropped connection", async () => {
    // **The one case where sweeping destroys live data.** The commit wrote the
    // whole cast and Postgres committed it; the ack never arrived, so
    // `prisma.$transaction` raised a `P1017` over rows that are on the table.
    // Read as "nothing landed", the sweep unlinked every file those rows name —
    // and `characterReferenceSetIsSettled` is satisfied by them, so nothing ever
    // re-renders the cast: every page render and the cover resolve a reference
    // path that ENOENTs for the life of the plan version.
    const lostAck = Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
    let transactions = 0;
    const serialized = mocks.transaction.getMockImplementation()!;
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      transactions += 1;
      const answer = await serialized(callback);
      // The claim is the first transaction, the commit the second.
      if (transactions < 2) {
        return answer;
      }
      throw lostAck;
    });

    await expect(ensureCharacterReferenceAssets(optionsFor(refusing()))).rejects.toBe(lostAck);

    // The rows really did land, which is the whole premise.
    expect(sheetNames()).toEqual(["Ada", "Beatrice"]);
    // And not one of the files they name was unlinked.
    const written = mocks.writeFile.mock.calls.map(([path]) => String(path));
    expect(written).toHaveLength(2);
    expect(mocks.rm).not.toHaveBeenCalled();
    // Said out loud, because a cast kept on a maybe is a cast nothing sweeps.
    const line = String(mocks.appendFile.mock.calls.at(-1)?.[1]);
    expect(JSON.parse(line)).toMatchObject({
      event: "character.reference.sweep_declined",
      reason: "commit_landed"
    });
  });

  it("unlinks what a render wrote before it gave up part way through the cast", async () => {
    // An outage stays fatal on purpose — `generate-book`'s retry ladder is the
    // right answer to one — and the retry draws the cast again under a fresh
    // render id, so this attempt's sheets are unreachable the moment it throws.
    // Ada is held open until after Beatrice fails, because a rejecting
    // `Promise.all` used to settle the pass while its siblings were still
    // inside a render: their `writeFile` then landed behind the sweep.
    const outage = new Error("the image provider timed out");
    const gate = openGate();
    const generateImageBytes = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes("Beatrice")) {
        throw outage;
      }
      await gate.promise;
      return image();
    });

    const pending = ensureCharacterReferenceAssets(optionsFor(generateImageBytes));
    await drain();
    gate.open();
    await expect(pending).rejects.toBe(outage);

    const written = mocks.writeFile.mock.calls.map(([path]) => String(path));
    expect(written).toHaveLength(1);
    expect(mocks.rm.mock.calls.map(([path]) => String(path))).toEqual(written);
    expect(store.assets).toEqual([]);
  });

  it("reads one plan's sheets by predicate and projection rather than the project's whole table", async () => {
    // What a waiter pays for every poll of a render it lost. The read named no
    // `select`, so `prompt` — the multi-kilobyte text a sheet was drawn from —
    // came back on every row; and no plan predicate, so it scanned and sorted
    // every plan version's sheets and dropped all but this one's in memory,
    // against a table that carried no index at all.
    await ensureCharacterReferenceAssets(optionsFor(refusing()));

    const reads = mocks.imageAsset.findMany.mock.calls.map(([args]) => args);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.where).toEqual({
        projectId: "project-1",
        type: "CHARACTER_REFERENCE",
        metadata: { path: ["planId"], equals: "plan-1" }
      });
      expect(read.select).toEqual({ id: true, path: true, metadata: true });
    }
  });

  it("leaves an answer that would trade one character's sheet for another's alone", async () => {
    // Neither answer covers the other: this pass drew Beatrice but was refused
    // Ada, and the settled one is the mirror of that. Committing it would take
    // one refusal back by recording another — the commit replaces the rows it
    // read rather than merging with them — and the two passes could then
    // ping-pong. The winner keeps it.
    const gate = openGate();
    const slow = gatedBy(gate.promise, "Ada");
    const { pending } = await startSlowPassAndExpireItsLease(slow);

    await ensureCharacterReferenceAssets(optionsFor(refusing("Beatrice")));
    expect(sheetNames()).toEqual(["Ada"]);

    gate.open();
    const loser = await pending;

    expect(loser.map((asset) => (asset.metadata as { characterName: string }).characterName)).toEqual(["Ada"]);
    expect(sheetNames()).toEqual(["Ada"]);
    expect(store.refusals).toEqual([{ name: "Beatrice", reason: "IMAGE_SAFETY" }]);
  });

  /**
   * The other half of overlapping passes: the caller that is *watching* them.
   *
   * Fake `setTimeout` and `Date` only — the harness drains its microtasks
   * through a real `setImmediate`, and the poll loop is minutes long in a clock
   * no test may spend.
   */
  const useLeaseClock = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  };

  it("waits out an owner it did not start waiting on, rather than abandoning under a live render", async () => {
    // The failure this is written for: a waiter's deadline was fixed at entry,
    // and a lease that is never renewed can only stay live across it by being
    // taken again. So the one state that could reach that deadline was a relay
    // — a second pass rendering the cast right now — and it was read as "nobody
    // is coming". The page then drew with the sheets that existed, which
    // mid-pass is none, minutes before the whole cast landed.
    useLeaseClock();
    const gate = openGate();
    const { pending } = await startSlowPass(gatedBy(gate.promise));

    // A second image job of the same book: the lease is live, so its claim
    // comes back busy and it polls instead of rendering.
    const waitingImage = refusing();
    const waiting = ensureCharacterReferenceAssets(optionsFor(waitingImage));
    await drain();
    expect(waitingImage).not.toHaveBeenCalled();

    // Four minutes of polling, all of it the owner it lost the claim to.
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    // Then that lease runs out and another worker's pass takes it — a new
    // token, a fresh five minutes — inside the two seconds before our waiter's
    // next poll, so it never sees the gap and never gets to re-claim.
    store.lease = { token: "another-worker", expiresAt: Date.now() + CHARACTER_REFERENCE_LEASE_MS };

    // Past the deadline a waiter that entered at t=0 used to hold.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(consoleWarn).not.toHaveBeenCalled();

    // The cast lands while that second owner is still inside its lease.
    gate.open();
    await drain();
    expect(sheetNames()).toEqual(["Ada", "Beatrice"]);

    await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);
    await expect(waiting).resolves.toHaveLength(2);
    await pending;
    // It waited for them rather than paying for a second cast of its own.
    expect(waitingImage).not.toHaveBeenCalled();
    expect(store.created).toBe(2);
  });

  it("still gives up when the lease keeps relaying and nobody finishes the cast", async () => {
    // And the renewal is bounded, or a book whose passes keep expiring would
    // hold this worker slot until the process restarted.
    useLeaseClock();
    const gate = openGate();
    const { pending } = await startSlowPass(gatedBy(gate.promise));

    const outcome: { assets: unknown } = { assets: "still-polling" };
    void ensureCharacterReferenceAssets(optionsFor(refusing())).then((assets) => {
      outcome.assets = assets;
    });
    await drain();

    // A fresh owner every four minutes, none of which ever commits, so the
    // lease is live at every single poll and the waiter never re-claims.
    for (let relay = 0; relay < 6; relay += 1) {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      store.lease = { token: `owner-${relay}`, expiresAt: Date.now() + CHARACTER_REFERENCE_LEASE_MS };
    }
    await drain();

    expect(outcome.assets).toEqual([]);
    const [message, detail] = consoleWarn.mock.calls.at(-1) as [string, { waitedMs: number; relays: number }];
    expect(message).toContain("Gave up waiting for a character reference render");
    expect(detail.relays).toBeGreaterThan(0);
    // Bounded in both directions: it renewed well past the one owner's budget
    // it entered with, and it stopped at the ceiling rather than at the relay
    // that happened to be last.
    expect(detail.waitedMs).toBeGreaterThan(2 * CHARACTER_REFERENCE_LEASE_MS);
    expect(detail.waitedMs).toBeLessThanOrEqual(CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS + TWO_POLLS_MS);
    // And it is legible rather than an empty array handed back in silence: the
    // run log is where a book's missing sheets are explained, and "we gave up on
    // a render somebody else was still paying for" is a different fact from
    // "this cast has no sheets" — which is the only thing `[]` says on its own.
    const standDown = mocks.appendFile.mock.calls.at(-1)?.[1];
    expect(standDown).toBeTypeOf("string");
    expect(JSON.parse(String(standDown))).toMatchObject({
      event: "character.reference.stand_down",
      reason: "lease_abandoned",
      projectId: "project-1",
      planId: "plan-1"
    });

    gate.open();
    await pending;
  });

  /**
   * Another worker claims the instant this caller sees the lease die, so the
   * wait answers `expired`, the re-claim behind it answers `busy`, and the pass
   * falls into its *second* wait — the state the ceiling below is about.
   */
  const stealTheGap = () => {
    const claimsAndReads = mocks.queryRawUnsafe.getMockImplementation()!;
    let stolen = false;
    mocks.queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
      const rows: unknown = await claimsAndReads(sql, ...params);
      const dead = !store.lease || store.lease.expiresAt <= Date.now();
      if (!stolen && dead && !sql.includes('UPDATE "PlanVersion"')) {
        stolen = true;
        store.lease = { token: "another-worker", expiresAt: Date.now() + CHARACTER_REFERENCE_LEASE_MS };
      }
      return rows;
    });
  };

  it("holds one ceiling over the whole job, not one per wait it enters", async () => {
    // The failure this is written for: the ceiling was taken on entry to the
    // *wait*, and one pass enters the wait twice. A first wait that relayed
    // through owners for its whole budget answers `expired` when the last of
    // them dies, the re-claim behind it comes back `busy` because another worker
    // was quicker, and the second wait then started a fresh fifteen minutes —
    // half an hour of a held worker slot out of a bound whose own comment says
    // "the whole wait, however many owners it spans, taken once".
    useLeaseClock();
    const gate = openGate();
    const { pending } = await startSlowPass(gatedBy(gate.promise));
    const startedAt = Date.now();

    const waitingImage = refusing();
    const gaveUp: { after: number; assets: unknown } = { after: -1, assets: "still-polling" };
    void ensureCharacterReferenceAssets(optionsFor(waitingImage)).then((assets) => {
      gaveUp.after = Date.now() - startedAt;
      gaveUp.assets = assets;
    });
    await drain();

    // Four minutes in, the owner it lost the claim to runs out at a poll and
    // somebody else takes the gap.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    store.lease = { token: store.lease!.token, expiresAt: Date.now() - 1 };
    stealTheGap();
    await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);

    // From here the lease keeps changing hands and nobody ever commits, so every
    // relay renews the deadline and only the ceiling can end this.
    const runFor = CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS + 2 * TWO_POLLS_MS;
    while (Date.now() - startedAt < runFor) {
      await vi.advanceTimersByTimeAsync(30_000);
      if (store.lease && store.lease.expiresAt - Date.now() < 60_000) {
        store.lease = { token: `owner-${Date.now()}`, expiresAt: Date.now() + CHARACTER_REFERENCE_LEASE_MS };
      }
    }
    await drain();

    expect(gaveUp.assets).toEqual([]);
    // Bounded in both directions, as the single-wait case is: it relayed well
    // past the one owner's budget it entered with, and it stopped at the job's
    // ceiling rather than at a second ladder of its own.
    expect(gaveUp.after).toBeGreaterThan(CHARACTER_REFERENCE_LEASE_MS);
    expect(gaveUp.after).toBeLessThanOrEqual(runFor);
    expect(waitingImage).not.toHaveBeenCalled();

    gate.open();
    await pending;
  });

  it("ends the wait when the reader stops the run", async () => {
    // Nothing else in this loop can see a stop: `pass.read` and the lease read
    // are plain selects, no abort signal reaches the driver, and `processJob`'s
    // own check runs only once the handler has returned or thrown. So a reader
    // who pressed Stop kept a worker slot — and the run's own settlement —
    // waiting on a cast nobody wants any more, for the whole ceiling.
    useLeaseClock();
    const gate = openGate();
    const { pending } = await startSlowPass(gatedBy(gate.promise));

    const waitingImage = refusing();
    const settled = ensureCharacterReferenceAssets(optionsFor(waitingImage)).then(
      () => "resolved",
      (error: unknown) => (error as Error).name
    );
    await drain();
    await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);
    expect(mocks.assertJobNotStopped).toHaveBeenCalledWith("gj-1");

    // The reader presses Stop: the `GenerationJob` row goes FAILED with the
    // stopped marker, which is the read behind this assert.
    mocks.assertJobNotStopped.mockRejectedValue(
      Object.assign(new Error("Stopped by user"), { name: "StopRequestedError" })
    );
    await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);

    // Raised rather than stood down for: `processJob` settles a stop through
    // `markStopped`, while a quiet empty answer would have this job COMPLETE.
    await expect(settled).resolves.toBe("StopRequestedError");
    // And it did not wait the owner out first — minutes of that lease were left.
    expect(waitingImage).not.toHaveBeenCalled();

    gate.open();
    await pending;
  });

  /**
   * And the case where there is no owner to wait for, because there is no row.
   *
   * An undo of a structural edit deletes the plan version it approved
   * (`packages/db/src/pageRestructureRevert.ts`), which can land while this
   * book's image jobs are still fanned out. The claim's compare-and-set is a
   * `WHERE "id" = $1`, so a deleted row makes it match nothing — and it matches
   * nothing for *everybody*, which is the exact inverse of what the lease is
   * for.
   */
  describe("a plan version deleted out from under the cast", () => {
    it("stands every waiting job down instead of telling all of them they won", async () => {
      // The failure this is written for: the vanished row answered `claimed`
      // with a null token, so every `generate-image` job of the book plus the
      // cover job was told it owned the render at once and each paid for the
      // whole cast — one renderer per plan version inverted into N of them,
      // unbilled, for a plan id nothing current reads.
      store.planExists = false;
      const jobs = [refusing(), refusing(), refusing()];

      const answers = await Promise.all(jobs.map((generateImageBytes) => ensureCharacterReferenceAssets(optionsFor(generateImageBytes))));

      // The cost first: three jobs, two characters each, six image renders
      // nobody asked for and nothing bills.
      for (const job of jobs) {
        expect(job).not.toHaveBeenCalled();
      }
      expect(answers).toEqual([[], [], []]);
      expect(store.created).toBe(0);
      expect(mocks.imageAsset.create).not.toHaveBeenCalled();
      // Said out loud, the way `abandoned` is: the page draws with the sheets
      // that exist, which is a weaker likeness and never a failed book.
      const [message, detail] = consoleWarn.mock.calls.at(-1) as [string, { warning: string; planId: string }];
      expect(message).toContain("character reference");
      expect(detail.warning).toBe("character_reference_plan_version_gone");
      expect(detail.planId).toBe("plan-1");
    });

    it("hands back the sheets that plan still has rather than nothing", async () => {
      // Standing down is "use what exists", not "answer empty": a half-drawn
      // cast is exactly what the deleted row leaves behind, and the sheet Ada
      // already has is still the sheet a page render should attach.
      store.assets = [
        { id: "asset-0", path: "http://api.test/ada.png", metadata: { planId: "plan-1", characterName: "Ada" } }
      ];
      store.created = 1;
      store.planExists = false;

      const generateImageBytes = refusing();
      const answer = await ensureCharacterReferenceAssets(optionsFor(generateImageBytes));

      expect(answer.map((asset) => (asset.metadata as { characterName: string }).characterName)).toEqual(["Ada"]);
      expect(generateImageBytes).not.toHaveBeenCalled();
      expect(mocks.imageAsset.deleteMany).not.toHaveBeenCalled();
      expect(store.created).toBe(1);
    });
  });
});
