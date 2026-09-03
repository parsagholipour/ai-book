import { describe, expect, it } from "vitest";
import { acceptCoupletRewrite, coupletsPer1000Sentences, findCouplets } from "./coupletRewrite.js";

const chapter = [
  "A Mongol army did not carry its whole world behind it in wagons. It carried a moving pasture. Each warrior might have several horses, and the army's speed depended on changing them.",
  "The wagon train was not an afterthought to the army in 1241. It set the limits of the army's reach under Batu. Nothing here is a couplet: the sentence runs on with a subordinate clause before it settles.",
  "Baghdad fell in 1258 after the campaign led by Hülegü. The city was the seat of the Abbasid caliphate."
].join("\n\n");

describe("coupletRewrite", () => {
  it("finds the negation-then-assertion pairs and counts them per thousand sentences", () => {
    const couplets = findCouplets(chapter);
    expect(couplets.map((couplet) => couplet.first)).toEqual([
      "A Mongol army did not carry its whole world behind it in wagons.",
      "The wagon train was not an afterthought to the army in 1241."
    ]);
    expect(couplets[1]!.paragraph).toBe(1);
    expect(Math.round(coupletsPer1000Sentences(chapter))).toBe(Math.round((2 / 8) * 1000));
  });

  it("accepts a rewrite only when the pattern is gone and every anchor survives", () => {
    const couplet = findCouplets(chapter)[1]!;
    expect(acceptCoupletRewrite(couplet, "Under Batu in 1241 the wagon train set the limits of the army's reach, whatever the riders could do without it.")).toBe(true);
    // Pattern kept.
    expect(acceptCoupletRewrite(couplet, "The wagon train was not decoration in 1241. It set Batu's limits.")).toBe(false);
    // A number and a name dropped.
    expect(acceptCoupletRewrite(couplet, "The wagon train set the limits of the army's reach, whatever the riders could do without it.")).toBe(false);
    // Too short.
    expect(acceptCoupletRewrite(couplet, "Batu, 1241: the train ruled.")).toBe(false);
    // Semicolon antithesis.
    expect(acceptCoupletRewrite(couplet, "In 1241 the wagon train limited Batu's army; the other half of the story was the riders' endurance.")).toBe(false);
  });
});
