import type { ChatCopyTable } from "../chatReplyCopy.js";
import type { TomezaCreditRemoval } from "./tomezaCredit.js";

/**
 * What the chat says, by what the shared removal decision did — never the
 * router's proposed action, and never a price. `not_finished` is not "once it
 * has finished": the first compile decides the credit from the owner's plan,
 * so a subscriber's book never prints the line and there is nothing to ask for
 * later. Its English sentence is also the sheet route's (`TOMEZA_CREDIT_NOT_FINISHED_MESSAGE`).
 */
export const TOMEZA_CREDIT_CHAT_COPY: ChatCopyTable<Record<TomezaCreditRemoval["kind"], string>> = {
  en: {
    reprinted: "Done — I’m taking the “Made with Tomeza” line off this book and refreshing the exports. This one’s free.",
    not_printed: "This book doesn’t carry the “Made with Tomeza” line, so there’s nothing to take off.",
    subscription_required: "Removing the “Made with Tomeza” line comes with any plan — credits alone don’t unlock it. Tap below and pick a monthly plan, then ask me again and I’ll take it off this book for free.",
    refreshing: "This book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, ask me again.",
    busy: "This book is still being worked on. Ask me again once the current job finishes.",
    not_finished: "This book isn’t finished yet. On your plan it will be put together without the “Made with Tomeza” line."
  },
  da: {
    reprinted: "Færdig — jeg fjerner linjen ‘Lavet med Tomeza’ fra denne bog og opdaterer eksportfilerne. Ændringen er gratis.",
    not_printed: "Denne bog har ikke linjen ‘Lavet med Tomeza’, så der er ikke noget at fjerne.",
    subscription_required: "Alle abonnementer giver mulighed for at fjerne ‘Lavet med Tomeza’; køb af kreditter alene er ikke nok. Tryk nedenfor, vælg et månedsabonnement, og bed mig derefter igen om at fjerne linjen gratis fra denne bog.",
    refreshing: "Denne bog bliver opdateret. Hvis ‘Lavet med Tomeza’ stadig er der, når den er klar, så bed mig igen om at fjerne linjen.",
    busy: "Der arbejdes stadig på denne bog. Spørg igen, når det aktuelle arbejde er færdigt.",
    not_finished: "Denne bog er ikke færdig endnu. Med dit abonnement bliver den lavet uden linjen ‘Lavet med Tomeza’."
  },
  nl: {
    reprinted: "Klaar — ik verwijder de regel ‘Gemaakt met Tomeza’ uit dit boek en werk de exportbestanden bij. Deze wijziging is gratis.",
    not_printed: "Dit boek heeft geen regel ‘Gemaakt met Tomeza’, dus er is niets te verwijderen.",
    subscription_required: "Met elk abonnement kun je ‘Gemaakt met Tomeza’ verwijderen; alleen credits kopen is niet genoeg. Tik hieronder, kies een maandabonnement en vraag het opnieuw. Dan verwijder ik de regel gratis uit dit boek.",
    refreshing: "Dit boek wordt bijgewerkt. Als ‘Gemaakt met Tomeza’ er daarna nog staat, vraag dan opnieuw om de regel te verwijderen.",
    busy: "Er wordt nog aan dit boek gewerkt. Vraag het opnieuw zodra het huidige werk klaar is.",
    not_finished: "Dit boek is nog niet af. Met je abonnement wordt het gemaakt zonder de regel ‘Gemaakt met Tomeza’."
  },
  el: {
    reprinted: "Έγινε — αφαιρώ τη γραμμή «Δημιουργήθηκε με το Tomeza» από αυτό το βιβλίο και ενημερώνω τα αρχεία εξαγωγής. Η αλλαγή είναι δωρεάν.",
    not_printed: "Αυτό το βιβλίο δεν έχει τη γραμμή «Δημιουργήθηκε με το Tomeza», οπότε δεν υπάρχει κάτι να αφαιρεθεί.",
    subscription_required: "Κάθε συνδρομή επιτρέπει την αφαίρεση της γραμμής «Δημιουργήθηκε με το Tomeza»· η αγορά πιστώσεων μόνο δεν αρκεί. Πατήστε παρακάτω, επιλέξτε μηνιαία συνδρομή και ζητήστε το ξανά για να την αφαιρέσω δωρεάν από αυτό το βιβλίο.",
    refreshing: "Αυτό το βιβλίο ενημερώνεται. Όταν είναι έτοιμο, αν η γραμμή «Δημιουργήθηκε με το Tomeza» παραμένει, ζητήστε ξανά την αφαίρεσή της.",
    busy: "Οι εργασίες σε αυτό το βιβλίο συνεχίζονται. Ζητήστε το ξανά όταν ολοκληρωθούν.",
    not_finished: "Αυτό το βιβλίο δεν έχει ολοκληρωθεί ακόμα. Με τη συνδρομή σας θα ετοιμαστεί χωρίς τη γραμμή «Δημιουργήθηκε με το Tomeza»."
  },
  he: {
    reprinted: "בוצע — אני מסיר מהספר את השורה «נוצר עם Tomeza» ומעדכן את קובצי הייצוא. השינוי בחינם.",
    not_printed: "בספר הזה אין שורה «נוצר עם Tomeza», ולכן אין מה להסיר.",
    subscription_required: "כל מנוי מאפשר להסיר את השורה «נוצר עם Tomeza»; רכישת קרדיטים בלבד אינה מספיקה. יש ללחוץ למטה, לבחור מנוי חודשי ולבקש שוב כדי שאסיר אותה מהספר בחינם.",
    refreshing: "הספר הזה מתעדכן כעת. אם השורה «נוצר עם Tomeza» עדיין תופיע כשהוא יהיה מוכן, אפשר לבקש שוב להסיר אותה.",
    busy: "העבודה על הספר הזה עדיין נמשכת. אפשר לבקש שוב אחרי שהעבודה הנוכחית תסתיים.",
    not_finished: "הספר הזה עדיין לא מוכן. במסגרת המנוי שלך הוא יוכן בלי השורה «נוצר עם Tomeza»."
  },
  no: {
    reprinted: "Ferdig — jeg fjerner linjen «Laget med Tomeza» fra denne boken og oppdaterer eksportfilene. Endringen er gratis.",
    not_printed: "Denne boken har ikke linjen «Laget med Tomeza», så det er ingenting å fjerne.",
    subscription_required: "Alle abonnementer lar deg fjerne «Laget med Tomeza»; å kjøpe bare kreditter er ikke nok. Trykk nedenfor, velg et månedsabonnement og spør meg igjen, så fjerner jeg linjen gratis fra denne boken.",
    refreshing: "Denne boken blir oppdatert. Hvis «Laget med Tomeza» fortsatt er der når den er klar, kan du be meg om å fjerne linjen igjen.",
    busy: "Det arbeides fortsatt med denne boken. Spør igjen når det pågående arbeidet er ferdig.",
    not_finished: "Denne boken er ikke ferdig ennå. Med abonnementet ditt blir den laget uten linjen «Laget med Tomeza»."
  },
  pl: {
    reprinted: "Gotowe — usuwam z tej książki wiersz „Utworzono w Tomeza” i aktualizuję pliki eksportu. Ta zmiana jest bezpłatna.",
    not_printed: "Ta książka nie ma wiersza „Utworzono w Tomeza”, więc nie ma czego usuwać.",
    subscription_required: "Każda subskrypcja pozwala usunąć wiersz „Utworzono w Tomeza”; sam zakup kredytów nie wystarczy. Naciśnij poniżej, wybierz miesięczną subskrypcję i poproś ponownie, a usunę go z tej książki bezpłatnie.",
    refreshing: "Ta książka jest aktualizowana. Jeśli po zakończeniu nadal będzie zawierać wiersz „Utworzono w Tomeza”, poproś ponownie o jego usunięcie.",
    busy: "Praca nad tą książką nadal trwa. Poproś ponownie, gdy bieżące zadanie się zakończy.",
    not_finished: "Ta książka nie jest jeszcze gotowa. W ramach Twojej subskrypcji zostanie przygotowana bez wiersza „Utworzono w Tomeza”."
  },
  sv: {
    reprinted: "Klart — jag tar bort raden ”Skapad med Tomeza” från den här boken och uppdaterar exportfilerna. Ändringen är gratis.",
    not_printed: "Den här boken har inte raden ”Skapad med Tomeza”, så det finns inget att ta bort.",
    subscription_required: "Alla prenumerationer låter dig ta bort ”Skapad med Tomeza”; enbart köp av krediter räcker inte. Tryck nedan, välj en månadsprenumeration och fråga igen, så tar jag bort raden gratis från den här boken.",
    refreshing: "Den här boken uppdateras. Om ”Skapad med Tomeza” finns kvar när den är klar kan du be mig att ta bort raden igen.",
    busy: "Arbetet med den här boken pågår fortfarande. Fråga igen när det aktuella arbetet är klart.",
    not_finished: "Den här boken är inte klar ännu. Med din prenumeration skapas den utan raden ”Skapad med Tomeza”."
  },
  th: {
    reprinted: "เรียบร้อย — กำลังลบข้อความ ‘สร้างด้วย Tomeza’ จากหนังสือเล่มนี้และอัปเดตไฟล์ส่งออก การเปลี่ยนแปลงนี้ไม่มีค่าใช้จ่าย",
    not_printed: "หนังสือเล่มนี้ไม่มีข้อความ ‘สร้างด้วย Tomeza’ จึงไม่มีข้อความที่ต้องลบ",
    subscription_required: "สมาชิกทุกแผนสามารถลบข้อความ ‘สร้างด้วย Tomeza’ ได้ การซื้อเครดิตอย่างเดียวไม่เพียงพอ แตะด้านล่างเพื่อเลือกแผนรายเดือน แล้วส่งคำขออีกครั้งเพื่อลบข้อความจากหนังสือเล่มนี้โดยไม่มีค่าใช้จ่าย",
    refreshing: "หนังสือเล่มนี้กำลังอัปเดต เมื่อพร้อมแล้ว หากยังมีข้อความ ‘สร้างด้วย Tomeza’ โปรดขอให้ลบอีกครั้ง",
    busy: "หนังสือเล่มนี้ยังอยู่ระหว่างดำเนินการ โปรดส่งคำขออีกครั้งเมื่องานปัจจุบันเสร็จสิ้น",
    not_finished: "หนังสือเล่มนี้ยังไม่เสร็จ ตามแผนสมาชิกของคุณ หนังสือจะถูกจัดทำโดยไม่มีข้อความ ‘สร้างด้วย Tomeza’"
  },
  uk: {
    reprinted: "Готово — прибираю з цієї книги рядок «Створено за допомогою Tomeza» й оновлюю файли експорту. Ця зміна безкоштовна.",
    not_printed: "У цій книзі немає рядка «Створено за допомогою Tomeza», тож видаляти нічого.",
    subscription_required: "Будь-яка підписка дає змогу прибрати рядок «Створено за допомогою Tomeza»; лише купівлі кредитів недостатньо. Натисніть нижче, виберіть місячну підписку й попросіть знову — я безкоштовно приберу рядок із цієї книги.",
    refreshing: "Ця книга оновлюється. Коли вона буде готова, якщо рядок «Створено за допомогою Tomeza» залишиться, попросіть знову його прибрати.",
    busy: "Робота над цією книгою ще триває. Попросіть знову після завершення поточної роботи.",
    not_finished: "Ця книга ще не готова. З вашою підпискою її буде підготовлено без рядка «Створено за допомогою Tomeza»."
  },
  vi: {
    reprinted: "Đã xong — tôi đang xóa dòng ‘Được tạo bằng Tomeza’ khỏi sách này và cập nhật các tệp xuất. Thay đổi này miễn phí.",
    not_printed: "Sách này không có dòng ‘Được tạo bằng Tomeza’, nên không có gì cần xóa.",
    subscription_required: "Mọi gói đăng ký đều cho phép xóa dòng ‘Được tạo bằng Tomeza’; chỉ mua tín dụng là chưa đủ. Nhấn bên dưới, chọn gói hằng tháng rồi yêu cầu lại để tôi xóa dòng này miễn phí khỏi sách.",
    refreshing: "Sách này đang được cập nhật. Khi sẵn sàng, nếu vẫn còn dòng ‘Được tạo bằng Tomeza’, hãy yêu cầu xóa lại.",
    busy: "Sách này vẫn đang được xử lý. Hãy yêu cầu lại sau khi công việc hiện tại hoàn tất.",
    not_finished: "Sách này chưa hoàn thành. Với gói đăng ký của bạn, sách sẽ được tạo mà không có dòng ‘Được tạo bằng Tomeza’."
  },
  fa: {
    reprinted: "انجام شد — عبارت «ساخته‌شده با Tomeza» را از این کتاب برمی‌دارم و فایل‌های خروجی را به‌روز می‌کنم. این تغییر رایگان است.",
    not_printed: "این کتاب عبارت «ساخته‌شده با Tomeza» را ندارد؛ چیزی برای حذف نیست.",
    subscription_required: "حذف عبارت «ساخته‌شده با Tomeza» با هر اشتراکی امکان‌پذیر است؛ خرید اعتبار به‌تنهایی کافی نیست. روی دکمهٔ زیر بزنید و یک اشتراک ماهانه انتخاب کنید، سپس دوباره درخواست بدهید تا آن را رایگان از این کتاب بردارم.",
    refreshing: "این کتاب در حال به‌روزرسانی است. پس از آماده‌شدن، اگر عبارت «ساخته‌شده با Tomeza» هنوز بود، دوباره درخواست بدهید.",
    busy: "هنوز کاری روی این کتاب در حال انجام است. پس از پایان آن، دوباره درخواست بدهید.",
    not_finished: "این کتاب هنوز آماده نشده است. با اشتراک شما، بدون عبارت «ساخته‌شده با Tomeza» آماده خواهد شد."
  },
  ar: {
    reprinted: "تم — أزيل عبارة «صُنع باستخدام Tomeza» من هذا الكتاب وأحدّث ملفات التصدير. هذا التغيير مجاني.",
    not_printed: "لا يحتوي هذا الكتاب على عبارة «صُنع باستخدام Tomeza»، لذلك لا يوجد ما يُحذف.",
    subscription_required: "تتيح أي خطة اشتراك إزالة عبارة «صُنع باستخدام Tomeza»؛ شراء الرصيد وحده لا يتيح ذلك. اضغط أدناه واختر اشتراكًا شهريًا، ثم اطلب مني مجددًا وسأزيلها من هذا الكتاب مجانًا.",
    refreshing: "يجري تحديث هذا الكتاب الآن. بعد أن يصبح جاهزًا، إذا بقيت عبارة «صُنع باستخدام Tomeza»، فاطلب مني مجددًا.",
    busy: "لا يزال العمل جاريًا على هذا الكتاب. اطلب مني مجددًا بعد انتهاء العمل الحالي.",
    not_finished: "لم يكتمل هذا الكتاب بعد. مع اشتراكك، سيُجهّز من دون عبارة «صُنع باستخدام Tomeza»."
  },
  zh: {
    reprinted: "已完成 — 正在从这本书中移除“使用 Tomeza 制作”标识，并更新导出文件。此更改免费。",
    not_printed: "这本书没有“使用 Tomeza 制作”标识，无需移除。",
    subscription_required: "订阅任意套餐即可移除“使用 Tomeza 制作”标识；仅购买点数无法解锁。请点击下方并选择月度套餐，然后再次提出请求，我会免费为这本书移除标识。",
    refreshing: "这本书正在更新。准备好后，如果仍有“使用 Tomeza 制作”标识，请再次提出请求。",
    busy: "这本书仍在处理中。请在当前任务完成后再次提出请求。",
    not_finished: "这本书尚未完成。根据你的订阅套餐，制作时将不会添加“使用 Tomeza 制作”标识。"
  },
  fr: {
    reprinted: "Terminé — je retire la mention « Réalisé avec Tomeza » de ce livre et j’actualise les fichiers d’export. Ce changement est gratuit.",
    not_printed: "Ce livre ne porte pas la mention « Réalisé avec Tomeza » ; il n’y a rien à retirer.",
    subscription_required: "Tout abonnement permet de retirer la mention « Réalisé avec Tomeza » ; les crédits seuls ne suffisent pas. Appuyez ci-dessous et choisissez un abonnement mensuel, puis redemandez-moi de la retirer gratuitement de ce livre.",
    refreshing: "Ce livre est en cours de mise à jour. Une fois prêt, si la mention « Réalisé avec Tomeza » est toujours présente, redemandez-moi de la retirer.",
    busy: "Un travail est encore en cours sur ce livre. Redemandez-moi une fois qu’il sera terminé.",
    not_finished: "Ce livre n’est pas encore terminé. Avec votre abonnement, il sera préparé sans la mention « Réalisé avec Tomeza »."
  },
  de: {
    reprinted: "Erledigt — ich entferne den Hinweis „Erstellt mit Tomeza“ aus diesem Buch und aktualisiere die Exportdateien. Diese Änderung ist kostenlos.",
    not_printed: "Dieses Buch enthält den Hinweis „Erstellt mit Tomeza“ nicht, daher gibt es nichts zu entfernen.",
    subscription_required: "Mit jedem Abo lässt sich der Hinweis „Erstellt mit Tomeza“ entfernen; Guthaben allein reicht dafür nicht aus. Tippe unten und wähle ein Monatsabo. Bitte mich danach erneut darum, dann entferne ich den Hinweis kostenlos aus diesem Buch.",
    refreshing: "Dieses Buch wird gerade aktualisiert. Wenn es fertig ist und der Hinweis „Erstellt mit Tomeza“ noch erscheint, bitte mich erneut darum.",
    busy: "An diesem Buch wird noch gearbeitet. Bitte mich erneut darum, sobald der laufende Auftrag abgeschlossen ist.",
    not_finished: "Dieses Buch ist noch nicht fertig. Mit deinem Abo wird es ohne den Hinweis „Erstellt mit Tomeza“ erstellt."
  },
  hi: {
    reprinted: "हो गया — मैं इस पुस्तक से “Tomeza से बनाई गई” पंक्ति हटा रहा हूँ और निर्यात फ़ाइलें अपडेट कर रहा हूँ। यह बदलाव मुफ़्त है।",
    not_printed: "इस पुस्तक में “Tomeza से बनाई गई” पंक्ति नहीं है, इसलिए हटाने के लिए कुछ नहीं है।",
    subscription_required: "“Tomeza से बनाई गई” पंक्ति किसी भी सदस्यता योजना के साथ हटाई जा सकती है; केवल क्रेडिट खरीदना पर्याप्त नहीं है। नीचे टैप करके मासिक योजना चुनें, फिर दोबारा अनुरोध करें और मैं इसे इस पुस्तक से मुफ़्त हटा दूँगा।",
    refreshing: "यह पुस्तक अभी अपडेट हो रही है। तैयार होने पर यदि “Tomeza से बनाई गई” पंक्ति अभी भी दिखे, तो दोबारा अनुरोध करें।",
    busy: "इस पुस्तक पर अभी काम चल रहा है। मौजूदा काम पूरा होने पर दोबारा अनुरोध करें।",
    not_finished: "यह पुस्तक अभी पूरी नहीं हुई है। आपकी सदस्यता योजना के तहत इसे “Tomeza से बनाई गई” पंक्ति के बिना तैयार किया जाएगा।"
  },
  it: {
    reprinted: "Fatto — sto togliendo la dicitura «Realizzato con Tomeza» da questo libro e aggiornando i file esportati. Questa modifica è gratuita.",
    not_printed: "Questo libro non contiene la dicitura «Realizzato con Tomeza», quindi non c’è nulla da togliere.",
    subscription_required: "Qualsiasi abbonamento permette di togliere la dicitura «Realizzato con Tomeza»; i soli crediti non bastano. Tocca qui sotto e scegli un abbonamento mensile, poi chiedimelo di nuovo e la toglierò gratuitamente da questo libro.",
    refreshing: "Questo libro è in aggiornamento. Quando sarà pronto, se la dicitura «Realizzato con Tomeza» sarà ancora presente, chiedimelo di nuovo.",
    busy: "È ancora in corso un lavoro su questo libro. Chiedimelo di nuovo quando sarà terminato.",
    not_finished: "Questo libro non è ancora finito. Con il tuo abbonamento verrà preparato senza la dicitura «Realizzato con Tomeza»."
  },
  ja: {
    reprinted: "完了 — この本から「Tomezaで制作」の表示を削除し、書き出しファイルを更新しています。この変更は無料です。",
    not_printed: "この本には「Tomezaで制作」の表示がないため、削除するものはありません。",
    subscription_required: "どの定期購入プランでも「Tomezaで制作」の表示を削除できます。クレジットの購入だけでは利用できません。下のボタンから月額プランを選び、もう一度依頼してください。この本から無料で削除します。",
    refreshing: "この本は現在更新中です。準備ができた後も「Tomezaで制作」の表示が残っている場合は、もう一度依頼してください。",
    busy: "この本はまだ処理中です。現在の作業が終わってから、もう一度依頼してください。",
    not_finished: "この本はまだ完成していません。ご利用のプランでは「Tomezaで制作」の表示を付けずに作成されます。"
  },
  ko: {
    reprinted: "완료 — 이 책에서 ‘Tomeza로 제작’ 문구를 제거하고 내보내기 파일을 갱신하고 있습니다. 이 변경은 무료입니다.",
    not_printed: "이 책에는 ‘Tomeza로 제작’ 문구가 없으므로 제거할 것이 없습니다.",
    subscription_required: "어떤 구독 요금제에서든 ‘Tomeza로 제작’ 문구를 제거할 수 있습니다. 크레딧 구매만으로는 이용할 수 없습니다. 아래 버튼을 눌러 월간 요금제를 선택한 뒤 다시 요청하시면 이 책에서 무료로 제거해 드립니다.",
    refreshing: "이 책은 현재 갱신 중입니다. 준비가 끝난 뒤에도 ‘Tomeza로 제작’ 문구가 남아 있다면 다시 요청해 주세요.",
    busy: "이 책에 대한 작업이 아직 진행 중입니다. 현재 작업이 끝나면 다시 요청해 주세요.",
    not_finished: "이 책은 아직 완성되지 않았습니다. 현재 구독 요금제에서는 ‘Tomeza로 제작’ 문구 없이 제작됩니다."
  },
  pt: {
    reprinted: "Concluído — estou removendo a indicação “Feito com Tomeza” deste livro e atualizando os arquivos de exportação. Esta alteração é gratuita.",
    not_printed: "Este livro não contém a indicação “Feito com Tomeza”, então não há nada a remover.",
    subscription_required: "Qualquer assinatura permite remover a indicação “Feito com Tomeza”; apenas comprar créditos não basta. Toque abaixo e escolha um plano mensal. Depois, peça novamente e eu a removerei deste livro gratuitamente.",
    refreshing: "Este livro está sendo atualizado. Quando estiver pronto, se a indicação “Feito com Tomeza” ainda aparecer, peça novamente.",
    busy: "Ainda há um trabalho em andamento neste livro. Peça novamente quando ele terminar.",
    not_finished: "Este livro ainda não está pronto. Com sua assinatura, ele será preparado sem a indicação “Feito com Tomeza”."
  },
  ru: {
    reprinted: "Готово — убираю строку «Создано в Tomeza» из этой книги и обновляю файлы экспорта. Это изменение бесплатно.",
    not_printed: "В этой книге нет строки «Создано в Tomeza», поэтому убирать нечего.",
    subscription_required: "Убрать строку «Создано в Tomeza» можно с любой подпиской; одних кредитов недостаточно. Нажмите ниже и выберите месячный план, затем попросите снова, и я бесплатно уберу её из этой книги.",
    refreshing: "Эта книга сейчас обновляется. Когда она будет готова, если строка «Создано в Tomeza» останется, попросите меня снова.",
    busy: "Работа над этой книгой ещё продолжается. Попросите снова после завершения текущей задачи.",
    not_finished: "Эта книга ещё не готова. С вашей подпиской она будет подготовлена без строки «Создано в Tomeza»."
  },
  es: {
    reprinted: "Hecho — estoy quitando la mención «Hecho con Tomeza» de este libro y actualizando los archivos de exportación. Este cambio es gratis.",
    not_printed: "Este libro no contiene la mención «Hecho con Tomeza», así que no hay nada que quitar.",
    subscription_required: "Cualquier suscripción permite quitar la mención «Hecho con Tomeza»; los créditos por sí solos no bastan. Toca abajo y elige un plan mensual, luego pídemelo de nuevo y la quitaré de este libro gratis.",
    refreshing: "Este libro se está actualizando. Cuando esté listo, si la mención «Hecho con Tomeza» sigue ahí, pídemelo de nuevo.",
    busy: "Todavía hay un trabajo en curso en este libro. Pídemelo de nuevo cuando termine.",
    not_finished: "Este libro aún no está terminado. Con tu suscripción, se preparará sin la mención «Hecho con Tomeza»."
  },
  tr: {
    reprinted: "Tamamlandı — bu kitaptan “Tomeza ile hazırlandı” satırını kaldırıyor ve dışa aktarılan dosyaları güncelliyorum. Bu değişiklik ücretsizdir.",
    not_printed: "Bu kitapta “Tomeza ile hazırlandı” satırı yok, dolayısıyla kaldırılacak bir şey yok.",
    subscription_required: "Herhangi bir abonelikle “Tomeza ile hazırlandı” satırı kaldırılabilir; yalnızca kredi satın almak yeterli değildir. Aşağıya dokunup aylık bir plan seçin, sonra tekrar isteyin; bu kitaptan ücretsiz kaldırayım.",
    refreshing: "Bu kitap şu anda güncelleniyor. Hazır olduğunda “Tomeza ile hazırlandı” satırı hâlâ duruyorsa tekrar isteyin.",
    busy: "Bu kitap üzerinde hâlâ çalışılıyor. Mevcut iş tamamlandıktan sonra tekrar isteyin.",
    not_finished: "Bu kitap henüz tamamlanmadı. Aboneliğinizle “Tomeza ile hazırlandı” satırı olmadan hazırlanacak."
  },
  ur: {
    reprinted: "ہو گیا — میں اس کتاب سے «Tomeza سے تیار کردہ» سطر ہٹا رہا ہوں اور برآمدی فائلیں تازہ کر رہا ہوں۔ یہ تبدیلی مفت ہے۔",
    not_printed: "اس کتاب میں «Tomeza سے تیار کردہ» سطر موجود نہیں، اس لیے ہٹانے کو کچھ نہیں۔",
    subscription_required: "کسی بھی سبسکرپشن کے ساتھ «Tomeza سے تیار کردہ» سطر ہٹائی جا سکتی ہے؛ صرف کریڈٹس خریدنا کافی نہیں۔ نیچے ٹیپ کر کے ماہانہ پلان منتخب کریں، پھر دوبارہ درخواست کریں تاکہ میں اسے اس کتاب سے مفت ہٹا دوں۔",
    refreshing: "یہ کتاب ابھی اپ ڈیٹ ہو رہی ہے۔ تیار ہونے کے بعد اگر «Tomeza سے تیار کردہ» سطر اب بھی موجود ہو تو دوبارہ درخواست کریں۔",
    busy: "اس کتاب پر ابھی کام جاری ہے۔ موجودہ کام مکمل ہونے کے بعد دوبارہ درخواست کریں۔",
    not_finished: "یہ کتاب ابھی مکمل نہیں ہوئی۔ آپ کی سبسکرپشن کے تحت اسے «Tomeza سے تیار کردہ» سطر کے بغیر تیار کیا جائے گا۔"
  }
};
