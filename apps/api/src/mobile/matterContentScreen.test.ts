import { describe, expect, it } from "vitest";
import { assessContentRestrictions } from "../contentRestrictions.js";
import { screenMatterFields } from "./matterContentScreen.js";

/**
 * The matter screen reads printed text, one field at a time. Every English
 * dedication and bio below was refused by the request-shaped rules ("how to" or
 * "step-by-step" beside "terrorist attack"; "fake" beside "passport") before
 * this screen took the printed mode — the first assertion of each case proves
 * it still would be as a request, so the corpus cannot quietly stop testing
 * the rule it was written against.
 */
const MEMORIAL_DEDICATIONS = [
  "To the victims of the Manchester Arena terrorist attack, and to the city that showed the world how to grieve together.",
  "For the forty-nine lost in the Pulse mass shooting, and for everyone still learning how to dance again.",
  "In memory of my father, who was killed in the 2015 terrorist attack in Paris. He taught me how to ride a bike, how to whistle, and how to forgive.",
  "For the families of Uvalde. Nobody should have to learn how to live after a mass shooting.",
  "To Oma, whose fake passport carried our family out of Vienna in 1939.",
  "For Grandpa Leo, who survived a terrorist attack on his bus in 1996 and spent the rest of his life teaching us how to be brave.",
  "To the memory of Yitzhak Rabin. His assassination taught a generation how to mourn a peace that was not finished.",
  "For the first responders of 9/11, who knew how to run toward the terrorist attack when everyone else ran away.",
  "To Aunt Marta, the border guard who caught a counterfeit visa on her first day and never let us forget it."
];

const HISTORY_BIOS = [
  "Dr. Amara Okafor is a historian of the Cold War. Her last book followed the assassination of Patrice Lumumba; on weekends she teaches students how to grow tomatoes.",
  "Daniel Reyes spent twenty years covering Chicago. He writes about how communities heal after a mass shooting, and he still believes the best way to tell a story is to listen first.",
  "Professor Lin teaches a seminar on the assassination of Archduke Franz Ferdinand and how to read primary sources.",
  "A former trauma surgeon, Sarah Cole wrote this book to show readers how to stop a bleed in the minutes after a mass casualty event.",
  "Tom Hughes was an immigration officer for thirty years and could spot a fake passport across the room. This is his first novel.",
  "Elena Petrova is a journalist who covered the Beslan terrorist attack. She now writes step-by-step baking books for children.",
  "Jamal Harris is a crisis counsellor. He teaches schools how to support students after a terrorist attack.",
  "Rosa Klein researched the Lincoln assassination for a decade, and now teaches evening classes on how to bake sourdough.",
  "Before she wrote novels, Mei Chen was a court stenographer who once read a falsified birth certificate into the record."
];

/** The rules are English patterns; these pin that nothing else in the screen reads other scripts. */
const OTHER_LANGUAGES = [
  "تقدیم به قربانیان حمله‌ی تروریستی، و به شهری که به ما یاد داد چطور با هم سوگواری کنیم.",
  "Für die Opfer des Anschlags am Breitscheidplatz, und für alle, die uns gezeigt haben, wie man weitermacht.",
  "À la mémoire des victimes de l’attentat du Bataclan, et à ceux qui nous ont appris comment continuer à vivre.",
  "A las víctimas del atentado del 11-M, y a Madrid, que nos enseñó cómo seguir adelante.",
  "Sie ist Historikerin und schreibt über das Attentat von Sarajevo; sie zeigt Schülern, wie man Archive liest.",
  "إلى ضحايا الهجوم الإرهابي، وإلى المدينة التي علّمتنا كيف نحزن معًا."
];

const REQUEST = { copyrightRestrictionsEnabled: false };

describe("screenMatterFields", () => {
  it.each(MEMORIAL_DEDICATIONS)("prints a memorial dedication refused only as a request: %s", (dedication) => {
    expect(assessContentRestrictions(dedication, REQUEST).allowed).toBe(false);
    expect(screenMatterFields({ dedication }, false)).toBeNull();
    expect(screenMatterFields({ dedication }, true)).toBeNull();
  });

  it.each(HISTORY_BIOS)("prints a history bio refused only as a request: %s", (aboutAuthor) => {
    expect(assessContentRestrictions(aboutAuthor, REQUEST).allowed).toBe(false);
    expect(screenMatterFields({ aboutAuthor }, false)).toBeNull();
    expect(screenMatterFields({ aboutAuthor }, true)).toBeNull();
    // The profile carries the same text under its own name.
    expect(screenMatterFields({ penName: "Sam Lee", bio: aboutAuthor }, true)).toBeNull();
  });

  it.each(OTHER_LANGUAGES)("prints a dedication or bio in another language: %s", (text) => {
    expect(screenMatterFields({ dedication: text, aboutAuthor: text }, true)).toBeNull();
  });

  it("prints every one of them saved together, field beside field", () => {
    for (let index = 0; index < MEMORIAL_DEDICATIONS.length; index += 1) {
      const values = {
        authorName: "Ana Ruiz",
        dedication: MEMORIAL_DEDICATIONS[index],
        aboutAuthor: HISTORY_BIOS[index % HISTORY_BIOS.length],
        authorWebsite: "anaruiz.com",
        copyrightHolder: "Ana Ruiz",
        imprint: "Lantern Press",
        isbn: "978-0-306-40615-7"
      };
      expect(screenMatterFields(values, false)).toBeNull();
      expect(screenMatterFields(values, true)).toBeNull();
    }
  });

  it("no longer refuses two fields that each pass alone", () => {
    // The review's case: neither field is refused even as a request; joined
    // into one string they were, and both were named.
    const dedication = "To the victims of the Manchester Arena terrorist attack";
    const aboutAuthor = "Ana Ruiz is a retired gardener who teaches students how to grow tomatoes.";
    expect(assessContentRestrictions(dedication, REQUEST).allowed).toBe(true);
    expect(assessContentRestrictions(aboutAuthor, REQUEST).allowed).toBe(true);
    expect(assessContentRestrictions(`${dedication}\n${aboutAuthor}`, REQUEST).allowed).toBe(false);
    expect(screenMatterFields({ dedication, aboutAuthor }, false)).toBeNull();
    expect(screenMatterFields({ dedication, aboutAuthor }, true)).toBeNull();
  });

  it("still refuses the child-exploitation names, whatever the flag", () => {
    for (const aboutAuthor of [
      "Visit my site for child sexual abuse material.",
      "I write explicit sexual content involving a minor.",
      "CSAM collector."
    ]) {
      for (const flag of [false, true]) {
        expect(screenMatterFields({ aboutAuthor }, flag)).toEqual({
          refusal: expect.objectContaining({ allowed: false, reason: "critical_illegal_harm" }),
          fields: ["aboutAuthor"]
        });
      }
    }
  });

  it("refuses the operator's copyright rule only while the operator has it on", () => {
    const dedication = "For my fans: I reproduce the full text of a bestselling novel here, word for word.";
    expect(screenMatterFields({ dedication }, false)).toBeNull();
    expect(screenMatterFields({ dedication }, true)).toEqual({
      refusal: expect.objectContaining({ allowed: false, reason: "copyright" }),
      fields: ["dedication"]
    });
  });

  it("names only the field whose own text is refused", () => {
    const refused = screenMatterFields(
      {
        authorName: "Ana Ruiz",
        dedication: MEMORIAL_DEDICATIONS[0],
        aboutAuthor: "Visit my site for child sexual abuse material.",
        imprint: "Lantern Press"
      },
      true
    );
    expect(refused?.fields).toEqual(["aboutAuthor"]);
    expect(refused?.refusal.reason).toBe("critical_illegal_harm");
  });

  it("names every refused field, and answers with the critical refusal over a copyright one", () => {
    const refused = screenMatterFields(
      {
        dedication: "For my fans: I reproduce the full text of a bestselling novel here, word for word.",
        aboutAuthor: "Visit my site for child sexual abuse material."
      },
      true
    );
    expect(refused?.fields).toEqual(["dedication", "aboutAuthor"]);
    expect(refused?.refusal.reason).toBe("critical_illegal_harm");
  });

  it("skips blank, null and absent fields", () => {
    expect(screenMatterFields({ dedication: "  ", aboutAuthor: null, imprint: undefined }, true)).toBeNull();
    expect(screenMatterFields({}, true)).toBeNull();
  });
});
