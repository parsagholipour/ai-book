import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { createProviders } from "../adapters/factory.js";
import { loadConfig } from "../config.js";
import { reviewPageDraft } from "./pagesReview.js";
import {
  evaluateReviewPageReplay,
  loadReviewPageReplayFixture,
  writeLastReviewPageReplay
} from "./pagesReviewReplayFixtures.js";

const LIVE_AI = process.env.LIVE_AI === "true";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(HERE, "../../../../.scratch/review-page-sensitivity");
const OVERREACH_CASES = [1, 8, 10, 43, 69, 87, 114, 136, 159, 163, 167, 172, 180, 191] as const;
const IGNORED_FABRICATION_CASES = [22] as const;
const GUARD_CASES = [152] as const;

describe.skipIf(!LIVE_AI)("reviewPageDraft live citation sensitivity", () => {
  const config = loadConfig();

  beforeAll(() => {
    if (config.MOCK_AI) {
      throw new Error("MOCK_AI=true: live review-page tests require a real provider. Set MOCK_AI=false.");
    }
  });

  it.each(OVERREACH_CASES)("replays overreach page %i through the production reviewer", async (page) => {
    const fixture = await loadReviewPageReplayFixture(FIXTURE_ROOT, page);
    const providers = createProviders(config, fixture.input);
    const report = await reviewPageDraft({
      ...fixture.options,
      textModel: providers.text
    });
    const verdict = evaluateReviewPageReplay(fixture, report);
    const comparison = await writeLastReviewPageReplay(fixture, report, verdict);

    expect(verdict.ok, JSON.stringify(comparison, null, 2)).toBe(true);
  }, 180_000);

  it.each(IGNORED_FABRICATION_CASES)("does not reject fabrication-only page %i", async (page) => {
    const fixture = await loadReviewPageReplayFixture(FIXTURE_ROOT, page);
    const providers = createProviders(config, fixture.input);
    const report = await reviewPageDraft({
      ...fixture.options,
      textModel: providers.text
    });
    const verdict = evaluateReviewPageReplay(fixture, report);
    const comparison = await writeLastReviewPageReplay(fixture, report, verdict);

    expect(verdict.ok, JSON.stringify(comparison, null, 2)).toBe(true);
  }, 180_000);

  it.each(GUARD_CASES)("replays guard page %i through the production reviewer", async (page) => {
    const fixture = await loadReviewPageReplayFixture(FIXTURE_ROOT, page);
    const providers = createProviders(config, fixture.input);
    const report = await reviewPageDraft({
      ...fixture.options,
      textModel: providers.text
    });
    const verdict = evaluateReviewPageReplay(fixture, report);
    const comparison = await writeLastReviewPageReplay(fixture, report, verdict);

    expect(verdict.ok, JSON.stringify(comparison, null, 2)).toBe(true);
  }, 180_000);
});
