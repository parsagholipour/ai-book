import { describe, expect, it } from "vitest";
import { pageDesignEditFromDecision, pageDesignEditFromMessage, pageDesignIntentFromMessage } from "./bookEditPageDesign.js";

describe("pageDesignEditFromMessage", () => {
  it("reads the design a request names", () => {
    expect(pageDesignEditFromMessage("Make the pages look like the night sky")).toEqual({ design: "night" });
    expect(pageDesignEditFromMessage("plain layout please")).toEqual({ design: "classic" });
    expect(pageDesignEditFromMessage("use the fairy tale style")).toEqual({ design: "fairytale" });
    expect(pageDesignEditFromMessage("Can you switch to the ocean design?")).toEqual({ design: "ocean" });
    expect(pageDesignEditFromMessage("a rainbow theme would be fun")).toEqual({ design: "rainbow" });
  });

  it("takes the design asked for, not the one refused beside it", () => {
    expect(pageDesignEditFromMessage("instead of the night sky, use the ocean design")).toEqual({ design: "ocean" });
    // Refusing the only design named is asking for any other one.
    expect(pageDesignEditFromMessage("I don't like the night sky design")).toEqual({ design: null });
  });

  it("reads a request for something different as no design in particular", () => {
    expect(pageDesignEditFromMessage("change the design")).toEqual({ design: null });
    expect(pageDesignEditFromMessage("I don't like the colours of the pages")).toEqual({ design: null });
    expect(pageDesignEditFromMessage("try a different layout")).toEqual({ design: null });
  });

  it("lists the designs when asked which there are", () => {
    expect(pageDesignEditFromMessage("What designs can I choose from?")).toEqual({ design: null, list: true });
    expect(pageDesignEditFromMessage("show me the page styles")).toEqual({ design: null, list: true });
    const intent = pageDesignIntentFromMessage("which layouts are available?");
    expect(intent).toMatchObject({ kind: "page_design", scope: "none", affectedPageIndexes: [], pageDesign: { list: true } });
  });

  it("leaves what the book says to normal routing", () => {
    // A named place is an edit of that place.
    expect(pageDesignEditFromMessage("rewrite page 3 to be about the sea")).toBeNull();
    expect(pageDesignEditFromMessage("change the design of chapter 2")).toBeNull();
    // No word about how the pages look.
    expect(pageDesignEditFromMessage("make the story darker")).toBeNull();
    expect(pageDesignEditFromMessage("add a scene in space")).toBeNull();
    expect(pageDesignEditFromMessage("a story about the sea")).toBeNull();
    // "Style" and "theme" about the writing, and the look of other things.
    expect(pageDesignEditFromMessage("change the writing style to something more playful")).toBeNull();
    expect(pageDesignEditFromMessage("change the theme of the story to friendship")).toBeNull();
    expect(pageDesignEditFromMessage("make the cover design brighter")).toBeNull();
    expect(pageDesignEditFromMessage("change the illustration style to watercolour")).toBeNull();
    expect(pageDesignEditFromMessage("use a bigger font")).toBeNull();
    // A colour word is the story's text before it is a look: read as one, this
    // chose the sea design for a dress.
    expect(pageDesignEditFromMessage("change the colour of Mira's dress to blue")).toBeNull();
    // A change with no design named has to be about the pages' design itself.
    expect(pageDesignEditFromMessage("change the theme to friendship")).toBeNull();
    expect(pageDesignEditFromMessage("I don't like the colours")).toBeNull();
  });
});

describe("pageDesignEditFromDecision", () => {
  it("keeps a known design and reads anything else as something different", () => {
    expect(pageDesignEditFromDecision("space")).toEqual({ design: "space" });
    expect(pageDesignEditFromDecision("neon")).toEqual({ design: null });
    expect(pageDesignEditFromDecision(null)).toEqual({ design: null });
  });
});
