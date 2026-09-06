import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bookPlanModelOutputSchemaWithFallback } from "../../../../packages/core/src/schemas/plan.js";
import { makeFallbackPlan } from "../../../../packages/core/src/prompting/templates.js";
import { developmentInput } from "../../../../packages/core/src/generation/testing/bookDevelopmentFixtures.js";

const raw = JSON.parse(readFileSync(new URL("./plan-4-raw.json", import.meta.url), "utf8"));
const fallback = makeFallbackPlan({ ...developmentInput, targetPages: 120 });
const parsed = bookPlanModelOutputSchemaWithFallback(fallback).parse(raw);
assert.deepEqual(parsed.chapters, raw.authorStance.chapters);
assert.deepEqual(parsed.promises, raw.authorStance.promises);
assert.equal(parsed.chapters.length, 14);
assert.equal(parsed.chapters.some((chapter) => /^Chapter \d+: (Opening|Development|Perspective|Resolution)$/.test(chapter.title)), false);
console.log("PASS: all 14 authored chapters preserved; no generic fallback outline.");
