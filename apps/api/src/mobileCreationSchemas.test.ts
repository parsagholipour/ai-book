import { describe, expect, it } from "vitest";
import { mobileCreationBriefSchema, mobileCreationOptionalDetailsSchema } from "./mobileCreationSchemas.js";

// A title the reader typed travels with every send and Build. At a minimum of
// two characters a one-character title — "雪", or "X" — refused every message
// that followed with a validation error about something else.
describe("creation title", () => {
  it("accepts a one-character title, which is a whole title in Chinese or Japanese", () => {
    expect(mobileCreationOptionalDetailsSchema.parse({ title: "雪" }).title).toBe("雪");
    expect(mobileCreationOptionalDetailsSchema.parse({ title: " X " }).title).toBe("X");
    expect(mobileCreationBriefSchema.parse({ title: "雪" }).title).toBe("雪");
  });

  it("still treats a blank title as no title and refuses one past 160 characters", () => {
    expect(mobileCreationOptionalDetailsSchema.parse({ title: "   " }).title).toBeUndefined();
    expect(mobileCreationOptionalDetailsSchema.safeParse({ title: "a".repeat(161) }).success).toBe(false);
  });
});
