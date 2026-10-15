import type { ChatCopyTable } from "../chatReplyCopy.js";

type ProjectChatReplyCopy = { cancelled: string; undoBusy: string; redoBusy: string };

/**
 * The finished-book chat route's own fixed replies — a dropped request, and an
 * undo or redo held back by a running job — in the conversation language
 * (`matterChatLanguage`). No model writes them, so nothing else translates
 * them; English here, mid-way through a localized question, switched the
 * conversation's language on the reader.
 */
export const PROJECT_CHAT_REPLY_COPY: ChatCopyTable<ProjectChatReplyCopy> = {
  en: {
    cancelled: "Okay, I dropped that request. No edit was applied.",
    undoBusy: "This book is still being worked on. Ask me to undo again once the current job finishes.",
    redoBusy: "This book is still being worked on. Ask me to redo again once the current job finishes."
  },
  ar: {
    cancelled: "حسنًا، ألغيت هذا الطلب. لم يُطبَّق أي تعديل.",
    undoBusy: "لا يزال العمل جاريًا على هذا الكتاب. اطلب مني التراجع عن التعديل مجددًا بعد انتهاء العمل الحالي.",
    redoBusy: "لا يزال العمل جاريًا على هذا الكتاب. اطلب مني إعادة التعديل الذي تم التراجع عنه مجددًا بعد انتهاء العمل الحالي."
  },
  zh: {
    cancelled: "好的，我已放弃该请求，没有进行任何修改。",
    undoBusy: "这本书仍在处理中。当前任务完成后，请再次让我撤销修改。",
    redoBusy: "这本书仍在处理中。当前任务完成后，请再次让我恢复已撤销的修改。"
  },
  da: {
    cancelled: "Okay, jeg har droppet den anmodning. Der blev ikke foretaget nogen ændringer.",
    undoBusy: "Der arbejdes stadig på denne bog. Bed mig igen om at fortryde ændringen, når det aktuelle arbejde er færdigt.",
    redoBusy: "Der arbejdes stadig på denne bog. Bed mig igen om at gendanne den fortrudte ændring, når det aktuelle arbejde er færdigt."
  },
  nl: {
    cancelled: "Oké, ik heb dat verzoek laten vallen. Er is geen wijziging doorgevoerd.",
    undoBusy: "Er wordt nog aan dit boek gewerkt. Vraag me opnieuw om de wijziging ongedaan te maken zodra het huidige werk klaar is.",
    redoBusy: "Er wordt nog aan dit boek gewerkt. Vraag me opnieuw om de ongedaan gemaakte wijziging terug te zetten zodra het huidige werk klaar is."
  },
  fa: {
    cancelled: "باشه، آن درخواست را کنار گذاشتم. هیچ ویرایشی اعمال نشد.",
    undoBusy: "کار روی این کتاب هنوز ادامه دارد. وقتی کار فعلی تمام شد، دوباره از من بخواهید ویرایش را برگردانم.",
    redoBusy: "کار روی این کتاب هنوز ادامه دارد. وقتی کار فعلی تمام شد، باز از من بخواهید ویرایشِ برگردانده‌شده را دوباره اعمال کنم."
  },
  fr: {
    cancelled: "D’accord, j’ai abandonné cette demande. Aucune modification n’a été appliquée.",
    undoBusy: "Le travail sur ce livre est toujours en cours. Redemandez-moi d’annuler la modification une fois le travail en cours terminé.",
    redoBusy: "Le travail sur ce livre est toujours en cours. Redemandez-moi de rétablir la modification annulée une fois le travail en cours terminé."
  },
  de: {
    cancelled: "Okay, ich habe diese Anfrage verworfen. Es wurde keine Änderung vorgenommen.",
    undoBusy: "An diesem Buch wird noch gearbeitet. Bitte mich noch einmal, die Änderung rückgängig zu machen, sobald die aktuelle Arbeit abgeschlossen ist.",
    redoBusy: "An diesem Buch wird noch gearbeitet. Bitte mich noch einmal, die rückgängig gemachte Änderung wiederherzustellen, sobald die aktuelle Arbeit abgeschlossen ist."
  },
  el: {
    cancelled: "Εντάξει, ακύρωσα αυτό το αίτημα. Δεν εφαρμόστηκε καμία αλλαγή.",
    undoBusy: "Οι εργασίες σε αυτό το βιβλίο συνεχίζονται. Ζητήστε μου ξανά να αναιρέσω την αλλαγή όταν ολοκληρωθεί η τρέχουσα εργασία.",
    redoBusy: "Οι εργασίες σε αυτό το βιβλίο συνεχίζονται. Ζητήστε μου ξανά να επαναφέρω την αλλαγή που αναιρέθηκε όταν ολοκληρωθεί η τρέχουσα εργασία."
  },
  he: {
    cancelled: "בסדר, ביטלתי את הבקשה הזו. לא בוצע שום שינוי.",
    undoBusy: "העבודה על הספר הזה עדיין נמשכת. אפשר לבקש שוב לבטל את העריכה אחרי שהעבודה הנוכחית תסתיים.",
    redoBusy: "העבודה על הספר הזה עדיין נמשכת. אפשר לבקש שוב להחזיר את העריכה שבוטלה אחרי שהעבודה הנוכחית תסתיים."
  },
  hi: {
    cancelled: "ठीक है, मैंने वह अनुरोध छोड़ दिया। कोई बदलाव लागू नहीं किया गया।",
    undoBusy: "इस किताब पर अभी काम चल रहा है। मौजूदा काम पूरा होने पर मुझसे फिर से बदलाव पूर्ववत करने को कहें।",
    redoBusy: "इस किताब पर अभी काम चल रहा है। मौजूदा काम पूरा होने पर मुझसे फिर से पूर्ववत किया गया बदलाव वापस लाने को कहें।"
  },
  it: {
    cancelled: "Va bene, ho annullato quella richiesta. Non è stata applicata alcuna modifica.",
    undoBusy: "Il lavoro su questo libro è ancora in corso. Chiedimi di nuovo di annullare la modifica quando il lavoro in corso sarà terminato.",
    redoBusy: "Il lavoro su questo libro è ancora in corso. Chiedimi di nuovo di ripristinare la modifica annullata quando il lavoro in corso sarà terminato."
  },
  ja: {
    cancelled: "承知しました。そのご依頼は取り消しました。変更は加えていません。",
    undoBusy: "この本はまだ処理中です。現在の処理が終わったら、もう一度編集を元に戻すよう依頼してください。",
    redoBusy: "この本はまだ処理中です。現在の処理が終わったら、元に戻した編集をやり直すようもう一度依頼してください。"
  },
  ko: {
    cancelled: "알겠습니다. 그 요청은 취소했습니다. 아무것도 변경하지 않았습니다.",
    undoBusy: "이 책은 아직 작업 중입니다. 현재 작업이 끝나면 수정을 되돌려 달라고 다시 요청해 주세요.",
    redoBusy: "이 책은 아직 작업 중입니다. 현재 작업이 끝나면 되돌린 수정을 복원해 달라고 다시 요청해 주세요."
  },
  no: {
    cancelled: "Greit, jeg har droppet den forespørselen. Ingen endring ble gjort.",
    undoBusy: "Det arbeides fortsatt med denne boken. Spør meg igjen om å angre endringen når det pågående arbeidet er ferdig.",
    redoBusy: "Det arbeides fortsatt med denne boken. Spør meg igjen om å gjenopprette den angrede endringen når det pågående arbeidet er ferdig."
  },
  pl: {
    cancelled: "Dobrze, ta prośba została anulowana. Nie wprowadzono żadnych zmian.",
    undoBusy: "Praca nad tą książką nadal trwa. Poproś ponownie o cofnięcie zmiany, gdy bieżące zadanie się zakończy.",
    redoBusy: "Praca nad tą książką nadal trwa. Poproś ponownie o przywrócenie cofniętej zmiany, gdy bieżące zadanie się zakończy."
  },
  pt: {
    cancelled: "Certo, descartei esse pedido. Nenhuma alteração foi aplicada.",
    undoBusy: "Este livro ainda está sendo trabalhado. Peça-me de novo para desfazer a alteração quando o trabalho atual terminar.",
    redoBusy: "Este livro ainda está sendo trabalhado. Peça-me de novo para refazer a alteração desfeita quando o trabalho atual terminar."
  },
  ru: {
    cancelled: "Хорошо, этот запрос отменён. Никаких изменений не внесено.",
    undoBusy: "Работа над этой книгой ещё идёт. Когда текущая работа завершится, попросите меня ещё раз отменить правку.",
    redoBusy: "Работа над этой книгой ещё идёт. Когда текущая работа завершится, попросите меня ещё раз вернуть отменённую правку."
  },
  es: {
    cancelled: "De acuerdo, descarté esa solicitud. No se aplicó ningún cambio.",
    undoBusy: "Este libro aún se está procesando. Pídeme de nuevo que deshaga el cambio cuando termine el trabajo actual.",
    redoBusy: "Este libro aún se está procesando. Pídeme de nuevo que rehaga el cambio deshecho cuando termine el trabajo actual."
  },
  sv: {
    cancelled: "Okej, jag har avbrutit den begäran. Ingen ändring har gjorts.",
    undoBusy: "Arbetet med den här boken pågår fortfarande. Be mig igen att ångra ändringen när det aktuella arbetet är klart.",
    redoBusy: "Arbetet med den här boken pågår fortfarande. Be mig igen att återställa den ångrade ändringen när det aktuella arbetet är klart."
  },
  th: {
    cancelled: "ได้เลย ยกเลิกคำขอนั้นแล้ว ไม่มีการแก้ไขใด ๆ",
    undoBusy: "หนังสือเล่มนี้ยังอยู่ระหว่างดำเนินการ โปรดขอให้เลิกทำการแก้ไขอีกครั้งเมื่องานปัจจุบันเสร็จสิ้น",
    redoBusy: "หนังสือเล่มนี้ยังอยู่ระหว่างดำเนินการ โปรดขอให้นำการแก้ไขที่เลิกทำไปกลับมาอีกครั้งเมื่องานปัจจุบันเสร็จสิ้น"
  },
  tr: {
    cancelled: "Tamam, bu isteği iptal ettim. Hiçbir düzenleme uygulanmadı.",
    undoBusy: "Bu kitap üzerinde hâlâ çalışılıyor. Mevcut iş tamamlandığında düzenlemeyi geri almamı yeniden isteyin.",
    redoBusy: "Bu kitap üzerinde hâlâ çalışılıyor. Mevcut iş tamamlandığında geri alınan düzenlemeyi yeniden uygulamamı tekrar isteyin."
  },
  uk: {
    cancelled: "Гаразд, цей запит скасовано. Жодних змін не внесено.",
    undoBusy: "Робота над цією книгою ще триває. Коли поточна робота завершиться, попросіть мене ще раз скасувати зміну.",
    redoBusy: "Робота над цією книгою ще триває. Коли поточна робота завершиться, попросіть мене ще раз повернути скасовану зміну."
  },
  ur: {
    cancelled: "ٹھیک ہے، وہ درخواست منسوخ کر دی گئی ہے۔ کوئی تبدیلی نہیں کی گئی۔",
    undoBusy: "اس کتاب پر ابھی کام جاری ہے۔ موجودہ کام مکمل ہونے پر مجھ سے دوبارہ ترمیم واپس لینے کو کہیں۔",
    redoBusy: "اس کتاب پر ابھی کام جاری ہے۔ موجودہ کام مکمل ہونے پر مجھ سے دوبارہ واپس لی گئی ترمیم بحال کرنے کو کہیں۔"
  },
  vi: {
    cancelled: "Được rồi, tôi đã hủy yêu cầu đó. Không có chỉnh sửa nào được áp dụng.",
    undoBusy: "Sách này vẫn đang được xử lý. Hãy yêu cầu tôi hoàn tác chỉnh sửa lần nữa khi công việc hiện tại hoàn tất.",
    redoBusy: "Sách này vẫn đang được xử lý. Hãy yêu cầu tôi khôi phục chỉnh sửa đã hoàn tác lần nữa khi công việc hiện tại hoàn tất."
  }
};
