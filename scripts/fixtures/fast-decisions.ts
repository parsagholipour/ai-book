import { COVER_DESIGNS } from "../../packages/core/src/generation/coverDesigns.js";
import type { DecisionRequest } from "../../packages/core/src/adapters/decisions.js";

export const decisionFixtures: { id: string; language: string; request: DecisionRequest }[] = [
  {
    id: "opening-en", language: "en", request: {
      purpose: "judge-page-drafts", context: "Opening page of a mystery. Brief: the bookkeeper finds a missing payment in the ledger and decides to visit the lighthouse.",
      instructions: "Choose the draft with the strongest hook, concrete forward progression and faithfulness to the brief. Prefer specific natural prose over generic summary.",
      options: [
        { id: "a", description: "In a world full of secrets, Mara embarked on a journey that would change everything. The ledger was more than a book. It was a testament to the power of truth." },
        { id: "b", description: "The lighthouse keeper had been paid twice on the day he drowned. Mara checked the ledger against the bank slip, folded the slip into her coat, and took the last bus to the headland." }
      ]
    }
  },
  {
    id: "opening-fa", language: "fa", request: {
      purpose: "judge-page-drafts", context: "صفحهٔ آغاز یک داستان معمایی. ناهید در دفتر حساب پرداختی مشکوک پیدا می‌کند و تصمیم می‌گیرد به فانوس دریایی برود.",
      instructions: "پیش‌نویسی را انتخاب کن که شروع گیراتر، جزئیات روشن‌تر و پیشرفت واقعی داستان دارد. از عبارت‌های کلی و نثر قالبی دوری کن.",
      options: [
        { id: "a", description: "ناهید رسید را دوباره خواند. حقوق نگهبان فانوس سه روز پس از مرگش پرداخت شده بود. دفتر را بست، رسید را در جیب گذاشت و پیش از حرکت آخرین اتوبوس از خانه بیرون زد." },
        { id: "b", description: "در دنیای پر از راز، ناهید قدم در سفری شگفت‌انگیز گذاشت. او می‌دانست که زندگی پر از چالش و فرصت است و حقیقت روزی آشکار خواهد شد." }
      ]
    }
  },
  {
    id: "chapter-en", language: "en", request: {
      purpose: "judge-chapter-drafts", context: "Two chapter excerpts about opening a community workshop. Judge craft, not topic or length.",
      instructions: "Choose the chapter a demanding reader would keep reading: varied paragraph rhythm, sentences that commit, forward movement, distinct endings. Never tie.",
      options: [
        { id: "A", description: "The first repair was a kettle with a broken switch. Luis set out three screwdrivers and asked the owner to stay. By noon she had repaired the switch herself and was teaching a stranger how to test a fuse.\n\nNobody left at closing time.\n\nThey moved the table under the streetlamp and finished the bicycle there." },
        { id: "B", description: "Community workshops are important because they build community. While they offer opportunities, challenges remain. The balance between opportunity and challenge is crucial.\n\nIn conclusion, workshops remind us that community matters, even as we navigate the complexities of cooperation." }
      ]
    }
  },
  {
    id: "chapter-fa", language: "fa", request: {
      purpose: "judge-chapter-drafts", context: "دو بخش از فصلی دربارهٔ راه‌اندازی تعمیرگاه محلی. موضوع و طول متن ملاک نیست.",
      instructions: "براساس تنوع آهنگ بندها، قاطعیت جمله‌ها، حرکت رو به جلو و پایان‌های متنوع، یکی را انتخاب کن. نتیجه نباید مساوی باشد.",
      options: [
        { id: "A", description: "همکاری محلی نقش بسیار مهمی دارد. اگرچه فرصت‌های زیادی وجود دارد، چالش‌ها هم کم نیستند. در نهایت باید میان فرصت و چالش تعادل برقرار کرد. این نکته نشان می‌دهد که همکاری اهمیت فراوانی دارد." },
        { id: "B", description: "اولین مشتری یک کتری آورد. لیلا سه پیچ‌گوشتی روی میز چید و از او خواست بماند. ظهر، زن کلید کتری را عوض کرده بود و به پسر همسایه یاد می‌داد فیوز را امتحان کند.\n\nوقت تعطیلی کسی نرفت.\n\nمیز را زیر چراغ کوچه بردند و تعمیر دوچرخه را همان‌جا تمام کردند." }
      ]
    }
  },
  ...["en", "fa"].map((language) => ({
    id: `cover-${language}`, language, request: {
      purpose: "select-cover-design",
      context: language === "fa" ? "عنوان: دفتر فانوس. داستان کارآگاهی در جزیره‌ای بارانی، برای بزرگسالان." : "Title: The Lighthouse Ledger. An adult detective mystery on a rainy island.",
      instructions: "Choose the catalog artwork that best fits the subject, genre and mood. Ignore typography.",
      options: COVER_DESIGNS.map((design) => ({ id: design.id, description: `${design.name}: ${design.description} (${design.tags.join(", ")})` }))
    }
  }))
];
