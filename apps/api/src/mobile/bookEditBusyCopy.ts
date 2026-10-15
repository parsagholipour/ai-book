import { chatCopy, type ChatCopyTable } from "../chatReplyCopy.js";
import type { MatterChatLanguage } from "./bookMatterChatLanguage.js";

type BusyCopy = { saved: string; run: string; confirm: string; questions: string };

// Keep the quoted command literal: the pending-edit confirmation parser accepts
// “apply it”. Translating that command alone would leave the saved edit stranded.
export const BUSY_EDIT_COPY: ChatCopyTable<BusyCopy> = {
  en: {
    saved: "This book is still being worked on, so I saved that request.",
    run: "Say “apply it” once the current job finishes and I’ll run it.",
    confirm: "Say “apply it” once the current job finishes and I’ll set it up for you to confirm.",
    questions: "You can keep asking questions in the meantime."
  },
  da: {
    saved: "Der arbejdes stadig på denne bog, så jeg har gemt din anmodning.",
    run: "Skriv ‘apply it’, når det aktuelle arbejde er færdigt, så udfører jeg den.",
    confirm: "Skriv ‘apply it’, når det aktuelle arbejde er færdigt, så gør jeg den klar til din bekræftelse.",
    questions: "Du kan fortsætte med at stille spørgsmål imens."
  },
  nl: {
    saved: "Er wordt nog aan dit boek gewerkt, dus ik heb je verzoek opgeslagen.",
    run: "Stuur ‘apply it’ zodra het huidige werk klaar is, dan voer ik je verzoek uit.",
    confirm: "Stuur ‘apply it’ zodra het huidige werk klaar is, dan zet ik je verzoek klaar om te bevestigen.",
    questions: "Je kunt ondertussen vragen blijven stellen."
  },
  el: {
    saved: "Οι εργασίες σε αυτό το βιβλίο συνεχίζονται, οπότε αποθήκευσα το αίτημά σας.",
    run: "Γράψτε «apply it» όταν ολοκληρωθεί η τρέχουσα εργασία και θα το εκτελέσω.",
    confirm: "Γράψτε «apply it» όταν ολοκληρωθεί η τρέχουσα εργασία και θα το ετοιμάσω για επιβεβαίωση.",
    questions: "Στο μεταξύ μπορείτε να συνεχίσετε να κάνετε ερωτήσεις."
  },
  he: {
    saved: "העבודה על הספר הזה עדיין נמשכת, ולכן שמרתי את הבקשה שלך.",
    run: "כשהעבודה הנוכחית תסתיים, יש לכתוב «apply it» ואבצע את הבקשה.",
    confirm: "כשהעבודה הנוכחית תסתיים, יש לכתוב «apply it» ואכין את הבקשה לאישור שלך.",
    questions: "בינתיים אפשר להמשיך לשאול שאלות."
  },
  no: {
    saved: "Det arbeides fortsatt med denne boken, så jeg har lagret forespørselen din.",
    run: "Skriv «apply it» når det pågående arbeidet er ferdig, så utfører jeg forespørselen.",
    confirm: "Skriv «apply it» når det pågående arbeidet er ferdig, så gjør jeg forespørselen klar til bekreftelse.",
    questions: "Du kan fortsette å stille spørsmål i mellomtiden."
  },
  pl: {
    saved: "Praca nad tą książką nadal trwa, więc prośba została zapisana.",
    run: "Napisz „apply it”, gdy bieżące zadanie się zakończy, a wykonam prośbę.",
    confirm: "Napisz „apply it”, gdy bieżące zadanie się zakończy, a przygotuję prośbę do potwierdzenia.",
    questions: "W międzyczasie możesz nadal zadawać pytania."
  },
  sv: {
    saved: "Arbetet med den här boken pågår fortfarande, så jag har sparat din begäran.",
    run: "Skriv ”apply it” när det aktuella arbetet är klart, så utför jag den.",
    confirm: "Skriv ”apply it” när det aktuella arbetet är klart, så förbereder jag den för din bekräftelse.",
    questions: "Du kan fortsätta att ställa frågor under tiden."
  },
  th: {
    saved: "หนังสือเล่มนี้ยังอยู่ระหว่างดำเนินการ จึงได้บันทึกคำขอของคุณไว้แล้ว",
    run: "ส่งคำว่า ‘apply it’ เมื่องานปัจจุบันเสร็จ แล้วจะดำเนินการตามคำขอให้",
    confirm: "ส่งคำว่า ‘apply it’ เมื่องานปัจจุบันเสร็จ แล้วจะเตรียมคำขอให้คุณยืนยัน",
    questions: "ระหว่างนี้คุณยังถามคำถามต่อได้"
  },
  uk: {
    saved: "Робота над цією книгою ще триває, тому ваш запит збережено.",
    run: "Коли поточна робота завершиться, напишіть «apply it», і я виконаю запит.",
    confirm: "Коли поточна робота завершиться, напишіть «apply it», і я підготую запит для вашого підтвердження.",
    questions: "Тим часом ви можете продовжувати ставити запитання."
  },
  vi: {
    saved: "Sách này vẫn đang được xử lý nên tôi đã lưu yêu cầu của bạn.",
    run: "Hãy gửi ‘apply it’ khi công việc hiện tại hoàn tất, rồi tôi sẽ thực hiện yêu cầu.",
    confirm: "Hãy gửi ‘apply it’ khi công việc hiện tại hoàn tất, rồi tôi sẽ chuẩn bị yêu cầu để bạn xác nhận.",
    questions: "Trong lúc chờ, bạn vẫn có thể tiếp tục đặt câu hỏi."
  },
  fa: {
    saved: "کار روی این کتاب هنوز ادامه دارد، پس درخواست شما را ذخیره کردم.",
    run: "وقتی کار فعلی تمام شد، بنویسید «apply it» تا درخواست را اجرا کنم.",
    confirm: "وقتی کار فعلی تمام شد، بنویسید «apply it» تا درخواست را برای تأیید شما آماده کنم.",
    questions: "در این فاصله می‌توانید به پرسیدن سؤال ادامه دهید."
  },
  ar: {
    saved: "لا يزال العمل على هذا الكتاب جاريًا، لذا حفظت طلبك.",
    run: "اكتب «apply it» بعد انتهاء العمل الحالي وسأنفذ الطلب.",
    confirm: "اكتب «apply it» بعد انتهاء العمل الحالي وسأجهز الطلب لتأكيده.",
    questions: "يمكنك مواصلة طرح الأسئلة في هذه الأثناء."
  },
  zh: {
    saved: "这本书仍在处理中，我已保存你的请求。",
    run: "当前任务完成后，请发送“apply it”，我就会执行该请求。",
    confirm: "当前任务完成后，请发送“apply it”，我会准备好该请求供你确认。",
    questions: "在此期间，你可以继续提问。"
  },
  fr: {
    saved: "Le travail sur ce livre est toujours en cours, j’ai donc enregistré votre demande.",
    run: "Écrivez « apply it » une fois le travail en cours terminé et j’exécuterai la demande.",
    confirm: "Écrivez « apply it » une fois le travail en cours terminé et je préparerai la demande pour votre confirmation.",
    questions: "Vous pouvez continuer à poser des questions en attendant."
  },
  de: {
    saved: "An diesem Buch wird noch gearbeitet. Ich habe deine Anfrage gespeichert.",
    run: "Schreibe „apply it“, sobald die aktuelle Arbeit abgeschlossen ist, und ich führe die Anfrage aus.",
    confirm: "Schreibe „apply it“, sobald die aktuelle Arbeit abgeschlossen ist, und ich bereite die Anfrage zur Bestätigung vor.",
    questions: "In der Zwischenzeit kannst du weiter Fragen stellen."
  },
  hi: {
    saved: "इस किताब पर अभी काम चल रहा है, इसलिए आपका अनुरोध सहेज लिया है।",
    run: "मौजूदा काम पूरा होने पर “apply it” लिखें और आपका अनुरोध पूरा कर दूँगा।",
    confirm: "मौजूदा काम पूरा होने पर “apply it” लिखें और आपकी पुष्टि के लिए अनुरोध तैयार कर दूँगा।",
    questions: "इस बीच आप सवाल पूछना जारी रख सकते हैं।"
  },
  it: {
    saved: "Il lavoro su questo libro è ancora in corso, quindi ho salvato la tua richiesta.",
    run: "Scrivi «apply it» quando il lavoro in corso sarà terminato ed eseguirò la richiesta.",
    confirm: "Scrivi «apply it» quando il lavoro in corso sarà terminato e preparerò la richiesta per la tua conferma.",
    questions: "Nel frattempo puoi continuare a fare domande."
  },
  ja: {
    saved: "この本はまだ処理中のため、ご依頼を保存しました。",
    run: "現在の処理が終わったら「apply it」と送信してください。ご依頼を実行します。",
    confirm: "現在の処理が終わったら「apply it」と送信してください。確認できるようにご依頼を準備します。",
    questions: "その間も引き続き質問できます。"
  },
  ko: {
    saved: "이 책은 아직 작업 중이므로 요청을 저장했습니다.",
    run: "현재 작업이 끝나면 “apply it”을 보내 주세요. 요청을 실행하겠습니다.",
    confirm: "현재 작업이 끝나면 “apply it”을 보내 주세요. 확인하실 수 있도록 요청을 준비하겠습니다.",
    questions: "그동안에도 계속 질문하실 수 있습니다."
  },
  pt: {
    saved: "Este livro ainda está sendo trabalhado, então salvei seu pedido.",
    run: "Escreva “apply it” quando o trabalho atual terminar e executarei o pedido.",
    confirm: "Escreva “apply it” quando o trabalho atual terminar e prepararei o pedido para sua confirmação.",
    questions: "Enquanto isso, você pode continuar fazendo perguntas."
  },
  ru: {
    saved: "Работа над этой книгой ещё идёт. Ваш запрос сохранён.",
    run: "Когда текущая работа завершится, напишите «apply it», и я выполню запрос.",
    confirm: "Когда текущая работа завершится, напишите «apply it», и я подготовлю запрос для вашего подтверждения.",
    questions: "А пока вы можете продолжать задавать вопросы."
  },
  es: {
    saved: "Este libro aún se está procesando, así que guardé tu solicitud.",
    run: "Escribe «apply it» cuando termine el trabajo actual y ejecutaré la solicitud.",
    confirm: "Escribe «apply it» cuando termine el trabajo actual y prepararé la solicitud para que la confirmes.",
    questions: "Mientras tanto, puedes seguir haciendo preguntas."
  },
  tr: {
    saved: "Bu kitap üzerinde hâlâ çalışılıyor, bu yüzden isteğinizi kaydettim.",
    run: "Mevcut iş tamamlandığında “apply it” yazın, isteğinizi uygulayayım.",
    confirm: "Mevcut iş tamamlandığında “apply it” yazın, isteğinizi onayınız için hazırlayayım.",
    questions: "Bu sırada soru sormaya devam edebilirsiniz."
  },
  ur: {
    saved: "اس کتاب پر ابھی کام جاری ہے، اس لیے آپ کی درخواست محفوظ کر لی ہے۔",
    run: "موجودہ کام مکمل ہونے پر «apply it» لکھیں تاکہ میں درخواست پر عمل کر سکوں۔",
    confirm: "موجودہ کام مکمل ہونے پر «apply it» لکھیں تاکہ میں درخواست آپ کی تصدیق کے لیے تیار کر سکوں۔",
    questions: "اس دوران آپ سوال پوچھنا جاری رکھ سکتے ہیں۔"
  }
};

export function busyEditMessage(language: MatterChatLanguage, executeOnResume: boolean): string {
  const copy = chatCopy(BUSY_EDIT_COPY, language);
  return [copy.saved, executeOnResume ? copy.run : copy.confirm, copy.questions].join(" ");
}
