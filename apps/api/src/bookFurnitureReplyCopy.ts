import type { ConversationLanguage, PdfPageZone } from "@book-maker/core";
import type { BookBackMatterContents, BookFrontMatterPage } from "./bookPageNumbering.js";
import { chatCopy, fillChatCopy, type ChatCopyTable } from "./chatReplyCopy.js";

type FurnitureCopy = Record<
  "cover" | "contents" | "title" | "sheet" | "front" | "sources" | "author" | "both" | "back" | "outside" | "story",
  string
>;

/**
 * What a printed page that holds no prose is — the cover, the Contents, the
 * front and back matter — and what to ask for instead, in every conversation
 * language. Deterministic on purpose: this is the model-less path's answer, and
 * the fallback for a routed edit whose model call may fail, so the router's
 * `responseLanguage` alone cannot localize it. `{page}` is the printed number
 * the reader spoke; `story` is appended when the printed range of the prose is
 * known.
 */
export const FURNITURE_REPLY_COPY: ChatCopyTable<FurnitureCopy> = {
  en: {
    cover: "That’s the book’s cover — there’s no page text on it to edit. To change the cover, tell me what you’d like it to show.",
    contents: "Printed page {page} is the table of contents. It’s rebuilt from the chapters at every export, so there’s nothing on it to edit directly — say “don’t use the word Chapter” or similar to restyle its headings.",
    title: "Printed page {page} is the book’s title page — it prints the title and the author name, not page text, and every book keeps one. Say “rename the book to …” or “change the author name to …” to change what it says.",
    sheet: "Printed page {page} holds the dedication and the publication details — the © line, the publisher and the ISBN. They’re printed from the book’s details, not its pages: tell me what to change, like “dedicate it to my mom” or “remove the ISBN”.",
    front: "Printed page {page} is the book’s front matter — the title page or the dedication and publication details, not page text. Tell me what to change there, like the author name, the dedication or the ISBN, or say “rename the book to …”.",
    sources: "Printed page {page} is the Sources list at the back of the book. It’s rebuilt at every export — say “remove the sources list” if you’d like it gone.",
    author: "Printed page {page} is the About the Author page at the back of the book. It’s printed from the book’s details, not its pages — tell me how the biography should change (or to remove it), or edit it in the book’s Title & credits.",
    both: "Printed page {page} is in the back matter, where the Sources list and the About the Author page are printed. Neither is page text: say “remove the sources list” if you’d like it gone, or tell me how the biography should change (or to remove it), or edit it in the book’s Title & credits.",
    back: "Printed page {page} is one of the pages at the end of the book, after its text — there’s no page text on it to edit.",
    outside: "This book’s PDF doesn’t have a printed page {page}.",
    story: "The story runs on printed pages {range}."
  },
  ar: {
    cover: "هذا غلاف الكتاب ولا يحتوي على نص صفحة لتعديله. أخبرني بما تريد أن يظهر على الغلاف.",
    contents: "الصفحة المطبوعة {page} هي جدول المحتويات. يُعاد إنشاؤه من الفصول عند كل تصدير، لذا لا يوجد فيه ما يُعدَّل مباشرة؛ قل «لا تستخدم كلمة الفصل» أو ما يشبهها لتغيير نمط عناوينه.",
    title: "الصفحة المطبوعة {page} هي صفحة عنوان الكتاب؛ تحمل العنوان واسم المؤلف، لا نص صفحة، ويحتفظ كل كتاب بهذه الصفحة. قل «غيّر اسم الكتاب إلى …» أو «غيّر اسم المؤلف إلى …» لتغيير ما تعرضه.",
    sheet: "الصفحة المطبوعة {page} تحمل الإهداء وبيانات النشر: سطر © والناشر ورقم ISBN. تُطبع هذه من بيانات الكتاب لا من صفحاته؛ أخبرني بما تريد تغييره، مثل «أهدِ الكتاب إلى أمي» أو «احذف رقم ISBN».",
    front: "الصفحة المطبوعة {page} من الصفحات التمهيدية للكتاب: صفحة العنوان أو الإهداء وبيانات النشر، لا نص صفحة. أخبرني بما تريد تغييره هناك، مثل اسم المؤلف أو الإهداء أو رقم ISBN، أو قل «غيّر اسم الكتاب إلى …».",
    sources: "الصفحة المطبوعة {page} هي قائمة المصادر في نهاية الكتاب، ويُعاد إنشاؤها عند كل تصدير؛ قل «احذف قائمة المصادر» إذا أردت إزالتها.",
    author: "الصفحة المطبوعة {page} هي صفحة عن المؤلف في نهاية الكتاب. تُطبع من بيانات الكتاب لا من صفحاته؛ أخبرني كيف تريد تعديل النبذة (أو حذفها)، أو عدّلها من Title & credits في الكتاب.",
    both: "الصفحة المطبوعة {page} ضمن الصفحات الختامية التي تُطبع فيها قائمة المصادر وصفحة عن المؤلف. وليس أي منهما نص صفحة: قل «احذف قائمة المصادر» إذا أردت إزالتها، أو أخبرني كيف تريد تعديل النبذة (أو حذفها)، أو عدّلها من Title & credits في الكتاب.",
    back: "الصفحة المطبوعة {page} من الصفحات الختامية بعد متن الكتاب، ولا تحتوي على نص صفحة لتعديله.",
    outside: "ملف هذا الكتاب لا يحتوي على صفحة مطبوعة برقم {page}.",
    story: "متن الكتاب في الصفحات المطبوعة {range}."
  },
  zh: {
    cover: "这是书的封面，没有可编辑的正文。请说明你希望封面呈现什么。",
    contents: "印刷页码 {page} 是目录。每次导出时，目录都会根据各章重新生成，因此上面没有可以直接编辑的内容；如需调整其中标题的样式，可以说“不要显示‘第几章’”之类的话。",
    title: "印刷页码 {page} 是本书的扉页，印有书名和作者名，而不是正文，每本书都会保留扉页。要修改上面的内容，可以说“把书名改成……”或“把作者名改成……”。",
    sheet: "印刷页码 {page} 是献词和出版信息：© 行、出版社和 ISBN。这些内容根据图书信息印出，而不是来自正文页面；请说明要修改什么，例如“把这本书献给我妈妈”或“删除 ISBN”。",
    front: "印刷页码 {page} 属于书前页，包含扉页或献词与出版信息，而不是正文。请说明要修改那里的什么内容，例如作者名、献词或 ISBN，或者说“把书名改成……”。",
    sources: "印刷页码 {page} 是书末的参考来源列表，每次导出时都会重新生成；如需删除，可以说“删除参考来源列表”。",
    author: "印刷页码 {page} 是书末的“关于作者”页面。它根据图书信息印出，而不是来自正文页面；请说明简介要如何修改（或要求删除），也可以在图书的 Title & credits 中编辑。",
    both: "印刷页码 {page} 属于书末部分，这里印有参考来源列表和“关于作者”页面。两者都不是正文：如需删除参考来源列表，可以说“删除参考来源列表”；也可以说明简介要如何修改（或要求删除），或在图书的 Title & credits 中编辑。",
    back: "印刷页码 {page} 属于正文之后的书末页，没有可编辑的正文。",
    outside: "这本书的文件没有印刷页码 {page}。",
    story: "正文位于印刷页码 {range}。"
  },
  da: {
    cover: "Det er bogens omslag uden sidetekst at redigere. Fortæl, hvad omslaget skal vise.",
    contents: "Trykt side {page} er indholdsfortegnelsen. Den dannes på ny ud fra kapitlerne ved hver eksport, så der er intet på den at redigere direkte — sig ‘brug ikke ordet Kapitel’ eller lignende for at ændre stilen på dens overskrifter.",
    title: "Trykt side {page} er bogens titelblad — det viser titel og forfatternavn, ikke sidetekst, og alle bøger beholder titelbladet. Sig ‘omdøb bogen til …’ eller ‘skift forfatternavnet til …’ for at ændre, hvad der står på det.",
    sheet: "Trykt side {page} indeholder dedikationen og udgivelsesoplysningerne — linjen med ©, forlaget og ISBN. De trykkes ud fra bogens oplysninger, ikke dens sider: fortæl, hvad der skal ændres, fx ‘dediker den til min mor’ eller ‘fjern ISBN’.",
    front: "Trykt side {page} hører til bogens indledende sider — titelbladet eller dedikationen og udgivelsesoplysningerne, ikke sidetekst. Fortæl, hvad der skal ændres der, fx forfatternavnet, dedikationen eller ISBN, eller sig ‘omdøb bogen til …’.",
    sources: "Trykt side {page} er kildelisten bagest i bogen. Den dannes på ny ved hver eksport — sig ‘fjern kildelisten’, hvis den skal væk.",
    author: "Trykt side {page} er siden ‘Om forfatteren’ bagest i bogen. Den trykkes ud fra bogens oplysninger, ikke dens sider — fortæl, hvordan biografien skal ændres (eller at den skal fjernes), eller rediger den i bogens Title & credits.",
    both: "Trykt side {page} ligger i bogens afsluttende sider, hvor kildelisten og siden ‘Om forfatteren’ trykkes. Ingen af dem er sidetekst: sig ‘fjern kildelisten’, hvis den skal væk, eller fortæl, hvordan biografien skal ændres (eller at den skal fjernes), eller rediger den i bogens Title & credits.",
    back: "Trykt side {page} ligger efter bogens tekst og har ingen sidetekst at redigere.",
    outside: "Denne bogs fil har ingen trykt side {page}.",
    story: "Bogens tekst står på de trykte sider {range}."
  },
  nl: {
    cover: "Dit is de boekomslag, zonder paginatekst om te bewerken. Vertel wat de omslag moet tonen.",
    contents: "Gedrukte pagina {page} is de inhoudsopgave. Die wordt bij elke export opnieuw opgebouwd uit de hoofdstukken, dus er valt niets direct op te bewerken; zeg ‘gebruik het woord Hoofdstuk niet’ of iets vergelijkbaars om de titels anders vorm te geven.",
    title: "Gedrukte pagina {page} is de titelpagina van het boek met titel en auteursnaam, geen paginatekst, en elk boek behoudt deze pagina. Zeg ‘hernoem het boek naar …’ of ‘verander de auteursnaam in …’ om te wijzigen wat erop staat.",
    sheet: "Gedrukte pagina {page} bevat de opdracht en de publicatiegegevens: de regel met ©, de uitgever en het ISBN. Die worden afgedrukt vanuit de boekgegevens, niet vanuit de pagina’s: vertel wat je wilt wijzigen, zoals ‘draag het boek op aan mijn moeder’ of ‘verwijder het ISBN’.",
    front: "Gedrukte pagina {page} hoort bij het voorwerk: de titelpagina of de opdracht en publicatiegegevens, geen paginatekst. Vertel wat je daar wilt wijzigen, zoals de auteursnaam, de opdracht of het ISBN, of zeg ‘hernoem het boek naar …’.",
    sources: "Gedrukte pagina {page} is de bronnenlijst achterin het boek. Die wordt bij elke export opnieuw opgebouwd; zeg ‘verwijder de bronnenlijst’ als je die wilt weglaten.",
    author: "Gedrukte pagina {page} is de pagina Over de auteur achterin het boek. Die wordt afgedrukt vanuit de boekgegevens, niet vanuit de pagina’s; vertel hoe de biografie moet veranderen (of dat die weg moet), of bewerk die in Title & credits van het boek.",
    both: "Gedrukte pagina {page} hoort bij het nawerk, waar de bronnenlijst en de pagina Over de auteur worden afgedrukt. Geen van beide is paginatekst: zeg ‘verwijder de bronnenlijst’ als je die wilt weglaten, vertel hoe de biografie moet veranderen (of dat die weg moet), of bewerk die in Title & credits van het boek.",
    back: "Gedrukte pagina {page} hoort bij het nawerk na de boektekst en heeft geen paginatekst om te bewerken.",
    outside: "Het bestand van dit boek heeft geen gedrukte pagina {page}.",
    story: "De boektekst staat op de gedrukte pagina’s {range}."
  },
  fa: {
    cover: "این جلد کتاب است و متن صفحه‌ای برای ویرایش ندارد. بگویید می‌خواهید جلد چه چیزی را نشان دهد.",
    contents: "صفحهٔ چاپی {page} فهرست مطالب است. فهرست در هر بار خروجی گرفتن از روی فصل‌ها دوباره ساخته می‌شود، پس چیزی در آن برای ویرایش مستقیم نیست؛ برای تغییر سبک عنوان‌هایش بگویید «از کلمهٔ فصل استفاده نکن» یا چیزی شبیه آن.",
    title: "صفحهٔ چاپی {page} صفحهٔ عنوان کتاب است؛ عنوان و نام نویسنده را چاپ می‌کند، نه متن صفحه را، و هر کتاب این صفحه را نگه می‌دارد. برای تغییر آنچه رویش نوشته شده بگویید «نام کتاب را به … تغییر بده» یا «نام نویسنده را به … تغییر بده».",
    sheet: "صفحهٔ چاپی {page} شامل تقدیم‌نامه و اطلاعات انتشار است: خط ©، ناشر و شابک. این‌ها از اطلاعات کتاب چاپ می‌شوند، نه از صفحه‌هایش؛ بگویید چه چیزی تغییر کند، مثلاً «کتاب را به مادرم تقدیم کن» یا «شابک را حذف کن».",
    front: "صفحهٔ چاپی {page} از صفحات آغازین کتاب است: صفحهٔ عنوان یا تقدیم‌نامه و اطلاعات انتشار، نه متن صفحه. بگویید چه چیزی آنجا تغییر کند، مثلاً نام نویسنده، تقدیم‌نامه یا شابک، یا بگویید «نام کتاب را به … تغییر بده».",
    sources: "صفحهٔ چاپی {page} فهرست منابع در پایان کتاب است که در هر بار خروجی گرفتن دوباره ساخته می‌شود؛ اگر می‌خواهید حذف شود، بگویید «فهرست منابع را حذف کن».",
    author: "صفحهٔ چاپی {page} صفحهٔ دربارهٔ نویسنده در پایان کتاب است. این صفحه از اطلاعات کتاب چاپ می‌شود، نه از صفحه‌هایش؛ بگویید زندگی‌نامه چگونه تغییر کند (یا حذف شود)، یا آن را در بخش Title & credits کتاب ویرایش کنید.",
    both: "صفحهٔ چاپی {page} در بخش پایانی کتاب است که فهرست منابع و دربارهٔ نویسنده در آن چاپ می‌شوند. هیچ‌کدام متن صفحه نیستند: اگر می‌خواهید فهرست منابع حذف شود بگویید «فهرست منابع را حذف کن»، یا بگویید زندگی‌نامه چگونه تغییر کند (یا حذف شود)، یا آن را در بخش Title & credits کتاب ویرایش کنید.",
    back: "صفحهٔ چاپی {page} از صفحات پایانی، پس از متن کتاب است و متن صفحه‌ای برای ویرایش ندارد.",
    outside: "فایل این کتاب صفحهٔ چاپی {page} ندارد.",
    story: "متن کتاب در صفحات چاپی {range} است."
  },
  fr: {
    cover: "C’est la couverture du livre, sans texte de page à modifier. Indiquez ce que vous souhaitez y voir.",
    contents: "La page imprimée {page} est la table des matières. Elle est reconstruite à partir des chapitres à chaque exportation, il n’y a donc rien à y modifier directement ; dites « ne pas utiliser le mot Chapitre » ou une demande similaire pour changer le style de ses titres.",
    title: "La page imprimée {page} est la page de titre du livre : elle porte le titre et le nom de l’auteur, pas du texte de page, et chaque livre la conserve. Dites « renommer le livre en … » ou « changer le nom de l’auteur en … » pour modifier ce qu’elle indique.",
    sheet: "La page imprimée {page} contient la dédicace et les informations de publication : la ligne ©, l’éditeur et l’ISBN. Elles sont imprimées à partir des informations du livre, pas de ses pages : indiquez ce qu’il faut modifier, par exemple « dédier le livre à ma mère » ou « supprimer l’ISBN ».",
    front: "La page imprimée {page} fait partie des pages liminaires : la page de titre ou la dédicace et les informations de publication, pas du texte de page. Indiquez ce qu’il faut y modifier, comme le nom de l’auteur, la dédicace ou l’ISBN, ou dites « renommer le livre en … ».",
    sources: "La page imprimée {page} est la liste des sources en fin de livre. Elle est reconstruite à chaque exportation ; dites « supprimer la liste des sources » si vous souhaitez la retirer.",
    author: "La page imprimée {page} est la page À propos de l’auteur en fin de livre. Elle est imprimée à partir des informations du livre, pas de ses pages ; indiquez comment la biographie doit changer (ou demandez sa suppression), ou modifiez-la dans Title & credits du livre.",
    both: "La page imprimée {page} fait partie des pages finales, où sont imprimées la liste des sources et la page À propos de l’auteur. Ni l’une ni l’autre n’est du texte de page : dites « supprimer la liste des sources » si vous souhaitez la retirer, indiquez comment la biographie doit changer (ou demandez sa suppression), ou modifiez-la dans Title & credits du livre.",
    back: "La page imprimée {page} se trouve après le corps du livre et ne contient pas de texte de page à modifier.",
    outside: "Le fichier de ce livre n’a pas de page imprimée {page}.",
    story: "Le texte du livre occupe les pages imprimées {range}."
  },
  de: {
    cover: "Das ist der Buchumschlag ohne bearbeitbaren Seitentext. Sag mir, was der Umschlag zeigen soll.",
    contents: "Die gedruckte Seite {page} ist das Inhaltsverzeichnis. Es wird bei jedem Export neu aus den Kapiteln erstellt, daher gibt es darauf nichts direkt zu bearbeiten; sag „verwende nicht das Wort Kapitel“ oder Ähnliches, um die Überschriften anders zu gestalten.",
    title: "Die gedruckte Seite {page} ist das Titelblatt des Buchs mit Titel und Autorenname, kein Seitentext, und jedes Buch behält es. Sag „benenne das Buch um in …“ oder „ändere den Autorennamen in …“, um zu ändern, was darauf steht.",
    sheet: "Die gedruckte Seite {page} enthält die Widmung und die Veröffentlichungsangaben: die ©-Zeile, den Verlag und die ISBN. Diese werden aus den Buchangaben gedruckt, nicht aus den Seiten: sag mir, was sich ändern soll, etwa „widme es meiner Mama“ oder „entferne die ISBN“.",
    front: "Die gedruckte Seite {page} gehört zu den Anfangsseiten des Buchs: Titelblatt oder Widmung und Veröffentlichungsangaben, kein Seitentext. Sag mir, was sich dort ändern soll, etwa der Autorenname, die Widmung oder die ISBN, oder sag „benenne das Buch um in …“.",
    sources: "Die gedruckte Seite {page} ist das Quellenverzeichnis am Buchende. Es wird bei jedem Export neu erstellt; sag „entferne das Quellenverzeichnis“, wenn es wegfallen soll.",
    author: "Die gedruckte Seite {page} ist die Seite Über den Autor am Buchende. Diese Seite wird aus den Buchangaben gedruckt, nicht aus den Buchseiten; sag mir, wie sich die Biografie ändern soll (oder dass sie entfernt werden soll), oder bearbeite sie in Title & credits des Buchs.",
    both: "Die gedruckte Seite {page} gehört zu den Schlussseiten, auf denen das Quellenverzeichnis und die Seite Über den Autor gedruckt werden. Beides ist kein Seitentext: sag „entferne das Quellenverzeichnis“, wenn es wegfallen soll, sag mir, wie sich die Biografie ändern soll (oder dass sie entfernt werden soll), oder bearbeite sie in Title & credits des Buchs.",
    back: "Die gedruckte Seite {page} liegt nach dem Buchtext und enthält keinen bearbeitbaren Seitentext.",
    outside: "Die Datei dieses Buchs hat keine gedruckte Seite {page}.",
    story: "Der Buchtext steht auf den gedruckten Seiten {range}."
  },
  el: {
    cover: "Αυτό είναι το εξώφυλλο του βιβλίου, χωρίς κείμενο σελίδας για επεξεργασία. Πείτε μου τι θέλετε να δείχνει.",
    contents: "Η τυπωμένη σελίδα {page} είναι ο πίνακας περιεχομένων. Δημιουργείται ξανά από τα κεφάλαια σε κάθε εξαγωγή, οπότε δεν έχει τίποτα για άμεση επεξεργασία· για να αλλάξει η μορφή των τίτλων του, πείτε «μη χρησιμοποιείς τη λέξη “Κεφάλαιο”» ή κάτι παρόμοιο.",
    title: "Η τυπωμένη σελίδα {page} είναι η σελίδα τίτλου του βιβλίου — τυπώνει τον τίτλο και το όνομα του συγγραφέα, όχι κείμενο σελίδας, και κάθε βιβλίο την κρατά. Για να αλλάξετε τι γράφει, πείτε «μετονόμασε το βιβλίο σε …» ή «άλλαξε το όνομα του συγγραφέα σε …».",
    sheet: "Η τυπωμένη σελίδα {page} περιέχει την αφιέρωση και τα στοιχεία έκδοσης — τη γραμμή ©, τον εκδότη και το ISBN. Τυπώνονται από τα στοιχεία του βιβλίου, όχι από τις σελίδες του: πείτε μου τι να αλλάξω, π.χ. «αφιέρωσέ το στη μαμά μου» ή «αφαίρεσε το ISBN».",
    front: "Η τυπωμένη σελίδα {page} ανήκει στις εισαγωγικές σελίδες του βιβλίου — τη σελίδα τίτλου ή την αφιέρωση και τα στοιχεία έκδοσης, όχι κείμενο σελίδας. Πείτε μου τι να αλλάξω εκεί, όπως το όνομα του συγγραφέα, την αφιέρωση ή το ISBN, ή πείτε «μετονόμασε το βιβλίο σε …».",
    sources: "Η τυπωμένη σελίδα {page} είναι ο κατάλογος πηγών στο τέλος του βιβλίου. Δημιουργείται ξανά σε κάθε εξαγωγή — πείτε «αφαίρεσε τον κατάλογο πηγών» αν δεν τον θέλετε.",
    author: "Η τυπωμένη σελίδα {page} είναι η σελίδα «Σχετικά με τον συγγραφέα» στο τέλος του βιβλίου. Τυπώνεται από τα στοιχεία του βιβλίου, όχι από τις σελίδες του — πείτε μου πώς να αλλάξει το βιογραφικό (ή να αφαιρεθεί) ή επεξεργαστείτε το στο Title & credits του βιβλίου.",
    both: "Η τυπωμένη σελίδα {page} ανήκει στις τελικές σελίδες, όπου τυπώνονται ο κατάλογος πηγών και η σελίδα «Σχετικά με τον συγγραφέα». Κανένα από τα δύο δεν είναι κείμενο σελίδας: πείτε «αφαίρεσε τον κατάλογο πηγών» αν δεν τον θέλετε, ή πείτε μου πώς να αλλάξει το βιογραφικό (ή να αφαιρεθεί) ή επεξεργαστείτε το στο Title & credits του βιβλίου.",
    back: "Η τυπωμένη σελίδα {page} βρίσκεται μετά το κυρίως κείμενο και δεν έχει κείμενο σελίδας για επεξεργασία.",
    outside: "Το αρχείο αυτού του βιβλίου δεν έχει τυπωμένη σελίδα {page}.",
    story: "Το κείμενο του βιβλίου βρίσκεται στις τυπωμένες σελίδες {range}."
  },
  he: {
    cover: "זו כריכת הספר, ואין בה טקסט של עמוד לעריכה. אפשר לציין מה רוצים שיופיע בכריכה.",
    contents: "עמוד מודפס {page} הוא תוכן העניינים. הוא נבנה מחדש מהפרקים בכל ייצוא, כך שאין בו מה לערוך ישירות; כדי לשנות את סגנון הכותרות שלו אפשר לכתוב «בלי המילה פרק» או משהו דומה.",
    title: "עמוד מודפס {page} הוא עמוד השער של הספר: מודפסים בו שם הספר ושם המחבר, לא טקסט של עמוד, וכל ספר שומר עליו. כדי לשנות את מה שכתוב בו אפשר לכתוב «לשנות את שם הספר ל…» או «לשנות את שם המחבר ל…».",
    sheet: "עמוד מודפס {page} מכיל את ההקדשה ואת פרטי הפרסום: שורת ©, ההוצאה לאור וה־ISBN. הם מודפסים מפרטי הספר, לא מהעמודים שלו; אפשר לציין מה לשנות, למשל «להקדיש את הספר לאמא שלי» או «להסיר את ה־ISBN».",
    front: "עמוד מודפס {page} שייך לעמודי הפתיחה של הספר: עמוד השער או ההקדשה ופרטי הפרסום, לא טקסט של עמוד. אפשר לציין מה לשנות שם, למשל את שם המחבר, את ההקדשה או את ה־ISBN, או לכתוב «לשנות את שם הספר ל…».",
    sources: "עמוד מודפס {page} הוא רשימת המקורות בסוף הספר. היא נבנית מחדש בכל ייצוא; כדי להסיר אותה אפשר לכתוב «להסיר את רשימת המקורות».",
    author: "עמוד מודפס {page} הוא עמוד «על המחבר» בסוף הספר. הוא מודפס מפרטי הספר, לא מהעמודים שלו; אפשר לציין איך לשנות את הביוגרפיה (או לבקש להסיר אותה), או לערוך אותה ב־Title & credits של הספר.",
    both: "עמוד מודפס {page} שייך לעמודי הסיום, שבהם מודפסים רשימת המקורות ועמוד «על המחבר». אף אחד מהם אינו טקסט של עמוד: כדי להסיר את רשימת המקורות אפשר לכתוב «להסיר את רשימת המקורות», או לציין איך לשנות את הביוגרפיה (או לבקש להסיר אותה), או לערוך אותה ב־Title & credits של הספר.",
    back: "עמוד מודפס {page} נמצא אחרי גוף הספר, ואין בו טקסט של עמוד לעריכה.",
    outside: "בקובץ הספר הזה אין עמוד מודפס {page}.",
    story: "טקסט הספר נמצא בעמודים המודפסים {range}."
  },
  hi: {
    cover: "यह किताब का कवर है; इसमें संपादित करने के लिए पृष्ठ का पाठ नहीं है। बताएं कि कवर पर क्या दिखाना है।",
    contents: "मुद्रित पृष्ठ {page} विषय-सूची है। हर निर्यात पर यह अध्यायों से दोबारा बनती है, इसलिए इसमें सीधे संपादित करने को कुछ नहीं है; इसके शीर्षकों की शैली बदलने के लिए “अध्याय शब्द का इस्तेमाल मत करो” या ऐसा कुछ कहें।",
    title: "मुद्रित पृष्ठ {page} किताब का शीर्षक पृष्ठ है; इस पर शीर्षक और लेखक का नाम छपता है, पृष्ठ का पाठ नहीं, और हर किताब में यह रहता है। इस पर लिखा बदलने के लिए “किताब का नाम बदलकर … कर दो” या “लेखक का नाम बदलकर … कर दो” कहें।",
    sheet: "मुद्रित पृष्ठ {page} में समर्पण और प्रकाशन की जानकारी है: © पंक्ति, प्रकाशक और ISBN। ये किताब के विवरण से छपते हैं, उसके पृष्ठों से नहीं; बताएं कि क्या बदलना है, जैसे “इसे मेरी माँ को समर्पित करो” या “ISBN हटा दो”।",
    front: "मुद्रित पृष्ठ {page} किताब के शुरुआती पृष्ठों में है: शीर्षक पृष्ठ या समर्पण और प्रकाशन की जानकारी, पृष्ठ का पाठ नहीं। बताएं कि वहाँ क्या बदलना है, जैसे लेखक का नाम, समर्पण या ISBN, या कहें “किताब का नाम बदलकर … कर दो”।",
    sources: "मुद्रित पृष्ठ {page} किताब के अंत की स्रोत-सूची है। यह हर निर्यात पर दोबारा बनती है; अगर आप इसे हटाना चाहें तो “स्रोत-सूची हटा दो” कहें।",
    author: "मुद्रित पृष्ठ {page} किताब के अंत में लेखक के बारे में वाला पृष्ठ है। यह किताब के विवरण से छपता है, उसके पृष्ठों से नहीं; बताएं कि परिचय कैसे बदलना है (या उसे हटाना है), या किताब के Title & credits में इसे संपादित करें।",
    both: "मुद्रित पृष्ठ {page} किताब के अंतिम हिस्से में है, जहां स्रोत-सूची और लेखक के बारे में वाला पृष्ठ छपते हैं। इनमें से कोई भी पृष्ठ का पाठ नहीं है: अगर स्रोत-सूची हटाना चाहें तो “स्रोत-सूची हटा दो” कहें, या बताएं कि परिचय कैसे बदलना है (या उसे हटाना है), या किताब के Title & credits में इसे संपादित करें।",
    back: "मुद्रित पृष्ठ {page} किताब के मुख्य पाठ के बाद है; इसमें संपादित करने के लिए पृष्ठ का पाठ नहीं है।",
    outside: "इस किताब की फ़ाइल में मुद्रित पृष्ठ {page} नहीं है।",
    story: "किताब का पाठ मुद्रित पृष्ठों {range} पर है।"
  },
  it: {
    cover: "Questa è la copertina del libro, senza testo di pagina da modificare. Dimmi cosa vorresti che mostrasse.",
    contents: "La pagina stampata {page} è l’indice. Viene ricreato dai capitoli a ogni esportazione, quindi non c’è nulla da modificare direttamente; scrivi «non usare la parola Capitolo» o qualcosa di simile per cambiare lo stile dei suoi titoli.",
    title: "La pagina stampata {page} è il frontespizio del libro con titolo e nome dell’autore, non testo di pagina, e ogni libro lo mantiene. Scrivi «rinomina il libro in …» o «cambia il nome dell’autore in …» per cambiare ciò che riporta.",
    sheet: "La pagina stampata {page} contiene la dedica e i dati di pubblicazione: la riga ©, l’editore e l’ISBN. Vengono stampati dai dati del libro, non dalle sue pagine: dimmi cosa cambiare, ad esempio «dedicalo a mia madre» o «rimuovi l’ISBN».",
    front: "La pagina stampata {page} fa parte delle pagine iniziali: il frontespizio oppure la dedica e i dati di pubblicazione, non testo di pagina. Dimmi cosa cambiare lì, ad esempio il nome dell’autore, la dedica o l’ISBN, oppure scrivi «rinomina il libro in …».",
    sources: "La pagina stampata {page} è l’elenco delle fonti in fondo al libro. Viene ricreato a ogni esportazione; scrivi «rimuovi l’elenco delle fonti» se non lo vuoi.",
    author: "La pagina stampata {page} è la pagina sull’autore in fondo al libro. Viene stampata dai dati del libro, non dalle sue pagine; dimmi come cambiare la biografia (o di rimuoverla), oppure modificala in Title & credits del libro.",
    both: "La pagina stampata {page} fa parte delle pagine finali, dove sono stampati l’elenco delle fonti e la pagina sull’autore. Nessuno dei due è testo di pagina: scrivi «rimuovi l’elenco delle fonti» se non lo vuoi, dimmi come cambiare la biografia (o di rimuoverla), oppure modificala in Title & credits del libro.",
    back: "La pagina stampata {page} si trova dopo il testo del libro e non contiene testo di pagina da modificare.",
    outside: "Il file di questo libro non ha una pagina stampata {page}.",
    story: "Il testo del libro occupa le pagine stampate {range}."
  },
  ja: {
    cover: "これは本の表紙で、編集できる本文はありません。表紙に何を表示したいか教えてください。",
    contents: "印刷ページ {page} は目次です。書き出しのたびに各章から再生成されるため、直接編集できる内容はありません。見出しのスタイルを変えるには、「『第○章』を付けないで」などと伝えてください。",
    title: "印刷ページ {page} は本の扉ページで、本文ではなく書名と著者名が印刷されます。すべての本に残るページです。記載内容を変えるには、「書名を……に変更して」や「著者名を……に変更して」と伝えてください。",
    sheet: "印刷ページ {page} は献辞と出版情報（© の行、出版社、ISBN）のページです。これらはページの本文ではなく本の情報から印刷されます。「この本を母に捧げて」や「ISBN を削除して」のように、変更したい内容を教えてください。",
    front: "印刷ページ {page} は巻頭の扉ページ、または献辞と出版情報のページで、本文ではありません。著者名、献辞、ISBN など変更したい内容を教えてください。「書名を……に変更して」と伝えることもできます。",
    sources: "印刷ページ {page} は巻末の出典一覧で、書き出しのたびに再生成されます。不要なら「出典一覧を削除して」と伝えてください。",
    author: "印刷ページ {page} は巻末の「著者について」のページです。ページの本文ではなく本の情報から印刷されます。紹介文をどう変えるか（または削除するか）教えていただくか、本の Title & credits で編集してください。",
    both: "印刷ページ {page} は出典一覧と「著者について」のページが印刷される巻末部分です。どちらもページの本文ではありません。出典一覧が不要なら「出典一覧を削除して」と伝えるか、紹介文をどう変えるか（または削除するか）教えていただくか、本の Title & credits で編集してください。",
    back: "印刷ページ {page} は本文の後の巻末ページで、編集できる本文はありません。",
    outside: "この本のファイルには印刷ページ {page} はありません。",
    story: "本文は印刷ページ {range} にあります。"
  },
  ko: {
    cover: "이것은 책 표지이며 편집할 본문이 없습니다. 표지에 무엇을 담고 싶은지 알려 주세요.",
    contents: "인쇄 페이지 {page}은(는) 목차입니다. 내보낼 때마다 장 제목을 바탕으로 다시 생성되므로 이 페이지에서 직접 편집할 내용은 없습니다. 제목의 스타일을 바꾸려면 “‘장’이라는 단어는 쓰지 마” 같은 식으로 말씀해 주세요.",
    title: "인쇄 페이지 {page}은(는) 책 제목과 저자 이름이 인쇄되는 속표지로, 본문이 아닙니다. 모든 책에 유지되는 페이지입니다. 표시되는 내용을 바꾸려면 “책 제목을 …(으)로 바꿔 줘” 또는 “저자 이름을 …(으)로 바꿔 줘”라고 말씀해 주세요.",
    sheet: "인쇄 페이지 {page}에는 헌사와 출판 정보인 © 줄, 출판사, ISBN이 있습니다. 이 내용은 본문 페이지가 아니라 책 정보에서 인쇄됩니다. “엄마에게 헌정해 줘”나 “ISBN을 삭제해 줘”처럼 바꿀 내용을 알려 주세요.",
    front: "인쇄 페이지 {page}은(는) 책 앞부분의 속표지 또는 헌사와 출판 정보 페이지로, 본문이 아닙니다. 저자 이름, 헌사, ISBN처럼 바꿀 내용을 알려 주시거나 “책 제목을 …(으)로 바꿔 줘”라고 말씀해 주세요.",
    sources: "인쇄 페이지 {page}은(는) 책 끝의 출처 목록이며 내보낼 때마다 다시 생성됩니다. 없애려면 “출처 목록을 삭제해 줘”라고 말씀해 주세요.",
    author: "인쇄 페이지 {page}은(는) 책 끝의 저자 소개 페이지입니다. 본문 페이지가 아니라 책 정보에서 인쇄됩니다. 약력을 어떻게 바꿀지(또는 삭제할지) 알려 주시거나 책의 Title & credits에서 직접 편집하세요.",
    both: "인쇄 페이지 {page}은(는) 출처 목록과 저자 소개 페이지가 실리는 책 뒷부분입니다. 둘 다 본문이 아닙니다. 출처 목록을 없애려면 “출처 목록을 삭제해 줘”라고 말씀해 주시고, 약력은 어떻게 바꿀지(또는 삭제할지) 알려 주시거나 책의 Title & credits에서 직접 편집하세요.",
    back: "인쇄 페이지 {page}은(는) 본문 뒤의 페이지이며 편집할 본문이 없습니다.",
    outside: "이 책 파일에는 인쇄 페이지 {page}이(가) 없습니다.",
    story: "책 본문은 인쇄 페이지 {range}에 있습니다."
  },
  no: {
    cover: "Dette er bokomslaget uten sidetekst å redigere. Fortell hva omslaget skal vise.",
    contents: "Trykt side {page} er innholdsfortegnelsen. Den bygges på nytt fra kapitlene ved hver eksport, så det er ingenting på den å redigere direkte; si «ikke bruk ordet Kapittel» eller lignende for å endre hvordan overskriftene ser ut.",
    title: "Trykt side {page} er bokens tittelside med tittel og forfatternavn, ikke sidetekst, og alle bøker beholder denne siden. Si «endre tittelen til …» eller «endre forfatternavnet til …» for å endre hva som står der.",
    sheet: "Trykt side {page} inneholder dedikasjonen og utgivelsesopplysningene: linjen med ©, forlaget og ISBN-et. De trykkes fra bokens opplysninger, ikke fra sidene: fortell hva du vil endre, for eksempel «tilegn boken til mamma» eller «fjern ISBN-et».",
    front: "Trykt side {page} er en av bokens innledende sider: tittelsiden eller dedikasjonen og utgivelsesopplysningene, ikke sidetekst. Fortell hva du vil endre der, for eksempel forfatternavnet, dedikasjonen eller ISBN-et, eller si «endre tittelen til …».",
    sources: "Trykt side {page} er kildelisten bakerst i boken. Den bygges på nytt ved hver eksport; si «fjern kildelisten» hvis du vil ta den bort.",
    author: "Trykt side {page} er siden Om forfatteren bakerst i boken. Den trykkes fra bokens opplysninger, ikke fra sidene; fortell hvordan biografien skal endres (eller at den skal fjernes), eller rediger den i bokens Title & credits.",
    both: "Trykt side {page} er blant sluttsidene, der kildelisten og siden Om forfatteren trykkes. Ingen av dem er sidetekst: si «fjern kildelisten» hvis du vil ta den bort, fortell hvordan biografien skal endres (eller at den skal fjernes), eller rediger den i bokens Title & credits.",
    back: "Trykt side {page} ligger etter bokteksten og har ingen sidetekst å redigere.",
    outside: "Denne bokfilen har ingen trykt side {page}.",
    story: "Bokteksten står på de trykte sidene {range}."
  },
  pl: {
    cover: "To okładka książki, bez tekstu strony do edycji. Powiedz, co ma przedstawiać.",
    contents: "Drukowana strona {page} to spis treści. Powstaje od nowa z rozdziałów przy każdym eksporcie, więc nie ma na niej nic do bezpośredniej edycji — aby zmienić styl jego nagłówków, powiedz na przykład „nie używaj słowa «Rozdział»”.",
    title: "Drukowana strona {page} to strona tytułowa książki — drukuje tytuł oraz imię i nazwisko autora, a nie tekst strony, i każda książka ją zachowuje. Aby zmienić to, co się na niej znajduje, powiedz „zmień tytuł książki na …” albo „zmień imię i nazwisko autora na …”.",
    sheet: "Drukowana strona {page} zawiera dedykację i dane wydawnicze — wiersz ©, wydawcę i ISBN. Są drukowane z danych książki, a nie z jej stron: powiedz, co zmienić, na przykład „zadedykuj ją mojej mamie” albo „usuń ISBN”.",
    front: "Drukowana strona {page} należy do stron wstępnych książki — strony tytułowej albo dedykacji i danych wydawniczych, a nie tekstu strony. Powiedz, co tam zmienić, na przykład imię i nazwisko autora, dedykację lub ISBN, albo powiedz „zmień tytuł książki na …”.",
    sources: "Drukowana strona {page} to wykaz źródeł na końcu książki. Powstaje od nowa przy każdym eksporcie — powiedz „usuń wykaz źródeł”, jeśli ma zniknąć.",
    author: "Drukowana strona {page} to strona „O autorze” na końcu książki. Jest drukowana z danych książki, a nie z jej stron — powiedz, jak zmienić biografię (lub że należy ją usunąć), albo edytuj ją w Title & credits książki.",
    both: "Drukowana strona {page} należy do stron końcowych, na których drukowane są wykaz źródeł i strona „O autorze”. Żadna z nich nie jest tekstem strony: powiedz „usuń wykaz źródeł”, jeśli ma zniknąć, albo powiedz, jak zmienić biografię (lub że należy ją usunąć), albo edytuj ją w Title & credits książki.",
    back: "Drukowana strona {page} znajduje się za tekstem książki i nie zawiera tekstu strony do edycji.",
    outside: "Plik tej książki nie ma drukowanej strony {page}.",
    story: "Tekst książki znajduje się na drukowanych stronach {range}."
  },
  pt: {
    cover: "Esta é a capa do livro, sem texto de página para editar. Diga o que gostaria que ela mostrasse.",
    contents: "A página impressa {page} é o sumário. Ele é recriado a partir dos capítulos a cada exportação, então não há nada nele para editar diretamente; diga “não use a palavra Capítulo” ou algo parecido para mudar o estilo dos títulos.",
    title: "A página impressa {page} é a folha de rosto do livro, com o título e o nome do autor, não texto de página, e todo livro a mantém. Diga “renomeie o livro para …” ou “mude o nome do autor para …” para mudar o que ela mostra.",
    sheet: "A página impressa {page} contém a dedicatória e os dados de publicação: a linha ©, a editora e o ISBN. Eles são impressos a partir dos dados do livro, não das páginas: diga o que mudar, como “dedique o livro à minha mãe” ou “remova o ISBN”.",
    front: "A página impressa {page} faz parte das páginas iniciais: folha de rosto ou dedicatória e dados de publicação, não texto de página. Diga o que mudar ali, como o nome do autor, a dedicatória ou o ISBN, ou diga “renomeie o livro para …”.",
    sources: "A página impressa {page} é a lista de fontes no final do livro. Ela é recriada a cada exportação; diga “remova a lista de fontes” se quiser retirá-la.",
    author: "A página impressa {page} é a página Sobre o autor no final do livro. Ela é impressa a partir dos dados do livro, não das páginas; diga como a biografia deve mudar (ou peça para removê-la), ou edite-a em Title & credits do livro.",
    both: "A página impressa {page} faz parte das páginas finais, onde são impressas a lista de fontes e a página Sobre o autor. Nenhuma delas é texto de página: diga “remova a lista de fontes” se quiser retirá-la, diga como a biografia deve mudar (ou peça para removê-la), ou edite-a em Title & credits do livro.",
    back: "A página impressa {page} fica depois do texto do livro e não tem texto de página para editar.",
    outside: "O arquivo deste livro não tem uma página impressa {page}.",
    story: "O texto do livro ocupa as páginas impressas {range}."
  },
  ru: {
    cover: "Это обложка книги, на ней нет текста страницы для редактирования. Скажите, что вы хотите видеть на обложке.",
    contents: "Печатная страница {page} — оглавление. Оно заново создаётся из глав при каждом экспорте, поэтому на нём нечего редактировать напрямую. Чтобы изменить оформление его заголовков, скажите, например, «не используй слово „Глава“».",
    title: "Печатная страница {page} — титульный лист книги: на нём печатаются название и имя автора, а не текст страницы, и он остаётся в каждой книге. Чтобы изменить то, что на нём написано, скажите «переименуй книгу в …» или «измени имя автора на …».",
    sheet: "Печатная страница {page} содержит посвящение и выходные данные — строку ©, издательство и ISBN. Они печатаются из сведений о книге, а не из её страниц: скажите, что изменить, например «посвяти книгу моей маме» или «удали ISBN».",
    front: "Печатная страница {page} относится к начальным страницам книги — титульному листу либо посвящению и выходным данным, а не к тексту страниц. Скажите, что там изменить — имя автора, посвящение или ISBN, — или напишите «переименуй книгу в …».",
    sources: "Печатная страница {page} — список источников в конце книги. Он заново создаётся при каждом экспорте — скажите «удали список источников», если он не нужен.",
    author: "Печатная страница {page} — страница «Об авторе» в конце книги. Она печатается из сведений о книге, а не из её страниц: скажите, как изменить биографию (или удалить её), либо отредактируйте её в Title & credits книги.",
    both: "Печатная страница {page} относится к заключительным страницам, где печатаются список источников и страница «Об авторе». Ни то ни другое не является текстом страниц: скажите «удали список источников», если он не нужен, или скажите, как изменить биографию (или удалить её), либо отредактируйте её в Title & credits книги.",
    back: "Печатная страница {page} находится после основного текста книги и не содержит текста страницы для редактирования.",
    outside: "В файле этой книги нет печатной страницы {page}.",
    story: "Текст книги расположен на печатных страницах {range}."
  },
  es: {
    cover: "Esta es la portada del libro, sin texto de página que editar. Dime qué quieres que muestre.",
    contents: "La página impresa {page} es el índice. Se reconstruye a partir de los capítulos en cada exportación, así que no hay nada en él que editar directamente; di «no uses la palabra Capítulo» o algo parecido para cambiar el estilo de sus títulos.",
    title: "La página impresa {page} es la página de título del libro, con el título y el nombre del autor, no texto de página, y todos los libros la conservan. Di «cambia el título del libro a …» o «cambia el nombre del autor a …» para modificar lo que muestra.",
    sheet: "La página impresa {page} contiene la dedicatoria y los datos de publicación: la línea ©, la editorial y el ISBN. Se imprimen a partir de los datos del libro, no de sus páginas: dime qué cambiar, por ejemplo «dedícalo a mi mamá» o «quita el ISBN».",
    front: "La página impresa {page} forma parte de las páginas iniciales: la página de título o la dedicatoria y los datos de publicación, no texto de página. Dime qué cambiar ahí, como el nombre del autor, la dedicatoria o el ISBN, o di «cambia el título del libro a …».",
    sources: "La página impresa {page} es la lista de fuentes al final del libro. Se reconstruye en cada exportación; di «quita la lista de fuentes» si quieres eliminarla.",
    author: "La página impresa {page} es la página Sobre el autor al final del libro. Se imprime a partir de los datos del libro, no de sus páginas; dime cómo debe cambiar la biografía (o que la quite), o edítala en Title & credits del libro.",
    both: "La página impresa {page} forma parte de las páginas finales, donde se imprimen la lista de fuentes y la página Sobre el autor. Ninguna de las dos es texto de página: di «quita la lista de fuentes» si quieres eliminarla, dime cómo debe cambiar la biografía (o que la quite), o edítala en Title & credits del libro.",
    back: "La página impresa {page} está después del texto del libro y no tiene texto de página que editar.",
    outside: "El archivo de este libro no tiene una página impresa {page}.",
    story: "El texto del libro ocupa las páginas impresas {range}."
  },
  sv: {
    cover: "Det här är bokens omslag utan sidtext att redigera. Berätta vad omslaget ska visa.",
    contents: "Tryckt sida {page} är innehållsförteckningen. Den skapas på nytt från kapitlen vid varje export, så det finns inget på den att redigera direkt; säg ”använd inte ordet Kapitel” eller liknande för att ändra hur rubrikerna ser ut.",
    title: "Tryckt sida {page} är bokens titelsida med titel och författarnamn, inte sidtext, och alla böcker behåller den. Säg ”byt namn på boken till …” eller ”ändra författarnamnet till …” för att ändra vad som står där.",
    sheet: "Tryckt sida {page} innehåller dedikationen och utgivningsuppgifterna: raden med ©, förlaget och ISBN. De trycks från bokens uppgifter, inte från sidorna: berätta vad du vill ändra, till exempel ”tillägna boken min mamma” eller ”ta bort ISBN”.",
    front: "Tryckt sida {page} hör till bokens inledande sidor: titelsidan eller dedikationen och utgivningsuppgifterna, inte sidtext. Berätta vad du vill ändra där, till exempel författarnamnet, dedikationen eller ISBN, eller säg ”byt namn på boken till …”.",
    sources: "Tryckt sida {page} är källförteckningen längst bak i boken. Den skapas på nytt vid varje export; säg ”ta bort källförteckningen” om du inte vill ha den.",
    author: "Tryckt sida {page} är sidan Om författaren längst bak i boken. Den trycks från bokens uppgifter, inte från sidorna; berätta hur biografin ska ändras (eller att den ska tas bort), eller redigera den i bokens Title & credits.",
    both: "Tryckt sida {page} hör till slutsidorna, där källförteckningen och sidan Om författaren trycks. Ingen av dem är sidtext: säg ”ta bort källförteckningen” om du inte vill ha den, berätta hur biografin ska ändras (eller att den ska tas bort), eller redigera den i bokens Title & credits.",
    back: "Tryckt sida {page} ligger efter bokens text och har ingen sidtext att redigera.",
    outside: "Den här bokfilen har ingen tryckt sida {page}.",
    story: "Bokens text finns på de tryckta sidorna {range}."
  },
  th: {
    cover: "นี่คือปกหนังสือ ไม่มีเนื้อหาหน้าหนังสือให้แก้ไข บอกได้ว่าต้องการให้ปกแสดงอะไร",
    contents: "หน้าที่พิมพ์หมายเลข {page} คือสารบัญ ซึ่งสร้างใหม่จากบทต่าง ๆ ทุกครั้งที่ส่งออก จึงไม่มีอะไรในหน้านี้ให้แก้ไขโดยตรง หากต้องการปรับรูปแบบหัวข้อ ให้พิมพ์ว่า ‘ไม่ต้องใช้คำว่าบทที่’ หรือข้อความทำนองนี้",
    title: "หน้าที่พิมพ์หมายเลข {page} คือหน้าชื่อเรื่องของหนังสือ ซึ่งพิมพ์ชื่อเรื่องและชื่อผู้เขียน ไม่ใช่เนื้อหาหน้าหนังสือ และหนังสือทุกเล่มจะเก็บหน้านี้ไว้ หากต้องการเปลี่ยนข้อความในหน้านี้ ให้พิมพ์ว่า ‘เปลี่ยนชื่อหนังสือเป็น …’ หรือ ‘เปลี่ยนชื่อผู้เขียนเป็น …’",
    sheet: "หน้าที่พิมพ์หมายเลข {page} มีคำอุทิศและข้อมูลการพิมพ์ ได้แก่ บรรทัด © สำนักพิมพ์ และ ISBN ข้อมูลเหล่านี้พิมพ์จากรายละเอียดของหนังสือ ไม่ใช่จากหน้าหนังสือ โปรดบอกว่าต้องการเปลี่ยนอะไร เช่น ‘อุทิศหนังสือเล่มนี้ให้แม่’ หรือ ‘ลบ ISBN ออก’",
    front: "หน้าที่พิมพ์หมายเลข {page} อยู่ส่วนต้นของหนังสือ เป็นหน้าชื่อเรื่องหรือคำอุทิศและข้อมูลการพิมพ์ ไม่ใช่เนื้อหาหน้าหนังสือ โปรดบอกว่าต้องการเปลี่ยนอะไรในส่วนนั้น เช่น ชื่อผู้เขียน คำอุทิศ หรือ ISBN หรือพิมพ์ว่า ‘เปลี่ยนชื่อหนังสือเป็น …’",
    sources: "หน้าที่พิมพ์หมายเลข {page} คือรายการแหล่งข้อมูลท้ายเล่ม ซึ่งสร้างใหม่ทุกครั้งที่ส่งออก หากไม่ต้องการ ให้พิมพ์ว่า ‘ลบรายการแหล่งข้อมูล’",
    author: "หน้าที่พิมพ์หมายเลข {page} คือหน้าเกี่ยวกับผู้เขียนท้ายเล่ม ซึ่งพิมพ์จากรายละเอียดของหนังสือ ไม่ใช่จากหน้าหนังสือ โปรดบอกว่าต้องการแก้ไขประวัติอย่างไร (หรือให้ลบออก) หรือแก้ไขเองได้ใน Title & credits ของหนังสือ",
    both: "หน้าที่พิมพ์หมายเลข {page} อยู่ส่วนท้ายเล่มที่พิมพ์รายการแหล่งข้อมูลและหน้าเกี่ยวกับผู้เขียน ทั้งสองส่วนไม่ใช่เนื้อหาหน้าหนังสือ หากไม่ต้องการรายการแหล่งข้อมูล ให้พิมพ์ว่า ‘ลบรายการแหล่งข้อมูล’ หรือบอกว่าต้องการแก้ไขประวัติอย่างไร (หรือให้ลบออก) หรือแก้ไขเองได้ใน Title & credits ของหนังสือ",
    back: "หน้าที่พิมพ์หมายเลข {page} อยู่ส่วนท้ายหลังเนื้อหาหนังสือ ไม่มีเนื้อหาหน้าหนังสือให้แก้ไข",
    outside: "ไฟล์หนังสือเล่มนี้ไม่มีหน้าที่พิมพ์หมายเลข {page}",
    story: "เนื้อหาหนังสืออยู่ในหน้าที่พิมพ์หมายเลข {range}"
  },
  tr: {
    cover: "Bu, kitabın kapağıdır; düzenlenecek sayfa metni yoktur. Kapakta ne görmek istediğinizi söyleyin.",
    contents: "Basılı {page}. sayfa içindekiler tablosudur. Her dışa aktarımda bölümlerden yeniden oluşturulur, bu yüzden üzerinde doğrudan düzenlenecek bir şey yoktur. Başlıklarının biçimini değiştirmek için “Bölüm kelimesini kullanma” veya benzeri bir şey söyleyin.",
    title: "Basılı {page}. sayfa kitabın başlık sayfasıdır: sayfa metnini değil, kitap ve yazar adını basar ve her kitap bu sayfayı korur. Üzerinde yazanı değiştirmek için “kitabın adını … olarak değiştir” veya “yazar adını … olarak değiştir” deyin.",
    sheet: "Basılı {page}. sayfada ithaf ve yayın bilgileri bulunur: © satırı, yayınevi ve ISBN. Bunlar kitabın sayfalarından değil, kitap bilgilerinden basılır; neyin değişeceğini söyleyin, örneğin “kitabı anneme ithaf et” veya “ISBN’yi kaldır”.",
    front: "Basılı {page}. sayfa kitabın başlangıç kısmındadır: başlık sayfası veya ithaf ve yayın bilgileri; sayfa metni değildir. Orada neyi değiştirmek istediğinizi söyleyin (yazar adı, ithaf veya ISBN gibi) ya da “kitabın adını … olarak değiştir” deyin.",
    sources: "Basılı {page}. sayfa kitabın sonundaki kaynakçadır ve her dışa aktarımda yeniden oluşturulur. Kaldırılmasını istiyorsanız “kaynakçayı kaldır” deyin.",
    author: "Basılı {page}. sayfa kitabın sonundaki “Yazar hakkında” sayfasıdır. Kitabın sayfalarından değil, kitap bilgilerinden basılır; biyografinin nasıl değişmesi gerektiğini (veya kaldırılmasını) söyleyin ya da kitabın Title & credits bölümünde düzenleyin.",
    both: "Basılı {page}. sayfa, kaynakçanın ve “Yazar hakkında” sayfasının basıldığı son kısımdadır. İkisi de sayfa metni değildir: kaynakçanın kaldırılmasını istiyorsanız “kaynakçayı kaldır” deyin, biyografinin nasıl değişmesi gerektiğini (veya kaldırılmasını) söyleyin ya da kitabın Title & credits bölümünde düzenleyin.",
    back: "Basılı {page}. sayfa kitap metninden sonra gelir ve düzenlenecek sayfa metni içermez.",
    outside: "Bu kitabın dosyasında basılı {page}. sayfa yoktur.",
    story: "Kitabın metni basılı {range} sayfalarındadır."
  },
  uk: {
    cover: "Це обкладинка книги, на ній немає тексту сторінки для редагування. Скажіть, що ви хочете бачити на обкладинці.",
    contents: "Друкована сторінка {page} — зміст. Він заново створюється з розділів під час кожного експорту, тож на ньому немає чого редагувати напряму. Щоб змінити оформлення його заголовків, скажіть, наприклад, «не використовуй слово „Розділ“».",
    title: "Друкована сторінка {page} — титульна сторінка книги: на ній друкуються назва та ім’я автора, а не текст сторінки, і вона залишається в кожній книзі. Щоб змінити те, що на ній написано, скажіть «перейменуй книгу на …» або «зміни ім’я автора на …».",
    sheet: "Друкована сторінка {page} містить присвяту й вихідні дані — рядок ©, видавництво та ISBN. Вони друкуються з відомостей про книгу, а не з її сторінок: скажіть, що змінити, наприклад «присвяти книгу моїй мамі» або «видали ISBN».",
    front: "Друкована сторінка {page} належить до початкових сторінок книги — титульної сторінки або присвяти й вихідних даних, а не тексту сторінок. Скажіть, що там змінити — ім’я автора, присвяту чи ISBN, — або напишіть «перейменуй книгу на …».",
    sources: "Друкована сторінка {page} — список джерел у кінці книги. Він заново створюється під час кожного експорту — скажіть «видали список джерел», якщо він не потрібен.",
    author: "Друкована сторінка {page} — сторінка «Про автора» в кінці книги. Вона друкується з відомостей про книгу, а не з її сторінок: скажіть, як змінити біографію (або видалити її), чи відредагуйте її в Title & credits книги.",
    both: "Друкована сторінка {page} належить до кінцевих сторінок, де друкуються список джерел і сторінка «Про автора». Жодна з них не є текстом сторінок: скажіть «видали список джерел», якщо він не потрібен, або скажіть, як змінити біографію (або видалити її), чи відредагуйте її в Title & credits книги.",
    back: "Друкована сторінка {page} розташована після основного тексту книги й не містить тексту сторінки для редагування.",
    outside: "У файлі цієї книги немає друкованої сторінки {page}.",
    story: "Текст книги розташований на друкованих сторінках {range}."
  },
  ur: {
    cover: "یہ کتاب کا سرورق ہے؛ اس پر ترمیم کے لیے صفحے کا متن نہیں ہے۔ بتائیں کہ سرورق پر کیا دکھانا چاہتے ہیں۔",
    contents: "مطبوعہ صفحہ {page} فہرستِ مضامین ہے۔ ہر برآمد پر یہ ابواب سے دوبارہ بنتی ہے، اس لیے اس میں براہِ راست ترمیم کے لیے کچھ نہیں؛ اس کے عنوانات کا انداز بدلنے کے لیے «لفظ باب استعمال نہ کریں» یا اس جیسی کوئی بات کہیں۔",
    title: "مطبوعہ صفحہ {page} کتاب کا عنوانی صفحہ ہے؛ اس پر عنوان اور مصنف کا نام چھپتا ہے، صفحے کا متن نہیں، اور ہر کتاب میں یہ صفحہ رہتا ہے۔ اس پر لکھا ہوا بدلنے کے لیے «کتاب کا نام بدل کر … کر دیں» یا «مصنف کا نام بدل کر … کر دیں» کہیں۔",
    sheet: "مطبوعہ صفحہ {page} میں انتساب اور اشاعتی معلومات ہیں: © کی سطر، ناشر اور ISBN۔ یہ کتاب کی معلومات سے چھپتی ہیں، اس کے صفحات سے نہیں؛ بتائیں کہ کیا بدلنا ہے، جیسے «کتاب میری امی کے نام منسوب کر دیں» یا «ISBN ہٹا دیں»۔",
    front: "مطبوعہ صفحہ {page} کتاب کے ابتدائی صفحات میں ہے: عنوانی صفحہ یا انتساب اور اشاعتی معلومات، صفحے کا متن نہیں۔ بتائیں کہ وہاں کیا بدلنا ہے، جیسے مصنف کا نام، انتساب یا ISBN، یا کہیں «کتاب کا نام بدل کر … کر دیں»۔",
    sources: "مطبوعہ صفحہ {page} کتاب کے آخر میں ماخذ کی فہرست ہے۔ یہ ہر برآمد پر دوبارہ بنتی ہے؛ اگر آپ اسے ہٹانا چاہتے ہیں تو «ماخذ کی فہرست ہٹا دیں» کہیں۔",
    author: "مطبوعہ صفحہ {page} کتاب کے آخر میں مصنف کا تعارفی صفحہ ہے۔ یہ کتاب کی معلومات سے چھپتا ہے، اس کے صفحات سے نہیں؛ بتائیں کہ تعارف کیسے بدلنا ہے (یا اسے ہٹانا ہے)، یا کتاب کے Title & credits میں اس میں ترمیم کریں۔",
    both: "مطبوعہ صفحہ {page} کتاب کے آخری حصے میں ہے، جہاں ماخذ کی فہرست اور مصنف کا تعارفی صفحہ چھپتے ہیں۔ ان میں سے کوئی بھی صفحے کا متن نہیں: اگر ماخذ کی فہرست ہٹانا چاہتے ہیں تو «ماخذ کی فہرست ہٹا دیں» کہیں، یا بتائیں کہ تعارف کیسے بدلنا ہے (یا اسے ہٹانا ہے)، یا کتاب کے Title & credits میں اس میں ترمیم کریں۔",
    back: "مطبوعہ صفحہ {page} کتاب کے متن کے بعد آخری صفحات میں ہے؛ اس پر ترمیم کے لیے صفحے کا متن نہیں ہے۔",
    outside: "اس کتاب کی فائل میں مطبوعہ صفحہ {page} نہیں ہے۔",
    story: "کتاب کا متن مطبوعہ صفحات {range} پر ہے۔"
  },
  vi: {
    cover: "Đây là bìa sách, không có văn bản trang để chỉnh sửa. Hãy cho biết bạn muốn bìa thể hiện điều gì.",
    contents: "Trang in {page} là mục lục. Mục lục được tạo lại từ các chương mỗi lần xuất sách, nên trên trang này không có gì để sửa trực tiếp. Để đổi kiểu các tiêu đề của nó, hãy nói ‘đừng dùng chữ Chương’ hoặc một yêu cầu tương tự.",
    title: "Trang in {page} là trang tên sách: trang này in tên sách và tên tác giả, không phải văn bản trang, và mỗi cuốn sách đều giữ trang này. Để đổi nội dung trên đó, hãy nói ‘đổi tên sách thành …’ hoặc ‘đổi tên tác giả thành …’.",
    sheet: "Trang in {page} chứa lời đề tặng và thông tin xuất bản: dòng ©, nhà xuất bản và ISBN. Những nội dung này được in từ thông tin của sách, không phải từ các trang của sách: hãy cho biết cần đổi gì, ví dụ ‘đề tặng sách cho mẹ tôi’ hoặc ‘xóa ISBN’.",
    front: "Trang in {page} thuộc phần đầu sách: trang tên sách hoặc lời đề tặng và thông tin xuất bản, không phải văn bản trang. Hãy cho biết cần đổi gì ở đó, như tên tác giả, lời đề tặng hoặc ISBN, hoặc nói ‘đổi tên sách thành …’.",
    sources: "Trang in {page} là danh sách nguồn ở cuối sách. Danh sách này được tạo lại mỗi lần xuất sách — hãy nói ‘xóa danh sách nguồn’ nếu bạn muốn bỏ nó.",
    author: "Trang in {page} là trang Về tác giả ở cuối sách. Trang này được in từ thông tin của sách, không phải từ các trang của sách — hãy cho biết tiểu sử nên thay đổi thế nào (hoặc yêu cầu xóa), hoặc sửa trong Title & credits của sách.",
    both: "Trang in {page} thuộc phần cuối sách, nơi in danh sách nguồn và trang Về tác giả. Cả hai đều không phải văn bản trang: hãy nói ‘xóa danh sách nguồn’ nếu bạn muốn bỏ nó, hoặc cho biết tiểu sử nên thay đổi thế nào (hoặc yêu cầu xóa), hoặc sửa trong Title & credits của sách.",
    back: "Trang in {page} nằm sau phần nội dung chính của sách, không có văn bản trang để chỉnh sửa.",
    outside: "Tệp sách này không có trang in {page}.",
    story: "Nội dung sách nằm ở các trang in {range}."
  }
};

/**
 * The sentence for one furniture zone, named by the number the reader spoke,
 * then where the story runs when the map knows.
 *
 * **`cover` is a version-1 answer and only ever that**, which is a property of
 * the two numbering systems rather than an oversight. A version-2 PDF resets the
 * counter on the cover sheet, so that sheet carries no printed number at all:
 * `pdfPageForPrintedPage` refuses to resolve any printed number onto sheet 1,
 * the app's chrome labels it "Cover" instead of "Page 1"
 * (`printedPageLabel`, `apps/mobile/lib/features/reader/domain/reader_models.dart`),
 * and the router prompt is told the same thing — so a version-2 reader can never
 * *mean* the cover by a number, and "page 1" is the first numbered sheet. A
 * version-1 PDF counted its cover, `printedPageOffset` is 0 for those maps, and
 * that book's footer and chrome both call the cover page 1 — so this arm is the
 * live path there, and `outside` would tell that reader their book has no
 * printed page 1. Both halves are pinned in `bookPageNumbering.test.ts`; the arm
 * looks dead against a version-2 map and is not.
 *
 * The back matter is named by what the book prints there. The map records one
 * start for the whole back matter, so with both sections printed a page past it
 * may be either, and the sentence names both.
 */
export function furnitureReply(
  language: ConversationLanguage | undefined,
  page: number,
  zone: PdfPageZone,
  front: BookFrontMatterPage["holds"] | undefined,
  back: BookBackMatterContents | undefined,
  storyRange: string | undefined
): string {
  const copy = chatCopy(FURNITURE_REPLY_COPY, language);
  let key: keyof FurnitureCopy;
  switch (zone) {
    case "cover": key = "cover"; break;
    case "contents": key = "contents"; break;
    case "front_matter": key = front === "title_page" ? "title" : front === "matter_sheet" ? "sheet" : "front"; break;
    case "back_matter": key = back?.sources ? (back.aboutAuthor ? "both" : "sources") : back?.aboutAuthor ? "author" : "back"; break;
    default: key = "outside";
  }
  const description = fillChatCopy(copy[key], { page: String(page) });
  return storyRange === undefined ? description : `${description} ${fillChatCopy(copy.story, { range: storyRange })}`;
}
