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

  it("documents exactly the reader-context fields it accepts", () => {
    // The nested object is `.strict()` too, and it is where the reader's file
    // identity travels: a `pdfDigest` the docs omit is a physical `pdfPage`
    // that documented clients can never get translated.
    const documented = Object.keys(mobileProjectChatMessageOpenApiBody.properties.readerContext.properties).sort();
    const accepted = Object.keys(mobileProjectChatMessageBodySchema.shape.readerContext.unwrap().shape).sort();

    expect(documented).toEqual(accepted);
    expect(accepted).toContain("pdfDigest");
  });

  it("accepts the reader's open-file identity alongside a physical sheet", () => {
    expect(
      mobileProjectChatMessageBodySchema.safeParse({
        message: 'Rewrite "the storm broke".',
        readerContext: { pdfPage: 7, contentRevision: 3, pdfDigest: "a".repeat(64) }
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
