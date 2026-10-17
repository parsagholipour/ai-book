import type { BookMatterChatField } from "@book-maker/core";
import { chatCopy, fillChatCopy, type ChatCopyTable } from "../chatReplyCopy.js";
import type { MatterChatLanguage } from "./bookMatterChatLanguage.js";

type Fields = readonly [string, string, string, string, string, string, string, string];
export type MatterChatNotice =
  | "done" | "unchanged" | "removed" | "already" | "absent" | "queued" | "next" | "free" | "coverNew" | "coverOld"
  | "failed" | "notFound" | "titleKept" | "titleChange" | "studio" | "separate" | "separateQuoted" | "unclear" | "sendOne"
  | "notMatter" | "copyrightAddRights" | "copyrightRemoveRights" | "tooLong" | "shorter" | "shorterOrSheet"
  | "invalidIsbn" | "isbnRefused" | "isbnOrSheet" | "askIsbn" | "notGiven" | "notGivenValue" | "askText" | "askValue"
  | "runsOn" | "askField" | "busy" | "restricted" | "prints" | "notPrinted" | "needsHolder" | "websiteNeedsBio";
type MatterChatCopy = {
  /** What each field is called in a sentence, in `FIELD_INDEX` order. */
  fields: Fields;
  /** Joins the names of several fields the screen refused. */
  fieldSeparator: string;
  /**
   * How a confirmation names what each field now prints. English phrases each
   * field in its own words ("the dedication now reads …"); the others list
   * `field: “value”`. The sentences around the list are `messages` either way.
   */
  changeGrammar: "english" | "listed";
  messages: Record<MatterChatNotice, string>;
};

/**
 * Every fixed sentence a `book_matter` reply is made of, in every conversation
 * language (`localizedMatterChatReplies` composes them). Values and quotes are
 * interpolated only after a template is chosen, so a reader's "{field}" prints
 * as typed. `{reason}` is the one placeholder only English fills: it is core's
 * content-screen sentence or the matter write's own (`BookMatterRefusal`), both
 * English prose, so the other languages say the same thing in their own words.
 * Example commands ("rename the book to …") are translated: the chat reads any
 * language, and only the busy reply's “apply it” has to stay literal.
 */
export const MATTER_CHAT_COPY: ChatCopyTable<MatterChatCopy> = {
  en: {
    fields: ["author name", "dedication", "About the Author text", "website", "copyright holder", "publisher", "ISBN", "“All rights reserved” line"],
    fieldSeparator: " and ", changeGrammar: "english",
    messages: {
      done: "Done", unchanged: "Nothing changed", removed: "the {field} is gone", already: "the {field} already reads {value}", absent: "this book has no {field} to take out",
      queued: "I’m refreshing the exports.", next: "It’ll be printed when the book is put together.", free: "This one’s free.", coverNew: "The cover gets the new name too.", coverOld: "The cover keeps the name it was drawn with.",
      failed: "Sorry, I couldn’t make that change right now. Please try again in a moment, or open the book’s Title & credits to change it yourself.", notFound: "I couldn’t find this book.",
      titleKept: "Every book keeps its title page — it’s where the title and the author name are printed.", titleChange: "I can change what it says, though: just tell me the author name it should show, or say “rename the book to …” for a new title.",
      studio: "This book’s author name and dedication are set in the Writing Studio’s book settings — change them there, and they reach the book when you update it.",
      separate: "Anything else in your message is a separate change — if you send it as its own message, I’ll gladly take care of it.", separateQuoted: "{request} is a separate change — if you send it as its own message, I’ll gladly take care of it.",
      unclear: "Sorry, I still couldn’t tell what to print there.", sendOne: "If you send it in one message — for example “Add a dedication: For my mom” or “The ISBN is 978…” — I’ll print it right away, or you can open the book’s Title & credits to type it in yourself.",
      notMatter: "Sorry, I couldn’t tell what you’d like changed on the title and credits pages. I can update the author name, the dedication, the About the Author page, the website, the copyright holder, the publisher, the ISBN or the “All rights reserved” line — just let me know which, and what it should say.",
      copyrightAddRights: "The © line prints whenever the book has an author name or a copyright holder, so it can’t come off on its own. I can change whose name is on it, or add “All rights reserved” under it.",
      copyrightRemoveRights: "The © line prints whenever the book has an author name or a copyright holder, so it can’t come off on its own. I can change whose name is on it, or take “All rights reserved” off it.",
      tooLong: "The {field} can be up to {limit} characters, and that one is {length}.", shorter: "Could you send a shorter one? I’ll print it right away.", shorterOrSheet: "If you send a shorter one in one message, I’ll print it right away, or you can open the book’s Title & credits to type it in yourself.",
      invalidIsbn: "That doesn’t look like a valid ISBN — an ISBN has 10 or 13 digits, and its last digit checks the rest.", isbnRefused: "{reason}",
      isbnOrSheet: "If you double-check it and send it in one message — “The ISBN is 978…” — I’ll print it right away, or you can open the book’s Title & credits to type it in yourself.", askIsbn: "What’s the ISBN exactly as it should print?",
      notGiven: "So that nothing on your book is made up, I only use details you’ve shared, and that {field} needed one I don’t have yet.", notGivenValue: "I couldn’t find the {field} in your message, and I’d rather not guess it.",
      askText: "What would you like it to say, exactly?", askValue: "Could you tell me exactly how it should print?",
      runsOn: "Part of what I’d have printed as the {field} was your other request, so I left the {field} as it was.", askField: "What should the {field} say, on its own?",
      busy: "{reason}", restricted: "Sorry, I can’t print that {field}. {reason}",
      prints: "“All rights reserved.” now prints under the copyright line", notPrinted: "“All rights reserved.” no longer prints", needsHolder: "“All rights reserved.” will print once the book has an author name or a copyright holder",
      websiteNeedsBio: "The saved website will appear on About the Author once you add a biography."
    }
  },
  ar: {
    fields: ["اسم المؤلف", "الإهداء", "عن المؤلف", "الموقع الإلكتروني", "صاحب حقوق النشر", "الناشر", "ISBN", "عبارة جميع الحقوق محفوظة"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "تم", unchanged: "لم يتغير شيء", removed: "تم حذف {field}", already: "{field} هو بالفعل {value}", absent: "لا يحتوي هذا الكتاب على {field}",
      queued: "أحدّث ملفات التصدير.", next: "سيُطبع عند إعداد الكتاب.", free: "هذا التغيير مجاني.", coverNew: "سيظهر الاسم الجديد على الغلاف أيضًا.", coverOld: "سيحتفظ الغلاف بالاسم السابق.",
      failed: "تعذر إجراء التغيير الآن. حاول لاحقًا أو افتح Title & credits في الكتاب.", notFound: "لم أجد هذا الكتاب.",
      titleKept: "يحتفظ كل كتاب بصفحة العنوان؛ يُطبع فيها العنوان واسم المؤلف.", titleChange: "يمكنني تغيير ما تعرضه: أخبرني باسم المؤلف الذي يجب أن يظهر عليها، أو قل «غيّر اسم الكتاب إلى …» لعنوان جديد.",
      studio: "يُضبط اسم المؤلف والإهداء في إعدادات Writing Studio لهذا الكتاب. عدّلهما هناك ثم حدّث الكتاب.",
      separate: "هذا تغيير منفصل؛ أرسله في رسالة مستقلة وسأنفذه.", separateQuoted: "{request}: هذا تغيير منفصل؛ أرسله في رسالة مستقلة وسأنفذه.",
      unclear: "ما زلت لم أتمكن من معرفة ما يجب طباعته هناك.", sendOne: "أرسله في رسالة واحدة، مثل «أضف إهداء: إلى أمي» أو «رقم ISBN هو 978…»، أو افتح Title & credits في الكتاب لتكتبه بنفسك.",
      notMatter: "لم أجد في ذلك تغييرًا لعنوان الكتاب وبياناته. يمكنني تغيير اسم المؤلف أو الإهداء أو صفحة عن المؤلف أو الموقع الإلكتروني أو صاحب حقوق النشر أو الناشر أو رقم ISBN أو عبارة «جميع الحقوق محفوظة»؛ أخبرني أيها، وماذا يجب أن يقول.",
      copyrightAddRights: "يُطبع سطر © كلما كان للكتاب اسم مؤلف أو صاحب حقوق نشر، لذا لا يُحذف وحده. يمكنني تغيير الاسم الذي يحمله، أو إضافة «جميع الحقوق محفوظة» تحته.",
      copyrightRemoveRights: "يُطبع سطر © كلما كان للكتاب اسم مؤلف أو صاحب حقوق نشر، لذا لا يُحذف وحده. يمكنني تغيير الاسم الذي يحمله، أو إزالة «جميع الحقوق محفوظة» منه.",
      tooLong: "الحد الأقصى لـ{field} هو {limit} حرفًا؛ النص الحالي {length} حرفًا.", shorter: "أرسل نصًا أقصر.", shorterOrSheet: "أرسل نصًا أقصر في رسالة واحدة، أو افتح Title & credits في الكتاب لتكتبه بنفسك.",
      invalidIsbn: "رقم ISBN غير صالح؛ يجب أن يتضمن 10 أو 13 رقمًا ورقم تحقق صحيحًا.", isbnRefused: "رقم ISBN غير صالح؛ يجب أن يتضمن 10 أو 13 رقمًا ورقم تحقق صحيحًا.",
      isbnOrSheet: "تحقق منه وأرسله في رسالة واحدة: «رقم ISBN هو 978…»، أو افتح Title & credits في الكتاب لتكتبه بنفسك.", askIsbn: "ما رقم ISBN تمامًا كما يجب أن يُطبع؟",
      notGiven: "أطبع في {field} المعلومات التي قدمتها فقط؛ يتضمن النص معلومات لم ترسلها.", notGivenValue: "أطبع فقط ما تخبرني به، ولم أجد {field} في رسالتك.",
      askText: "ما النص الذي يجب طباعته بالضبط؟", askValue: "ماذا يجب أن يكون، تمامًا كما يجب أن يُطبع؟",
      runsOn: "تضمن نص {field} طلبك الآخر، لذلك أبقيته كما هو.", askField: "ماذا يجب أن يكون نص {field} وحده؟",
      busy: "يجري تحديث الكتاب أو إعداده. حاول مرة أخرى بعد قليل.", restricted: "لا يمكنني طباعة هذا النص في {field}.",
      prints: "تُطبع {field}", notPrinted: "لا تُطبع {field}", needsHolder: "ستُطبع {field} عند تحديد اسم المؤلف أو صاحب الحقوق",
      websiteNeedsBio: "تم حفظ الموقع، وسيظهر في قسم نبذة عن المؤلف بعد إضافة السيرة الذاتية."
    }
  },
  zh: {
    fields: ["作者姓名", "献辞", "关于作者", "网站", "版权所有者", "出版方", "ISBN", "保留所有权利声明"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "已完成", unchanged: "没有变化", removed: "已删除{field}", already: "{field}已经是{value}", absent: "本书没有{field}",
      queued: "正在更新导出文件。", next: "将在制作图书时印入。", free: "此更改免费。", coverNew: "封面也会使用新姓名。", coverOld: "封面保留原来的姓名。",
      failed: "现在无法完成更改。请稍后重试，或打开图书的 Title & credits。", notFound: "找不到这本书。",
      titleKept: "每本书都会保留扉页，上面印有书名和作者姓名。", titleChange: "可以更改上面的内容：请告诉我要显示的作者姓名，或者说“把书名改成……”来设置新书名。",
      studio: "本书的作者姓名和献辞在 Writing Studio 设置中修改；修改后请更新图书。",
      separate: "这是另一项更改；请单独发送一条消息，我会处理。", separateQuoted: "{request}: 这是另一项更改；请单独发送一条消息，我会处理。",
      unclear: "我仍然无法确定那里要印什么。", sendOne: "请在一条消息中发送，例如“添加献辞：献给我的妈妈”或“ISBN 是 978……”，或打开图书的 Title & credits 自己输入。",
      notMatter: "这条消息中未找到对书名和出版信息的更改。我可以更改作者姓名、献辞、“关于作者”页面、网站、版权所有者、出版方、ISBN 或“保留所有权利”声明；请说明要改哪一项，以及应写成什么。",
      copyrightAddRights: "只要图书有作者姓名或版权所有者，就会印出 © 行，因此不能单独删除。我可以更改上面的姓名，或在其下方加上“保留所有权利”声明。",
      copyrightRemoveRights: "只要图书有作者姓名或版权所有者，就会印出 © 行，因此不能单独删除。我可以更改上面的姓名，或去掉其下方的“保留所有权利”声明。",
      tooLong: "{field}最多可有{limit}个字符；当前文本有{length}个字符。", shorter: "请发送更短的文字。", shorterOrSheet: "请在一条消息中发送更短的文字，或打开图书的 Title & credits 自己输入。",
      invalidIsbn: "ISBN 无效；需要 10 或 13 位数字及正确的校验位。", isbnRefused: "ISBN 无效；需要 10 或 13 位数字及正确的校验位。",
      isbnOrSheet: "请核对后在一条消息中发送，例如“ISBN 是 978……”，或打开图书的 Title & credits 自己输入。", askIsbn: "要按原样印出的 ISBN 具体是什么？",
      notGiven: "{field}只使用你提供的信息；这段文字包含未提供的信息。", notGivenValue: "我只会印出你告诉我的内容，但在你的消息中没有找到{field}。",
      askText: "具体要印什么文字？", askValue: "要按原样印出的内容具体是什么？",
      runsOn: "{field}的文字包含另一项请求，因此保持原样。", askField: "{field}本身应该写什么？",
      busy: "图书正在更新或制作。请稍后重试。", restricted: "无法将这段文字印入{field}。",
      prints: "会印出{field}", notPrinted: "不会印出{field}", needsHolder: "设置作者姓名或版权所有者后会印出{field}",
      websiteNeedsBio: "网站已保存。添加作者简介后，网站会显示在作者介绍中。"
    }
  },
  da: {
    fields: ["forfatternavn", "dedikation", "om forfatteren", "websted", "ophavsretsindehaver", "forlag", "ISBN", "linjen Alle rettigheder forbeholdes"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Færdig", unchanged: "Intet blev ændret", removed: "{field} er fjernet", already: "{field} er allerede {value}", absent: "Denne bog har ikke {field}",
      queued: "Jeg opdaterer eksportfilerne.", next: "Det trykkes, når bogen bliver lavet.", free: "Denne ændring er gratis.", coverNew: "Det nye navn kommer også på omslaget.", coverOld: "Omslaget beholder det gamle navn.",
      failed: "Jeg kunne ikke foretage ændringen nu. Prøv igen senere, eller åbn bogens Title & credits.", notFound: "Jeg kunne ikke finde denne bog.",
      titleKept: "Alle bøger beholder titelbladet, hvor titel og forfatternavn trykkes.", titleChange: "Jeg kan ændre, hvad der står på det: fortæl, hvilket forfatternavn det skal vise, eller sig ‘omdøb bogen til …’ for at få en ny titel.",
      studio: "Denne bogs forfatternavn og dedikation styres i Writing Studio. Ret dem der, og opdater bogen.",
      separate: "Det er en separat ændring. Send den i en separat besked, så klarer jeg den.", separateQuoted: "{request}: Det er en separat ændring. Send den i en separat besked, så klarer jeg den.",
      unclear: "Jeg kunne stadig ikke se, hvad der skal trykkes der.", sendOne: "Send den ønskede tekst i én besked — fx ‘Tilføj en dedikation: Til min mor’ eller ‘ISBN er 978…’ — eller åbn bogens Title & credits, og skriv den selv.",
      notMatter: "Jeg fandt ingen ændring af bogens titeloplysninger i den besked. Jeg kan ændre forfatternavnet, dedikationen, siden ‘Om forfatteren’, webstedet, ophavsretsindehaveren, forlaget, ISBN eller linjen ‘Alle rettigheder forbeholdes’ — fortæl, hvilken af dem, og hvad der skal stå.",
      copyrightAddRights: "Linjen med © trykkes, når bogen har et forfatternavn eller en ophavsretsindehaver, så den kan ikke fjernes alene. Jeg kan ændre, hvis navn der står på den, eller tilføje ‘Alle rettigheder forbeholdes’ under den.",
      copyrightRemoveRights: "Linjen med © trykkes, når bogen har et forfatternavn eller en ophavsretsindehaver, så den kan ikke fjernes alene. Jeg kan ændre, hvis navn der står på den, eller fjerne ‘Alle rettigheder forbeholdes’ under den.",
      tooLong: "{field} kan højst have {limit} tegn; teksten har {length} tegn.", shorter: "Send en kortere tekst.", shorterOrSheet: "Send en kortere tekst i én besked, eller åbn bogens Title & credits, og skriv den selv.",
      invalidIsbn: "Dette ISBN er ugyldigt. Det skal have 10 eller 13 cifre med et korrekt kontrolciffer.", isbnRefused: "Dette ISBN er ugyldigt. Det skal have 10 eller 13 cifre med et korrekt kontrolciffer.",
      isbnOrSheet: "Tjek det, og send det i én besked — ‘ISBN er 978…’ — eller åbn bogens Title & credits, og skriv det selv.", askIsbn: "Hvad er ISBN præcis, som det skal trykkes?",
      notGiven: "Til {field} trykker jeg kun oplysninger, du har givet. Teksten indeholder oplysninger, du ikke har angivet.", notGivenValue: "Jeg trykker kun det, du fortæller mig, og jeg kunne ikke finde {field} i din besked.",
      askText: "Præcis hvilken tekst skal trykkes?", askValue: "Hvad skal det være, præcis som det skal trykkes?",
      runsOn: "Teksten til {field} indeholdt også din anden anmodning, så jeg ændrede den ikke.", askField: "Hvad skal teksten til {field} være, uden din anden anmodning?",
      busy: "Bogen bliver opdateret eller lavet. Prøv igen om lidt.", restricted: "Jeg kan ikke trykke denne tekst i {field}.",
      prints: "{field} trykkes", notPrinted: "{field} trykkes ikke", needsHolder: "{field} trykkes, når der er angivet et forfatternavn eller en ophavsretsindehaver",
      websiteNeedsBio: "Webstedet er gemt og vises i afsnittet om forfatteren, når du tilføjer en biografi."
    }
  },
  nl: {
    fields: ["auteursnaam", "opdracht", "over de auteur", "website", "rechthebbende", "uitgever", "ISBN", "regel Alle rechten voorbehouden"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Klaar", unchanged: "Er is niets gewijzigd", removed: "{field} is verwijderd", already: "{field} is al {value}", absent: "Dit boek heeft geen {field}",
      queued: "Ik werk de exportbestanden bij.", next: "Dit wordt afgedrukt wanneer het boek wordt gemaakt.", free: "Deze wijziging is gratis.", coverNew: "De nieuwe naam komt ook op de omslag.", coverOld: "De omslag behoudt de oude naam.",
      failed: "Ik kon de wijziging nu niet uitvoeren. Probeer het later opnieuw of open Title & credits van het boek.", notFound: "Ik kon dit boek niet vinden.",
      titleKept: "Elk boek behoudt de titelpagina, waarop de titel en auteursnaam worden afgedrukt.", titleChange: "Ik kan wijzigen wat erop staat: vertel welke auteursnaam erop moet komen, of zeg ‘hernoem het boek naar …’ voor een nieuwe titel.",
      studio: "De auteursnaam en opdracht van dit boek worden ingesteld in Writing Studio. Wijzig ze daar en werk het boek bij.",
      separate: "Dat is een afzonderlijke wijziging. Stuur die in een apart bericht, dan voer ik die uit.", separateQuoted: "{request}: Dat is een afzonderlijke wijziging. Stuur die in een apart bericht, dan voer ik die uit.",
      unclear: "Ik kon nog steeds niet opmaken wat daar afgedrukt moet worden.", sendOne: "Stuur het in één bericht – bijvoorbeeld ‘Voeg een opdracht toe: Voor mijn moeder’ of ‘Het ISBN is 978…’ – of open Title & credits van het boek om het zelf in te vullen.",
      notMatter: "Ik vond daarin geen wijziging van de titel- en boekgegevens. Ik kan de auteursnaam, de opdracht, de pagina Over de auteur, de website, de rechthebbende, de uitgever, het ISBN of de regel ‘Alle rechten voorbehouden’ wijzigen; vertel welke, en wat erin moet staan.",
      copyrightAddRights: "De regel met © wordt afgedrukt zodra het boek een auteursnaam of rechthebbende heeft, dus die kan niet afzonderlijk worden verwijderd. Ik kan wijzigen wiens naam erop staat, of ‘Alle rechten voorbehouden’ eronder toevoegen.",
      copyrightRemoveRights: "De regel met © wordt afgedrukt zodra het boek een auteursnaam of rechthebbende heeft, dus die kan niet afzonderlijk worden verwijderd. Ik kan wijzigen wiens naam erop staat, of ‘Alle rechten voorbehouden’ eronder weghalen.",
      tooLong: "{field} mag maximaal {limit} tekens bevatten; deze tekst bevat {length} tekens.", shorter: "Stuur een kortere tekst.", shorterOrSheet: "Stuur een kortere tekst in één bericht, of open Title & credits van het boek om die zelf in te vullen.",
      invalidIsbn: "Dit ISBN is ongeldig. Het moet 10 of 13 cijfers met een correct controlecijfer bevatten.", isbnRefused: "Dit ISBN is ongeldig. Het moet 10 of 13 cijfers met een correct controlecijfer bevatten.",
      isbnOrSheet: "Controleer het en stuur het in één bericht – ‘Het ISBN is 978…’ – of open Title & credits van het boek om het zelf in te vullen.", askIsbn: "Wat is het ISBN, precies zoals het afgedrukt moet worden?",
      notGiven: "Voor {field} druk ik alleen informatie af die je hebt gegeven. Deze tekst bevat informatie die je niet hebt aangeleverd.", notGivenValue: "Voor {field} druk ik alleen af wat je me vertelt, en ik vond het niet in je bericht.",
      askText: "Welke tekst moet er precies worden afgedrukt?", askValue: "Wat moet het zijn, precies zoals het afgedrukt moet worden?",
      runsOn: "De tekst voor {field} bevatte ook je andere verzoek, dus ik heb die niet gewijzigd.", askField: "Wat moet er bij {field} staan, en verder niets?",
      busy: "Het boek wordt bijgewerkt of gemaakt. Probeer het straks opnieuw.", restricted: "Ik kan deze tekst niet afdrukken in {field}.",
      prints: "{field} wordt afgedrukt", notPrinted: "{field} wordt niet afgedrukt", needsHolder: "{field} wordt afgedrukt zodra een auteursnaam of rechthebbende is ingesteld",
      websiteNeedsBio: "De website is opgeslagen en verschijnt bij Over de auteur zodra je een biografie toevoegt."
    }
  },
  fa: {
    fields: ["نام نویسنده", "تقدیم‌نامه", "دربارهٔ نویسنده", "وب‌سایت", "دارندهٔ حق نشر", "ناشر", "شابک", "عبارت همهٔ حقوق محفوظ است"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "انجام شد", unchanged: "چیزی تغییر نکرد", removed: "{field} حذف شد", already: "{field} از قبل {value} است", absent: "این کتاب {field} ندارد",
      queued: "دارم فایل‌های خروجی را تازه می‌کنم.", next: "هنگام آماده‌سازی کتاب چاپ می‌شود.", free: "این تغییر رایگان است.", coverNew: "نام تازه روی جلد هم قرار می‌گیرد.", coverOld: "جلد نام قبلی خود را نگه می‌دارد.",
      failed: "الان نتوانستم این تغییر را انجام بدهم. کمی بعد دوباره امتحان کنید یا بخش Title & credits کتاب را باز کنید.", notFound: "این کتاب را پیدا نکردم.",
      titleKept: "هر کتاب صفحهٔ عنوانش را نگه می‌دارد؛ عنوان و نام نویسنده آنجا چاپ می‌شوند.", titleChange: "می‌توانم آنچه رویش نوشته شده را تغییر بدهم: نام نویسنده‌ای را که باید نشان بدهد بگویید، یا برای عنوان تازه بگویید «نام کتاب را به … تغییر بده».",
      studio: "نام نویسنده و تقدیم‌نامهٔ این کتاب در تنظیمات Writing Studio تعیین می‌شوند. آنجا تغییرشان بدهید و کتاب را به‌روز کنید.",
      separate: "این درخواست تغییر جداگانه‌ای است؛ آن را در پیام جداگانه بفرستید تا انجامش بدهم.", separateQuoted: "{request}: این درخواست تغییر جداگانه‌ای است؛ آن را در پیام جداگانه بفرستید تا انجامش بدهم.",
      unclear: "هنوز نتوانستم بفهمم آنجا چه باید چاپ شود.", sendOne: "آن را در یک پیام بفرستید، مثلاً «تقدیم‌نامه اضافه کن: تقدیم به مادرم» یا «شابک ۹۷۸… است»، یا بخش Title & credits کتاب را باز کنید و خودتان واردش کنید.",
      notMatter: "در این پیام تغییری برای عنوان و اطلاعات کتاب پیدا نکردم. می‌توانم نام نویسنده، تقدیم‌نامه، صفحهٔ دربارهٔ نویسنده، وب‌سایت، دارندهٔ حق نشر، ناشر، شابک یا عبارت «همهٔ حقوق محفوظ است» را تغییر بدهم؛ بگویید کدام، و چه باید نوشته شود.",
      copyrightAddRights: "خط © هر وقت کتاب نام نویسنده یا دارندهٔ حق نشر داشته باشد چاپ می‌شود، پس جداگانه حذف نمی‌شود. می‌توانم نامی را که روی آن است تغییر بدهم، یا عبارت «همهٔ حقوق محفوظ است» را زیر آن اضافه کنم.",
      copyrightRemoveRights: "خط © هر وقت کتاب نام نویسنده یا دارندهٔ حق نشر داشته باشد چاپ می‌شود، پس جداگانه حذف نمی‌شود. می‌توانم نامی را که روی آن است تغییر بدهم، یا عبارت «همهٔ حقوق محفوظ است» را از آن بردارم.",
      tooLong: "{field} حداکثر {limit} نویسه می‌پذیرد؛ این متن {length} نویسه دارد.", shorter: "متن کوتاه‌تری بفرستید.", shorterOrSheet: "متن کوتاه‌تری را در یک پیام بفرستید، یا بخش Title & credits کتاب را باز کنید و خودتان واردش کنید.",
      invalidIsbn: "این شابک معتبر نیست؛ باید ۱۰ یا ۱۳ رقم با رقم کنترل درست داشته باشد.", isbnRefused: "این شابک معتبر نیست؛ باید ۱۰ یا ۱۳ رقم با رقم کنترل درست داشته باشد.",
      isbnOrSheet: "آن را بررسی کنید و در یک پیام بفرستید، به این شکل: «شابک ۹۷۸… است»، یا بخش Title & credits کتاب را باز کنید و خودتان واردش کنید.", askIsbn: "شابک دقیقاً همان‌طور که باید چاپ شود چیست؟",
      notGiven: "برای {field} فقط اطلاعاتی را چاپ می‌کنم که شما داده‌اید؛ متن پیشنهادی اطلاعاتی دارد که دریافت نکردم.", notGivenValue: "فقط چیزی را چاپ می‌کنم که شما بگویید، و {field} را در پیام شما پیدا نکردم.",
      askText: "دقیقاً چه متنی باید چاپ شود؟", askValue: "دقیقاً چه باید باشد، همان‌طور که باید چاپ شود؟",
      runsOn: "متن {field} شامل درخواست دیگر شما بود، پس آن را تغییر ندادم.", askField: "{field} به‌تنهایی چه باید بگوید؟",
      busy: "کتاب در حال به‌روزرسانی یا آماده‌سازی است. کمی بعد دوباره امتحان کنید.", restricted: "نمی‌توانم این متن را برای {field} چاپ کنم.",
      prints: "{field} چاپ می‌شود", notPrinted: "{field} چاپ نمی‌شود", needsHolder: "{field} وقتی نام نویسنده یا دارندهٔ حق نشر تعیین شود چاپ خواهد شد",
      websiteNeedsBio: "وب‌سایت ذخیره شده و پس از افزودن زندگی‌نامه در بخش دربارهٔ نویسنده نمایش داده می‌شود."
    }
  },
  fr: {
    fields: ["Nom de l’auteur", "Dédicace", "À propos de l’auteur", "Site web", "Titulaire des droits", "Éditeur", "ISBN", "Mention de droits réservés"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Terminé", unchanged: "Rien n’a changé", removed: "{field} : supprimé", already: "{field} : déjà {value}", absent: "Ce livre ne contient pas : {field}",
      queued: "Je mets à jour les fichiers exportés.", next: "Cela sera imprimé lors de la préparation du livre.", free: "Ce changement est gratuit.", coverNew: "La couverture portera aussi le nouveau nom.", coverOld: "La couverture conserve l’ancien nom.",
      failed: "Je n’ai pas pu effectuer ce changement maintenant. Réessayez plus tard ou ouvrez Title & credits du livre.", notFound: "Je n’ai pas trouvé ce livre.",
      titleKept: "Chaque livre conserve sa page de titre, où sont imprimés le titre et le nom de l’auteur.", titleChange: "Je peux modifier ce qui y figure : indiquez le nom d’auteur à afficher, ou dites « renommer le livre en … » pour un nouveau titre.",
      studio: "Le nom de l’auteur et la dédicace se modifient dans les paramètres Writing Studio de ce livre. Modifiez-les puis actualisez le livre.",
      separate: "Il s’agit d’un changement distinct ; envoyez-le dans un message séparé et je m’en occuperai.", separateQuoted: "{request}: Il s’agit d’un changement distinct ; envoyez-le dans un message séparé et je m’en occuperai.",
      unclear: "Je n’arrive toujours pas à savoir quoi imprimer à cet endroit.", sendOne: "Envoyez-le dans un seul message – par exemple « Ajouter une dédicace : Pour ma mère » ou « L’ISBN est 978… » – ou ouvrez Title & credits du livre pour le saisir vous-même.",
      notMatter: "Je n’ai pas trouvé de changement du titre ou des informations du livre dans ce message. Je peux modifier le nom de l’auteur, la dédicace, la page À propos de l’auteur, le site web, le titulaire des droits, l’éditeur, l’ISBN ou la mention « Tous droits réservés » ; précisez lequel de ces éléments, et ce qu’il doit indiquer.",
      copyrightAddRights: "La ligne © s’imprime dès que le livre a un nom d’auteur ou un titulaire des droits ; elle ne peut donc pas être supprimée seule. Je peux changer le nom qui y figure, ou ajouter « Tous droits réservés » en dessous.",
      copyrightRemoveRights: "La ligne © s’imprime dès que le livre a un nom d’auteur ou un titulaire des droits ; elle ne peut donc pas être supprimée seule. Je peux changer le nom qui y figure, ou retirer le « Tous droits réservés » placé en dessous.",
      tooLong: "{field} : maximum {limit} caractères ; ce texte en contient {length}.", shorter: "Envoyez un texte plus court.", shorterOrSheet: "Envoyez un texte plus court dans un seul message, ou ouvrez Title & credits du livre pour le saisir vous-même.",
      invalidIsbn: "Cet ISBN n’est pas valide : il faut 10 ou 13 chiffres avec un chiffre de contrôle correct.", isbnRefused: "Cet ISBN n’est pas valide : il faut 10 ou 13 chiffres avec un chiffre de contrôle correct.",
      isbnOrSheet: "Vérifiez-le et envoyez-le dans un seul message – « L’ISBN est 978… » – ou ouvrez Title & credits du livre pour le saisir vous-même.", askIsbn: "Quel est l’ISBN, exactement tel qu’il doit être imprimé ?",
      notGiven: "{field} : je n’imprime que les faits que vous fournissez ; ce texte contient des informations non fournies.", notGivenValue: "{field} : je n’imprime que ce que vous m’indiquez, et je ne l’ai pas trouvé dans votre message.",
      askText: "Quel texte faut-il imprimer exactement ?", askValue: "Que faut-il indiquer, exactement tel que cela doit être imprimé ?",
      runsOn: "Le texte de {field} contenait votre autre demande ; je l’ai donc laissé inchangé.", askField: "Quel texte faut-il imprimer pour {field}, et rien d’autre ?",
      busy: "Le livre est en cours de mise à jour ou de préparation. Réessayez dans un instant.", restricted: "Je ne peux pas imprimer ce texte pour {field}.",
      prints: "{field} : imprimé", notPrinted: "{field} : non imprimé", needsHolder: "{field} : sera imprimé lorsqu’un auteur ou un titulaire des droits sera indiqué",
      websiteNeedsBio: "Le site web est enregistré et apparaîtra dans la section À propos de l’auteur une fois la biographie ajoutée."
    }
  },
  de: {
    fields: ["Autorenname", "Widmung", "Über den Autor", "Website", "Rechteinhaber", "Verlag", "ISBN", "Rechtevorbehalt"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Erledigt", unchanged: "Nichts wurde geändert", removed: "{field}: entfernt", already: "{field}: bereits {value}", absent: "Dieses Buch enthält keinen Eintrag für {field}",
      queued: "Ich aktualisiere die Exportdateien.", next: "Wird bei der Fertigstellung des Buchs gedruckt.", free: "Diese Änderung ist kostenlos.", coverNew: "Auch das Cover erhält den neuen Namen.", coverOld: "Das Cover behält den bisherigen Namen.",
      failed: "Ich konnte das jetzt nicht ändern. Versuchen Sie es später erneut oder öffnen Sie Title & credits des Buchs.", notFound: "Ich konnte dieses Buch nicht finden.",
      titleKept: "Jedes Buch behält seine Titelseite; dort werden Titel und Autorenname gedruckt.", titleChange: "Ich kann ändern, was dort steht: Nennen Sie mir den Autorennamen, der dort stehen soll, oder sagen Sie „benenne das Buch um in …“ für einen neuen Titel.",
      studio: "Autorenname und Widmung dieses Buchs werden in den Einstellungen von Writing Studio geändert. Ändern Sie sie dort und aktualisieren Sie das Buch.",
      separate: "Das ist eine separate Änderung; senden Sie sie als eigene Nachricht, dann kümmere ich mich darum.", separateQuoted: "{request}: Das ist eine separate Änderung; senden Sie sie als eigene Nachricht, dann kümmere ich mich darum.",
      unclear: "Ich konnte immer noch nicht erkennen, was dort gedruckt werden soll.", sendOne: "Senden Sie es in einer Nachricht – zum Beispiel „Füge eine Widmung hinzu: Für meine Mama“ oder „Die ISBN ist 978…“ – oder öffnen Sie Title & credits des Buchs, um es selbst einzugeben.",
      notMatter: "Ich habe darin keine Änderung an Titel und Buchangaben gefunden. Ich kann den Autorennamen, die Widmung, die Seite Über den Autor, die Website, den Rechteinhaber, den Verlag, die ISBN oder den Rechtevorbehalt „Alle Rechte vorbehalten“ ändern; sagen Sie mir, was davon, und was dort stehen soll.",
      copyrightAddRights: "Die ©-Zeile wird gedruckt, sobald das Buch einen Autorennamen oder einen Rechteinhaber hat, und kann daher nicht einzeln entfernt werden. Ich kann ändern, wessen Name darauf steht, oder „Alle Rechte vorbehalten“ darunter hinzufügen.",
      copyrightRemoveRights: "Die ©-Zeile wird gedruckt, sobald das Buch einen Autorennamen oder einen Rechteinhaber hat, und kann daher nicht einzeln entfernt werden. Ich kann ändern, wessen Name darauf steht, oder „Alle Rechte vorbehalten“ darunter entfernen.",
      tooLong: "{field}: höchstens {limit} Zeichen; dieser Text hat {length}.", shorter: "Senden Sie einen kürzeren Text.", shorterOrSheet: "Senden Sie einen kürzeren Text in einer Nachricht oder öffnen Sie Title & credits des Buchs, um ihn selbst einzugeben.",
      invalidIsbn: "Diese ISBN ist ungültig: Sie benötigt 10 oder 13 Ziffern mit einer korrekten Prüfziffer.", isbnRefused: "Diese ISBN ist ungültig: Sie benötigt 10 oder 13 Ziffern mit einer korrekten Prüfziffer.",
      isbnOrSheet: "Prüfen Sie sie und senden Sie sie in einer Nachricht – „Die ISBN ist 978…“ – oder öffnen Sie Title & credits des Buchs, um sie selbst einzugeben.", askIsbn: "Wie lautet die ISBN genau so, wie sie gedruckt werden soll?",
      notGiven: "{field}: Ich drucke nur Ihre Angaben; dieser Text enthält nicht angegebene Informationen.", notGivenValue: "{field}: Ich drucke nur, was Sie mir sagen, und ich habe es in Ihrer Nachricht nicht gefunden.",
      askText: "Welcher Text soll genau gedruckt werden?", askValue: "Was soll es sein, genau so, wie es gedruckt werden soll?",
      runsOn: "Der Text für {field} enthielt Ihre andere Anfrage, daher blieb er unverändert.", askField: "{field}: Was genau soll dort stehen, für sich allein?",
      busy: "Das Buch wird aktualisiert oder fertiggestellt. Versuchen Sie es gleich erneut.", restricted: "Ich kann diesen Text für {field} nicht drucken.",
      prints: "{field}: wird gedruckt", notPrinted: "{field}: wird nicht gedruckt", needsHolder: "{field}: wird gedruckt, sobald Autor oder Rechteinhaber angegeben ist",
      websiteNeedsBio: "Die Website ist gespeichert und erscheint im Abschnitt Über den Autor, sobald Sie eine Biografie hinzufügen."
    }
  },
  el: {
    fields: ["όνομα συγγραφέα", "αφιέρωση", "σχετικά με τον συγγραφέα", "ιστότοπος", "κάτοχος πνευματικών δικαιωμάτων", "εκδότης", "ISBN", "δήλωση επιφύλαξης δικαιωμάτων"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Έγινε", unchanged: "Δεν άλλαξε τίποτα", removed: "Αφαιρέθηκε: {field}", already: "{field}: είναι ήδη {value}", absent: "Το βιβλίο δεν έχει: {field}",
      queued: "Ενημερώνω τα αρχεία εξαγωγής.", next: "Θα εκτυπωθεί όταν ετοιμαστεί το βιβλίο.", free: "Αυτή η αλλαγή είναι δωρεάν.", coverNew: "Το νέο όνομα θα εμφανίζεται και στο εξώφυλλο.", coverOld: "Το εξώφυλλο θα κρατήσει το παλιό όνομα.",
      failed: "Δεν μπόρεσα να κάνω την αλλαγή τώρα. Δοκιμάστε αργότερα ή ανοίξτε το Title & credits του βιβλίου.", notFound: "Δεν βρήκα αυτό το βιβλίο.",
      titleKept: "Κάθε βιβλίο διατηρεί τη σελίδα τίτλου, όπου εκτυπώνονται ο τίτλος και το όνομα του συγγραφέα.", titleChange: "Μπορώ να αλλάξω τι γράφει: πείτε μου ποιο όνομα συγγραφέα να δείχνει ή πείτε «μετονόμασε το βιβλίο σε …» για νέο τίτλο.",
      studio: "Το όνομα του συγγραφέα και η αφιέρωση αυτού του βιβλίου ορίζονται στο Writing Studio. Αλλάξτε τα εκεί και ενημερώστε το βιβλίο.",
      separate: "Αυτή είναι ξεχωριστή αλλαγή. Στείλτε τη σε άλλο μήνυμα για να την κάνω.", separateQuoted: "{request}: Αυτή είναι ξεχωριστή αλλαγή. Στείλτε τη σε άλλο μήνυμα για να την κάνω.",
      unclear: "Ακόμα δεν μπόρεσα να καταλάβω τι να εκτυπώσω εκεί.", sendOne: "Στείλτε το κείμενο που θέλετε σε ένα μήνυμα — για παράδειγμα «Πρόσθεσε αφιέρωση: Στη μαμά μου» ή «Το ISBN είναι 978…» — ή ανοίξτε το Title & credits του βιβλίου για να το πληκτρολογήσετε μόνοι σας.",
      notMatter: "Δεν βρήκα σε αυτό το μήνυμα αλλαγή στον τίτλο και τα στοιχεία του βιβλίου. Μπορώ να αλλάξω το όνομα του συγγραφέα, την αφιέρωση, τη σελίδα «Σχετικά με τον συγγραφέα», τον ιστότοπο, τον κάτοχο πνευματικών δικαιωμάτων, τον εκδότη, το ISBN ή τη δήλωση «Με επιφύλαξη παντός δικαιώματος» — πείτε μου ποιο και τι πρέπει να γράφει.",
      copyrightAddRights: "Η γραμμή © εκτυπώνεται όποτε το βιβλίο έχει όνομα συγγραφέα ή κάτοχο δικαιωμάτων, οπότε δεν αφαιρείται μόνη της. Μπορώ να αλλάξω το όνομα που γράφει ή να προσθέσω από κάτω της «Με επιφύλαξη παντός δικαιώματος».",
      copyrightRemoveRights: "Η γραμμή © εκτυπώνεται όποτε το βιβλίο έχει όνομα συγγραφέα ή κάτοχο δικαιωμάτων, οπότε δεν αφαιρείται μόνη της. Μπορώ να αλλάξω το όνομα που γράφει ή να αφαιρέσω από κάτω της το «Με επιφύλαξη παντός δικαιώματος».",
      tooLong: "{field}: έως {limit} χαρακτήρες· το κείμενο έχει {length}.", shorter: "Στείλτε μικρότερο κείμενο.", shorterOrSheet: "Στείλτε ένα μικρότερο κείμενο σε ένα μήνυμα ή ανοίξτε το Title & credits του βιβλίου για να το πληκτρολογήσετε μόνοι σας.",
      invalidIsbn: "Το ISBN δεν είναι έγκυρο. Χρειάζεται 10 ή 13 ψηφία με σωστό ψηφίο ελέγχου.", isbnRefused: "Το ISBN δεν είναι έγκυρο. Χρειάζεται 10 ή 13 ψηφία με σωστό ψηφίο ελέγχου.",
      isbnOrSheet: "Ελέγξτε το και στείλτε το σε ένα μήνυμα — «Το ISBN είναι 978…» — ή ανοίξτε το Title & credits του βιβλίου για να το πληκτρολογήσετε μόνοι σας.", askIsbn: "Ποιο είναι το ISBN ακριβώς όπως πρέπει να εκτυπωθεί;",
      notGiven: "Για το πεδίο {field} εκτυπώνω μόνο πληροφορίες που δώσατε. Το κείμενο περιέχει πληροφορίες που δεν έχω λάβει.", notGivenValue: "Εκτυπώνω μόνο ό,τι μου λέτε, και δεν βρήκα στο μήνυμά σας τι να γράψω στο πεδίο {field}.",
      askText: "Ποιο ακριβώς κείμενο πρέπει να εκτυπωθεί;", askValue: "Τι πρέπει να γράφει, ακριβώς όπως θα εκτυπωθεί;",
      runsOn: "Το κείμενο στο πεδίο {field} περιείχε και το άλλο σας αίτημα, οπότε δεν το άλλαξα.", askField: "Τι πρέπει να γράφει μόνο του το πεδίο {field};",
      busy: "Το βιβλίο ενημερώνεται ή ετοιμάζεται. Δοκιμάστε ξανά σε λίγο.", restricted: "Δεν μπορώ να εκτυπώσω αυτό το κείμενο στο πεδίο {field}.",
      prints: "Θα εκτυπωθεί: {field}", notPrinted: "Δεν θα εκτυπωθεί: {field}", needsHolder: "Το πεδίο {field} θα εκτυπωθεί όταν οριστεί συγγραφέας ή κάτοχος δικαιωμάτων",
      websiteNeedsBio: "Ο ιστότοπος αποθηκεύτηκε και θα εμφανιστεί στην ενότητα για τον συγγραφέα μόλις προσθέσετε βιογραφικό."
    }
  },
  he: {
    fields: ["שם המחבר", "הקדשה", "על המחבר", "אתר", "בעל זכויות היוצרים", "מוציא לאור", "ISBN", "שורת כל הזכויות שמורות"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "בוצע", unchanged: "לא השתנה דבר", removed: "{field} הוסר", already: "{field} כבר מוגדר כך: {value}", absent: "בספר הזה אין {field}",
      queued: "אני מעדכן את קובצי הייצוא.", next: "זה יודפס כשהספר יוכן.", free: "השינוי הזה בחינם.", coverNew: "השם החדש יופיע גם על הכריכה.", coverOld: "על הכריכה יישאר השם הקודם.",
      failed: "לא הצלחתי לבצע את השינוי כרגע. אפשר לנסות שוב מאוחר יותר או לפתוח את Title & credits של הספר.", notFound: "לא מצאתי את הספר הזה.",
      titleKept: "עמוד השער נשאר בכל ספר; שם מודפסים שם הספר ושם המחבר.", titleChange: "אפשר לשנות את מה שכתוב בו: יש לציין את שם המחבר שצריך להופיע, או לכתוב «לשנות את שם הספר ל…» לשם ספר חדש.",
      studio: "שם המחבר וההקדשה של הספר הזה מוגדרים ב־Writing Studio. יש לשנות אותם שם ולעדכן את הספר.",
      separate: "זהו שינוי נפרד. יש לשלוח אותו בהודעה נפרדת כדי שאבצע אותו.", separateQuoted: "{request}: זהו שינוי נפרד. יש לשלוח אותו בהודעה נפרדת כדי שאבצע אותו.",
      unclear: "עדיין לא הצלחתי להבין מה להדפיס שם.", sendOne: "יש לשלוח אותו בהודעה אחת, למשל «להוסיף הקדשה: לאמא שלי» או «ה־ISBN הוא 978…», או לפתוח את Title & credits של הספר ולהקליד אותו שם.",
      notMatter: "לא מצאתי בהודעה שינוי בפרטי הספר. אפשר לשנות את שם המחבר, ההקדשה, עמוד «על המחבר», האתר, בעל זכויות היוצרים, המוציא לאור, ה־ISBN או שורת «כל הזכויות שמורות»; יש לציין איזה מהם, ומה צריך להיות כתוב בו.",
      copyrightAddRights: "שורת © מודפסת בכל פעם שיש לספר שם מחבר או בעל זכויות יוצרים, ולכן אי אפשר להסיר אותה לבדה. אפשר לשנות את השם שמופיע בה, או להוסיף מתחתיה «כל הזכויות שמורות».",
      copyrightRemoveRights: "שורת © מודפסת בכל פעם שיש לספר שם מחבר או בעל זכויות יוצרים, ולכן אי אפשר להסיר אותה לבדה. אפשר לשנות את השם שמופיע בה, או להסיר ממנה את «כל הזכויות שמורות».",
      tooLong: "{field} מוגבל ל־{limit} תווים; בטקסט הזה יש {length} תווים.", shorter: "יש לשלוח טקסט קצר יותר.", shorterOrSheet: "יש לשלוח נוסח קצר יותר בהודעה אחת, או לפתוח את Title & credits של הספר ולהקליד אותו שם.",
      invalidIsbn: "ה־ISBN הזה אינו תקין. דרושות 10 או 13 ספרות עם ספרת ביקורת נכונה.", isbnRefused: "ה־ISBN הזה אינו תקין. דרושות 10 או 13 ספרות עם ספרת ביקורת נכונה.",
      isbnOrSheet: "יש לבדוק אותו ולשלוח בהודעה אחת בנוסח «ה־ISBN הוא 978…», או לפתוח את Title & credits של הספר ולהקליד אותו שם.", askIsbn: "מהו ה־ISBN בדיוק כפי שצריך להדפיס אותו?",
      notGiven: "עבור {field} אני מדפיס רק מידע שמסרת. הטקסט הזה מכיל מידע שלא נמסר.", notGivenValue: "אני מדפיס רק מה שמסרת, ולא מצאתי בהודעה שלך ערך עבור {field}.",
      askText: "מהו הנוסח המדויק שצריך להדפיס?", askValue: "מה צריך להיות הערך, בדיוק כפי שצריך להדפיס אותו?",
      runsOn: "הטקסט של {field} כלל גם את הבקשה האחרת שלך, ולכן לא שיניתי אותו.", askField: "מה בדיוק צריך להיות כתוב בשדה {field}, בלי שום דבר נוסף?",
      busy: "הספר מתעדכן או נמצא בהכנה. אפשר לנסות שוב בעוד מעט.", restricted: "לא אוכל להדפיס את הטקסט הזה בשדה {field}.",
      prints: "{field} יודפס", notPrinted: "{field} לא יודפס", needsHolder: "{field} יודפס לאחר שיוגדר שם מחבר או בעל זכויות יוצרים",
      websiteNeedsBio: "האתר נשמר ויופיע בחלק על המחבר לאחר הוספת ביוגרפיה."
    }
  },
  hi: {
    fields: ["लेखक का नाम", "समर्पण", "लेखक के बारे में", "वेबसाइट", "कॉपीराइट धारक", "प्रकाशक", "ISBN", "सर्वाधिकार सुरक्षित की पंक्ति"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "हो गया", unchanged: "कुछ नहीं बदला", removed: "{field} हटा दिया गया", already: "{field} पहले से {value} है", absent: "इस पुस्तक में {field} नहीं है",
      queued: "निर्यात फ़ाइलें अपडेट कर रहा हूँ।", next: "पुस्तक तैयार होने पर छपेगा।", free: "यह बदलाव निःशुल्क है।", coverNew: "आवरण पर भी नया नाम आएगा।", coverOld: "आवरण पर पुराना नाम रहेगा।",
      failed: "अभी बदलाव नहीं कर सका। थोड़ी देर में फिर कोशिश करें या पुस्तक का Title & credits खोलें।", notFound: "यह पुस्तक नहीं मिली।",
      titleKept: "हर पुस्तक का शीर्षक पृष्ठ बना रहता है; शीर्षक और लेखक का नाम वहीं छपते हैं।", titleChange: "इस पर लिखा बदल सकता हूँ: बताएं कि इस पर लेखक का कौन-सा नाम दिखना चाहिए, या नए शीर्षक के लिए कहें “पुस्तक का नाम बदलकर … कर दो”।",
      studio: "इस पुस्तक के लेखक का नाम और समर्पण Writing Studio की सेटिंग में बदलें, फिर पुस्तक अपडेट करें।",
      separate: "यह अलग बदलाव है; इसे अलग संदेश में भेजें और मैं कर दूँगा।", separateQuoted: "{request}: यह अलग बदलाव है; इसे अलग संदेश में भेजें और मैं कर दूँगा।",
      unclear: "मैं अब भी नहीं समझ पाया कि वहाँ क्या छापना है।", sendOne: "इसे एक संदेश में भेजें, जैसे “समर्पण जोड़ो: मेरी माँ के लिए” या “ISBN 978… है”, या पुस्तक का Title & credits खोलकर इसे खुद दर्ज करें।",
      notMatter: "इसमें शीर्षक और प्रकाशन जानकारी का कोई बदलाव नहीं मिला। मैं लेखक का नाम, समर्पण, लेखक के बारे में वाला पृष्ठ, वेबसाइट, कॉपीराइट धारक, प्रकाशक, ISBN या “सर्वाधिकार सुरक्षित” की पंक्ति बदल सकता हूँ; बताएं कि कौन-सा, और उसमें क्या लिखा होना चाहिए।",
      copyrightAddRights: "जब भी पुस्तक में लेखक का नाम या कॉपीराइट धारक हो, © पंक्ति छपती है, इसलिए यह अकेले नहीं हट सकती। मैं इस पर दिया नाम बदल सकता हूँ, या इसके नीचे “सर्वाधिकार सुरक्षित” जोड़ सकता हूँ।",
      copyrightRemoveRights: "जब भी पुस्तक में लेखक का नाम या कॉपीराइट धारक हो, © पंक्ति छपती है, इसलिए यह अकेले नहीं हट सकती। मैं इस पर दिया नाम बदल सकता हूँ, या इससे “सर्वाधिकार सुरक्षित” हटा सकता हूँ।",
      tooLong: "{field} में अधिकतम {limit} अक्षर हो सकते हैं; इस पाठ में {length} अक्षर हैं।", shorter: "छोटा पाठ भेजें।", shorterOrSheet: "एक संदेश में छोटा पाठ भेजें, या पुस्तक का Title & credits खोलकर इसे खुद दर्ज करें।",
      invalidIsbn: "यह ISBN मान्य नहीं है; सही जाँच अंक सहित 10 या 13 अंक चाहिए।", isbnRefused: "यह ISBN मान्य नहीं है; सही जाँच अंक सहित 10 या 13 अंक चाहिए।",
      isbnOrSheet: "इसे जाँचकर एक संदेश में भेजें, जैसे “ISBN 978… है”, या पुस्तक का Title & credits खोलकर इसे खुद दर्ज करें।", askIsbn: "ISBN ठीक-ठीक क्या है, जैसा उसे छपना चाहिए?",
      notGiven: "{field} में केवल आपकी दी जानकारी छापता हूँ; इस पाठ में ऐसी जानकारी है जो आपने नहीं दी।", notGivenValue: "मैं केवल वही छापता हूँ जो आप बताते हैं, और आपके संदेश में {field} का ज़िक्र नहीं मिला।",
      askText: "ठीक कौन सा पाठ छापना है?", askValue: "यह ठीक-ठीक क्या होना चाहिए, जैसा इसे छपना है?",
      runsOn: "{field} के पाठ में आपका दूसरा अनुरोध था, इसलिए उसे नहीं बदला।", askField: "सिर्फ़ {field} में क्या लिखा होना चाहिए?",
      busy: "पुस्तक अपडेट या तैयार हो रही है। थोड़ी देर में फिर कोशिश करें।", restricted: "यह पाठ {field} में नहीं छाप सकता।",
      prints: "{field} छपेगा", notPrinted: "{field} नहीं छपेगा", needsHolder: "लेखक या कॉपीराइट धारक का नाम तय होने पर {field} छपेगा",
      websiteNeedsBio: "वेबसाइट सहेज दी गई है। जीवनी जोड़ने पर यह लेखक के परिचय में दिखाई देगी।"
    }
  },
  it: {
    fields: ["Nome dell’autore", "Dedica", "L’autore", "Sito web", "Titolare dei diritti", "Editore", "ISBN", "Dicitura sui diritti riservati"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Fatto", unchanged: "Non è cambiato nulla", removed: "{field}: rimosso", already: "{field}: già {value}", absent: "Questo libro non contiene: {field}",
      queued: "Sto aggiornando i file esportati.", next: "Verrà stampato quando il libro sarà preparato.", free: "Questa modifica è gratuita.", coverNew: "Anche la copertina avrà il nuovo nome.", coverOld: "La copertina mantiene il vecchio nome.",
      failed: "Non ho potuto apportare la modifica ora. Riprova più tardi o apri Title & credits del libro.", notFound: "Non ho trovato questo libro.",
      titleKept: "Ogni libro conserva il frontespizio, dove si stampano titolo e nome dell’autore.", titleChange: "Posso cambiare ciò che riporta: dimmi quale nome dell’autore deve comparire, oppure scrivi «rinomina il libro in …» per un nuovo titolo.",
      studio: "Nome dell’autore e dedica si cambiano nelle impostazioni Writing Studio di questo libro. Modificali lì, poi aggiorna il libro.",
      separate: "È una modifica separata: inviala in un altro messaggio e me ne occuperò.", separateQuoted: "{request}: È una modifica separata: inviala in un altro messaggio e me ne occuperò.",
      unclear: "Non mi è ancora chiaro cosa stampare lì.", sendOne: "Invialo in un solo messaggio – ad esempio «Aggiungi una dedica: Per mia madre» o «L’ISBN è 978…» – oppure apri Title & credits del libro per inserirlo tu.",
      notMatter: "Non ho trovato in questo messaggio una modifica al titolo o ai dati del libro. Posso cambiare il nome dell’autore, la dedica, la pagina sull’autore, il sito web, il titolare dei diritti, l’editore, l’ISBN o la dicitura «Tutti i diritti riservati»; dimmi quale, e cosa deve riportare.",
      copyrightAddRights: "La riga © viene stampata ogni volta che il libro ha un nome dell’autore o un titolare dei diritti, quindi non si può eliminare da sola. Posso cambiare il nome che vi compare, oppure aggiungere «Tutti i diritti riservati» sotto di essa.",
      copyrightRemoveRights: "La riga © viene stampata ogni volta che il libro ha un nome dell’autore o un titolare dei diritti, quindi non si può eliminare da sola. Posso cambiare il nome che vi compare, oppure togliere la dicitura «Tutti i diritti riservati» che compare sotto.",
      tooLong: "{field}: massimo {limit} caratteri; questo testo ne ha {length}.", shorter: "Invia un testo più breve.", shorterOrSheet: "Invia un testo più breve in un solo messaggio, oppure apri Title & credits del libro per inserirlo tu.",
      invalidIsbn: "Questo ISBN non è valido: servono 10 o 13 cifre con una cifra di controllo corretta.", isbnRefused: "Questo ISBN non è valido: servono 10 o 13 cifre con una cifra di controllo corretta.",
      isbnOrSheet: "Controllalo e invialo in un solo messaggio – «L’ISBN è 978…» – oppure apri Title & credits del libro per inserirlo tu.", askIsbn: "Qual è l’ISBN, esattamente come deve essere stampato?",
      notGiven: "{field}: stampo solo le informazioni che fornisci; il testo ne contiene altre non fornite.", notGivenValue: "{field}: stampo solo ciò che mi dici, e non l’ho trovato nel tuo messaggio.",
      askText: "Quale testo devo stampare esattamente?", askValue: "Quale deve essere, esattamente come va stampato?",
      runsOn: "Il testo di {field} conteneva l’altra richiesta, quindi l’ho lasciato invariato.", askField: "{field}: quale testo deve riportare, e nient’altro?",
      busy: "Il libro è in aggiornamento o preparazione. Riprova tra poco.", restricted: "Non posso stampare questo testo per {field}.",
      prints: "{field}: viene stampato", notPrinted: "{field}: non viene stampato", needsHolder: "{field}: verrà stampato quando sarà indicato autore o titolare dei diritti",
      websiteNeedsBio: "Il sito web è salvato e apparirà nella sezione sull’autore quando aggiungerai una biografia."
    }
  },
  ja: {
    fields: ["著者名", "献辞", "著者について", "ウェブサイト", "著作権者", "出版社", "ISBN", "権利留保の表示"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "完了", unchanged: "変更はありません", removed: "{field}を削除しました", already: "{field}はすでに{value}です", absent: "この本には{field}がありません",
      queued: "書き出しファイルを更新しています。", next: "本を作成するときに印刷されます。", free: "この変更は無料です。", coverNew: "表紙にも新しい名前が入ります。", coverOld: "表紙には以前の名前が残ります。",
      failed: "今は変更できませんでした。後でもう一度試すか、本の Title & credits を開いてください。", notFound: "この本が見つかりません。",
      titleKept: "どの本にもタイトルページが残り、書名と著者名が印刷されます。", titleChange: "記載内容は変更できます。表示する著者名を教えていただくか、新しい書名にするには「書名を……に変更して」と伝えてください。",
      studio: "この本の著者名と献辞は Writing Studio の設定で変更し、本を更新してください。",
      separate: "これは別の変更です。別のメッセージで送ってください。", separateQuoted: "{request}: これは別の変更です。別のメッセージで送ってください。",
      unclear: "そこに何を印刷すればよいか、まだ判断できませんでした。", sendOne: "「献辞を追加して：母へ」や「ISBN は 978……」のように一つのメッセージで送るか、本の Title & credits を開いてご自身で入力してください。",
      notMatter: "そのメッセージには書名や出版情報の変更が見つかりませんでした。著者名、献辞、「著者について」のページ、ウェブサイト、著作権者、出版社、ISBN、権利留保の表示を変更できます。どれを、どのような内容にするか指定してください。",
      copyrightAddRights: "本に著者名または著作権者があるかぎり © の行は印刷されるため、単独では削除できません。行にある名前を変更するか、その下に権利留保の表示（「無断転載を禁じます」）を加えることはできます。",
      copyrightRemoveRights: "本に著者名または著作権者があるかぎり © の行は印刷されるため、単独では削除できません。行にある名前を変更するか、そこから権利留保の表示（「無断転載を禁じます」）を外すことはできます。",
      tooLong: "{field}は最大{limit}文字です。この文章は{length}文字です。", shorter: "より短い文章を送ってください。", shorterOrSheet: "より短い文章を一つのメッセージで送るか、本の Title & credits を開いてご自身で入力してください。",
      invalidIsbn: "ISBN が無効です。正しいチェック数字を含む10桁または13桁が必要です。", isbnRefused: "ISBN が無効です。正しいチェック数字を含む10桁または13桁が必要です。",
      isbnOrSheet: "確認のうえ「ISBN は 978……」のように一つのメッセージで送るか、本の Title & credits を開いてご自身で入力してください。", askIsbn: "印刷するとおりの ISBN は何ですか？",
      notGiven: "{field}には提供された情報だけを印刷します。この文章には未提供の情報が含まれています。", notGivenValue: "伝えていただいた内容だけを印刷しますが、メッセージに{field}が見つかりませんでした。",
      askText: "どの文章を印刷すればよいですか？", askValue: "印刷するとおりに、正確には何にしますか？",
      runsOn: "{field}の文章に別の依頼が含まれていたため、変更しませんでした。", askField: "{field}そのものには何と書きますか？",
      busy: "本を更新または作成しています。後でもう一度試してください。", restricted: "この文章を{field}に印刷できません。",
      prints: "{field}を印刷します", notPrinted: "{field}は印刷しません", needsHolder: "著者名または著作権者を設定すると{field}を印刷します",
      websiteNeedsBio: "ウェブサイトを保存しました。著者紹介文を追加すると、著者紹介ページに表示されます。"
    }
  },
  ko: {
    fields: ["저자 이름", "헌사", "저자 소개", "웹사이트", "저작권자", "출판사", "ISBN", "권리 보유 문구"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "완료", unchanged: "변경 사항이 없습니다", removed: "{field} 삭제됨", already: "{field}은 이미 {value}입니다", absent: "이 책에는 {field}이 없습니다",
      queued: "내보내기 파일을 갱신하고 있습니다.", next: "책을 제작할 때 인쇄됩니다.", free: "이 변경은 무료입니다.", coverNew: "표지에도 새 이름이 들어갑니다.", coverOld: "표지에는 이전 이름이 유지됩니다.",
      failed: "지금은 변경할 수 없습니다. 잠시 후 다시 시도하거나 책의 Title & credits를 여세요.", notFound: "이 책을 찾을 수 없습니다.",
      titleKept: "모든 책에는 제목 페이지가 유지되며 제목과 저자 이름이 인쇄됩니다.", titleChange: "인쇄되는 내용은 바꿀 수 있습니다. 표시할 저자 이름을 알려 주시거나, 새 제목을 원하시면 “책 제목을 …(으)로 바꿔 줘”라고 말씀해 주세요.",
      studio: "이 책의 저자 이름과 헌사는 Writing Studio 설정에서 변경한 뒤 책을 갱신하세요.",
      separate: "별도의 변경 요청입니다. 별도 메시지로 보내 주시면 처리하겠습니다.", separateQuoted: "{request}: 별도의 변경 요청입니다. 별도 메시지로 보내 주시면 처리하겠습니다.",
      unclear: "그곳에 무엇을 인쇄할지 여전히 알 수 없습니다.", sendOne: "인쇄할 문구를 “헌사 추가: 엄마에게”나 “ISBN은 978…”처럼 한 메시지로 보내 주시거나, 책의 Title & credits를 열어 직접 입력하세요.",
      notMatter: "이 메시지에서 책의 제목과 출판 정보에 대한 변경을 찾지 못했습니다. 저자 이름, 헌사, 저자 소개 페이지, 웹사이트, 저작권자, 출판사, ISBN 또는 “모든 권리 보유” 문구를 바꿀 수 있습니다. 어느 항목을 무엇으로 바꿀지 알려 주세요.",
      copyrightAddRights: "저자 이름이나 저작권자가 있으면 © 줄은 항상 인쇄되므로 그 줄만 따로 삭제할 수는 없습니다. 줄에 들어가는 이름을 바꾸거나, 그 아래에 “모든 권리 보유” 문구를 추가할 수 있습니다.",
      copyrightRemoveRights: "저자 이름이나 저작권자가 있으면 © 줄은 항상 인쇄되므로 그 줄만 따로 삭제할 수는 없습니다. 줄에 들어가는 이름을 바꾸거나, 그 아래의 “모든 권리 보유” 문구를 삭제할 수 있습니다.",
      tooLong: "{field}은 최대 {limit}자입니다. 현재 문구는 {length}자입니다.", shorter: "더 짧은 문구를 보내 주세요.", shorterOrSheet: "더 짧은 문구를 한 메시지로 보내 주시거나, 책의 Title & credits를 열어 직접 입력하세요.",
      invalidIsbn: "유효하지 않은 ISBN입니다. 올바른 검증 숫자가 포함된 10자리 또는 13자리가 필요합니다.", isbnRefused: "유효하지 않은 ISBN입니다. 올바른 검증 숫자가 포함된 10자리 또는 13자리가 필요합니다.",
      isbnOrSheet: "ISBN을 확인한 뒤 “ISBN은 978…”처럼 한 메시지로 보내 주시거나, 책의 Title & credits를 열어 직접 입력하세요.", askIsbn: "인쇄할 그대로, 정확한 ISBN은 무엇인가요?",
      notGiven: "{field}에는 제공하신 정보만 인쇄합니다. 이 문구에는 제공하지 않은 정보가 있습니다.", notGivenValue: "알려 주신 내용만 인쇄하는데, 메시지에서 {field}을(를) 찾지 못했습니다.",
      askText: "정확히 어떤 문구를 인쇄할까요?", askValue: "인쇄할 그대로, 정확히 무엇으로 할까요?",
      runsOn: "{field} 문구에 다른 요청이 포함되어 그대로 두었습니다.", askField: "다른 요청을 빼고 {field}에는 무엇이라고 적을까요?",
      busy: "책을 갱신하거나 제작 중입니다. 잠시 후 다시 시도하세요.", restricted: "이 문구를 {field}에 인쇄할 수 없습니다.",
      prints: "{field} 인쇄됨", notPrinted: "{field} 인쇄 안 됨", needsHolder: "저자 이름이나 저작권자를 설정하면 {field}이 인쇄됩니다",
      websiteNeedsBio: "웹사이트가 저장되었습니다. 약력을 추가하면 저자 소개에 표시됩니다."
    }
  },
  no: {
    fields: ["forfatternavn", "dedikasjon", "om forfatteren", "nettsted", "rettighetshaver", "forlag", "ISBN", "linjen Alle rettigheter forbeholdt"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Ferdig", unchanged: "Ingenting ble endret", removed: "{field} er fjernet", already: "{field} er allerede {value}", absent: "Denne boken har ikke {field}",
      queued: "Jeg oppdaterer eksportfilene.", next: "Dette trykkes når boken blir laget.", free: "Denne endringen er gratis.", coverNew: "Det nye navnet kommer også på omslaget.", coverOld: "Omslaget beholder det gamle navnet.",
      failed: "Jeg kunne ikke gjøre endringen nå. Prøv igjen senere, eller åpne bokens Title & credits.", notFound: "Jeg fant ikke denne boken.",
      titleKept: "Alle bøker beholder tittelsiden, der tittelen og forfatternavnet trykkes.", titleChange: "Jeg kan endre det som står der: fortell meg hvilket forfatternavn som skal vises, eller si «endre tittelen til …» hvis du vil ha en ny tittel.",
      studio: "Forfatternavnet og dedikasjonen for denne boken angis i Writing Studio. Endre dem der, og oppdater boken.",
      separate: "Dette er en egen endring. Send den i en egen melding, så ordner jeg den.", separateQuoted: "{request}: Dette er en egen endring. Send den i en egen melding, så ordner jeg den.",
      unclear: "Jeg klarte fortsatt ikke å se hva som skal trykkes der.", sendOne: "Send det i én melding – for eksempel «Legg til en dedikasjon: Til mamma» eller «ISBN-et er 978…» – eller åpne bokens Title & credits og skriv det inn selv.",
      notMatter: "Jeg fant ingen endring i bokens tittelopplysninger der. Jeg kan endre forfatternavnet, dedikasjonen, siden Om forfatteren, nettstedet, rettighetshaveren, forlaget, ISBN-et eller linjen «Alle rettigheter forbeholdt»; si hvilken det gjelder, og hva som skal stå der.",
      copyrightAddRights: "Linjen med © trykkes når boken har et forfatternavn eller en rettighetshaver, så den kan ikke fjernes alene. Jeg kan endre hvilket navn som står på den, eller legge til «Alle rettigheter forbeholdt» under den.",
      copyrightRemoveRights: "Linjen med © trykkes når boken har et forfatternavn eller en rettighetshaver, så den kan ikke fjernes alene. Jeg kan endre hvilket navn som står på den, eller ta bort «Alle rettigheter forbeholdt» under den.",
      tooLong: "{field} kan ha maksimalt {limit} tegn; teksten har {length} tegn.", shorter: "Send en kortere tekst.", shorterOrSheet: "Send en kortere tekst i én melding, eller åpne bokens Title & credits og skriv den inn selv.",
      invalidIsbn: "Dette ISBN-et er ugyldig. Det må ha 10 eller 13 sifre med et korrekt kontrollsiffer.", isbnRefused: "Dette ISBN-et er ugyldig. Det må ha 10 eller 13 sifre med et korrekt kontrollsiffer.",
      isbnOrSheet: "Sjekk det og send det i én melding – «ISBN-et er 978…» – eller åpne bokens Title & credits og skriv det inn selv.", askIsbn: "Hva er ISBN-et, nøyaktig slik det skal trykkes?",
      notGiven: "For {field} trykker jeg bare opplysninger du har gitt. Teksten inneholder opplysninger du ikke har oppgitt.", notGivenValue: "For {field} trykker jeg bare det du forteller meg, og jeg fant det ikke i meldingen din.",
      askText: "Nøyaktig hvilken tekst skal trykkes?", askValue: "Hva skal det være, nøyaktig slik det skal trykkes?",
      runsOn: "Teksten for {field} inneholdt også den andre forespørselen din, så jeg endret den ikke.", askField: "Hva skal teksten for {field} være, helt for seg selv?",
      busy: "Boken blir oppdatert eller laget. Prøv igjen om litt.", restricted: "Jeg kan ikke trykke denne teksten i {field}.",
      prints: "{field} trykkes", notPrinted: "{field} trykkes ikke", needsHolder: "{field} trykkes når et forfatternavn eller en rettighetshaver er angitt",
      websiteNeedsBio: "Nettstedet er lagret og vises i delen om forfatteren når du legger til en biografi."
    }
  },
  pl: {
    fields: ["imię i nazwisko autora", "dedykacja", "o autorze", "strona internetowa", "właściciel praw autorskich", "wydawca", "ISBN", "klauzula Wszelkie prawa zastrzeżone"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Gotowe", unchanged: "Nic się nie zmieniło", removed: "Usunięto: {field}", already: "{field}: już ma wartość {value}", absent: "Ta książka nie zawiera: {field}",
      queued: "Aktualizuję pliki eksportu.", next: "Zostanie wydrukowane podczas przygotowania książki.", free: "Ta zmiana jest bezpłatna.", coverNew: "Nowe nazwisko pojawi się także na okładce.", coverOld: "Okładka zachowa poprzednie nazwisko.",
      failed: "Nie udało się teraz wprowadzić zmiany. Spróbuj później lub otwórz Title & credits książki.", notFound: "Nie udało się znaleźć tej książki.",
      titleKept: "Każda książka zachowuje stronę tytułową z tytułem oraz imieniem i nazwiskiem autora.", titleChange: "Mogę zmienić to, co się na niej znajduje: podaj imię i nazwisko autora, które ma się pojawić, albo powiedz „zmień tytuł książki na …”, aby nadać nowy tytuł.",
      studio: "Imię i nazwisko autora oraz dedykację tej książki ustawia się w Writing Studio. Zmień je tam i zaktualizuj książkę.",
      separate: "To osobna zmiana. Wyślij ją w oddzielnej wiadomości, a ją wprowadzę.", separateQuoted: "{request}: To osobna zmiana. Wyślij ją w oddzielnej wiadomości, a ją wprowadzę.",
      unclear: "Nadal nie wiem, co tam wydrukować.", sendOne: "Wyślij żądany tekst w jednej wiadomości — na przykład „Dodaj dedykację: Dla mojej mamy” albo „ISBN to 978…” — lub otwórz Title & credits książki i wpisz go samodzielnie.",
      notMatter: "W tej wiadomości nie znaleziono zmiany tytułu ani danych książki. Mogę zmienić imię i nazwisko autora, dedykację, stronę „O autorze”, stronę internetową, właściciela praw autorskich, wydawcę, ISBN lub klauzulę „Wszelkie prawa zastrzeżone” — wskaż, co zmienić i jak ma brzmieć.",
      copyrightAddRights: "Wiersz © jest drukowany zawsze, gdy książka ma imię i nazwisko autora lub właściciela praw autorskich, więc nie można go usunąć oddzielnie. Mogę zmienić nazwisko w tym wierszu albo dodać pod nim „Wszelkie prawa zastrzeżone”.",
      copyrightRemoveRights: "Wiersz © jest drukowany zawsze, gdy książka ma imię i nazwisko autora lub właściciela praw autorskich, więc nie można go usunąć oddzielnie. Mogę zmienić nazwisko w tym wierszu albo usunąć spod niego „Wszelkie prawa zastrzeżone”.",
      tooLong: "{field}: limit to {limit} znaków; ten tekst ma {length} znaków.", shorter: "Wyślij krótszy tekst.", shorterOrSheet: "Wyślij krótszy tekst w jednej wiadomości lub otwórz Title & credits książki i wpisz go samodzielnie.",
      invalidIsbn: "Ten ISBN jest nieprawidłowy. Musi mieć 10 lub 13 cyfr z poprawną cyfrą kontrolną.", isbnRefused: "Ten ISBN jest nieprawidłowy. Musi mieć 10 lub 13 cyfr z poprawną cyfrą kontrolną.",
      isbnOrSheet: "Sprawdź go i wyślij w jednej wiadomości — „ISBN to 978…” — lub otwórz Title & credits książki i wpisz go samodzielnie.", askIsbn: "Jaki dokładnie ISBN ma zostać wydrukowany?",
      notGiven: "W polu {field} drukuję tylko podane przez Ciebie informacje. Ten tekst zawiera informacje, których nie podano.", notGivenValue: "Drukuję tylko to, co mi podasz, a w Twojej wiadomości nie udało mi się znaleźć tego, co ma trafić do pola {field}.",
      askText: "Jaki dokładnie tekst ma zostać wydrukowany?", askValue: "Jak to ma brzmieć — dokładnie w takiej postaci, w jakiej ma zostać wydrukowane?",
      runsOn: "Tekst w polu {field} zawierał także drugą prośbę, więc pozostał bez zmian.", askField: "Co ma zawierać samo pole {field}, bez drugiej prośby?",
      busy: "Książka jest aktualizowana lub przygotowywana. Spróbuj ponownie za chwilę.", restricted: "Nie mogę wydrukować tego tekstu w polu {field}.",
      prints: "Zostanie wydrukowane: {field}", notPrinted: "Nie zostanie wydrukowane: {field}", needsHolder: "Pole {field} zostanie wydrukowane po podaniu autora lub właściciela praw",
      websiteNeedsBio: "Strona internetowa jest zapisana i pojawi się w sekcji o autorze po dodaniu biografii."
    }
  },
  pt: {
    fields: ["Nome do autor", "Dedicatória", "Sobre o autor", "Site", "Titular dos direitos", "Editora", "ISBN", "Linha de direitos reservados"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Concluído", unchanged: "Nada mudou", removed: "{field}: removido", already: "{field}: já é {value}", absent: "Este livro não contém: {field}",
      queued: "Estou atualizando os arquivos exportados.", next: "Será impresso quando o livro for preparado.", free: "Esta alteração é gratuita.", coverNew: "A capa também receberá o novo nome.", coverOld: "A capa mantém o nome anterior.",
      failed: "Não consegui fazer a alteração agora. Tente mais tarde ou abra Title & credits do livro.", notFound: "Não encontrei este livro.",
      titleKept: "Todo livro mantém a página de título, onde são impressos o título e o nome do autor.", titleChange: "Posso mudar o que aparece nela: diga qual nome do autor deve aparecer, ou diga “renomeie o livro para …” para um novo título.",
      studio: "O nome do autor e a dedicatória deste livro são alterados nas configurações do Writing Studio. Altere-os lá e atualize o livro.",
      separate: "Esta é uma alteração separada; envie-a em outra mensagem e eu cuido dela.", separateQuoted: "{request}: Esta é uma alteração separada; envie-a em outra mensagem e eu cuido dela.",
      unclear: "Ainda não consegui entender o que imprimir ali.", sendOne: "Envie em uma única mensagem, por exemplo “Adicione uma dedicatória: Para minha mãe” ou “O ISBN é 978…”, ou abra Title & credits do livro para digitar você mesmo.",
      notMatter: "Não encontrei nessa mensagem uma alteração do título ou dos dados do livro. Posso mudar o nome do autor, a dedicatória, a página Sobre o autor, o site, o titular dos direitos, a editora, o ISBN ou a linha “Todos os direitos reservados”; diga qual, e o que deve constar.",
      copyrightAddRights: "A linha © é impressa sempre que o livro tem um nome do autor ou um titular dos direitos, por isso não pode ser removida sozinha. Posso mudar o nome que aparece nela, ou adicionar “Todos os direitos reservados” abaixo dela.",
      copyrightRemoveRights: "A linha © é impressa sempre que o livro tem um nome do autor ou um titular dos direitos, por isso não pode ser removida sozinha. Posso mudar o nome que aparece nela, ou retirar o “Todos os direitos reservados” abaixo dela.",
      tooLong: "{field}: no máximo {limit} caracteres; este texto tem {length}.", shorter: "Envie um texto mais curto.", shorterOrSheet: "Envie um texto mais curto em uma única mensagem, ou abra Title & credits do livro para digitá-lo você mesmo.",
      invalidIsbn: "Este ISBN não é válido: são necessários 10 ou 13 dígitos com um dígito verificador correto.", isbnRefused: "Este ISBN não é válido: são necessários 10 ou 13 dígitos com um dígito verificador correto.",
      isbnOrSheet: "Confira e envie em uma única mensagem, como “O ISBN é 978…”, ou abra Title & credits do livro para digitá-lo você mesmo.", askIsbn: "Qual é o ISBN, exatamente como deve ser impresso?",
      notGiven: "{field}: imprimo somente informações que você fornece; o texto contém informações não fornecidas.", notGivenValue: "{field}: só imprimo o que você me informa, e não encontrei isso na sua mensagem.",
      askText: "Qual texto deve ser impresso exatamente?", askValue: "Qual deve ser o texto, exatamente como vai ser impresso?",
      runsOn: "O texto de {field} incluía seu outro pedido, por isso o mantive sem alterações.", askField: "{field}: qual texto deve constar, e nada mais?",
      busy: "O livro está sendo atualizado ou preparado. Tente novamente em instantes.", restricted: "Não posso imprimir este texto em {field}.",
      prints: "{field}: será impresso", notPrinted: "{field}: não será impresso", needsHolder: "{field}: será impresso quando houver autor ou titular dos direitos",
      websiteNeedsBio: "O site está salvo e aparecerá na seção sobre o autor quando você adicionar uma biografia."
    }
  },
  ru: {
    fields: ["Имя автора", "Посвящение", "Об авторе", "Сайт", "Правообладатель", "Издатель", "ISBN", "Строка об охране прав"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Готово", unchanged: "Ничего не изменилось", removed: "{field}: удалено", already: "{field}: уже {value}", absent: "В этой книге отсутствует: {field}",
      queued: "Обновляю файлы экспорта.", next: "Будет напечатано при подготовке книги.", free: "Это изменение бесплатно.", coverNew: "На обложке тоже будет новое имя.", coverOld: "На обложке останется прежнее имя.",
      failed: "Сейчас не удалось внести изменение. Попробуйте позже или откройте Title & credits книги.", notFound: "Не удалось найти эту книгу.",
      titleKept: "Титульный лист сохраняется в каждой книге: на нём печатаются название и имя автора.", titleChange: "Можно изменить то, что на нём написано: скажите, какое имя автора там должно стоять, или напишите «переименуй книгу в …», чтобы задать новое название.",
      studio: "Имя автора и посвящение этой книги меняются в настройках Writing Studio. Измените их там и обновите книгу.",
      separate: "Это отдельное изменение; отправьте его отдельным сообщением, и я выполню его.", separateQuoted: "{request}: Это отдельное изменение; отправьте его отдельным сообщением, и я выполню его.",
      unclear: "Мне всё ещё непонятно, что там напечатать.", sendOne: "Пришлите текст для печати одним сообщением — например, «Добавь посвящение: Моей маме» или «ISBN: 978…» — или откройте Title & credits книги, чтобы ввести его самостоятельно.",
      notMatter: "В этом сообщении не найдено изменения названия и выходных данных книги. Можно изменить имя автора, посвящение, страницу «Об авторе», сайт, правообладателя, издателя, ISBN или строку «Все права защищены» — укажите, что именно и что там должно быть написано.",
      copyrightAddRights: "Строка © печатается всегда, когда у книги есть имя автора или правообладатель, поэтому отдельно её не убрать. Можно изменить имя в ней или добавить под ней «Все права защищены».",
      copyrightRemoveRights: "Строка © печатается всегда, когда у книги есть имя автора или правообладатель, поэтому отдельно её не убрать. Можно изменить имя в ней или убрать «Все права защищены» под ней.",
      tooLong: "{field}: максимум {limit} символов; в этом тексте {length}.", shorter: "Пришлите более короткий текст.", shorterOrSheet: "Пришлите более короткий текст одним сообщением или откройте Title & credits книги, чтобы ввести его самостоятельно.",
      invalidIsbn: "ISBN недействителен: нужны 10 или 13 цифр с верной контрольной цифрой.", isbnRefused: "ISBN недействителен: нужны 10 или 13 цифр с верной контрольной цифрой.",
      isbnOrSheet: "Проверьте его и пришлите одним сообщением — «ISBN: 978…» — или откройте Title & credits книги, чтобы ввести его самостоятельно.", askIsbn: "Какой ISBN нужно напечатать — в точности в том виде, в каком он должен быть?",
      notGiven: "{field}: я печатаю только предоставленные вами сведения; в этом тексте есть сведения, которых вы не сообщали.", notGivenValue: "Я печатаю только то, что вы сообщаете, а в вашем сообщении не удалось найти, что указать в поле «{field}».",
      askText: "Какой именно текст нужно напечатать?", askValue: "Что там должно стоять — в точности как это будет напечатано?",
      runsOn: "{field}: текст включал другой ваш запрос, поэтому я оставил его без изменений.", askField: "Что именно указать в поле «{field}», отдельно от другого запроса?",
      busy: "Книга обновляется или готовится. Попробуйте чуть позже.", restricted: "Не могу напечатать этот текст: {field}.",
      prints: "{field}: печатается", notPrinted: "{field}: не печатается", needsHolder: "{field}: будет напечатано после указания имени автора или правообладателя",
      websiteNeedsBio: "Сайт сохранён и появится в разделе об авторе после добавления биографии."
    }
  },
  es: {
    fields: ["Nombre del autor", "Dedicatoria", "Sobre el autor", "Sitio web", "Titular de los derechos", "Editorial", "ISBN", "Línea de derechos reservados"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Hecho", unchanged: "Nada ha cambiado", removed: "{field}: eliminado", already: "{field}: ya es {value}", absent: "Este libro no contiene: {field}",
      queued: "Estoy actualizando los archivos exportados.", next: "Se imprimirá al preparar el libro.", free: "Este cambio es gratuito.", coverNew: "La portada también tendrá el nombre nuevo.", coverOld: "La portada conserva el nombre anterior.",
      failed: "No pude hacer el cambio ahora. Inténtalo más tarde o abre Title & credits del libro.", notFound: "No encontré este libro.",
      titleKept: "Todos los libros conservan su página de título, donde se imprimen el título y el nombre del autor.", titleChange: "Puedo cambiar lo que muestra: dime qué nombre del autor debe aparecer, o di «cambia el título del libro a …» para un título nuevo.",
      studio: "El nombre del autor y la dedicatoria se cambian en los ajustes de Writing Studio de este libro. Cámbialos allí y actualiza el libro.",
      separate: "Es un cambio separado; envíalo en otro mensaje y me ocuparé de él.", separateQuoted: "{request}: Es un cambio separado; envíalo en otro mensaje y me ocuparé de él.",
      unclear: "Sigo sin saber qué imprimir ahí.", sendOne: "Envíalo en un solo mensaje, por ejemplo «Añade una dedicatoria: Para mi mamá» o «El ISBN es 978…», o abre Title & credits del libro para escribirlo tú.",
      notMatter: "No encontré en ese mensaje un cambio del título o los datos del libro. Puedo cambiar el nombre del autor, la dedicatoria, la página Sobre el autor, el sitio web, el titular de los derechos, la editorial, el ISBN o la línea «Todos los derechos reservados»; dime cuál, y qué debe decir.",
      copyrightAddRights: "La línea © se imprime siempre que el libro tiene un nombre de autor o un titular de los derechos, así que no se puede quitar sola. Puedo cambiar el nombre que aparece en ella, o añadir «Todos los derechos reservados» debajo.",
      copyrightRemoveRights: "La línea © se imprime siempre que el libro tiene un nombre de autor o un titular de los derechos, así que no se puede quitar sola. Puedo cambiar el nombre que aparece en ella, o quitar el «Todos los derechos reservados» que lleva debajo.",
      tooLong: "{field}: máximo {limit} caracteres; este texto tiene {length}.", shorter: "Envía un texto más corto.", shorterOrSheet: "Envía un texto más corto en un solo mensaje, o abre Title & credits del libro para escribirlo tú.",
      invalidIsbn: "Este ISBN no es válido: necesita 10 o 13 dígitos con un dígito de control correcto.", isbnRefused: "Este ISBN no es válido: necesita 10 o 13 dígitos con un dígito de control correcto.",
      isbnOrSheet: "Revísalo y envíalo en un solo mensaje, como «El ISBN es 978…», o abre Title & credits del libro para escribirlo tú.", askIsbn: "¿Cuál es el ISBN, exactamente como debe imprimirse?",
      notGiven: "{field}: solo imprimo los datos que das; este texto contiene información que no has proporcionado.", notGivenValue: "{field}: solo imprimo lo que me dices, y no lo encontré en tu mensaje.",
      askText: "¿Qué texto debe imprimirse exactamente?", askValue: "¿Qué debe decir, exactamente como se imprimirá?",
      runsOn: "El texto de {field} incluía tu otra petición, así que lo dejé sin cambios.", askField: "{field}: ¿qué debe decir, y nada más?",
      busy: "El libro se está actualizando o preparando. Inténtalo de nuevo en un momento.", restricted: "No puedo imprimir este texto en {field}.",
      prints: "{field}: se imprime", notPrinted: "{field}: no se imprime", needsHolder: "{field}: se imprimirá cuando haya autor o titular de los derechos",
      websiteNeedsBio: "El sitio web está guardado y aparecerá en la sección sobre el autor cuando añadas una biografía."
    }
  },
  sv: {
    fields: ["författarnamn", "dedikation", "om författaren", "webbplats", "upphovsrättsinnehavare", "förlag", "ISBN", "raden Alla rättigheter förbehållna"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Klart", unchanged: "Inget ändrades", removed: "{field} har tagits bort", already: "{field} är redan {value}", absent: "Den här boken har inte {field}",
      queued: "Jag uppdaterar exportfilerna.", next: "Det trycks när boken skapas.", free: "Den här ändringen är gratis.", coverNew: "Det nya namnet hamnar även på omslaget.", coverOld: "Omslaget behåller det gamla namnet.",
      failed: "Jag kunde inte göra ändringen nu. Försök senare eller öppna bokens Title & credits.", notFound: "Jag kunde inte hitta den här boken.",
      titleKept: "Alla böcker behåller titelsidan där titeln och författarnamnet trycks.", titleChange: "Jag kan ändra vad som står där: berätta vilket författarnamn som ska visas, eller säg ”byt namn på boken till …” om du vill ha en ny titel.",
      studio: "Den här bokens författarnamn och dedikation anges i Writing Studio. Ändra dem där och uppdatera boken.",
      separate: "Det är en separat ändring. Skicka den i ett eget meddelande, så ordnar jag den.", separateQuoted: "{request}: Det är en separat ändring. Skicka den i ett eget meddelande, så ordnar jag den.",
      unclear: "Jag kunde fortfarande inte avgöra vad som ska tryckas där.", sendOne: "Skicka det i ett meddelande – till exempel ”Lägg till en dedikation: Till min mamma” eller ”ISBN-numret är 978…” – eller öppna bokens Title & credits och skriv in det själv.",
      notMatter: "Jag hittade ingen ändring av bokens titeluppgifter i det. Jag kan ändra författarnamnet, dedikationen, sidan Om författaren, webbplatsen, upphovsrättsinnehavaren, förlaget, ISBN eller raden ”Alla rättigheter förbehållna”; säg vilken det gäller och vad det ska stå.",
      copyrightAddRights: "Raden med © trycks när boken har ett författarnamn eller en upphovsrättsinnehavare, så den kan inte tas bort separat. Jag kan ändra vems namn som står på den, eller lägga till ”Alla rättigheter förbehållna” under den.",
      copyrightRemoveRights: "Raden med © trycks när boken har ett författarnamn eller en upphovsrättsinnehavare, så den kan inte tas bort separat. Jag kan ändra vems namn som står på den, eller ta bort ”Alla rättigheter förbehållna” under den.",
      tooLong: "{field} får ha högst {limit} tecken; texten har {length} tecken.", shorter: "Skicka en kortare text.", shorterOrSheet: "Skicka en kortare text i ett meddelande, eller öppna bokens Title & credits och skriv in den själv.",
      invalidIsbn: "Detta ISBN är ogiltigt. Det måste ha 10 eller 13 siffror med en korrekt kontrollsiffra.", isbnRefused: "Detta ISBN är ogiltigt. Det måste ha 10 eller 13 siffror med en korrekt kontrollsiffra.",
      isbnOrSheet: "Kontrollera det och skicka det i ett meddelande – ”ISBN-numret är 978…” – eller öppna bokens Title & credits och skriv in det själv.", askIsbn: "Vilket är ISBN-numret, exakt som det ska tryckas?",
      notGiven: "För {field} trycker jag bara uppgifter som du har lämnat. Texten innehåller uppgifter som du inte har angett.", notGivenValue: "För {field} trycker jag bara det du berättar för mig, och jag hittade det inte i ditt meddelande.",
      askText: "Exakt vilken text ska tryckas?", askValue: "Vad ska det vara, exakt som det ska tryckas?",
      runsOn: "Texten för {field} innehöll även din andra begäran, så jag ändrade den inte.", askField: "Vad ska texten för {field} vara, helt för sig själv?",
      busy: "Boken uppdateras eller skapas. Försök igen om en stund.", restricted: "Jag kan inte trycka den här texten i {field}.",
      prints: "{field} trycks", notPrinted: "{field} trycks inte", needsHolder: "{field} trycks när ett författarnamn eller en upphovsrättsinnehavare har angetts",
      websiteNeedsBio: "Webbplatsen är sparad och visas i avsnittet om författaren när du lägger till en biografi."
    }
  },
  th: {
    fields: ["ชื่อผู้เขียน", "คำอุทิศ", "เกี่ยวกับผู้เขียน", "เว็บไซต์", "ผู้ถือลิขสิทธิ์", "สำนักพิมพ์", "ISBN", "ข้อความสงวนลิขสิทธิ์"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "เรียบร้อย", unchanged: "ไม่มีการเปลี่ยนแปลง", removed: "ลบ{field}แล้ว", already: "{field}เป็น {value} อยู่แล้ว", absent: "หนังสือเล่มนี้ไม่มี{field}",
      queued: "กำลังอัปเดตไฟล์ส่งออก", next: "ข้อความนี้จะพิมพ์เมื่อจัดทำหนังสือ", free: "การเปลี่ยนแปลงนี้ไม่มีค่าใช้จ่าย", coverNew: "ชื่อใหม่จะปรากฏบนปกด้วย", coverOld: "ปกจะยังใช้ชื่อเดิม",
      failed: "ตอนนี้ยังเปลี่ยนแปลงไม่ได้ โปรดลองอีกครั้งภายหลังหรือเปิด Title & credits ของหนังสือ", notFound: "ไม่พบหนังสือเล่มนี้",
      titleKept: "หนังสือทุกเล่มจะเก็บหน้าชื่อเรื่องไว้ โดยพิมพ์ชื่อเรื่องและชื่อผู้เขียนในหน้านั้น", titleChange: "เปลี่ยนข้อความในหน้านี้ได้ โปรดบอกชื่อผู้เขียนที่ต้องการให้แสดง หรือหากต้องการชื่อเรื่องใหม่ ให้พิมพ์ว่า ‘เปลี่ยนชื่อหนังสือเป็น …’",
      studio: "ชื่อผู้เขียนและคำอุทิศของหนังสือเล่มนี้ตั้งค่าใน Writing Studio โปรดแก้ไขที่นั่นแล้วอัปเดตหนังสือ",
      separate: "นี่เป็นการเปลี่ยนแปลงอีกอย่าง โปรดส่งเป็นข้อความแยกเพื่อให้ดำเนินการได้", separateQuoted: "{request}: นี่เป็นการเปลี่ยนแปลงอีกอย่าง โปรดส่งเป็นข้อความแยกเพื่อให้ดำเนินการได้",
      unclear: "ยังบอกไม่ได้ว่าต้องการให้พิมพ์อะไรตรงนั้น", sendOne: "ส่งมาในข้อความเดียว เช่น ‘เพิ่มคำอุทิศ: แด่แม่’ หรือ ‘ISBN คือ 978…’ หรือเปิด Title & credits ของหนังสือเพื่อกรอกเอง",
      notMatter: "ไม่พบการเปลี่ยนแปลงข้อมูลหนังสือในข้อความนั้น เปลี่ยนชื่อผู้เขียน คำอุทิศ หน้าเกี่ยวกับผู้เขียน เว็บไซต์ ผู้ถือลิขสิทธิ์ สำนักพิมพ์ ISBN หรือข้อความ ‘สงวนลิขสิทธิ์’ ได้ โปรดบอกว่าต้องการเปลี่ยนส่วนใด และให้มีข้อความว่าอะไร",
      copyrightAddRights: "บรรทัด © จะพิมพ์ทุกครั้งที่หนังสือมีชื่อผู้เขียนหรือผู้ถือลิขสิทธิ์ จึงลบออกแยกต่างหากไม่ได้ แต่เปลี่ยนชื่อที่อยู่ในบรรทัดนี้ได้ หรือเพิ่ม ‘สงวนลิขสิทธิ์’ ไว้ใต้บรรทัดนี้ได้",
      copyrightRemoveRights: "บรรทัด © จะพิมพ์ทุกครั้งที่หนังสือมีชื่อผู้เขียนหรือผู้ถือลิขสิทธิ์ จึงลบออกแยกต่างหากไม่ได้ แต่เปลี่ยนชื่อที่อยู่ในบรรทัดนี้ได้ หรือนำ ‘สงวนลิขสิทธิ์’ ออกจากบรรทัดนี้ได้",
      tooLong: "{field}ยาวได้ไม่เกิน {limit} อักขระ ข้อความนี้มี {length} อักขระ", shorter: "โปรดส่งข้อความที่สั้นลง", shorterOrSheet: "ส่งข้อความที่สั้นลงมาในข้อความเดียว หรือเปิด Title & credits ของหนังสือเพื่อกรอกเอง",
      invalidIsbn: "ISBN นี้ไม่ถูกต้อง ต้องมี 10 หรือ 13 หลักพร้อมเลขตรวจสอบที่ถูกต้อง", isbnRefused: "ISBN นี้ไม่ถูกต้อง ต้องมี 10 หรือ 13 หลักพร้อมเลขตรวจสอบที่ถูกต้อง",
      isbnOrSheet: "โปรดตรวจสอบแล้วส่งมาในข้อความเดียว เช่น ‘ISBN คือ 978…’ หรือเปิด Title & credits ของหนังสือเพื่อกรอกเอง", askIsbn: "ISBN ที่ต้องการให้พิมพ์คืออะไรแน่นอน?",
      notGiven: "สำหรับ{field} จะพิมพ์เฉพาะข้อมูลที่คุณให้มา ข้อความนี้มีข้อมูลที่คุณยังไม่ได้ให้", notGivenValue: "จะพิมพ์เฉพาะสิ่งที่คุณบอกเท่านั้น และไม่พบ{field}ในข้อความของคุณ",
      askText: "ต้องการให้พิมพ์ข้อความว่าอะไรแน่นอน?", askValue: "ต้องการให้เป็นอะไร ตรงตามที่จะพิมพ์ทุกตัวอักษร?",
      runsOn: "ข้อความใน{field}มีคำขออื่นของคุณรวมอยู่ด้วย จึงไม่ได้เปลี่ยนแปลง", askField: "{field}ควรมีข้อความว่าอะไร โดยไม่มีอย่างอื่นปน?",
      busy: "หนังสือกำลังอัปเดตหรือจัดทำ โปรดลองอีกครั้งในอีกสักครู่", restricted: "ไม่สามารถพิมพ์ข้อความนี้ใน{field}ได้",
      prints: "จะพิมพ์{field}", notPrinted: "จะไม่พิมพ์{field}", needsHolder: "จะพิมพ์{field}เมื่อตั้งชื่อผู้เขียนหรือผู้ถือลิขสิทธิ์แล้ว",
      websiteNeedsBio: "บันทึกเว็บไซต์แล้ว และจะแสดงในส่วนเกี่ยวกับผู้เขียนเมื่อคุณเพิ่มประวัติผู้เขียน"
    }
  },
  tr: {
    fields: ["Yazar adı", "İthaf", "Yazar hakkında", "Web sitesi", "Telif hakkı sahibi", "Yayınevi", "ISBN", "Haklar saklıdır satırı"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Tamamlandı", unchanged: "Hiçbir şey değişmedi", removed: "{field}: kaldırıldı", already: "{field}: zaten {value}", absent: "Bu kitapta {field} yok",
      queued: "Dışa aktarma dosyalarını güncelliyorum.", next: "Kitap hazırlanırken basılacak.", free: "Bu değişiklik ücretsizdir.", coverNew: "Kapakta da yeni ad yer alacak.", coverOld: "Kapak önceki adı koruyacak.",
      failed: "Şu anda değişikliği yapamadım. Biraz sonra tekrar deneyin veya kitabın Title & credits bölümünü açın.", notFound: "Bu kitabı bulamadım.",
      titleKept: "Her kitap başlık sayfasını korur; başlık ve yazar adı orada basılır.", titleChange: "Üzerinde yazanı değiştirebilirim: görünmesi gereken yazar adını söyleyin ya da yeni başlık için “kitabın adını … olarak değiştir” deyin.",
      studio: "Bu kitabın yazar adı ve ithafı Writing Studio ayarlarında değiştirilir. Orada değiştirip kitabı güncelleyin.",
      separate: "Bu ayrı bir değişikliktir; ayrı bir mesajda gönderin, ilgileneyim.", separateQuoted: "{request}: Bu ayrı bir değişikliktir; ayrı bir mesajda gönderin, ilgileneyim.",
      unclear: "Oraya ne basılacağını hâlâ anlayamadım.", sendOne: "Basılacak metni tek mesajda gönderin (örneğin “İthaf ekle: Anneme” veya “ISBN numarası 978…”) ya da kendiniz yazmak için kitabın Title & credits bölümünü açın.",
      notMatter: "Bu mesajda başlık ve kitap bilgilerine yönelik bir değişiklik bulamadım. Yazar adını, ithafı, “Yazar hakkında” sayfasını, web sitesini, telif hakkı sahibini, yayınevini, ISBN’yi veya “Tüm hakları saklıdır” satırını değiştirebilirim; hangisi olduğunu ve ne yazması gerektiğini söyleyin.",
      copyrightAddRights: "© satırı, kitapta yazar adı veya telif hakkı sahibi olduğu sürece basılır, bu yüzden tek başına kaldırılamaz. Üzerindeki adı değiştirebilir veya altına “Tüm hakları saklıdır” ekleyebilirim.",
      copyrightRemoveRights: "© satırı, kitapta yazar adı veya telif hakkı sahibi olduğu sürece basılır, bu yüzden tek başına kaldırılamaz. Üzerindeki adı değiştirebilir veya altındaki “Tüm hakları saklıdır” ifadesini kaldırabilirim.",
      tooLong: "{field}: en fazla {limit} karakter; bu metin {length} karakter.", shorter: "Daha kısa bir metin gönderin.", shorterOrSheet: "Daha kısa bir metni tek mesajda gönderin ya da kendiniz yazmak için kitabın Title & credits bölümünü açın.",
      invalidIsbn: "Bu ISBN geçerli değil; doğru kontrol basamağıyla 10 veya 13 rakam gerekir.", isbnRefused: "Bu ISBN geçerli değil; doğru kontrol basamağıyla 10 veya 13 rakam gerekir.",
      isbnOrSheet: "Kontrol edip tek mesajda gönderin (“ISBN numarası 978…”) ya da kendiniz yazmak için kitabın Title & credits bölümünü açın.", askIsbn: "ISBN tam olarak basılacağı haliyle nedir?",
      notGiven: "{field}: yalnızca verdiğiniz bilgileri basarım; bu metin vermediğiniz bilgiler içeriyor.", notGivenValue: "Yalnızca bana söylediklerinizi basarım ve mesajınızda “{field}” bilgisini bulamadım.",
      askText: "Tam olarak hangi metin basılmalı?", askValue: "Tam olarak basılacağı haliyle ne olmalı?",
      runsOn: "{field} metni diğer isteğinizi de içeriyordu, bu yüzden değiştirmedim.", askField: "“{field}” alanında tek başına ne yazmalı?",
      busy: "Kitap güncelleniyor veya hazırlanıyor. Biraz sonra tekrar deneyin.", restricted: "Bu metni {field} bölümünde basamam.",
      prints: "{field}: basılacak", notPrinted: "{field}: basılmayacak", needsHolder: "{field}: yazar veya hak sahibi belirlendiğinde basılacak",
      websiteNeedsBio: "Web sitesi kaydedildi; biyografi eklediğinizde yazar hakkında bölümünde görünecek."
    }
  },
  uk: {
    fields: ["ім’я автора", "присвята", "про автора", "вебсайт", "власник авторських прав", "видавець", "ISBN", "рядок Усі права захищено"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Готово", unchanged: "Нічого не змінилося", removed: "Видалено: {field}", already: "{field}: уже має значення {value}", absent: "У цій книзі немає: {field}",
      queued: "Оновлюю файли експорту.", next: "Це буде надруковано під час підготовки книги.", free: "Ця зміна безкоштовна.", coverNew: "Нове ім’я також з’явиться на обкладинці.", coverOld: "На обкладинці залишиться попереднє ім’я.",
      failed: "Зараз не вдалося внести зміну. Спробуйте пізніше або відкрийте Title & credits книги.", notFound: "Не вдалося знайти цю книгу.",
      titleKept: "Кожна книга зберігає титульну сторінку, на якій друкуються назва та ім’я автора.", titleChange: "Я можу змінити те, що на ній написано: скажіть, яке ім’я автора там має стояти, або напишіть «перейменуй книгу на …», щоб задати нову назву.",
      studio: "Ім’я автора та присвята цієї книги задаються у Writing Studio. Змініть їх там і оновіть книгу.",
      separate: "Це окрема зміна. Надішліть її окремим повідомленням, і я її внесу.", separateQuoted: "{request}: Це окрема зміна. Надішліть її окремим повідомленням, і я її внесу.",
      unclear: "Мені досі незрозуміло, що там надрукувати.", sendOne: "Надішліть потрібний текст одним повідомленням — наприклад, «Додай присвяту: Моїй мамі» або «ISBN: 978…» — або відкрийте Title & credits книги, щоб ввести його самостійно.",
      notMatter: "У цьому повідомленні не знайдено зміни назви та відомостей про книгу. Я можу змінити ім’я автора, присвяту, сторінку «Про автора», вебсайт, власника авторських прав, видавця, ISBN або рядок «Усі права захищено» — вкажіть, що саме і що там має бути написано.",
      copyrightAddRights: "Рядок © друкується завжди, коли в книзі є ім’я автора або власник авторських прав, тому окремо його не прибрати. Я можу змінити ім’я в ньому або додати під ним «Усі права захищено».",
      copyrightRemoveRights: "Рядок © друкується завжди, коли в книзі є ім’я автора або власник авторських прав, тому окремо його не прибрати. Я можу змінити ім’я в ньому або прибрати «Усі права захищено» під ним.",
      tooLong: "{field}: не більше {limit} символів; у цьому тексті {length}.", shorter: "Надішліть коротший текст.", shorterOrSheet: "Надішліть коротший текст одним повідомленням або відкрийте Title & credits книги, щоб ввести його самостійно.",
      invalidIsbn: "Цей ISBN недійсний. Потрібно 10 або 13 цифр із правильною контрольною цифрою.", isbnRefused: "Цей ISBN недійсний. Потрібно 10 або 13 цифр із правильною контрольною цифрою.",
      isbnOrSheet: "Перевірте його й надішліть одним повідомленням — «ISBN: 978…» — або відкрийте Title & credits книги, щоб ввести його самостійно.", askIsbn: "Який ISBN надрукувати — точно в тому вигляді, у якому він має бути?",
      notGiven: "У полі {field} друкую лише надані вами відомості. У цьому тексті є відомості, яких ви не надали.", notGivenValue: "Я друкую лише те, що ви повідомляєте, а у вашому повідомленні не вдалося знайти, що вказати в полі {field}.",
      askText: "Який саме текст потрібно надрукувати?", askValue: "Що там має стояти — точно так, як це буде надруковано?",
      runsOn: "Текст у полі {field} також містив ваш інший запит, тому я його не змінив.", askField: "Що саме вказати в полі {field}, окремо від іншого запиту?",
      busy: "Книга оновлюється або готується. Спробуйте ще раз трохи пізніше.", restricted: "Не можу надрукувати цей текст у полі {field}.",
      prints: "Буде надруковано: {field}", notPrinted: "Не буде надруковано: {field}", needsHolder: "Поле {field} буде надруковано після зазначення автора або власника прав",
      websiteNeedsBio: "Вебсайт збережено; він з’явиться в розділі про автора після додавання біографії."
    }
  },
  ur: {
    fields: ["مصنف کا نام", "انتساب", "مصنف کے بارے میں", "ویب سائٹ", "حقوق کے مالک", "ناشر", "ISBN", "جملہ حقوق محفوظ ہیں کی سطر"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "ہو گیا", unchanged: "کچھ نہیں بدلا", removed: "{field} ہٹا دیا گیا", already: "{field} پہلے سے {value} ہے", absent: "اس کتاب میں {field} نہیں ہے",
      queued: "برآمدی فائلیں تازہ کر رہا ہوں۔", next: "کتاب تیار ہوتے وقت چھپے گا۔", free: "یہ تبدیلی مفت ہے۔", coverNew: "سرورق پر بھی نیا نام آئے گا۔", coverOld: "سرورق پر پرانا نام رہے گا۔",
      failed: "ابھی تبدیلی نہیں کر سکا۔ کچھ دیر بعد کوشش کریں یا کتاب کا Title & credits کھولیں۔", notFound: "یہ کتاب نہیں ملی۔",
      titleKept: "ہر کتاب کا عنوانی صفحہ برقرار رہتا ہے؛ عنوان اور مصنف کا نام وہاں چھپتے ہیں۔", titleChange: "اس پر لکھا ہوا بدل سکتا ہوں: بتائیں کہ اس پر مصنف کا کون سا نام دکھانا ہے، یا نئے عنوان کے لیے «کتاب کا نام بدل کر … کر دیں» کہیں۔",
      studio: "اس کتاب کے مصنف کا نام اور انتساب Writing Studio کی ترتیبات میں بدلیں، پھر کتاب تازہ کریں۔",
      separate: "یہ الگ تبدیلی ہے؛ اسے الگ پیغام میں بھیجیں، میں کر دوں گا۔", separateQuoted: "{request}: یہ الگ تبدیلی ہے؛ اسے الگ پیغام میں بھیجیں، میں کر دوں گا۔",
      unclear: "میں اب بھی نہیں سمجھ سکا کہ وہاں کیا چھاپنا ہے۔", sendOne: "اسے ایک پیغام میں بھیجیں، مثلاً «انتساب شامل کریں: میری امی کے نام» یا «ISBN نمبر 978… ہے»، یا کتاب کا Title & credits کھول کر خود درج کریں۔",
      notMatter: "اس میں عنوان اور اشاعتی معلومات کی کوئی تبدیلی نہیں ملی۔ میں مصنف کا نام، انتساب، مصنف کا تعارفی صفحہ، ویب سائٹ، حقوق کے مالک، ناشر، ISBN یا «جملہ حقوق محفوظ ہیں» کی سطر بدل سکتا ہوں؛ بتائیں کون سی چیز، اور اس میں کیا لکھا ہونا چاہیے۔",
      copyrightAddRights: "جب بھی کتاب میں مصنف کا نام یا حقوق کے مالک ہوں تو © کی سطر چھپتی ہے، اس لیے یہ اکیلے نہیں ہٹ سکتی۔ میں اس پر درج نام بدل سکتا ہوں، یا اس کے نیچے «جملہ حقوق محفوظ ہیں» شامل کر سکتا ہوں۔",
      copyrightRemoveRights: "جب بھی کتاب میں مصنف کا نام یا حقوق کے مالک ہوں تو © کی سطر چھپتی ہے، اس لیے یہ اکیلے نہیں ہٹ سکتی۔ میں اس پر درج نام بدل سکتا ہوں، یا اس سے «جملہ حقوق محفوظ ہیں» ہٹا سکتا ہوں۔",
      tooLong: "{field} میں زیادہ سے زیادہ {limit} حروف ہو سکتے ہیں؛ اس متن میں {length} حروف ہیں۔", shorter: "چھوٹا متن بھیجیں۔", shorterOrSheet: "ایک پیغام میں چھوٹا متن بھیجیں، یا کتاب کا Title & credits کھول کر خود درج کریں۔",
      invalidIsbn: "یہ ISBN درست نہیں؛ صحیح پڑتالی ہندسے کے ساتھ 10 یا 13 ہندسے درکار ہیں۔", isbnRefused: "یہ ISBN درست نہیں؛ صحیح پڑتالی ہندسے کے ساتھ 10 یا 13 ہندسے درکار ہیں۔",
      isbnOrSheet: "اسے جانچ کر ایک پیغام میں بھیجیں، جیسے «ISBN نمبر 978… ہے»، یا کتاب کا Title & credits کھول کر خود درج کریں۔", askIsbn: "ISBN ٹھیک ٹھیک کیا ہے، بالکل جیسا اسے چھپنا چاہیے?",
      notGiven: "{field} میں صرف آپ کی دی ہوئی معلومات چھاپتا ہوں؛ اس متن میں ایسی معلومات ہیں جو آپ نے نہیں دیں۔", notGivenValue: "میں صرف وہی چھاپتا ہوں جو آپ بتائیں، اور آپ کے پیغام میں {field} کا ذکر نہیں ملا۔",
      askText: "بالکل کون سا متن چھاپنا ہے؟", askValue: "یہ ٹھیک ٹھیک کیا ہونا چاہیے، بالکل جیسا اسے چھپنا ہے?",
      runsOn: "{field} کے متن میں آپ کی دوسری درخواست تھی، اس لیے اسے نہیں بدلا۔", askField: "صرف {field} کے لیے کیا لکھا جائے?",
      busy: "کتاب تازہ یا تیار ہو رہی ہے۔ کچھ دیر بعد کوشش کریں۔", restricted: "یہ متن {field} میں نہیں چھاپ سکتا۔",
      prints: "{field} چھپے گا", notPrinted: "{field} نہیں چھپے گا", needsHolder: "مصنف یا حقوق کے مالک کا نام طے ہونے پر {field} چھپے گا",
      websiteNeedsBio: "ویب سائٹ محفوظ ہے۔ سوانح شامل کرنے کے بعد یہ مصنف کے تعارف میں دکھائی دے گی۔"
    }
  },
  vi: {
    fields: ["tên tác giả", "lời đề tặng", "giới thiệu tác giả", "trang web", "chủ sở hữu bản quyền", "nhà xuất bản", "ISBN", "dòng bảo lưu mọi quyền"],
    fieldSeparator: ", ", changeGrammar: "listed",
    messages: {
      done: "Đã xong", unchanged: "Không có gì thay đổi", removed: "Đã xóa {field}", already: "{field} đã là {value}", absent: "Cuốn sách này không có {field}",
      queued: "Tôi đang cập nhật các tệp xuất.", next: "Nội dung này sẽ được in khi sách được tạo.", free: "Thay đổi này miễn phí.", coverNew: "Tên mới cũng sẽ xuất hiện trên bìa.", coverOld: "Bìa vẫn giữ tên cũ.",
      failed: "Hiện chưa thể thực hiện thay đổi. Hãy thử lại sau hoặc mở Title & credits của sách.", notFound: "Tôi không tìm thấy cuốn sách này.",
      titleKept: "Mọi cuốn sách đều giữ trang tên sách, nơi in tên sách và tên tác giả.", titleChange: "Tôi có thể thay đổi nội dung trên đó: hãy cho biết tên tác giả cần hiển thị, hoặc nói ‘đổi tên sách thành …’ để có tên sách mới.",
      studio: "Tên tác giả và lời đề tặng của sách này được đặt trong Writing Studio. Hãy sửa tại đó rồi cập nhật sách.",
      separate: "Đây là thay đổi riêng. Hãy gửi trong một tin nhắn riêng để tôi thực hiện.", separateQuoted: "{request}: Đây là thay đổi riêng. Hãy gửi trong một tin nhắn riêng để tôi thực hiện.",
      unclear: "Tôi vẫn chưa rõ cần in gì ở đó.", sendOne: "Hãy gửi nội dung muốn in trong một tin nhắn — ví dụ ‘Thêm lời đề tặng: Tặng mẹ tôi’ hoặc ‘ISBN là 978…’ — hoặc mở Title & credits của sách để tự nhập.",
      notMatter: "Tôi không tìm thấy thay đổi nào về tên sách và thông tin sách trong tin nhắn đó. Tôi có thể thay đổi tên tác giả, lời đề tặng, trang Về tác giả, trang web, chủ sở hữu bản quyền, nhà xuất bản, ISBN hoặc dòng ‘Bảo lưu mọi quyền’ — hãy cho biết mục nào và nội dung cần in.",
      copyrightAddRights: "Dòng © được in bất cứ khi nào sách có tên tác giả hoặc chủ sở hữu bản quyền, nên không thể xóa riêng dòng này. Tôi có thể đổi tên trên dòng đó, hoặc thêm dòng ‘Bảo lưu mọi quyền’ bên dưới.",
      copyrightRemoveRights: "Dòng © được in bất cứ khi nào sách có tên tác giả hoặc chủ sở hữu bản quyền, nên không thể xóa riêng dòng này. Tôi có thể đổi tên trên dòng đó, hoặc bỏ dòng ‘Bảo lưu mọi quyền’ bên dưới.",
      tooLong: "{field} có tối đa {limit} ký tự; văn bản này có {length} ký tự.", shorter: "Hãy gửi văn bản ngắn hơn.", shorterOrSheet: "Hãy gửi văn bản ngắn hơn trong một tin nhắn, hoặc mở Title & credits của sách để tự nhập.",
      invalidIsbn: "ISBN này không hợp lệ. Cần 10 hoặc 13 chữ số với chữ số kiểm tra chính xác.", isbnRefused: "ISBN này không hợp lệ. Cần 10 hoặc 13 chữ số với chữ số kiểm tra chính xác.",
      isbnOrSheet: "Hãy kiểm tra lại và gửi trong một tin nhắn — ‘ISBN là 978…’ — hoặc mở Title & credits của sách để tự nhập.", askIsbn: "ISBN chính xác cần in là gì?",
      notGiven: "Với {field}, tôi chỉ in thông tin bạn đã cung cấp. Văn bản này có thông tin bạn chưa cung cấp.", notGivenValue: "Tôi chỉ in những gì bạn cho tôi biết, và tôi không tìm thấy {field} trong tin nhắn của bạn.",
      askText: "Chính xác nội dung nào cần được in?", askValue: "Nội dung đó nên là gì, đúng y như sẽ được in?",
      runsOn: "Văn bản của {field} chứa cả yêu cầu khác của bạn nên tôi chưa thay đổi.", askField: "Riêng phần {field} nên ghi gì?",
      busy: "Sách đang được cập nhật hoặc tạo. Hãy thử lại sau một lát.", restricted: "Tôi không thể in văn bản này trong {field}.",
      prints: "{field} sẽ được in", notPrinted: "{field} sẽ không được in", needsHolder: "{field} sẽ được in khi có tên tác giả hoặc chủ sở hữu bản quyền",
      websiteNeedsBio: "Trang web đã được lưu và sẽ xuất hiện trong phần giới thiệu tác giả khi bạn thêm tiểu sử."
    }
  }
};

const FIELD_INDEX: Record<BookMatterChatField, number> = {
  authorName: 0, dedication: 1, aboutAuthor: 2, authorWebsite: 3,
  copyrightHolder: 4, imprint: 5, isbn: 6, allRightsReserved: 7
};

export type MatterChatText = ReturnType<typeof localizedMatterChatCopy>;

export function localizedMatterChatCopy(language: MatterChatLanguage) {
  const copy = chatCopy(MATTER_CHAT_COPY, language);
  return {
    fieldSeparator: copy.fieldSeparator,
    changeGrammar: copy.changeGrammar,
    field: (field: BookMatterChatField) => copy.fields[FIELD_INDEX[field]]!,
    text: (notice: MatterChatNotice, values: Record<string, string> = {}) => fillChatCopy(copy.messages[notice], values)
  };
}
