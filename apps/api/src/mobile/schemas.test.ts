import { describe, expect, it } from "vitest";
import {
  mobileCreationMessageBodySchema,
  mobileProjectChatMessageBodySchema,
  mobileProjectChatMessageOpenApiBody
} from "./schemas.js";

// The Zod schema is the real gate; the JSON-schema copy beside it is what the
// OpenAPI docs publish. They are separate objects, and `.strict()` plus
// `additionalProperties: false` means a field added to only one of them either
// 400s a documented request or documents a field the route rejects. Nothing
// else checks the pair, because `attachValidation: true` keeps Fastify's own
// validation from ever rejecting the body.

describe("mobile chat body schemas", () => {
  it("documents exactly the project chat fields it accepts", () => {
    const documented = Object.keys(mobileProjectChatMessageOpenApiBody.properties).sort();
    const accepted = Object.keys(mobileProjectChatMessageBodySchema.shape).sort();

    expect(documented).toEqual(accepted);
  });

  it("accepts a reply on both chat surfaces", () => {
    expect(
      mobileProjectChatMessageBodySchema.safeParse({
        message: "What does that mean?",
        replyToMessageId: "chat-1"
      }).success
    ).toBe(true);
    expect(
      mobileCreationMessageBodySchema.safeParse({
        message: "The second one",
        replyToMessageId: "m1"
      }).success
    ).toBe(true);
  });

  it("rejects an unknown field rather than silently dropping it", () => {
    expect(
      mobileProjectChatMessageBodySchema.safeParse({
        message: "hi",
        replyToMessageID: "chat-1"
      }).success
    ).toBe(false);
  });
});
