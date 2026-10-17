/**
 * The variant registry and spec parser. A spec is `<base>[+modifier…]`:
 *
 *   baseline                         the logged request on today's live route
 *   baseline+effort=none             … at reasoning effort none
 *   no-extend+effort=low             a prompt arm and an effort change together (avoid: one axis at a time)
 *   baseline+model=openai:gpt-6-sol  another model, same prompt
 *   baseline+tier=fast               the other tier's route for the same purpose
 *   baseline+temp=0.3                another temperature (inert on OpenAI at effort above none)
 *
 * A new arm is a `Variant` added to BASES. Put purpose-specific arms in their own file beside
 * `editChapter.ts`, and keep product code read-only: import builders, never edit them for an eval.
 */
import type { Route } from "../container/runtime.ts";
import { baseline, recorded } from "./common.ts";
import { fidelity } from "./composeFidelity.ts";
import { noEdit, noExtend, patchMode } from "./editChapter.ts";
import { hunkJudged, hunkJudgedLinked, hunkProtected, today } from "./editChapterE2.ts";
import type { Variant } from "./types.ts";

export const BASES: Record<string, Variant> = Object.fromEntries([recorded, baseline, noEdit, noExtend, patchMode, today, hunkJudged, hunkJudgedLinked, hunkProtected, fidelity].map((variant) => [variant.name, variant]));

export type ParsedVariant = { spec: string; label: string; base: Variant; route: Route };

export function parseVariant(spec: string): ParsedVariant {
  const [baseName, ...modifiers] = spec.split("+");
  const base = BASES[baseName ?? ""];
  if (!base) throw new Error(`Unknown variant "${baseName}". Known: ${Object.keys(BASES).join(", ")}`);
  const route: Route = {};
  for (const modifier of modifiers) {
    const [key, value] = modifier.split("=");
    if (!value) throw new Error(`Variant modifier "${modifier}" needs a value`);
    if (key === "effort") route.thinkingEffort = value;
    else if (key === "tier") route.tier = value;
    else if (key === "temp") route.temperature = Number(value);
    else if (key === "model") {
      const [provider, ...model] = value.split(":");
      if (!provider || model.length === 0) throw new Error(`model= takes provider:model, got "${value}"`);
      route.provider = provider;
      route.model = model.join(":");
    } else throw new Error(`Unknown variant modifier "${key}" (effort, tier, temp, model)`);
  }
  return { spec, label: spec.replace(/[^A-Za-z0-9._+=-]/g, "_"), base, route };
}

export function describeVariants(): string {
  return Object.values(BASES)
    .map((variant) => `  ${variant.name.padEnd(12)} ${variant.purposes ? `[${variant.purposes.join(", ")}] ` : ""}${variant.description}`)
    .join("\n");
}
