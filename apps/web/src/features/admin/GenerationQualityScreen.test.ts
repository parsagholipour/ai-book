import { QUALITY_FEATURE_IDS } from "@book-maker/core/qualityGates";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";
import {
  QualityTierFieldset,
  featureRows,
  qualityConflictNotice,
  qualityResetFailure,
  qualitySaveClaim,
  qualitySaveConflict,
  readQualityHead,
  rebaseQualityDraft,
  recoverQualitySave,
  toggleQualityTier,
  type GenerationQuality
} from "./GenerationQualityScreen.js";

/**
 * The twelfth feature: an id the server knows about and wrote no copy for.
 *
 * `settings` is what the API builds from known ids plus compatible future ids,
 * so it is the only key set a save may be missing a row for; `features` is a
 * separate hand-maintained array in core. This is the whole reason the screen
 * keys off the first and not the second — and the reason it takes the known ids
 * from core rather than restating them, which is what makes the base map below
 * impossible to leave a known key out of.
 */
function responseWith(...undescribedIds: string[]): GenerationQuality {
  const settings = {} as GenerationQuality["settings"];
  for (const id of QUALITY_FEATURE_IDS) {
    settings[id] = [];
  }
  settings.planCritic = ["ultra", "premium"];
  for (const id of undescribedIds) {
    settings[id] = [];
  }
  return {
    version: 3,
    settings,
    usingCompiledDefaults: false,
    features: [{ id: "planCritic", label: "Plan critic", summary: "One cheap call per book." }],
    note: null,
    updatedBy: null,
    updatedAt: null
  };
}

/** What the screen holds as its draft: the response's own map, cloned. */
function draftOf(state: GenerationQuality): GenerationQuality["settings"] {
  return JSON.parse(JSON.stringify(state.settings)) as GenerationQuality["settings"];
}

/**
 * `mergeQualityFeatureSettings` restated, so a claim can be checked against the
 * thing it is built for.
 *
 * A feature the body names takes the body's tiers; one it does not keeps the
 * stored revision's, decided by presence and never truthiness. Which is which
 * is decided *only* by what the body carries — which is why a body naming all
 * eleven features could never preserve a concurrent save, however carefully the
 * server replayed the merge underneath it.
 */
function mergeLikeServer(
  stored: GenerationQuality["settings"],
  body: ReturnType<typeof qualitySaveClaim>
): GenerationQuality["settings"] {
  const merged = {} as GenerationQuality["settings"];
  for (const id of QUALITY_FEATURE_IDS) {
    const assigned = body?.[id];
    merged[id] = Array.isArray(assigned) ? [...assigned] : (stored[id] ?? []);
  }
  return merged;
}

describe("featureRows", () => {
  it("keeps the written copy for a described feature", () => {
    const rows = featureRows(responseWith());
    expect(rows.find((row) => row.id === "planCritic")).toEqual({
      id: "planCritic",
      label: "Plan critic",
      summary: "One cheap call per book."
    });
  });

  it("gives every id the server sent a row, in the order it sent them", () => {
    const response = responseWith("twelfthGate");
    expect(featureRows(response).map((row) => row.id)).toEqual(Object.keys(response.settings));
  });

  it("renders a server id with no copy rather than dropping it", () => {
    const rows = featureRows(responseWith("twelfthGate"));
    const undescribed = rows.find((row) => row.id === "twelfthGate");
    expect(undescribed?.label).toBe("Twelfth Gate");
    expect(undescribed?.summary).toContain("twelfthGate");
  });

  it("title-cases an undescribed id however the server spelled it", () => {
    const rows = featureRows(responseWith("twelfthGate", "beat_dedup", "arcContinuityCheck"));
    const labels = new Map(rows.map((row) => [row.id, row.label]));
    expect(labels.get("beat_dedup")).toBe("Beat Dedup");
    expect(labels.get("arcContinuityCheck")).toBe("Arc Continuity Check");
  });
});

describe("quality tier controls", () => {
  it("renders an observed unknown active tier and lets the shared toggle remove it", () => {
    const assigned = ["ultra", "glacial"];
    const markup = renderToStaticMarkup(
      createElement(QualityTierFieldset, {
        label: "Plan critic",
        assigned,
        disabled: true,
        onToggle: () => undefined
      })
    );

    expect(markup).toContain("Ultra");
    expect(markup).toContain("Unknown tier · glacial");
    expect(markup).toContain('aria-label="Plan critic"');
    expect(markup).toContain("disabled");
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(toggleQualityTier(assigned, "glacial")).toEqual(["ultra"]);
  });
});

describe("quality form request boundary", () => {
  it("locks the complete form during save and reset, then settles without losing edits", async () => {
    const server = await createServer({
      root: new URL("../../../", import.meta.url).pathname,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 }
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Vite did not publish a test port");
    }
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      chromium.executablePath(),
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome"
    ];
    const executablePath = candidates.find((candidate) => candidate && existsSync(candidate));
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox"]
    });
    const page = await browser.newPage();
    const loaded = responseWith("twelfthGate");
    loaded.settings.planCritic = ["ultra", "premium", "glacial"];
    type Reply = { status?: number; body: GenerationQuality | { error: string } };
    let pending:
      | { started: () => void; reply: Promise<Reply> }
      | undefined;
    let mutationRequests = 0;
    function armMutation() {
      let started!: () => void;
      let resolve!: (reply: Reply) => void;
      const startedPromise = new Promise<void>((done) => (started = done));
      const reply = new Promise<Reply>((done) => (resolve = done));
      pending = { started, reply };
      return { started: startedPromise, resolve };
    }
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/auth/status") {
        await route.fulfill({ json: { enabled: true, authenticated: true } });
      } else if (path === "/api/admin/generation-quality" && request.method() === "GET") {
        await route.fulfill({ json: loaded });
      } else if (
        path === "/api/admin/generation-quality" ||
        path === "/api/admin/generation-quality/reset"
      ) {
        const requestBoundary = pending;
        if (!requestBoundary) {
          throw new Error(`unexpected ${request.method()} ${path}`);
        }
        mutationRequests += 1;
        requestBoundary.started();
        const reply = await requestBoundary.reply;
        pending = undefined;
        await route.fulfill({ status: reply.status ?? 200, json: reply.body });
      } else {
        await route.abort();
      }
    });

    try {
      await page.goto(`http://127.0.0.1:${address.port}/admin/quality`);
      await page.getByRole("heading", { name: "Publish change" }).waitFor();
      // The first request makes Vite transform the route and can be slower under
      // the concurrent workspace gate. Keep fast feedback for the interactions
      // below without turning that startup work into a three-second race.
      page.setDefaultTimeout(3_000);
      const tiers = page.getByRole("group", { name: "Plan critic" });
      const premium = tiers.getByRole("checkbox", { name: "Premium" });
      const note = page.getByLabel("Change note");
      const save = page.getByRole("button", { name: "Save setting" });
      const reset = page.getByRole("button", { name: "Reset to defaults" });
      await premium.uncheck();
      await note.fill("keep this draft");

      const refusedSave = armMutation();
      await save.click();
      await refusedSave.started;
      const controls = page.locator(".admin-page input, .admin-page button");
      expect(await controls.evaluateAll((nodes) => nodes.every((node) => node.matches(":disabled"))))
        .toBe(true);
      await premium.click({ force: true });
      await reset.click({ force: true });
      expect(await premium.isChecked()).toBe(false);
      expect(await note.inputValue()).toBe("keep this draft");
      expect(mutationRequests).toBe(1);
      refusedSave.resolve({ status: 400, body: { error: "save refused" } });
      await page.getByText("save refused").waitFor();
      expect(await premium.isDisabled()).toBe(false);
      expect(await note.isDisabled()).toBe(false);
      expect(await reset.isDisabled()).toBe(false);
      expect(await save.isDisabled()).toBe(false);
      expect(await note.inputValue()).toBe("keep this draft");

      const saved = responseWith();
      saved.version = 4;
      saved.settings.planCritic = ["fast"];
      saved.note = "keep this draft";
      const acceptedSave = armMutation();
      await save.click();
      await acceptedSave.started;
      acceptedSave.resolve({ body: saved });
      await page.getByText("Saved as generation quality version 4.").waitFor();
      expect(await page.getByText(/Current version 4/).count()).toBe(1);
      expect(await tiers.getByRole("checkbox", { name: "Quick draft" }).isChecked()).toBe(true);
      expect(await note.inputValue()).toBe("");
      expect(await note.isDisabled()).toBe(false);
      expect(await reset.isDisabled()).toBe(false);

      await tiers.getByRole("checkbox", { name: "Ultra" }).check();
      await note.fill("keep reset draft");
      const refusedReset = armMutation();
      await reset.click();
      await refusedReset.started;
      expect(await controls.evaluateAll((nodes) => nodes.every((node) => node.matches(":disabled"))))
        .toBe(true);
      await save.click({ force: true });
      expect(mutationRequests).toBe(3);
      refusedReset.resolve({ status: 400, body: { error: "reset refused" } });
      await page.getByText("reset refused").waitFor();
      expect(await note.inputValue()).toBe("keep reset draft");
      expect(await tiers.getByRole("checkbox", { name: "Ultra" }).isChecked()).toBe(true);
      expect(await note.isDisabled()).toBe(false);
      expect(await reset.isDisabled()).toBe(false);

      const resetState = responseWith();
      resetState.version = 5;
      resetState.settings.planCritic = ["balanced"];
      const acceptedReset = armMutation();
      await reset.click();
      await acceptedReset.started;
      acceptedReset.resolve({ body: resetState });
      await page.getByText("Reset to compiled defaults as version 5.").waitFor();
      expect(await tiers.getByRole("checkbox", { name: "Balanced" }).isChecked()).toBe(true);
      expect(await note.inputValue()).toBe("");
      expect(await note.isDisabled()).toBe(false);
      expect(await reset.isDisabled()).toBe(false);
    } finally {
      await page.close();
      await browser.close();
      await server.close();
    }
  }, 30_000);
});

describe("qualitySaveClaim", () => {
  it("posts the trimmed note alone when no box was touched", () => {
    const state = responseWith();

    // The save the server documents and no client could produce: the button
    // used to read the settings map only, so this note was dropped in silence.
    expect(qualitySaveClaim(state.settings, draftOf(state), "  gates stand  ")).toEqual({
      note: "gates stand"
    });
  });

  it("stays inert for a note that is blank once trimmed", () => {
    const state = responseWith();

    expect(qualitySaveClaim(state.settings, draftOf(state), " \t\n ")).toBeNull();
  });

  it("stays inert for a form nobody touched", () => {
    const state = responseWith();

    expect(qualitySaveClaim(state.settings, draftOf(state), "")).toBeNull();
  });

  it("posts the moved feature alone, and no note, when nothing was typed", () => {
    const state = responseWith();
    const draft = draftOf(state);
    draft.planCritic = ["ultra"];

    const claim = qualitySaveClaim(state.settings, draft, "");

    // Not the eleven-key map this used to send: every feature nobody touched is
    // absent, so the server's merge leaves it as whoever saved last stored it.
    expect(Object.keys(claim ?? {})).toEqual(["planCritic"]);
    expect(claim?.planCritic).toEqual(["ultra"]);
    expect(claim && "note" in claim).toBe(false);
  });

  it("claims an emptied feature, because `[]` is how a gate is switched off", () => {
    const state = responseWith();
    const draft = draftOf(state);
    draft.planCritic = [];

    const claim = qualitySaveClaim(state.settings, draft, "");

    // Presence, the way the server decides it — a truthiness test here would
    // drop the one claim an operator most needs to make.
    expect(claim && "planCritic" in claim).toBe(true);
    expect(claim?.planCritic).toEqual([]);
    expect(Object.keys(claim ?? {})).toEqual(["planCritic"]);
  });

  it("names only this operator's feature, so a concurrent save survives", () => {
    // Operator B's console loaded version 7. Operator A unchecked `planCritic`
    // and stored version 8 while B was still looking at the form.
    const loadedByB = responseWith();
    loadedByB.settings.styleExcerpts = ["ultra", "premium"];
    const draftOfB = draftOf(loadedByB);
    draftOfB.styleExcerpts = [];

    const claim = qualitySaveClaim(loadedByB.settings, draftOfB, "");

    expect(Object.keys(claim ?? {})).toEqual(["styleExcerpts"]);
    expect(claim?.styleExcerpts).toEqual([]);
    // B's body carries no `planCritic`, so the merge onto version 8 keeps A's.
    // Sent as the whole map it would have carried planCritic at its version 7
    // value and reverted A — the lost update the merge and its replay exist to
    // prevent, delivered by the one client they were built for.
    const storedByA = { ...loadedByB.settings, planCritic: [] };
    const merged = mergeLikeServer(storedByA, claim);
    expect(merged.planCritic).toEqual([]);
    expect(merged.styleExcerpts).toEqual([]);
  });

  it("posts the note beside the map when a box moved and a note explains it", () => {
    const state = responseWith();
    const draft = draftOf(state);
    draft.planCritic = [];

    const claim = qualitySaveClaim(state.settings, draft, "  turning the critic off  ");

    expect(claim?.planCritic).toEqual([]);
    expect(claim?.note).toBe("turning the critic off");
  });

  it("counts a box toggled back as a change, the way the server does", () => {
    const state = responseWith();
    const draft = draftOf(state);
    draft.planCritic = ["premium", "ultra"];

    expect(qualitySaveClaim(state.settings, draft, "")).not.toBeNull();
  });

  it("carries a toggled-back box with the order the toggling left it in", () => {
    const state = responseWith();
    const draft = draftOf(state);
    // Stored is ["ultra", "premium"]; re-checking Ultra appends it, so the list
    // moved and the server is told so — order and all, since it stores what it
    // is given rather than deciding what an equal list is.
    draft.planCritic = ["premium", "ultra"];

    expect(qualitySaveClaim(state.settings, draft, "")).toEqual({
      planCritic: ["premium", "ultra"]
    });
  });

  it("saves a byte-identical round trip on its note alone, and not without one", () => {
    const state = responseWith();
    const draft = draftOf(state);
    // Premium was already last, so unchecking it and checking it back rebuilds
    // the stored list exactly. Re-asserting it would revert whatever another
    // operator stored for `planCritic`, and nothing here can tell this console's
    // own no-op from a value two versions stale — so the gesture rides the note.
    draft.planCritic = ["ultra", "premium"];

    expect(qualitySaveClaim(state.settings, draft, "")).toBeNull();
    expect(qualitySaveClaim(state.settings, draft, "  had another look  ")).toEqual({
      note: "had another look"
    });
  });

  it("goes inert again on the revision the save comes back with", () => {
    // The screen re-drafts from the response and clears the input, so the note
    // it just stored cannot ride along into a second, no-op revision — the
    // saved note is echoed from `state.note` beside the new version instead.
    const saved: GenerationQuality = { ...responseWith(), version: 4, note: "gates stand" };

    expect(qualitySaveClaim(saved.settings, draftOf(saved), "")).toBeNull();
  });

  it("diffs the next save against the revision the last one came back with", () => {
    // `save()` re-drafts from the response and re-seats `state` on it, because
    // the merge it answers with may carry another operator's boxes too. Held
    // against the map this console originally loaded, the very next save would
    // name their change back out.
    const answered: GenerationQuality = { ...responseWith(), version: 9 };
    answered.settings.planCritic = [];
    const draft = draftOf(answered);

    expect(qualitySaveClaim(answered.settings, draft, "")).toBeNull();

    draft.styleAuditor = ["fast"];
    expect(qualitySaveClaim(answered.settings, draft, "")).toEqual({ styleAuditor: ["fast"] });
  });
});

/**
 * The 409 `withRevisionConflictReply` sends, thrown the way `apiPatch` throws it.
 *
 * `apiPatch` raises `new Error(await response.text())` and keeps no status, so
 * the body *is* the whole failure as this screen meets it — which is why the
 * recovery is decided on the shape rather than on 409.
 */
function conflictError(currentVersion: number): Error {
  return new Error(
    JSON.stringify({
      error:
        "Another operator saved generation-quality settings first. " +
        "Re-send your change to merge it onto the stored revision.",
      currentVersion
    })
  );
}

describe("qualitySaveConflict", () => {
  it("reads the revision a refused save merged onto", () => {
    expect(qualitySaveConflict(conflictError(8))).toEqual({ currentVersion: 8 });
  });

  it("recognises the conflict a fresh install races at version 0", () => {
    // `appendGenerationQualityRevision` reports `current?.version ?? 0`, so the
    // first two saves a deployment ever takes conflict at zero. Returned bare,
    // the number would be indistinguishable from "no conflict" to any caller
    // testing it for truth — which is the whole reason it comes back wrapped.
    expect(qualitySaveConflict(conflictError(0))).toEqual({ currentVersion: 0 });
  });

  it("leaves a refused body to the plain error path", () => {
    const rejected = new Error(
      JSON.stringify({ error: "note: Keep the change note to 500 characters or fewer." })
    );

    expect(qualitySaveConflict(rejected)).toBeNull();
  });

  it("leaves Fastify's own 500 to the plain error path", () => {
    const crashed = new Error(
      JSON.stringify({ statusCode: 500, error: "Internal Server Error", message: "boom" })
    );

    expect(qualitySaveConflict(crashed)).toBeNull();
  });

  it("declines a body whose version is not a number, and text that is not a body", () => {
    expect(qualitySaveConflict(new Error(JSON.stringify({ currentVersion: "8" })))).toBeNull();
    expect(qualitySaveConflict(new Error("Unauthorized"))).toBeNull();
    expect(qualitySaveConflict(new Error("null"))).toBeNull();
    expect(qualitySaveConflict("Unauthorized")).toBeNull();
  });
});

describe("readQualityHead", () => {
  it("takes the revision the server actually sends, twelfth gate and all", () => {
    // Over-strictness is the other way this fails: a read that refuses a real
    // reply turns every conflict into the stale-rows banner, and an id the
    // server added without copy is exactly the reply nobody wrote a shape for.
    const response = responseWith("twelfthGate");

    expect(readQualityHead(JSON.parse(JSON.stringify(response)) as unknown)).toEqual(response);
  });

  it("refuses a body missing either half the rows are built from", () => {
    const response = responseWith();

    expect(readQualityHead({ ...response, settings: undefined })).toBeNull();
    expect(readQualityHead({ ...response, features: undefined })).toBeNull();
    // `settings` is a map and `features` a list; neither survives the other's shape.
    expect(readQualityHead({ ...response, settings: [] })).toBeNull();
    expect(readQualityHead({ ...response, features: {} })).toBeNull();
    expect(readQualityHead({ ...response, features: [null] })).toBeNull();
    expect(readQualityHead({ ...response, features: [{ id: "planCritic" }] })).toBeNull();
    expect(readQualityHead(null)).toBeNull();
    expect(readQualityHead("<html>502 Bad Gateway</html>")).toBeNull();
  });

  it("refuses a version it could only name untruthfully", () => {
    const response = responseWith();

    // The banner names the version and the panel prints it; neither has anything
    // honest to say about a revision whose number is not one.
    expect(readQualityHead({ ...response, version: "3" })).toBeNull();
    expect(readQualityHead({ ...response, version: Number.NaN })).toBeNull();
    // Zero is the version a fresh install races at, and it is a real revision.
    expect(readQualityHead({ ...response, version: 0 })?.version).toBe(0);
  });

  it("refuses a tier list that is not a list of tiers", () => {
    const response = responseWith();

    expect(readQualityHead({ ...response, settings: { planCritic: "ultra" } })).toBeNull();
    expect(readQualityHead({ ...response, settings: { planCritic: [7] } })).toBeNull();
  });

  it("keeps a tier this build has no name for, rather than filtering it out", () => {
    // Forward compatibility, the same bargain `featureRows` makes for an id with
    // no copy: filtering would quietly post a newer server's value back out the
    // next time this feature is claimed.
    const head = readQualityHead({ ...responseWith(), settings: { planCritic: ["glacial"] } });

    expect(head?.settings.planCritic).toEqual(["glacial"]);
  });

  it("coerces the fields it only prints rather than losing a usable revision", () => {
    const response = responseWith();

    const head = readQualityHead({
      ...response,
      usingCompiledDefaults: undefined,
      note: undefined,
      updatedBy: 7,
      updatedAt: { at: "yesterday" }
    });

    expect(head?.version).toBe(3);
    expect(head?.usingCompiledDefaults).toBe(false);
    expect(head?.note).toBeNull();
    expect(head?.updatedBy).toBeNull();
    expect(head?.updatedAt).toBeNull();
  });
});

describe("rebaseQualityDraft", () => {
  /** Operator B loaded version 7 and unchecked `styleExcerpts`; A stored something else. */
  function twoOperators() {
    const loadedByB = responseWith();
    loadedByB.settings.styleExcerpts = ["ultra", "premium"];
    const draftOfB = draftOf(loadedByB);
    draftOfB.styleExcerpts = [];
    return { loadedByB, draftOfB };
  }

  it("keeps the operator's boxes and takes every other gate from the stored revision", () => {
    const { loadedByB, draftOfB } = twoOperators();
    const head: GenerationQuality["settings"] = { ...draftOf(loadedByB), planCritic: [] };

    const rebased = rebaseQualityDraft(head, loadedByB.settings, draftOfB);

    expect(rebased.settings.styleExcerpts).toEqual([]);
    expect(rebased.settings.planCritic).toEqual([]);
    expect(rebased.movedUnderneath).toEqual(["planCritic"]);
    // Copied, never aliased: the rows are edited in place from here.
    expect(rebased.settings.planCritic).not.toBe(head.planCritic);
  });

  it("leaves the claim the refused save carried exactly where it was", () => {
    const { loadedByB, draftOfB } = twoOperators();
    const head: GenerationQuality["settings"] = { ...draftOf(loadedByB), planCritic: [] };

    // The point of rebasing rather than reloading: pressing Save again posts the
    // same partial body, which the server lays over A's revision — so both
    // operators keep their work, exactly as the optional feature keys intend.
    const refused = qualitySaveClaim(loadedByB.settings, draftOfB, "");
    const rebased = rebaseQualityDraft(head, loadedByB.settings, draftOfB);

    expect(qualitySaveClaim(head, rebased.settings, "")).toEqual(refused);
    expect(mergeLikeServer(head, qualitySaveClaim(head, rebased.settings, "")).planCritic).toEqual(
      []
    );
  });

  it("drops the claim when the winner stored exactly the change this operator meant", () => {
    const { loadedByB, draftOfB } = twoOperators();
    const head: GenerationQuality["settings"] = { ...draftOf(loadedByB), styleExcerpts: [] };

    const rebased = rebaseQualityDraft(head, loadedByB.settings, draftOfB);

    expect(rebased.settings.styleExcerpts).toEqual([]);
    expect(qualitySaveClaim(head, rebased.settings, "")).toBeNull();
  });

  it("seats a gate this console never loaded without calling it someone's edit", () => {
    const { loadedByB, draftOfB } = twoOperators();
    const head: GenerationQuality["settings"] = { ...draftOf(loadedByB), twelfthGate: ["fast"] };

    const rebased = rebaseQualityDraft(head, loadedByB.settings, draftOfB);

    expect(rebased.settings.twelfthGate).toEqual(["fast"]);
    expect(rebased.movedUnderneath).not.toContain("twelfthGate");
  });

  it("keeps a claimed compiled gate when an older replica omits it from the head", () => {
    const loaded = responseWith();
    loaded.settings.styleExcerpts = ["fast"];
    const draft = draftOf(loaded);
    draft.styleExcerpts = [];
    const head = draftOf(loaded);
    Reflect.deleteProperty(head, "styleExcerpts");

    const rebased = rebaseQualityDraft(head, loaded.settings, draft);

    expect(rebased.settings.styleExcerpts).toEqual([]);
    expect(qualitySaveClaim(head, rebased.settings, "")).toEqual({ styleExcerpts: [] });
    expect(rebased.movedUnderneath).not.toContain("styleExcerpts");
  });

  it("does not resurrect an untouched stale-only gate omitted from the head", () => {
    const loaded = responseWith();
    loaded.settings.styleExcerpts = ["fast"];
    const draft = draftOf(loaded);
    const head = draftOf(loaded);
    Reflect.deleteProperty(head, "styleExcerpts");

    const rebased = rebaseQualityDraft(head, loaded.settings, draft);

    expect(Object.hasOwn(rebased.settings, "styleExcerpts")).toBe(false);
    expect(qualitySaveClaim(head, rebased.settings, "")).toBeNull();
  });
});

describe("qualityConflictNotice", () => {
  it("names the stored version, the gates that moved, and the button that finishes the job", () => {
    const notice = qualityConflictNotice({
      version: 9,
      reloaded: true,
      movedUnderneath: ["Plan critic"],
      stillClaiming: true
    });

    expect(notice).toContain("version 9");
    expect(notice).toContain("They changed Plan critic.");
    expect(notice).toContain("press Save setting");
  });

  it("claims no other operator's edit when the reload found none", () => {
    const notice = qualityConflictNotice({
      version: 9,
      reloaded: true,
      movedUnderneath: [],
      stillClaiming: true
    });

    expect(notice).not.toContain("They changed");
    expect(notice).toContain("press Save setting");
  });

  it("tells an operator whose change is already stored that there is nothing to press", () => {
    const notice = qualityConflictNotice({
      version: 9,
      reloaded: true,
      movedUnderneath: ["Plan critic"],
      stillClaiming: false
    });

    expect(notice).toContain("nothing left to save");
    expect(notice).not.toContain("press Save setting");
  });

  it("admits the rows are stale when the reload failed, not that they are current", () => {
    const notice = qualityConflictNotice({
      version: 8,
      reloaded: false,
      movedUnderneath: [],
      stillClaiming: true
    });

    expect(notice).toContain("version 8");
    expect(notice).toContain("out of date");
    expect(notice).toContain("press Save setting");
    expect(notice).not.toContain("now show");
  });

  it("never repeats the server's instruction, because this screen reloads itself", () => {
    // `GenerationQualityVersionConflictError` says "Re-send your change to merge
    // it onto the stored revision" — true for every client, and already done by
    // the time this screen speaks: it has rebased the boxes the operator did not
    // touch and named the one button that finishes the job.
    const shapes = [
      { version: 9, reloaded: true, movedUnderneath: ["Plan critic"], stillClaiming: true },
      { version: 9, reloaded: true, movedUnderneath: [], stillClaiming: false },
      { version: 8, reloaded: false, movedUnderneath: [], stillClaiming: true }
    ];

    for (const shape of shapes) {
      expect(qualityConflictNotice(shape)).not.toContain("Re-send your change to merge it onto");
    }
  });
});

describe("recoverQualitySave", () => {
  /** Operator B loaded version 7 and unchecked `styleExcerpts`. */
  function refusedSave() {
    const loaded = responseWith();
    loaded.settings.styleExcerpts = ["ultra", "premium"];
    const draft = draftOf(loaded);
    draft.styleExcerpts = [];
    return { loaded, draft, claim: qualitySaveClaim(loaded.settings, draft, "") };
  }

  /** Operator A got the number first, and unchecked a different gate with it. */
  function storedByA(loaded: GenerationQuality): GenerationQuality {
    return { ...loaded, version: 8, settings: { ...draftOf(loaded), planCritic: [] } };
  }

  it("rebases the operator's boxes onto the winner's revision and keeps their claim", async () => {
    const { loaded, draft, claim } = refusedSave();
    const head = storedByA(loaded);

    const recovery = await recoverQualitySave({
      error: conflictError(7),
      loaded,
      draft,
      note: "",
      reload: () => Promise.resolve(head)
    });

    if (recovery.kind !== "rebase") {
      throw new Error(`expected a rebase, got ${recovery.kind}`);
    }
    // Their unchecked box survived the refusal untouched...
    expect(recovery.draft.styleExcerpts).toEqual([]);
    // ...A's landed underneath it...
    expect(recovery.draft.planCritic).toEqual([]);
    expect(recovery.state.version).toBe(8);
    // ...and pressing Save now posts the identical partial body, which merges
    // onto version 8 rather than reverting it. That is the whole recovery.
    expect(qualitySaveClaim(recovery.state.settings, recovery.draft, "")).toEqual(claim);
    expect(recovery.error).toContain("version 8");
    expect(recovery.error).toContain("Plan critic");
    expect(recovery.error).toContain("press Save setting");
  });

  it("says there is nothing to press when the winner stored that very change", async () => {
    const { loaded, draft } = refusedSave();
    const head: GenerationQuality = {
      ...loaded,
      version: 8,
      settings: { ...draftOf(loaded), styleExcerpts: [] }
    };

    const recovery = await recoverQualitySave({
      error: conflictError(7),
      loaded,
      draft,
      note: "",
      reload: () => Promise.resolve(head)
    });

    expect(recovery.error).toContain("nothing left to save");
  });

  it("keeps the rows where they are when the reload fails, and admits they are stale", async () => {
    const { loaded, draft } = refusedSave();

    const recovery = await recoverQualitySave({
      error: conflictError(7),
      loaded,
      draft,
      note: "",
      reload: () => Promise.reject(new Error("Failed to fetch"))
    });

    // Nothing to rebase onto, so nothing moves — the operator's boxes are still
    // theirs and the banner does not claim the untouched gates are current.
    expect(recovery.kind).toBe("report");
    expect(recovery.error).toContain("version 7");
    expect(recovery.error).toContain("out of date");
    expect(recovery.error).toContain("press Save setting");
  });

  /** A 200 that carries no revision: a proxy's page, or a skewed replica. */
  function withoutHalf(head: GenerationQuality, half: "settings" | "features"): GenerationQuality {
    const body: Partial<GenerationQuality> = { ...head };
    delete body[half];
    return body as GenerationQuality;
  }

  it("still banners the refusal when the reload answers without settings", async () => {
    const { loaded, draft, claim } = refusedSave();

    const recovery = await recoverQualitySave({
      error: conflictError(7),
      loaded,
      draft,
      note: "",
      reload: () => Promise.resolve(withoutHalf(storedByA(loaded), "settings"))
    });

    // This used to reject out of `save()`'s own catch: the confirmation had been
    // cleared, `setError` never ran, and `finally` stopped the spinner — so the
    // operator pressed Save and read neither a failure nor a confirmation, and
    // the only trace was an unhandled rejection in the console.
    expect(recovery.kind).toBe("report");
    expect(recovery.error).toContain("version 7");
    expect(recovery.error).toContain("out of date");
    expect(recovery.error).toContain("press Save setting");
    // And the boxes are still theirs to press it with.
    expect(qualitySaveClaim(loaded.settings, draft, "")).toEqual(claim);
  });

  it("still banners the refusal when the reload answers without features", async () => {
    const { loaded, draft, claim } = refusedSave();

    const recovery = await recoverQualitySave({
      error: conflictError(7),
      loaded,
      draft,
      note: "",
      reload: () => Promise.resolve(withoutHalf(storedByA(loaded), "features"))
    });

    expect(recovery.kind).toBe("report");
    expect(recovery.error).toContain("out of date");
    expect(qualitySaveClaim(loaded.settings, draft, "")).toEqual(claim);
  });

  it("refuses a head whose tier list is not a list, rather than seating the wreckage", async () => {
    const { loaded, draft } = refusedSave();
    const head = storedByA(loaded);
    const shredded = { ...head, settings: { ...head.settings, planCritic: "ultra" } };

    const recovery = await recoverQualitySave({
      error: conflictError(7),
      loaded,
      draft,
      note: "",
      reload: () => Promise.resolve(shredded as unknown as GenerationQuality)
    });

    // The body a catch alone would wave through: nothing throws on it, so the
    // rebase would seat `["u", "l", "t", "r", "a"]` as a gate's tiers, render it
    // as five boxes matching none, and post the shredding back on the next Save.
    expect(recovery.kind).toBe("report");
    expect(recovery.error).toContain("out of date");
  });

  it("reports a failure that is not a conflict, reloads nothing and moves nothing", async () => {
    const { loaded, draft } = refusedSave();
    let reloads = 0;

    const recovery = await recoverQualitySave({
      error: new Error(
        JSON.stringify({ error: "note: Keep the change note to 500 characters or fewer." })
      ),
      loaded,
      draft,
      note: "x".repeat(501),
      reload: () => {
        reloads += 1;
        return Promise.resolve(storedByA(loaded));
      }
    });

    expect(recovery).toEqual({
      kind: "report",
      error: "note: Keep the change note to 500 characters or fewer."
    });
    expect(reloads).toBe(0);
  });
});

describe("qualityResetFailure", () => {
  it("tells the operator to press Reset again, because a reset needs no rebase", () => {
    // Reset claims every feature at the compiled default, so repeating it
    // asserts the same thing over whoever won — no head to merge onto, and no
    // draft to keep.
    const notice = qualityResetFailure(conflictError(7));

    expect(notice).toContain("Press Reset to defaults again");
    expect(notice).not.toContain("Re-send your change to merge it onto");
  });

  it("passes every other refusal through as the server wrote it", () => {
    const refused = new Error(JSON.stringify({ error: "Send an optional note." }));

    expect(qualityResetFailure(refused)).toBe("Send an optional note.");
  });
});
