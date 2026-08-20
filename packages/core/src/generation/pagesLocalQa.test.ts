import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";

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
