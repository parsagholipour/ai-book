import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { FIRST_PAGE_OPENING_WINDOW, reviewPageDraftLocally } from "./pagesLocalQa.js";

function kidsInput(language: string) {
  return {
    prompt: "A bedtime picture book about a little fox who watches the moon.",
    category: "KIDS" as const,
    targetPages: 8,
    complexity: 2,
    temperature: 0.6,
    language,
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "narrative" as const
    }
  };
}

function nonfictionInput(category: "SCIENCE" | "EDUCATION") {
  return {
    prompt: "A practical history of city water systems and home filtration.",
    category,
    targetPages: 12,
    complexity: 6,
    temperature: 0.4,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "scholarly" as const
    }
  };
}

/**
 * The provenance an imported manuscript carries: `mediaSettings.mobile.import`,
 * written by the import route when it creates the project and copied into every
 * plan version's input snapshot, which is what `compileExport` rebuilds `input`
 * from before it runs final QA.
 */
function importedInput(category: "SCIENCE" | "EDUCATION") {
  const base = nonfictionInput(category);
  return {
    ...base,
    mediaSettings: {
      ...base.mediaSettings,
      mobile: {
        bookType: "custom",
        import: { importId: "imp_1", fileName: "tap-water.docx", format: "docx" }
      }
    }
  };
}

function storyInput() {
  return {
    prompt: "A winter story about Mira, her grandmother, and the frozen river behind the mill.",
    category: "STORY" as const,
    targetPages: 12,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "narrative" as const
    }
  };
}

/**
 * The book the Persian gates are read against: a CUSTOM bedtime story, so no
 * kids reading level narrows the word budget and the page is measured by the
 * general floor, exactly as the Persian pages that first failed these checks
 * were.
 */
function persianCustomInput() {
  return {
    prompt: "یک داستان آرام شبانه درباره چمنزار خواب‌آلود.",
    category: "CUSTOM" as const,
    targetPages: 5,
    complexity: 5,
    temperature: 0.8,
    language: "fa",
    mediaSettings: {
      fullIllustrations: true,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "neutral" as const
    }
  };
}

function review(input: Parameters<typeof makeFallbackPlan>[0], title: string, markdown: string, summary: string) {
  return reviewPageDraftLocally({
    input,
    plan: makeFallbackPlan(input),
    pageIndex: 2,
    draft: { title, markdown, summary, continuityNotes: [] },
    previousPages: [],
    continuityNotes: []
  });
}

const weakOpenerIssue = "First page opens with a generic or meta hook instead of a concrete one.";

const WEAK_HOOK_PHRASE = "Have you ever wondered";
const WEAK_HOOK_SENTENCE = `${WEAK_HOOK_PHRASE} why a river forgets how to freeze?`;
const OPENING_FILLER =
  "Mira was on the bridge before sunrise, prying at the ice with the mill's iron pole while her grandmother held the lantern. The river had refused to freeze for three winters running, and the village had run out of patient explanations. ";

/**
 * A first page whose hook sentence begins exactly `offset` characters into the
 * page as written. Both boundary tests are built from
 * FIRST_PAGE_OPENING_WINDOW rather than from paragraphs that happen to add up:
 * the fixture this replaced cleared the window by ten characters, so trimming a
 * sentence — or raising the constant to 300 — failed the test for a reason it
 * does not name, while a regression widening the window to 289 still passed it.
 */
function openingWithHookAt(offset: number): string {
  // The lead is exactly `offset` characters and its last one is a space: the
  // patterns open on \\b, so a lead truncated mid-word would glue the phrase to
  // a letter and the fixture would pass for carrying no hook at all rather
  // than for the window. It may not pad at the *front* either — the checker
  // reads a trimmed body, so a leading space would shift the whole fixture.
  const filler = OPENING_FILLER.repeat(Math.ceil(offset / OPENING_FILLER.length) + 1);
  const lead = `${filler.slice(0, offset - 1)} `;
  return `${lead}${WEAK_HOOK_SENTENCE} Mira had stopped wondering and started measuring, and the folding rule in her pocket was the only answer she trusted all winter.`;
}

function reviewOpening(
  input: Parameters<typeof makeFallbackPlan>[0],
  markdown: string,
  pageIndex = 1
) {
  return reviewPageDraftLocally({
    input,
    plan: makeFallbackPlan(input),
    pageIndex,
    draft: { title: "Opening", markdown, summary: "The book opens on its subject.", continuityNotes: [] },
    previousPages: [],
    continuityNotes: []
  });
}

describe("first-page opening gate", () => {
  it("fails a story's first page that opens on a stock rhetorical hook", () => {
    const report = reviewOpening(
      storyInput(),
      "Have you ever wondered what it feels like to lose a whole winter? Mira had not, until the morning the river behind the mill refused to freeze and her grandmother packed a single bag without a word of explanation to anyone in the house."
    );
    expect(report.issues).toContain(weakOpenerIssue);
    expect(report.checks.styleNatural).toBe(false);
  });

  it("lets the same sentence pass on any page after the first", () => {
    const report = reviewOpening(
      storyInput(),
      "Have you ever wondered what it feels like to lose a whole winter? Mira asked herself that on the bridge, watching the river that would not freeze, while her grandmother's bag sat packed by the mill door and nobody in the house said a word about it.",
      5
    );
    expect(report.issues).not.toContain(weakOpenerIssue);
  });

  it("catches a hook whose last character is the window's last", () => {
    const report = reviewOpening(
      storyInput(),
      openingWithHookAt(FIRST_PAGE_OPENING_WINDOW - WEAK_HOOK_PHRASE.length)
    );
    expect(report.issues).toContain(weakOpenerIssue);
    expect(report.checks.styleNatural).toBe(false);
  });

  it("lets a hook whose last character falls one past the window survive", () => {
    // Together with the test above this pins the boundary to the character:
    // the phrase here ends on the first index outside the window, so widening
    // the window by one catches it and narrowing by one loses the case above.
    const report = reviewOpening(
      storyInput(),
      openingWithHookAt(FIRST_PAGE_OPENING_WINDOW - WEAK_HOOK_PHRASE.length + 1)
    );
    expect(report.issues).not.toContain(weakOpenerIssue);
  });

  it("does not slide the window down a page that opens on dash-led dialogue", () => {
    // Stripping the dialogue before taking the window collapsed these five
    // opening blocks to a handful of newlines, so the 280 characters that
    // survived started in the sixth paragraph — roughly 900 characters into
    // the page a reader actually sees — and auto-rejected a first page whose
    // hook the window was never supposed to reach.
    const page = [
      "— The river has not frozen once this winter, and the mill wheel has not turned since the feast day — said Grandmother, folding the map she had carried in from the yard.",
      "— Then we walk to the weir before the light goes, and we take the iron pole with us — said Mira, who had her boots on already and was standing in the open doorway.",
      "— The keeper will say what he said in March, and I will not argue with him twice in one winter — said Grandmother, and she pushed the folded map into her coat pocket.",
      "> The parish register, 1904: the water above the weir stood open in every February the keeper walked the bank.",
      "They went down the towpath with the lantern between them, and the reeds along the bank stood stiff as fence posts the whole way to the sluice.",
      `${WEAK_HOOK_SENTENCE} Mira had stopped wondering and started measuring, and the folding rule in her pocket was the only answer she trusted.`
    ].join("\n\n");

    expect(reviewOpening(storyInput(), page).issues).not.toContain(weakOpenerIssue);
  });

  it("does not take its opening from the narration behind the dialogue", () => {
    // The window fix above stopped the *window* sliding; the anchored-welcome
    // scan slid anyway. `narrationOutsideQuotedSpeech` maps a dash-led line to
    // "", the scan skipped every empty line, and so the first candidate was
    // the narration paragraph 219 characters in — inside the window, and
    // nothing a reader would call this page's opening. The docstring promised
    // scanning stops at the first line that is not a heading; a page whose
    // opening prose is dialogue has no narration opening for the greeting rule
    // to read at all.
    const page = [
      "— The rain has not let up since Tuesday, and the lower gallery is shut — said the guide, shaking out her wet coat.",
      "— Then we start at the top and walk down — said Mira, who had the folded ticket in her glove already.",
      "Welcome to the museum, said the brass plate over the stair, and Mira read it twice on the way past it."
    ].join("\n\n");

    expect(reviewOpening(storyInput(), page).issues).not.toContain(weakOpenerIssue);
  });

  it("fails a signposting category that opens by naming what the book will teach", () => {
    // firstPageOpeningRule (pagesShared.ts) lets the signposting categories
    // signpost "later on the page, never in the first paragraph", and the
    // opening window this check reads *is* that first paragraph — so excusing
    // them here excused the one place the instruction never did.
    // hasChapterOpenerScaffold still carries the category distinction over the
    // rest of the page, which is where the concession actually lives.
    const report = reviewOpening(
      nonfictionInput("EDUCATION"),
      "This book will show you how to test your own tap water with tools that cost less than a takeaway meal. Start at the kitchen sink: run the cold tap for thirty seconds, fill a clear glass, and hold it against a white sheet of paper in daylight."
    );
    expect(report.issues).toContain(weakOpenerIssue);
    expect(report.checks.styleNatural).toBe(false);
  });

  it("fails a signposting category that opens on the phrase both prompts quote", () => {
    // "In this book" is named as forbidden by buildPageInstruction and by
    // FIRST_PAGE_IDENTITY_RULE (pageBriefContract.ts), and appeared in none of this
    // file's pattern lists. EDUCATION is the category that proves it: the
    // whole-page hasChapterOpenerScaffold check skips the signposting
    // categories, so nothing else here was looking at this sentence.
    const report = reviewOpening(
      nonfictionInput("EDUCATION"),
      "In this book we will explore how a city drinks, stores, and loses water. The pipes under a single street carry more history than the street above them, and the meters at each end have been arguing about it for a century."
    );
    expect(report.issues).toContain(weakOpenerIssue);
    expect(report.checks.styleNatural).toBe(false);
  });

  it("reads the stock opener with the apostrophe a provider actually writes", () => {
    // The typographic U+2019 is what comes back from every provider; the
    // pattern spelled only the ASCII one, so the single most recognisable AI
    // opener there is sailed through the page it matters most on.
    for (const apostrophe of ["'", "’"]) {
      const report = reviewOpening(
        nonfictionInput("SCIENCE"),
        `In today${apostrophe}s fast-paced world, the water in your tap has already travelled further than most people drive in a week, and three separate authorities have measured, chlorinated, and pressurised it before it reaches the kitchen.`
      );
      expect(report.issues, apostrophe).toContain(weakOpenerIssue);
    }
  });

  it("finds the welcome behind a heading or an emphasis marker", () => {
    // narrationOutsideQuotedSpeech keeps headings and emphasis verbatim, and
    // the pattern was anchored with `^` against that raw text — so a bolded
    // welcome starts with `*`, a welcome under the page title models emit
    // despite INTERNAL_PAGE_TITLE_RULE starts with `#`, and the exact sentence
    // the test below says must never pass was approved twice over.
    const tail =
      " The kit on the kitchen table costs less than a takeaway meal, and it will tell you within ten minutes whether the tap you drink from carries more chlorine than the supplier's own annual report admits to.";
    const pages = [
      `**Welcome to the world of home water testing.**${tail}`,
      `## Tap Water\n\nWelcome to the world of home water testing.${tail}`,
      `# Welcome to the world of home water testing\n\nThe kit on the kitchen table costs less than a takeaway meal.${tail}`
    ];

    for (const page of pages) {
      const report = reviewOpening(nonfictionInput("EDUCATION"), page);
      expect(report.issues, page.slice(0, 24)).toContain(weakOpenerIssue);
      expect(report.checks.styleNatural).toBe(false);
    }
  });

  it("still reads only the opening, not a welcome inside the first paragraph", () => {
    // The anchor moved from the first character to the first word, not from
    // the opening to the window: "welcome to" is ordinary English prose once a
    // sentence is under way, and it costs the page nothing there.
    const report = reviewOpening(
      storyInput(),
      "The lamp above the mill door had been lit since Tuesday, a welcome to anyone walking up the towpath in the dark, and Mira counted on it the way other people counted on a clock in a room with no windows at all."
    );
    expect(report.issues).not.toContain(weakOpenerIssue);
  });

  it("leaves an imported manuscript's own first sentence alone", () => {
    // runLocalFinalQa feeds this rejection to repairPagesFromFinalQa, which
    // model-redrafts the page in place — so on an import the gate rewrote the
    // author's opening line for breaking a writer instruction nothing had ever
    // been given. The generated twin below is the control: the sentence is the
    // same, and only the import provenance separates them.
    const opening =
      "Have you ever wondered why your tap water tastes different in August? I did, for eleven summers, before I finally carried a jar of it to the treatment works on the hill and asked the duty engineer to explain himself over a cup of tea.";

    expect(reviewOpening(importedInput("SCIENCE"), opening).issues).not.toContain(weakOpenerIssue);
    expect(reviewOpening(nonfictionInput("SCIENCE"), opening).issues).toContain(weakOpenerIssue);
  });

  it("fails a signposting category that opens on a bare welcome", () => {
    // buildPageInstruction (pagesShared.ts) forbids a welcome to every page-1
    // writer with no category exemption, so excusing one here passed the exact
    // sentence the writer had been told not to write.
    const report = reviewOpening(
      nonfictionInput("EDUCATION"),
      "Welcome to the world of home water testing. The kit on the kitchen table costs less than a takeaway meal, and it will tell you within ten minutes whether the tap you drink from carries more chlorine than the supplier's own annual report admits to."
    );
    expect(report.issues).toContain(weakOpenerIssue);
    expect(report.checks.styleNatural).toBe(false);
  });

  it("still fails the meta opener in a scholarly category", () => {
    const report = reviewOpening(
      nonfictionInput("SCIENCE"),
      "This book is about the hidden machinery of urban water, and over the coming chapters the reader will come to understand how a city drinks, stores, cleans, and loses the water it depends on every single day of the year."
    );
    expect(report.issues).toContain(weakOpenerIssue);
  });

  it("does not read quoted speech as the book's own opening", () => {
    const report = reviewOpening(
      storyInput(),
      '"Welcome to Willow Creek," said the sign, and Mira read it twice because someone had crossed out Willow and painted Frozen above it in tar. She dragged her sled past the sign and down the lane toward the mill, counting the dark windows as she went.'
    );
    expect(report.issues).not.toContain(weakOpenerIssue);
  });

  it("still reads the stock opener when the page hard-wraps inside the phrase", () => {
    // Every pattern in this file spells its gaps as literal single spaces, and
    // nothing normalised the page before matching them — so one line break
    // inside the phrase retired the single most recognisable AI opener there
    // is. `splitSentences` (`proseShape.ts`) collapses whitespace before it
    // matches for exactly this reason.
    const tail =
      " Mira had stopped wondering and started measuring, and the folding rule in her pocket was the only answer she trusted all winter long.";
    const wrapped = [
      `Have you ever\nwondered why the river stopped freezing?${tail}`,
      `Have you  ever wondered why the river stopped freezing?${tail}`
    ];

    for (const page of wrapped) {
      const report = reviewOpening(storyInput(), page);
      expect(report.issues, JSON.stringify(page.slice(0, 30))).toContain(weakOpenerIssue);
      expect(report.checks.styleNatural).toBe(false);
    }
  });

  it("still reads the meta opener and the welcome across a hard wrap", () => {
    // The meta list and the anchored welcome had the same hole, and the
    // welcome's is the one the window slice could not fix on its own: the
    // anchor is a line's first word, so the second half of "Welcome\nto" sat on
    // a line no pattern was ever matched against.
    const pages = [
      "In this book,\nwe will explore how a city drinks, stores, and loses water. The pipes under a single street carry more history than the street above them, and the meters at each end have been arguing about it for a century.",
      "Welcome\nto the world of home water testing. The kit on the kitchen table costs less than a takeaway meal, and it will tell you within ten minutes whether the tap you drink from carries more chlorine than the supplier admits to."
    ];

    for (const page of pages) {
      const report = reviewOpening(nonfictionInput("EDUCATION"), page);
      expect(report.issues, JSON.stringify(page.slice(0, 24))).toContain(weakOpenerIssue);
      expect(report.checks.styleNatural).toBe(false);
    }
  });

  it("fails open on a Persian first page, leaving other languages to the model reviewer", () => {
    const persianInput = { ...storyInput(), language: "fa" };
    const report = reviewOpening(
      persianInput,
      "آیا تا به حال فکر کرده‌اید که از دست دادن یک زمستان چه حسی دارد؟ میرا تا آن صبح به این موضوع فکر نکرده بود. رودخانهٔ پشت آسیاب یخ نمی‌بست و مادربزرگش بی‌هیچ توضیحی چمدان کوچکی بست. میرا کنار پنجره ایستاد و به آب تیره نگاه کرد. در خانه هیچ‌کس حرفی نمی‌زد و صدای چرخ آسیاب هم خاموش شده بود. او شال پشمی‌اش را برداشت و از در پشتی بیرون رفت تا خودش دلیل این سکوت را پیدا کند."
    );
    expect(report.issues).not.toContain(weakOpenerIssue);
  });
});

/**
 * What the whitespace collapse may and may not join. Collapsing the page whole
 * closed the hard-wrap hole the test above pins — and opened a wider one, since
 * `.` matches no newline without the `s` flag, so every `.{0,N}` window in this
 * file and every literal phrase table silently gained paragraph-crossing reach.
 * Keeping the blank line closed that, and left the same reach across every
 * structural break a page writes *without* one: two list items, two speakers'
 * lines, a heading and the prose under it.
 *
 * **The four tests below are the whole bound, and only the four together are.**
 * A hard wrap inside one unit of prose is one phrase broken in half and must
 * still join; a paragraph break, a list and a block of dialogue are each two
 * phrases and must still not. Each of the four fails on its own if the rule
 * moves one step in either direction — the joining pair on a rule that keeps
 * more breaks, the separating three on a rule that keeps fewer — so a fifth
 * round should read them as one fixture rather than four.
 */
describe("phrase matching across a hard wrap and across the breaks that are not one", () => {
  const vagueEndingIssue = "Final page ending is too vague to resolve the book's central promise.";
  const fabricatedResearchIssue = "Page contains invented or explicitly fabricated research evidence.";
  const ENDING_TAIL =
    " than it should have, from the kettle to the coat still on its hook by the door. Mira set two cups on the table because habit is slower to change than a house is. The frost on the window had thinned to a grey film, and the mill wheel turned once, twice, and then kept turning at the pace it had kept all her life.";

  function reviewFinalPage(markdown: string) {
    const input = storyInput();
    return reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: input.targetPages,
      draft: {
        title: "The Last Morning",
        markdown,
        summary: "Mira keeps the old morning habits in a house that has changed.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: []
    });
  }

  it("does not read a vague ending across a paragraph break", () => {
    // Two sentences a blank line apart. Flattened into one line they sit 15
    // characters apart inside `/\bnothing\b.{0,80}\beverything\b/`, with no
    // resolution word anywhere in the page to excuse them — so a finished
    // final page lost 25 points, auto-rejected, and spent a revision call.
    const report = reviewFinalPage(`She had nothing left to give.\n\nEverything about the morning felt heavier${ENDING_TAIL}`);

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
  });

  it("still reads a vague ending across a hard wrap inside one paragraph", () => {
    // The same two clauses in one paragraph, broken by the hard wrap the
    // collapse exists for: this is the half of the bound that must survive
    // narrowing the collapse, and it fails outright without any collapse.
    const report = reviewFinalPage(
      `She had nothing left to give, and\neverything about the morning felt heavier${ENDING_TAIL}`
    );

    expect(report.issues).toEqual([vagueEndingIssue]);
    expect(report.checks.progressionOk).toBe(false);
  });

  it("bounds the research window at the paragraph break and not before it", () => {
    // The same bound one pattern group over: FABRICATED_RESEARCH_PATTERNS
    // carries a `.{0,100}` window, and a chart described as invented in one
    // paragraph sat 58 characters from the word "study" in the next.
    const opening = "The first chart of the bay was invented, drawn from hearsay by a clerk who never left the port.";
    const rest =
      "A study of the same coastline in 1902 replaced it with soundings taken from a steam launch, and the two disagree by a full mile at the northern head.";
    const summary = "How the bay was charted twice, sixty years apart.";

    const acrossParagraphs = review(nonfictionInput("SCIENCE"), "The Coast in 1902", `${opening}\n\n${rest}`, summary);
    expect(acrossParagraphs.issues).not.toContain(fabricatedResearchIssue);

    const acrossAWrap = review(nonfictionInput("SCIENCE"), "The Coast in 1902", `${opening}\n${rest}`, summary);
    expect(acrossAWrap.issues).toContain(fabricatedResearchIssue);
  });

  it("does not read the research window across two list items", () => {
    // Adjacent list items carry no blank line between them, so a collapse
    // bounded only by the blank line joined them and read one bullet's
    // "invented" 66 characters from the next bullet's "Data" — 25 points and a
    // revision call for a page whose two bullets say nothing of the kind.
    const lead = "The bay was charted twice, and the second survey agreed with the first about almost nothing at all.";
    const items = [
      "- The map I invented for the frontispiece, drawn from hearsay and a ferry timetable.",
      "- Data from the 1902 soundings, taken from a steam launch at the northern head."
    ];
    const closing =
      "The two disagree by a full mile at the northern head, and the pilots kept using the older chart for another decade.";
    const summary = "How the bay was charted twice, sixty years apart.";
    const page = (joinedBy: string) => `${lead}\n\n${items.join(joinedBy)}\n\n${closing}`;

    const asAList = review(nonfictionInput("SCIENCE"), "The Coast in 1902", page("\n"), summary);
    expect(asAList.issues).not.toContain(fabricatedResearchIssue);

    // The one break between the items is the whole difference: on a single
    // line — what the flat collapse handed the pattern — the same two bullets
    // match.
    const asOneLine = review(nonfictionInput("SCIENCE"), "The Coast in 1902", page(" "), summary);
    expect(asOneLine.issues).toContain(fabricatedResearchIssue);
  });

  it("does not read a vague ending across a block of dialogue", () => {
    // A dialogue block is written one line per speaker with no blank line
    // anywhere in it, so the blank-line bound joined two mouths into one
    // sentence and read the "nothing … everything" shrug off a final page that
    // resolves in the kitchen two lines later.
    const spoken = [
      '"There is nothing left to carry," Mira said, and she meant the sled.',
      '"Everything in this house is yours now," her grandmother answered from the top of the stair.'
    ];
    const tail =
      "\n\nThey went down to the kitchen together and set the kettle on, and neither of them said another word about the sacks until the water boiled. Mira put out two cups from habit, and her grandmother let her. The frost on the window had thinned to a grey film, and the mill wheel turned once, twice, and then kept turning at the pace it had kept all her life.";

    const asDialogue = reviewFinalPage(`${spoken.join("\n")}${tail}`);
    expect(asDialogue.issues).toEqual([]);
    expect(asDialogue.approved).toBe(true);

    // Same page, same words, one break fewer: 53 characters then separate
    // "nothing" from "everything" inside `/\bnothing\b.{0,80}\beverything\b/`.
    const asOneLine = reviewFinalPage(`${spoken.join(" ")}${tail}`);
    expect(asOneLine.issues).toContain(vagueEndingIssue);
  });
});

describe("kids gates on non-Latin scripts", () => {
  it("splits Chinese sentences on full-width terminators so a normal zh kids page passes", () => {
    const report = review(
      kidsInput("zh"),
      "月亮和小狐狸",
      // Six short sentences (~23 estimated words). Splitting only on spaced
      // ASCII terminators read this as one 23-word "sentence", which no page
      // of correct zh kids prose could ever get under the sentence cap.
      "小狐狸看见了月亮。它跳上小山坡。风把叶子吹起来。狐狸对月亮眨眨眼。它数了三颗星星。今晚它睡得很香。",
      "小狐狸在山坡上看月亮，然后安睡。"
    );

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("still fails a genuine zh run-on sentence against the kids sentence cap", () => {
    const report = review(
      kidsInput("zh"),
      "月亮和小狐狸",
      "小狐狸看见了月亮然后跳上小山坡接着风把叶子吹起来它对月亮眨眨眼一直看一直看直到今晚它终于睡得很香很香。",
      "小狐狸看月亮的一整个晚上。"
    );

    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/Sentences are too long/);
  });

  it("still fails a zh page that outruns the kids word budget", () => {
    const page = "小狐狸看见了月亮。它跳上小山坡。风把叶子吹起来。狐狸对月亮眨眨眼。它数了三颗星星。今晚它睡得很香。";
    const report = review(kidsInput("zh"), "月亮和小狐狸", page.repeat(4), "小狐狸的漫长夜晚。");

    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/too long for ages/);
  });

  it("splits Japanese sentences with closing quotes riding their terminators", () => {
    const report = review(
      kidsInput("ja"),
      "きつねとうさぎのおやつ",
      "きつねはケーキを見ました。「ジュースもある！」とうさぎが言いました。ふたりはテーブルでケーキをたべました。",
      "きつねとうさぎがおやつをたべる。"
    );

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("splits Thai sentences on the spaces that are that script's sentence mark", () => {
    const report = review(
      kidsInput("th"),
      "โมจิกับชามปลา",
      "แมวน้อยชื่อโมจินอนอยู่บนเบาะ แม่ของโมจิร้องเรียกกินข้าว โมจิวิ่งลงบันไดอย่างเร็ว ชามข้าวของโมจิเต็มไปด้วยปลา โมจิกินอิ่มแล้วนอนหลับสบาย",
      "โมจิกินข้าวแล้วนอนหลับ"
    );

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("counts by code point, by Script_Extensions, and without combining marks", () => {
    // The too-short message prints the estimate, so each case pins the exact
    // arithmetic: a supplementary-plane Han character is one character, not
    // two UTF-16 units (3 chars -> 2 words, not 3); the prolonged sound mark
    // ー stays inside its katakana word instead of spilling into a leftover
    // extra word (4 chars -> 2 words, not 3); and a Thai tone mark neither
    // splits its run nor feeds the divisor (4 base chars -> 1 word, not 2).
    const cases: Array<[string, string, string]> = [
      ["zh", "𠀋𠀋𠀋", "(2 words)"],
      ["ja", "ラーメン", "(2 words)"],
      ["th", "น้ำใส", "(1 words)"]
    ];
    for (const [language, markdown, expected] of cases) {
      const report = review(kidsInput(language), "みじかいページ", markdown, "short page");
      expect(report.issues.join(" ")).toContain(expected);
    }
  });
});

describe("non-Latin local quality review", () => {
  const persianInput = persianCustomInput();
  const persianPlan = makeFallbackPlan(persianInput);
  const persianBody = [
    "خرگوش کوچولو در چمنزار سبز و نرم دراز کشیده بود و به آسمان شب نگاه می‌کرد.",
    "ستاره‌ها یکی‌یکی روشن می‌شدند و برای او چشمک می‌زدند.",
    "مادرش کنار او نشست و پتوی گرم و پشمی را روی شانه‌هایش کشید.",
    "باد ملایمی میان علف‌های بلند می‌پیچید و بوی گل‌های وحشی را با خود می‌آورد.",
    "جیرجیرک‌ها آواز آرام شبانه‌شان را از گوشه‌ی چمنزار شروع کرده بودند.",
    "خرگوش کوچولو خمیازه‌ای بلند کشید و گفت که هنوز خوابش نمی‌آید.",
    "مادرش آرام خندید و قصه‌ی قدیمی ماه و تپه‌ی نقره‌ای را برایش تعریف کرد.",
    "ماه از پشت تپه بالا آمد و نور نقره‌ای‌اش را روی تمام چمنزار پاشید.",
    "کم‌کم پلک‌های خرگوش کوچولو سنگین و سنگین‌تر شد.",
    "او در میان لالایی نسیم و عطر علف‌های تازه به خوابی شیرین رفت."
  ].join(" ");

  it("counts Persian prose as real words instead of rejecting the page as empty", () => {
    const report = reviewPageDraftLocally({
      input: persianInput,
      plan: persianPlan,
      pageIndex: 1,
      draft: {
        title: "چمنزار خواب‌آلود",
        markdown: persianBody,
        summary: "خرگوش کوچولو زیر آسمان پرستاره آماده خواب می‌شود.",
        continuityNotes: []
      },
      previousPages: [],
      continuityNotes: []
    });

    expect(report.issues.find((issue) => issue.includes("too short"))).toBeUndefined();
    expect(report.checks.progressionOk).toBe(true);
  });

  it("does not flag distinct Persian titles as duplicates of the previous page", () => {
    const report = reviewPageDraftLocally({
      input: persianInput,
      plan: persianPlan,
      pageIndex: 2,
      draft: {
        title: "ستاره‌های بیدار",
        markdown: persianBody,
        summary: "ستاره‌ها برای چمنزار آواز شبانه می‌خوانند.",
        continuityNotes: []
      },
      previousPages: [
        {
          index: 1,
          title: "چمنزار خواب‌آلود",
          markdown: "مهتاب روی رودخانه می‌درخشید و قورباغه‌ها آواز می‌خواندند و شب‌تاب‌ها می‌رقصیدند.",
          summary: "شب در کنار رودخانه آغاز می‌شود."
        }
      ],
      continuityNotes: []
    });

    expect(report.issues.find((issue) => issue.includes("title repeats"))).toBeUndefined();
    expect(report.checks.titleClean).toBe(true);
  });
});

describe("contrast formula patterns", () => {
  it("leaves the ordinary 'not only … but' correlative alone", () => {
    const report = review(
      nonfictionInput("SCIENCE"),
      "Pipes and Parishes",
      "Sanitation was not only a public-health measure; it was a political settlement. The engineers were not only builders, but they were arbiters of who got water. The pipes below Whitechapel followed property lines drawn a century earlier, and every junction recorded a negotiation between a parish board and a private company. When the two systems met at a boundary street, the pressure dropped, and residents on the wrong side carried buckets past working taps they were never entitled to open. Reformers learned to read those junctions the way surveyors read contour lines, and the maps they drew outlasted the companies themselves.",
      "Victorian water infrastructure as political settlement."
    );

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("still fires on a page built twice on the 'not just X, it's Y' formula", () => {
    const report = review(
      nonfictionInput("SCIENCE"),
      "The Harbor Ledger",
      "The market wasn't just a place to buy fish; it was the town's morning bulletin. Every stall that opened late told the regulars something, and the fishermen watched the crowd before they priced the catch. The harbor was not merely a shelter for boats. It was a ledger of every storm the town had survived, written in patched hulls and replaced planks. Visitors photographed the lighthouse, but the locals steered by the church spire behind it, the way their grandparents had, and nobody thought to write any of that down until the ferry service closed.",
      "The harbor town's working knowledge of weather and trade."
    );

    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/not just X, it's Y/);
  });
});

describe("chapter opener scaffold category guard", () => {
  it("lets an instructional book signpost what a section covers", () => {
    const report = review(
      nonfictionInput("EDUCATION"),
      "Choosing a Home Filter",
      "This section covers the three filters most home systems use. A sediment filter catches sand and rust before they reach the finer stages, and it costs the least to replace, so check it first when the flow slows. A carbon block absorbs chlorine and the compounds that make tap water taste like a swimming pool; swap it every six months in a busy kitchen. The reverse-osmosis membrane does the fine work and lasts years when the first two stages are maintained on schedule. Write the replacement dates on the housing with a marker, because the manufacturer stickers fade long before the filters do.",
      "The three standard home filter stages and their maintenance."
    );

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("still rejects agenda-announcing prose in a scholarly category", () => {
    const report = review(
      nonfictionInput("SCIENCE"),
      "How Rivers Cut Valleys",
      "In this chapter, we will explore how rivers shape the valleys they run through, and why the same water can build land in one century and carry it away in the next.",
      "The chapter's plan for river geomorphology."
    );

    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/announces what the chapter will cover/);
  });
});

describe("chapter opener scaffold against quoted speech", () => {
  function earlyReaderKidsInput() {
    const base = kidsInput("en");
    return { ...base, mediaSettings: { ...base.mediaSettings, audienceAgeRange: "6-8" as const } };
  }

  it("lets a character say the scaffold sentence out loud", () => {
    // KIDS and STORY are not on the signposting allowlist and must not be, so
    // this page — correct picture-book prose — used to flip styleNatural on
    // every draft candidate and spend the page's whole revision budget
    // rewriting dialogue that was already right.
    const report = review(
      earlyReaderKidsInput(),
      "Cloud Watching",
      [
        "The owls sat in a ring on the wide branch.",
        '"In this chapter, we will learn about clouds," said Professor Hoot.',
        "Mira laughed and pointed at the sky.",
        "A fat white cloud drifted past the moon like a slow sheep.",
        '"That one looks like my pillow," she whispered.',
        "Professor Hoot nodded and passed her the small brass telescope."
      ].join("\n"),
      "Professor Hoot opens the cloud lesson while Mira watches the sky."
    );

    expect(report.issues).toEqual([]);
    expect(report.approved).toBe(true);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("reads the quotation marks of every convention the product ships books in", () => {
    // Guillemets are the Persian and Arabic convention, corner brackets the
    // CJK one, and a model writes curly quotes into an English page as often
    // as straight ones. A convention left unread fails a correct page.
    const conventions: Array<[string, string]> = [
      ['"', '"'],
      ["“", "”"],
      ["«", "»"],
      ["‘", "’"],
      ["「", "」"]
    ];

    for (const [open, close] of conventions) {
      const report = review(
        storyInput(),
        "The Frozen Mill",
        [
          "Mira sat on the cold step and watched the sky above the mill wheel.",
          `${open}In this chapter, we will learn why the river freezes,${close} said Grandmother, tapping the glass with one knuckle.`,
          "The reeds along the bank stood stiff as fence posts, and the water under the ice moved without a sound.",
          "Mira counted to twenty before she answered, because that was how long it took to get an answer right.",
          "Then she pulled her boots on and went down the towpath to see the grey pane of ice for herself."
        ].join("\n"),
        "Mira goes down to the frozen river after her grandmother speaks."
      );

      expect(report.issues, `${open}…${close}`).toEqual([]);
      expect(report.checks.styleNatural).toBe(true);
    }
  });

  it("reads a dash-led line as the dialogue those typographies write", () => {
    const report = review(
      storyInput(),
      "The Frozen Mill",
      [
        "Mira sat on the cold step and watched the sky above the mill wheel.",
        "— In this chapter, we will learn why the river freezes — said Grandmother, tapping the glass.",
        "The reeds along the bank stood stiff as fence posts, and the water under the ice moved without a sound.",
        "Mira counted to twenty before she answered, because that was how long it took to get an answer right.",
        "Then she pulled her boots on and went down the towpath to see the grey pane of ice for herself."
      ].join("\n"),
      "Mira goes down to the frozen river after her grandmother speaks."
    );

    expect(report.issues).toEqual([]);
    expect(report.checks.styleNatural).toBe(true);
  });

  it("still fails a narrative page whose own narration announces the chapter", () => {
    const report = review(
      storyInput(),
      "The Frozen Mill",
      [
        "In this chapter, we will follow Mira down to the frozen river and learn why the ice broke apart in March.",
        '"Stay where I can see you," her brother called from the bank, and she waved without turning around.',
        "The river had gone quiet under its white lid, and the reeds along the edge stood stiff as fence posts.",
        "By the mill the ice thinned to a grey pane, and beneath it the water moved fast enough to pull a sledge under."
      ].join("\n"),
      "Mira walks down to the frozen river in March."
    );

    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/announces what the chapter will cover/);
  });

  it("still fails the forward-looking twin at the foot of the page", () => {
    // Voice is what the check reads, not position: the scan covers the whole
    // body, so the closing half of the scaffold pair is still caught where it
    // actually appears — the page's last line.
    const report = review(
      nonfictionInput("SCIENCE"),
      "The Weir at Ashford",
      [
        "The gauge above the weir has recorded the river's height every morning since 1904, and the ledgers survive unbroken.",
        "Two floods stand out in them, both in Februarys when the ground upstream was already frozen and could hold no more rain.",
        "The parish paid a keeper to walk the bank at dawn, and his marginal notes are often better evidence than the readings themselves.",
        "In the following pages, we will trace those measurements upstream to the reservoirs that were cut into the moor after the second flood."
      ].join("\n"),
      "The weir ledgers and the two February floods they record."
    );

    expect(report.checks.styleNatural).toBe(false);
    expect(report.issues.join(" ")).toMatch(/announces what the chapter will cover/);
  });
});

describe("prompt leak in the book's own language", () => {
  it("flags the Persian model apology written with the ZWNJ Persian uses", () => {
    // «به‌عنوان» is one word joined by U+200C, which `\s` does not match, so
    // the standard spelling of the phrase this check exists for used to reach
    // the reader while the spaced spelling was caught.
    const report = review(
      { ...nonfictionInput("SCIENCE"), language: "fa" },
      "روباه و باغ",
      "به‌عنوان یک مدل زبانی، نمی‌توانم داستان کامل را بنویسم، اما روباه هر روز صبح کنار باغ می‌نشست.",
      "روباه کنار باغ می‌نشیند."
    );

    expect(report.checks.promptLeakFree).toBe(false);
  });

  it("flags the Arabic model apology whichever way its tanween is encoded", () => {
    const report = review(
      { ...nonfictionInput("SCIENCE"), language: "ar" },
      "الثعلب والحديقة",
      "بصفتي نموذجًا لغويًا، لا أستطيع كتابة القصة كاملة، لكن الثعلب كان يجلس كل صباح بجانب الحديقة.",
      "الثعلب يجلس بجانب الحديقة."
    );

    expect(report.checks.promptLeakFree).toBe(false);
  });

  it("leaves ordinary Persian prose that says «به عنوان» alone", () => {
    // The two commonest words in any Persian book: the tail is what makes the
    // phrase a leak, never the preposition.
    const report = review(
      { ...nonfictionInput("SCIENCE"), language: "fa" },
      "نویسنده و باغ",
      "او به‌عنوان یک نویسنده شناخته می‌شد و به عنوان مثال هر روز صبح کنار باغ می‌نشست و می‌نوشت. مدل‌های زبانی بزرگ در فصل بعد معرفی می‌شوند.",
      "نویسنده هر روز کنار باغ می‌نویسد."
    );

    expect(report.checks.promptLeakFree).toBe(true);
  });
});
