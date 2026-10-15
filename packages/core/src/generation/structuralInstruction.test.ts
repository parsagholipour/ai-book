import { describe, expect, it } from "vitest";
import {
  STRUCTURAL_ACTION_PREFIX_PATTERN,
  STRUCTURAL_PAGE_SELECTION_PATTERN,
  classifyStructuralEditInstruction,
  isBareStructuralInstruction,
  structuralEditRequiresWholeBookGeneration,
  type StructuralInstructionEdit
} from "./structuralInstruction.js";

const remove = (...pageIndexes: number[]): StructuralInstructionEdit => ({
  action: "delete",
  anchorPageIndex: null,
  pageIndexes
});
const carry = (anchorPageIndex: number | null, ...pageIndexes: number[]): StructuralInstructionEdit => ({
  action: "move",
  anchorPageIndex,
  pageIndexes
});
const write = (): StructuralInstructionEdit => ({
  action: "insert",
  anchorPageIndex: 2,
  pageIndexes: []
});

describe("structural edit instruction classification", () => {
  it.each([
    [remove(2), "Remove page 2"],
    [remove(11), "Delete page eleven"],
    [remove(20), "Remove the twentieth page"],
    [remove(2, 3, 4), "Delete pages 2, 3, and 4 from the book."],
    [remove(2), "delete pages"],
    [carry(4, 2), "Move page 2 after page 4"],
    [carry(19, 11), "Move page eleven after page nineteen"],
    [carry(10, 20), "Move the twentieth page after page ten"],
    [carry(1, 2, 3), "Move pages 2-3 to the front of the book."],
    [carry(4, 2), "Move page 2 from page 2 to before page 5"],
    [carry(4, 2), "move pages"]
  ] as const)("keeps a pure %# on the direct structural path", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
    expect(classifyStructuralEditInstruction(edit, instruction)).toEqual({
      hasContentRequirements: false,
      contentRequirements: null
    });
  });

  /**
   * The closed grammar was closed too tightly around one verb list and one
   * spelling of "the end of the book", so an ordinary English delete was priced
   * as a whole book regenerated: "Cut page 4" named a verb it did not know, and
   * "Delete the last page of the book." left "of the book" standing as prose.
   */
  it.each([
    [remove(4), "Cut page 4"],
    [remove(4), "Erase page 4"],
    [remove(4), "Get rid of page 4"],
    [remove(5), "Delete the last page of the book."],
    [remove(5), "Remove the final page of the story."],
    [remove(4), "Please delete page 4, thanks"],
    [carry(6, 3), "Move page 3 after page 7 please"]
  ] as const)("reads an ordinary English page edit as structural: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
  });

  /**
   * Courtesy at either end and a reason that only says the page is redundant
   * are not prose work; each of these was quoted as a whole-book rebuild.
   */
  it.each([
    [remove(6), "delete page 6 please and thanks"],
    [remove(6), "Delete page 6, thanks so much!"],
    [remove(6), "can you delete page 6"],
    [remove(6), "Could you please remove page 6?"],
    [remove(6), "I'd like you to delete page 6"],
    [remove(5), "remove page 5, it repeats page 4"],
    [remove(5), "delete page 5 because it's a duplicate of page 4"],
    [remove(5), "delete page 5, it's empty"],
    [carry(4, 2), "can you move page 2 after page 4 please"]
  ] as const)("reads courtesy and a redundancy reason as structural: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
  });

  /**
   * Pages located by a pattern or by what they hold: the router picks the rows
   * and the card lists them, so nothing here asks for prose. Both were quoted as
   * whole-book rebuilds.
   */
  it.each([
    [remove(2, 4, 6), "delete every other page"],
    [remove(7, 8), "remove all the pages about shopping"],
    [remove(9), "delete the page with the printable checklist"],
    [carry(12, 3), "move the page about leftovers to the end"],
    [remove(3, 4), "صفحه ۳ و ۴ را حذف کن"],
    [carry(2, 4), "صفحه ۳ و ۴ را جابجا کن"]
  ] as const)("reads a located page object as structural: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
  });

  it.each([
    [remove(7), "remove the page about shopping and rewrite page 8"],
    [remove(7), "delete the page about shopping, merging its tip into page 8"],
    [carry(12, 3), "move the page about leftovers to the end and make it shorter"]
  ] as const)("keeps a located page object that asks for more on the generation path: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  it.each([
    [remove(5), "remove page 5, it repeats page 4, and fix the ending of page 6"],
    [remove(5), "delete page 5 because the ending is weak"],
    [remove(5), "can you delete page 5 and rewrite page 6"]
  ] as const)("keeps a reason or a request that asks for more on the generation path: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  /**
   * "swap pages 2 and 3" was quoted as a whole-book rebuild: "swap" is in no
   * move grammar, so the request read as prose work. It is one reorder, and the
   * API answers any swap one move cannot perform before a card exists.
   */
  it.each([
    [carry(0, 3), "swap pages 2 and 3"],
    [carry(0, 3), "Switch page 2 with page 3, please"],
    [carry(0, 3), "swap the order of pages 2 and 3"],
    [carry(0, 3), "exchange pages 2 & 3 around"]
  ] as const)("reads a swap as a bare move: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
  });

  it.each([
    [carry(0, 3), "swap pages 2 and 3 and make page 3 funnier"],
    [remove(3), "swap pages 2 and 3"],
    [carry(0, 3), "swap the pictures on pages 2 and 3"]
  ] as const)("keeps a swap that asks for more, or is not a move, off the free path: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  /**
   * The determiner a reader with the page in front of them actually types. The
   * generic page object knew "the", "that" and "those" but neither
   * demonstrative, so
   * "Remove this page" — a delete the resolver had already pinned to one row —
   * was read as prose work and priced as a whole second book, on the most
   * common phrasing there is.
   */
  it.each([
    [remove(4), "Remove this page"],
    [remove(4), "Delete this page"],
    [remove(4), "Delete this page, thanks"],
    [remove(4, 5), "Remove these pages"],
    [carry(null, 4), "Move this page to the end"],
    [carry(1, 4), "Move these pages to the front of the book, please"]
  ] as const)("reads a demonstrative page object as structural: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
    expect(classifyStructuralEditInstruction(edit, instruction)).toEqual({
      hasContentRequirements: false,
      contentRequirements: null
    });
  });

  /**
   * The action prefix is what the API takes off the front to find the content
   * requirement, so a prefix that ends inside a word hands the durable replan a
   * sliced one: "Delete the page about the storm" matched through "page a" and
   * the whole book was rebriefed from "Bout the storm".
   */
  it("never lets an action prefix end inside a word", () => {
    const deletePrefix = new RegExp(`^${STRUCTURAL_ACTION_PREFIX_PATTERN.delete}`, "i");
    expect(deletePrefix.test("Delete the page about the storm")).toBe(false);
    expect(deletePrefix.exec("Delete page 4 and shorten it")?.[0]).toBe("Delete page 4");
    expect(deletePrefix.exec("Delete the last page and shorten it")?.[0]).toBe("Delete the last page");
    expect(deletePrefix.exec("Delete pages 2, 3 and 4 from the book")?.[0]).toBe("Delete pages 2, 3 and 4");
    // An article still *counts* pages for an insert; it only stopped naming one.
    const insertPrefix = new RegExp(`^${STRUCTURAL_ACTION_PREFIX_PATTERN.insert}`, "i");
    expect(insertPrefix.exec("Add a new page about Mina")?.[0]).toBe("Add a new page");
    expect(insertPrefix.exec("Add 2 pages after page 3")?.[0]).toBe("Add 2 pages");
    // Spoken page references reach twenty, but word-based insert quantities do
    // not: the API recogniser deliberately accepts those only through ten.
    expect(insertPrefix.test("Add eleven pages after page 3")).toBe(false);
  });

  /**
   * The same rule on the branch that ends in the page *noun* rather than in a
   * number. The article's guard was written on `PAGE_NUMBER` and `PAGE_QUANTITY`
   * and never reached the `${quantity} pages?` branch that terminates the
   * exported delete and move prefixes, so "remove a pageant scene" was consumed
   * as "remove a page" and "ant scene" went on as the brief — "Bout the storm"
   * one branch over. The boundary belongs to the grammar rather than to the
   * consumer that remembers it, so the insert prefix is asked without one here.
   */
  it("never lets a quantity clause end inside the page noun", () => {
    const prefixOf = (action: keyof typeof STRUCTURAL_ACTION_PREFIX_PATTERN) =>
      new RegExp(`^${STRUCTURAL_ACTION_PREFIX_PATTERN[action]}`, "i");
    expect(prefixOf("delete").test("Remove a pageant scene")).toBe(false);
    expect(prefixOf("delete").test("Delete three pageants from the fair")).toBe(false);
    expect(prefixOf("move").test("Move three pageants to the end")).toBe(false);
    expect(prefixOf("insert").test("Add a pageant scene")).toBe(false);
    // The branch still has to read what it was written for.
    expect(prefixOf("delete").exec("Remove a page from the book")?.[0]).toBe("Remove a page");
    expect(prefixOf("move").exec("Move three pages to the end")?.[0]).toBe("Move three pages");
  });

  /**
   * `structuralPageEditFromMessage` (`apps/api/src/bookEditStructure.ts`)
   * resolves these verbs into an edit, and this grammar is what takes their
   * clause back off. A verb it knows and this one does not leaves the whole
   * sentence standing as the content requirement, which prices a free row
   * reorder as a whole book regenerated — `shift` and `put` did exactly that.
   * The API side pins the pairing end to end in
   * `structuralPageEditInstructions.test.ts`; this list is the leaf's own copy
   * of what it must never be narrower than.
   */
  it.each([
    [carry(1, 3), "Shift page 3 after page 1"],
    [carry(1, 3), "Put page 3 after page 1"],
    [carry(null, 3), "Shift page 3 to the end"],
    [carry(null, 3), "Put page 3 at the end"],
    [remove(3), "Drop page 3"],
    [remove(3), "Take out page 3"]
  ] as const)("strips every verb the API recogniser accepts: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
    expect(classifyStructuralEditInstruction(edit, instruction)).toEqual({
      hasContentRequirements: false,
      contentRequirements: null
    });
  });

  /**
   * An empty `Content requirements:` body is the extractor saying it found no
   * prose, which is not the same as there being none — the action clause it
   * could not read is still a requirement. Answering with the whole instruction
   * made the literal marker words the brief: "Delete the page about the storm
   * Content requirements" was what `strategy.revisePlan` would have been handed.
   */
  it("never briefs a replan from the marker's own words", () => {
    const classified = classifyStructuralEditInstruction(
      remove(4),
      "Delete the page about the storm and keep its last line\nContent requirements: "
    );
    expect(classified).toEqual({
      hasContentRequirements: true,
      contentRequirements: "Delete the page about the storm and keep its last line"
    });
    expect(classified.contentRequirements).not.toContain("Content requirements");
    // A bare action clause under an empty body is still free.
    expect(structuralEditRequiresWholeBookGeneration(remove(4), "Remove page 4. Content requirements: ")).toBe(
      false
    );
  });

  /**
   * The expensive half. A closed *English* grammar answers "this is entirely
   * prose" to every language it cannot read, so a bare delete typed in Persian,
   * Spanish or Japanese was quoted a whole book. The second door reads the
   * request word by word against the structural vocabulary instead.
   */
  it.each([
    [remove(4), "صفحه ۴ را حذف کن"],
    [remove(4), "صفحهٔ ۴ را پاک کن"],
    [remove(4), "احذف الصفحة ٤"],
    [remove(4), "احذف الصفحة ٤ من الكتاب"],
    [remove(4), "صفحہ ۴ حذف کریں"],
    [remove(4), "Eliminar la página 4"],
    [remove(4), "Elimina la pagina 4"],
    [remove(4), "Seite 4 löschen"],
    [remove(4), "Удалить страницу 4"],
    [remove(4), "पेज 4 हटा दें"],
    [remove(4), "หน้า 4 ลบ"],
    [remove(4), "עמוד 4 למחוק"],
    [remove(4), "第4ページを削除して"],
    [remove(4), "4ページを削除してください"],
    [remove(4), "删除第4页"],
    [remove(4), "4페이지를 삭제해줘"],
    [carry(4, 3), "صفحه ۳ را بعد از صفحه ۴ ببر"],
    [carry(6, 3), "Mueve la página 3 después de la página 7"],
    [carry(6, 3), "Verschiebe Seite 3 hinter Seite 7"],
    [carry(6, 3), "把第3页移到第7页后面"]
  ] as const)("keeps a bare page edit written in another language free: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
    expect(classifyStructuralEditInstruction(edit, instruction)).toEqual({
      hasContentRequirements: false,
      contentRequirements: null
    });
  });

  it.each([
    [remove(2), "Remove page 2. Content requirements: Moving its final quote to page 3."],
    [remove(2), "Delete page 2 while preserving Mina's final line on page 3"],
    [remove(2), "Delete page 2 and rewrite page 3 in a warmer tone"],
    [carry(4, 2), "Move page 2 after page 4. Content requirements: Preserve its title on page 5."],
    [carry(4, 2), "Move page 2 after page 4 and make the ending funnier"],
    [carry(4, 2), "Move page 2 after page 4 without changing its final quote"]
  ] as const)("routes a compound delete/move through generation: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  /**
   * The other direction of the same door. A second clause is built out of
   * content words, and most of them name a page the edit has no coordinate for
   * — so no entry may join the vocabulary until all of these still fail it.
   */
  it.each([
    [remove(4), "صفحه ۴ را حذف کن و صفحه ۳ را گرم‌تر بازنویسی کن"],
    [remove(2), "صفحه ۲ را حذف کن بدون تغییر جمله آخرش"],
    [remove(2), "احذف الصفحة ٢ مع الاحتفاظ بالاقتباس الأخير في الصفحة ٣"],
    [remove(2), "Elimina la página 2 conservando la cita final en la página 3"],
    [remove(2), "Lösche Seite 2 und schreibe Seite 3 wärmer um"],
    [remove(2), "Удалить страницу 2, сохранив последнюю цитату на странице 3"],
    [remove(2), "第2ページを削除して、3ページをもっと面白く書き直して"],
    [remove(2), "删除第2页，并把第3页改写得更有趣"],
    [remove(2), "2페이지를 삭제하고 3페이지를 더 재미있게 다시 써줘"],
    [carry(4, 2), "Mueve la página 2 después de la página 4 y haz el final más divertido"]
  ] as const)("still generates for a compound request in another language: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  /**
   * Both directions of the second door, which a character budget could not hold
   * in either. Measured over this corpus, the heaviest bare request
   * ("4ページを削除してください") and the lightest compound one
   * ("删除第4页并让它更有趣") weigh exactly the same, so every threshold either
   * quotes a whole book for a row deletion or — the case below the first list —
   * delivers one of the two things a reader asked for and says nothing.
   *
   * The verbs and the furniture are recognised instead, so a language nobody
   * listed overcharges and none of them can lose prose work.
   */
  it.each([
    [remove(4), "Supprime la page 4"],
    [remove(4), "Supprimez la page 4 du livre"],
    [remove(4), "Sayfa 4'ü sil"],
    [remove(4), "Slett side 4"],
    [remove(4), "Usuń stronę 4"],
    [remove(4), "Verwijder pagina 4 uit het boek"]
  ] as const)("keeps a bare page edit free where the English grammar knows no verb: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(false);
    expect(classifyStructuralEditInstruction(edit, instruction)).toEqual({
      hasContentRequirements: false,
      contentRequirements: null
    });
  });

  it.each([
    [remove(4), "صفحه ۴ را حذف کن و بامزه‌ترش کن"],
    [remove(4), "删除第4页并让它更有趣"],
    [remove(4), "4ページを削除して面白くして"],
    [remove(4), "4페이지 삭제하고 더 재미있게"],
    [remove(4), "Supprime la page 4 et rends la fin plus drôle"],
    [remove(4), "Sayfa 4'ü sil ve sonunu daha komik yap"],
    [remove(4), "Slett side 4 og gjør slutten morsommere"],
    [remove(4), "Usuń stronę 4 i zmień zakończenie"],
    [remove(4), "Verwijder pagina 4 en maak het einde grappiger"],
    [remove(4), "صفحه ۴ و ۵ را حذف کن"]
  ] as const)("charges for a second clause no length could separate: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  /**
   * English keeps a single authority. Nothing English is in the structural
   * vocabulary, so the second door only ever opens for a request that used a
   * word this project had to learn — an English verb this grammar has never
   * heard of stays conservative rather than being read by the other door, which
   * is the one way it could hand prose work to the free row-ordering path.
   */
  it.each([
    [remove(2), "Scrap page 2 and make it funny"],
    [remove(2), "Cut page 2 and make it funnier"],
    [remove(2), "Delete page 2 make it funny"],
    [remove(2), "Delete the final spread while preserving its last quote on page 3"]
  ] as const)("never lets a short English content clause into the free path: %#", (edit, instruction) => {
    expect(structuralEditRequiresWholeBookGeneration(edit, instruction)).toBe(true);
  });

  it("does not send an insertion away from its existing generation path", () => {
    expect(
      structuralEditRequiresWholeBookGeneration(
        write(),
        "Add 1 new page after page 2. Content requirements: Reveal the brass key."
      )
    ).toBe(false);
    expect(
      classifyStructuralEditInstruction(
        write(),
        "Add 1 new page after page 2. Content requirements: Reveal the brass key."
      ).hasContentRequirements
    ).toBe(true);
    // The second door is deliberately shut for an insert: its remainder is the
    // brief the new pages are drafted from, so a bare-looking one in another
    // language must keep its subject rather than lose it to a length budget.
    expect(
      classifyStructuralEditInstruction(write(), "یک صفحه درباره مینا اضافه کن").hasContentRequirements
    ).toBe(true);
  });

  it("fails malformed or unfamiliar legacy syntax closed", () => {
    expect(structuralEditRequiresWholeBookGeneration(remove(2), "make the whole thing shorter")).toBe(true);
    expect(structuralEditRequiresWholeBookGeneration(carry(4, 2), "move it over there")).toBe(true);
  });
});

describe("structural classification keeps every answer across the linear rewrite", () => {
  // Captured from the classifier as it stood before its courtesy tail, its
  // reason tail and its clause trim were made linear. The rewrite changes the
  // backtracking and nothing else, so no entry may move — null is a bare edit,
  // a string the content requirement it was read as.
  const CORPUS: ReadonlyArray<readonly [StructuralInstructionEdit, string, string | null]> = [
    [remove(3), "delete page 3", null],
    [remove(3), "delete page 3 please", null],
    [remove(3), "delete page 3, please and thanks", null],
    [remove(3), "delete page 3 , please , thanks", null],
    [remove(3), "delete page 3,please", null],
    [remove(3), "delete page 3 please thank you so much", null],
    [remove(3), "delete page 3 ty ty", null],
    [remove(3), "delete page 3 cheers, ty", null],
    [remove(3), "delete page 3 and thanks", null],
    [remove(3), "delete page 3 please and also make it funny", "delete page 3 please and also make it funny"],
    [remove(3), "delete page 3, it repeats page 7", null],
    [remove(3), "delete page 3 because it's redundant", null],
    [remove(3), "delete page 3 — it is just a duplicate of page 4", null],
    [remove(3), "delete page 3 as it's empty", null],
    [remove(3), "delete page 3 - it's not needed, thanks", null],
    [remove(3), "delete page 3,it's blank", null],
    [remove(3), "delete page 3 since this is basically the same as page 2", null],
    [remove(3), "delete page 3, it is boring", "delete page 3, it is boring"],
    [remove(3), "delete page 3,,,", null],
    [remove(3), "delete page 3!!!", null],
    [remove(3), "delete page 3?!", null],
    [remove(3), "...delete page 3", null],
    [remove(3), "delete page 3, , ,", null],
    [remove(3), "delete page 3 —", null],
    [remove(3), "can you delete page 3", null],
    [remove(3), "delete the page about the storm", null],
    [remove(3), "delete the page about the storm please", null],
    [remove(3), "delete every other page", null],
    [remove(3), "صفحه ۳ را حذف کن", null],
    [remove(3), "صفحه ۳ را حذف کن لطفا", null],
    [remove(3), "删除第3页", null],
    [remove(3), "3ページを削除してください", null],
    [remove(3), "Elimina la página 3", null],
    [remove(3), "supprime la page 3", null],
    [remove(3), "delete page 3 and make it funny!!!", "delete page 3 and make it funny"],
    [remove(3), ",, delete page 3 and make it funny ,,", "delete page 3 and make it funny"],
    [remove(3), "delete page 3 and make it funny ?!", "delete page 3 and make it funny"],
    [remove(3), "delete page 3 and make it funny —!", "delete page 3 and make it funny"],
    [remove(3), "—! delete page 3 and make it funny", "! delete page 3 and make it funny"],
    [remove(3), "delete page 3 and make it funny, , ;: x", "delete page 3 and make it funny, , ;: x"],
    [carry(5, 2), "swap pages 1 and 2", null],
    [carry(5, 2), "swap pages 1 and 2 please", null],
    [carry(5, 2), "swap pages 1 and 2, thanks a lot", null],
    [carry(5, 2), "swap pages 1 and 2 ty ty ty", null],
    [carry(5, 2), "swap pages 1 and 2 ty ty x", "swap pages 1 and 2 ty ty x"],
    [carry(5, 2), "swap pages 1,2", null],
    [carry(5, 2), "swap the order of pages 1 & 2 around", null],
    [carry(5, 2), "move page 2 after page 5", null],
    [carry(5, 2), "move page 2 after page 5 please", null],
    [carry(5, 2), "move page 2 to the end of the book, thanks", null],
    [carry(5, 2), "move page 2 after page 5 and rewrite it", "move page 2 after page 5 and rewrite it"],
    [write(), "add a page", null],
    [write(), "add a page after page 2", null],
    [write(), "add a page after page 2 please", null],
    [write(), "add 2 new pages at the end, thanks!", null],
    [write(), "add a page about the storm", "add a page about the storm"],
    [write(), "add a page after page 2 , please", null],
    // The leading trim stops short of "!" and "?", and the trailing one
    // still starts where it stopped, as it did when the two were one pattern.
    [remove(3), ",!", ",!"],
    [remove(3), ", ?", ", ?"],
    [remove(3), "—?!", "—?!"],
    [remove(3), "?", "?"],
    [remove(3), "make it funny,!", "make it funny"],
    [remove(3), ",make it funny!?, ", "make it funny"]
  ];

  it("reads every request the way it did before", () => {
    const moved = CORPUS.flatMap(([edit, instruction, before]) => {
      const classified = classifyStructuralEditInstruction(edit, instruction);
      const after = classified.hasContentRequirements ? classified.contentRequirements : null;
      return after === before ? [] : [{ instruction, before, after }];
    });
    expect(moved).toEqual([]);
  });
});

describe("structural classification on adversarial input", () => {
  // Every structural edit a reader proposes is classified on the API's only
  // thread. `\s*,?\s*` inside the repeated courtesy tail let each space go to
  // either quantifier, so a tail that failed at its last word was retried 2ⁿ
  // ways: "swap pages 1 and 2" and 26 "ty"s took 2.7 s. Timed at 1k before 10k,
  // so a regression fails in a fraction of a second instead of hanging.
  const fill =
    (head: string, filler: string, tail = " x") =>
    (length: number): string => {
      const room = length - head.length - tail.length;
      return head + filler.repeat(Math.ceil(room / filler.length)).slice(0, room) + tail;
    };
  const ADVERSARIAL: ReadonlyArray<readonly [StructuralInstructionEdit, string, (length: number) => string]> = [
    [carry(5, 2), "a swap + repeated courtesies", fill("swap pages 1 and 2", " ty")],
    [carry(5, 2), "a swap + spaced comma courtesies", fill("swap pages 1 and 2", " , ty")],
    [carry(5, 2), "a move + repeated thanks", fill("move page 2 after page 5", " and thanks")],
    [remove(3), "a delete + repeated pleases", fill("delete page 3", ", please")],
    [remove(3), "a delete + a reason + spaces", fill("delete page 3 because it", " ")],
    [remove(3), "a delete + a run of commas", fill("delete page 3", ",", "y")],
    [remove(3), "a delete + a run of dashes and spaces", fill("delete page 3", " -")],
    [remove(3), "a located delete + a joined word", fill("delete the page about ", "ty")],
    [remove(3), "a located delete + hyphens", fill("delete the page about x", "-x")],
    [write(), "an insert + repeated courtesies", fill("add a page", " please")],
    [write(), "a canonical insert + punctuation", fill("Add 1 new page after page 2. Content requirements: x", ",")]
  ];
  const readMs = (run: () => unknown): number => {
    // Best of two, so one slow read under load is not a failure.
    let best = Number.POSITIVE_INFINITY;
    for (let read = 0; read < 2; read += 1) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("stays linear on long courtesy, reason and punctuation tails", () => {
    for (const [length, budgetMs] of [
      [1_000, 200],
      [10_000, 1_000]
    ] as const) {
      for (const [edit, label, build] of ADVERSARIAL) {
        const text = build(length);
        expect(text).toHaveLength(length);
        const ms = readMs(() => [isBareStructuralInstruction(edit, text), classifyStructuralEditInstruction(edit, text)]);
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs);
      }
    }
  });

  it("reads a page selection out of a long number from its first digit only", () => {
    // The API searches the selection unanchored to find placement-only prose,
    // and from every digit of a run no boundary ended `\d+` rescanned the rest.
    const selection = new RegExp(STRUCTURAL_PAGE_SELECTION_PATTERN, "gi");
    for (const [length, budgetMs] of [
      [1_000, 200],
      [10_000, 1_000]
    ] as const) {
      for (const [label, build] of [
        ["digits then a letter", fill("", "1", "x")],
        ["digits then an ordinal suffix", fill("page ", "21", "thx")],
        ["digits then spaces", fill("the ", "1", "    x")]
      ] as const) {
        const text = build(length);
        const ms = readMs(() => text.replace(selection, " "));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs);
      }
    }
  });
});
