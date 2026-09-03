import { describe, expect, it } from "vitest";
import { acceptSeam, applySeam, chapterSeams } from "./seams.js";

describe("seams", () => {
  const original = "At Housesteads in 1745 the garrison counted forty-one carts before dawn, and the ledger kept by Aelius names each driver.";

  it("accepts a rewrite that keeps names, numbers and length, and refuses one that loses them", () => {
    expect(acceptSeam(original, "Before dawn in 1745 the garrison at Housesteads counted forty-one carts, and Aelius wrote every driver into his ledger.")).toBe(true);
    expect(acceptSeam(original, "Before dawn the garrison counted the carts, and the clerk wrote every driver into his ledger.")).toBe(false);
    expect(acceptSeam(original, "Carts.")).toBe(false);
    expect(acceptSeam(original, original)).toBe(false);
  });

  it("replaces only the first and last paragraphs, whatever blank lines the chapter ends on", () => {
    const chapter = "One.\n\nTwo.\n\nThree.";
    expect(applySeam(chapter, { index: 1, opening: "Uno.", closing: "Tres." })).toBe("Uno.\n\nTwo.\n\nTres.");
    expect(applySeam(`${chapter}\n\n`, { index: 1, closing: "Tres." })).toBe("One.\n\nTwo.\n\nTres.");
    expect(chapterSeams(chapter)).toEqual({ opening: "One.", closing: "Three." });
  });
});
