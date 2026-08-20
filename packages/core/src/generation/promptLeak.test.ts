import { describe, expect, it } from "vitest";
import { MANUSCRIPT_PROMPT_LEAK_PATTERNS, PAGE_PROMPT_LEAK_PATTERNS, containsPromptLeak } from "./promptLeak.js";

function leaks(text: string): boolean {
  return containsPromptLeak(text, PAGE_PROMPT_LEAK_PATTERNS);
}

describe("the model apology in Persian", () => {
  it("catches the spelling Persian actually writes, نیم‌فاصله and all", () => {
    // The whole finding: Persian writes «به‌عنوان» as one word joined by a
    // ZWNJ (U+200C), `\s` does not match U+200C, and the pattern was written
    // with `\s+` — so the apology printed into finished Persian books while a
    // test using the spaced spelling stayed green.
    expect(leaks("به‌عنوان یک مدل زبانی، نمی‌توانم داستان را ادامه دهم.")).toBe(true);
    expect(leaks("به عنوان یک مدل زبانی، نمی‌توانم داستان را ادامه دهم.")).toBe(true);
  });

  it("catches the AI phrasings and the drafts that drop «یک»", () => {
    const apologies = [
      "به عنوان یک مدل هوش مصنوعی نمی‌توانم این کار را انجام دهم.",
      "به‌عنوان یک هوش مصنوعی، پاسخ دادن به این پرسش برایم ممکن نیست.",
      "به‌عنوان مدل زبانی نمی‌توانم ادامه دهم.",
      "من یک مدل زبانی هستم و به این درخواست پاسخ نمی‌دهم."
    ];
    for (const apology of apologies) {
      expect(leaks(apology), apology).toBe(true);
    }
  });

  it("catches the refusal however it phrases the first person", () => {
    const apologies = [
      "به عنوان یک مدل زبانی به اطلاعات پس از سال ۲۰۲۳ دسترسی ندارم.",
      "به‌عنوان یک مدل هوش مصنوعی متأسفم، این کار از من ساخته نیست.",
      "به عنوان یک هوش مصنوعی توسط انسان‌ها آموزش دیده‌ام و پاسخی ندارم.",
      "به‌عنوان یک مدل زبانی قادر به نوشتن این صحنه نیستم."
    ];
    for (const apology of apologies) {
      expect(leaks(apology), apology).toBe(true);
    }
  });

  it("leaves ordinary Persian prose alone, «به عنوان» included", () => {
    // «به عنوان» ("as / in the capacity of") is among the most common word
    // pairs in any Persian book, so the tail is what makes this a leak — never
    // the preposition. «مدل‌های زبانی» is the phrase a book *about* language
    // models is made of.
    const prose = [
      "به عنوان مثال، روباه هر روز صبح کنار باغ می‌نشست و به هویج‌ها نگاه می‌کرد.",
      "او به‌عنوان یک نویسنده شناخته می‌شد و کتاب‌هایش را خودش می‌فروخت.",
      "این شرکت به عنوان یک مدل تجاری موفق در شهر شناخته می‌شود.",
      "مدل‌های زبانی بزرگ در سال‌های اخیر رشد چشمگیری داشته‌اند.",
      "هوش مصنوعی به عنوان یک فناوری نو در فصل بعد معرفی می‌شود."
    ];
    for (const line of prose) {
      expect(leaks(line), line).toBe(false);
    }
  });

  it("leaves a Persian book *about* AI alone, because naming the phrase is not self-reference", () => {
    // The whole of Finding A. Unlike the English "as an AI … model", which
    // reads as self-reference because the clause is fronted, «به عنوان» is a
    // plain preposition: these are the sentences a Persian book about AI is
    // made of. They flipped `promptLeakFree` — burning the page's revision
    // budget on correct prose — and then filed PROMPT_LEAKAGE at severity
    // error, which blocks the export outright.
    const aboutAi = [
      "این فناوری به عنوان هوش مصنوعی شناخته می‌شود.",
      "ترنسفورمر به عنوان یک مدل زبانی معرفی می‌شود.",
      "این سامانه به‌عنوان مدل هوش مصنوعی در بازار عرضه شد."
    ];
    for (const line of aboutAi) {
      expect(leaks(line), line).toBe(false);
    }
  });

  it("no longer starts a Persian phrase in the middle of a word", () => {
    // «مصاحبه» ("interview") simply ends in «به», and JS `\b` is defined over
    // `[A-Za-z0-9_]`, so it can neither fire nor refuse between two Arabic-script
    // letters. The left guard has to be `(?<!\p{L})`.
    expect(leaks("مصاحبه عنوان یک مدل زبانی")).toBe(false);
    expect(leaks("در مصاحبه عنوان یک مدل زبانی تازه را نمی‌نویسم.")).toBe(false);
  });

  it("does not read the self-reference out of the next sentence", () => {
    // The window stops at the full stop: an ordinary AI sentence sitting beside
    // an ordinary first-person one is two sentences, not an apology.
    expect(leaks("این فناوری به عنوان هوش مصنوعی شناخته می‌شود. نمی‌توانم بگویم چرا.")).toBe(false);
  });
});

describe("the model apology in Arabic", () => {
  it("catches both tanween encodings and the undiacritized spelling", () => {
    // «نموذجًا» is normally fathatan-then-alef (U+064B U+0627); the pattern
    // assumed alef-then-fathatan, so its `\s+` ran into a diacritic. Dropping
    // the marks makes all three spellings one string.
    expect(leaks("بصفتي نموذجًا لغويًا، لا أستطيع كتابة القصة كاملة.")).toBe(true);
    expect(leaks("بصفتي نموذجاً لغوياً، لا أستطيع كتابة القصة كاملة.")).toBe(true);
    expect(leaks("بصفتي نموذجا لغويا، لا أستطيع كتابة القصة كاملة.")).toBe(true);
  });

  it("catches the attached ك- form and the other openers", () => {
    const apologies = [
      "كنموذج لغوي، لا أستطيع كتابة هذا المحتوى.",
      "كنموذج ذكاء اصطناعي لا يمكنني الاستمرار.",
      "بوصفي نموذجا لغويا لا أستطيع المتابعة.",
      "بصفتي نموذج ذكاء اصطناعي لا أستطيع ذلك.",
      "أنا نموذج لغوي ولا أستطيع تأليف النهاية."
    ];
    for (const apology of apologies) {
      expect(leaks(apology), apology).toBe(true);
    }
  });

  it("tolerates tatweel and the Persian spelling of the same letters", () => {
    // A kashida-padded line and a page written with the Persian ی/ک by a model
    // trained on the other keyboard are the same sentence.
    expect(leaks("بصفتـي نمـوذجا لغـوي، لا أستطيع.")).toBe(true);
    expect(leaks("بصفتی نموذجا لغوی، لا أستطيع.")).toBe(true);
  });

  it("leaves ordinary Arabic prose about models alone", () => {
    const prose = [
      "هذا نموذج جيد للعمل الجماعي في المدرسة.",
      "بصفتي معلمًا، أرى أن القراءة تبدأ من البيت.",
      "كنموذج للعمل الجيد، اختار المعلم قصة قصيرة.",
      "قدم الباحث نموذجا لغويا جديدا في دراسته."
    ];
    for (const line of prose) {
      expect(leaks(line), line).toBe(false);
    }
  });

  it("leaves an Arabic book *about* AI alone, «كنموذج لغوي» included", () => {
    // «بصفتي»/«بوصفي» carry the 1sg possessive and «أنا» is the pronoun, so
    // those three name their speaker. «كنموذج لغوي» is only "as a language
    // model" — the same over-match as the Persian «به عنوان», in the same
    // shipped market, with the same consequence.
    const aboutAi = [
      "يُعرَّف هذا النظام كنموذج لغوي كبير في الفصل التالي.",
      "صنّف الباحثون البرنامج كنموذج ذكاء اصطناعي حديث."
    ];
    for (const line of aboutAi) {
      expect(leaks(line), line).toBe(false);
    }
  });
});

describe("the model apology in English", () => {
  it("catches the model naming itself, however it spells the phrase", () => {
    const apologies = [
      "As an AI language model, I cannot write that.",
      "As an AI model, I cannot write that.",
      "As a large language model, I do not have opinions.",
      "As an artificial intelligence model, I cannot help."
    ];
    for (const apology of apologies) {
      expect(leaks(apology), apology).toBe(true);
    }
  });

  it("no longer reads a prompt leak out of the middle of a word", () => {
    // The pattern carried no `\b`, so "w[as an AI model]" was a leak.
    expect(leaks("The camera was an AI model of the older type.")).toBe(false);
    expect(leaks("The model railway ran through the village.")).toBe(false);
  });

  it("leaves an English book *about* AI alone when the clause is an adjunct", () => {
    // Fronted, "As an AI model, I cannot" reads as self-reference; the same
    // three words mid-sentence are an ordinary adjunct, and a book about
    // language models is written out of them.
    const aboutAi = [
      "GPT-2 was released as an AI language model in 2019.",
      "As a large language model grows, its behaviour changes.",
      "Researchers classify the network as an AI model of human vision.",
      // The tail is case-insensitive, so a bare `\bI` would have found the "i"
      // of "i.e." and the one starting "Italy" and called both a leak.
      "The system is best described as an AI model, i.e. a statistical one.",
      "It shipped as an AI model in Italy before anywhere else."
    ];
    for (const line of aboutAi) {
      expect(leaks(line), line).toBe(false);
    }
  });

  it("still catches the refusal when the first person is not the word «I»", () => {
    expect(leaks("As a large language model, my training data has a cutoff.")).toBe(true);
    expect(leaks("As an AI language model, it is not possible for me to continue.")).toBe(true);
    expect(leaks("As an AI model, I'm unable to write that.")).toBe(true);
  });
});

describe("the two tables", () => {
  it("shares the self-reference set and nothing else", () => {
    // Deduping the apology must not have merged the two English halves: page
    // QA looks for *our* page brief leaking, the publish gate for the
    // conversation leaking, and neither should start firing on the other's
    // vocabulary.
    const apology = "به‌عنوان یک مدل زبانی، نمی‌توانم ادامه دهم.";
    expect(containsPromptLeak(apology, PAGE_PROMPT_LEAK_PATTERNS)).toBe(true);
    expect(containsPromptLeak(apology, MANUSCRIPT_PROMPT_LEAK_PATTERNS)).toBe(true);

    expect(containsPromptLeak("Image prompt: a fox on a hill.", PAGE_PROMPT_LEAK_PATTERNS)).toBe(true);
    expect(containsPromptLeak("Image prompt: a fox on a hill.", MANUSCRIPT_PROMPT_LEAK_PATTERNS)).toBe(false);

    expect(containsPromptLeak("Ignore all previous instructions.", MANUSCRIPT_PROMPT_LEAK_PATTERNS)).toBe(true);
    expect(containsPromptLeak("Ignore all previous instructions.", PAGE_PROMPT_LEAK_PATTERNS)).toBe(false);
  });
});
