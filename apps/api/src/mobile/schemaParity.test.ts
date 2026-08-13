import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import * as characterSchemas from "./characterSchemas.js";
import * as schemas from "./schemas.js";

/**
 * Every documented mobile route validates with a Zod schema and documents with a
 * hand-written JSON-schema twin beside it — Fastify's OpenAPI output uses the
 * copy, and there is no generator holding the two together. They drift silently:
 * the request keeps being validated correctly while `/docs` describes a body
 * that no longer exists, which is worse than no docs because the app is written
 * against them.
 *
 * This is the cheap half of a generator. It does not compare types or
 * constraints — only which keys exist and which are required, which is what
 * actually rots when a field is added to one side.
 */

type JsonSchemaBody = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: readonly string[];
};

/** Unwrap `.default()`, `.optional()`, `.catch()` … down to the object itself. */
const unwrap = (schema: unknown): unknown => {
  let current = schema;
  for (let hops = 0; hops < 10; hops++) {
    const def = (current as { def?: { innerType?: unknown } } | undefined)?.def;
    if (!def?.innerType) return current;
    current = def.innerType;
  }
  return current;
};

const shapeOf = (schema: unknown): Record<string, ZodType> | null => {
  const inner = unwrap(schema) as { shape?: Record<string, ZodType> } | undefined;
  return inner?.shape && typeof inner.shape === "object" ? inner.shape : null;
};

/** A field is required when it refuses `undefined` — defaults count as optional. */
const isRequired = (field: ZodType): boolean => !field.safeParse(undefined).success;

const modules: Record<string, unknown> = { ...schemas, ...characterSchemas };

/**
 * Most twins are `mobileFooOpenApiBody` / `mobileFooBodySchema`, but a couple of
 * the older ones dropped the `mobile` prefix on the Zod side
 * (`generationRetryBodySchema`). Try both rather than renaming a published
 * symbol to satisfy a test.
 */
const zodNamesFor = (base: string): string[] => {
  const names = [`${base}BodySchema`];
  if (base.startsWith("mobile")) {
    const stripped = base.slice("mobile".length);
    names.push(`${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}BodySchema`);
  }
  return names;
};

const pairs = Object.keys(modules)
  .filter((name) => name.endsWith("OpenApiBody"))
  .map((openApiName) => {
    const base = openApiName.slice(0, -"OpenApiBody".length);
    const zodName = zodNamesFor(base).find((name) => modules[name] !== undefined);
    return { openApiName, zodName: zodName ?? zodNamesFor(base)[0]!, base };
  });

describe("mobile request schemas and their OpenAPI twins", () => {
  it("finds a documented body for every route that has one", () => {
    // A guard on the guard: if the naming convention changes, this suite would
    // quietly stop covering anything.
    expect(pairs.length).toBeGreaterThanOrEqual(15);
  });

  it.each(pairs)("$base: the JSON-schema twin has a Zod schema", ({ zodName }) => {
    expect(modules[zodName], `${zodName} is missing — the OpenAPI body documents nothing`).toBeDefined();
  });

  it.each(pairs)("$base: same properties, same required set", ({ openApiName, zodName }) => {
    const body = modules[openApiName] as JsonSchemaBody;
    const shape = shapeOf(modules[zodName]);

    // Non-object bodies (a bare string, an array) have no keys to compare.
    if (!shape || body.type !== "object") return;

    const documented = Object.keys(body.properties ?? {}).sort();
    const validated = Object.keys(shape).sort();
    expect(documented, `${openApiName} documents different keys than ${zodName} validates`).toEqual(validated);

    const documentedRequired = [...(body.required ?? [])].sort();
    const validatedRequired = Object.entries(shape)
      .filter(([, field]) => isRequired(field))
      .map(([key]) => key)
      .sort();
    expect(
      documentedRequired,
      `${openApiName} and ${zodName} disagree about which fields are required`
    ).toEqual(validatedRequired);
  });
});
