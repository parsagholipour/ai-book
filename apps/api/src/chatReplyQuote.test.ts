import { describe, expect, it } from "vitest";
import { chatReplyQuoteFor } from "./chatReplyQuote.js";

describe("chatReplyQuoteFor", () => {
  it("keeps user asterisks and strips assistant markup", () => {
    expect(chatReplyQuoteFor({ id: "u1", role: "USER", content: "**note**" })?.excerpt).toBe(
      "**note**"
    );
    expect(chatReplyQuoteFor({ id: "a1", role: "ASSISTANT", content: "**note**" })?.excerpt).toBe(
      "note"
    );
  });
});
