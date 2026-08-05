import { describe, expect, it } from "vitest";
import { targetLanguageFromLanguageVersionRequest } from "./bookEditMessage.js";

describe("targetLanguageFromLanguageVersionRequest", () => {
  it("reads a real request for another language version", () => {
    expect(targetLanguageFromLanguageVersionRequest("create a Spanish version of this book")).toBe(
      "Spanish"
    );
    expect(targetLanguageFromLanguageVersionRequest("translate the whole book into German")).toBe(
      "German"
    );
    expect(targetLanguageFromLanguageVersionRequest("change the language to Korean")).toBe("Korean");
    expect(targetLanguageFromLanguageVersionRequest("make a Japanese copy")).toBe("Japanese");
  });

  // A hit here forces kind "book_replan" in bookEditHeuristics, i.e. a paid
  // regeneration of the whole book in a language nobody asked for.
  it("ignores a language named as subject matter", () => {
    expect(
      targetLanguageFromLanguageVersionRequest(
        "make chapter 2 about how aliens are portrayed in Chinese media"
      )
    ).toBeNull();
    expect(
      targetLanguageFromLanguageVersionRequest("rewrite page 4 so the alien lands in Japanese waters")
    ).toBeNull();
    expect(
      targetLanguageFromLanguageVersionRequest("create a chapter on jazz in French colonial Africa")
    ).toBeNull();
    expect(targetLanguageFromLanguageVersionRequest("make the ending more hopeful")).toBeNull();
  });
});
