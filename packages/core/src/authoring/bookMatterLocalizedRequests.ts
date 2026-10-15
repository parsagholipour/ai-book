import type { BookMatterChatLanguage } from "./bookMatterChatEdit.js";
import { arabicScriptFold, localizedBookMatterFieldsNamedIn } from "./bookMatterWords.js";
import { normalizeNumerals } from "../generation/replanSettings.js";

/**
 * The translated half of the matter guard's book-addressed request grammar.
 * A cover noun alone or a general imperative is never enough: these shapes
 * require an imperative and its explicit book object. They deliberately leave
 * prose, instructions to the dedicatee and refinements of the matter to the
 * composer. English and the broader Persian reader remain in bookMatterRequests.
 */
type Grammar = { lead: string; verb: string; object: string; objectFirst?: true; thirdPersonOwner?: string };
const W = String.raw`(?<![\p{L}\p{M}\p{N}])`;
const E = String.raw`(?![\p{L}\p{M}\p{N}])`;
const DIGITS = String.raw`\d{1,4}${E}`;
const CJK_NUMBER = String.raw`[\d〇零一二三四五六七八九十百]+`;

const GRAMMARS: Record<Exclude<BookMatterChatLanguage, "en">, Grammar> = {
  es: {
    lead: "también|tambien|además|ademas|luego|por favor",
    verb: "cambia|cambie|modifica|modifique|redibuja|redibuje|rehaz|reescribe|reescriba|elimina|elimine|quita",
    object: String.raw`(?:(?:la|el)\s+)?(?:portada|cubierta|t[ií]tulo\s+del\s+libro|p[aá]gina\s+${DIGITS}|cap[ií]tulo\s+${DIGITS})`,
    thirdPersonOwner: String.raw`de\s+(?:su|sus)\s+\p{L}`
  },
  fr: {
    lead: "aussi|ensuite|puis|de plus|s'il vous plaît|s'il te plaît",
    verb: "change|changez|modifie|modifiez|redessine|redessinez|réécris|réécrivez|supprime|supprimez|enlève|enlevez",
    object: String.raw`(?:(?:la|le)\s+)?(?:couverture|titre\s+du\s+livre|page\s+${DIGITS}|chapitre\s+${DIGITS})`,
    thirdPersonOwner: String.raw`de\s+(?:son|sa|ses|leur|leurs)\s+\p{L}`
  },
  de: {
    lead: "auch|außerdem|ausserdem|bitte|dann|anschließend",
    verb: "ändere|ändern Sie|entferne|entfernen Sie|lösche|löschen Sie|überarbeite|zeichne neu|schreibe neu",
    object: String.raw`(?:(?:das|die|den)\s+)?(?:cover|buchcover|buchtitel|seite\s+${DIGITS}|kapitel\s+${DIGITS})`
  },
  it: {
    lead: "anche|inoltre|poi|per favore",
    verb: "cambia|modifica|ridisegna|riscrivi|elimina|rimuovi|rifai",
    object: String.raw`(?:(?:la|il)\s+)?(?:copertina|titolo\s+del\s+libro|pagina\s+${DIGITS}|capitolo\s+${DIGITS})`,
    thirdPersonOwner: String.raw`(?:del|della|dello|dei|degli|delle|di)\s+(?:suo|sua|suoi|sue|loro)\s+\p{L}`
  },
  pt: {
    lead: "também|tambem|além disso|alem disso|depois|por favor",
    verb: "mude|altere|modifique|redesenhe|reescreva|remova|elimine|refaça",
    object: String.raw`(?:(?:a|o)\s+)?(?:capa|t[ií]tulo\s+do\s+livro|p[aá]gina\s+${DIGITS}|cap[ií]tulo\s+${DIGITS})`
  },
  ru: {
    lead: "также|ещё|еще|пожалуйста|затем",
    verb: "измени|измените|поменяй|поменяйте|перерисуй|перерисуйте|перепиши|перепишите|удали|удалите",
    object: String.raw`(?:обложку|название\s+книги|страницу\s+${DIGITS}|главу\s+${DIGITS})`
  },
  ar: {
    lead: "أيضاً|أيضا|كذلك|ثم|من فضلك|يرجى",
    verb: "غيّر|غير|بدّل|بدل|عدّل|عدل|احذف|أعد رسم|أعد كتابة",
    object: String.raw`(?:(?:ال)?غلاف|عنوان\s+الكتاب|(?:ال)?صفحة\s+${DIGITS}|(?:ال)?فصل\s+${DIGITS})`
  },
  fa: {
    lead: "همچنین|ضمنا|سپس|بعدش|لطفا",
    object: String.raw`(?:جلد|عنوان\s+کتاب|(?:صفحه|فصل)\s+${DIGITS})(?:\s+را|\s+رو)?`,
    verb: "عوض کن|تغییر بده|بازنویسی کن|حذف کن|دوباره بکش",
    objectFirst: true
  },
  tr: {
    lead: "ayrıca|sonra|lütfen",
    object: String.raw`(?:kapa[ğg][ıiİ]|kapak|kitab[ıiİ]n\s+ba[şs]l[ıiİ][ğg][ıiİ]n[ıiİ]|${DIGITS}\.\s*(?:sayfay[ıiİ]|b[öo]l[üu]m[üu]))`,
    verb: "değiştir|değiştirin|yeniden çiz|yeniden yaz|sil|kaldır",
    objectFirst: true
  },
  hi: {
    lead: "इसके अलावा|कृपया|फिर",
    object: String.raw`(?:कवर|आवरण|पुस्तक\s+का\s+शीर्षक|(?:पृष्ठ|अध्याय)\s+${DIGITS})(?:\s+को)?`,
    verb: "बदलें|बदलो|बदल दो|दोबारा बनाएं|दोबारा लिखें|हटाएं|हटाओ",
    objectFirst: true
  },
  ur: {
    lead: "اس کے علاوہ|مزید|براہ کرم|پھر",
    object: String.raw`(?:سرورق|کتاب\s+کا\s+عنوان|(?:صفحہ|باب)\s+${DIGITS})(?:\s+کو)?`,
    verb: "تبدیل کریں|بدل دیں|دوبارہ بنائیں|دوبارہ لکھیں|حذف کریں",
    objectFirst: true
  },
  zh: {
    lead: "另外|然后|然後|还|還|也|请|請",
    verb: "更改|修改|重画|重畫|重新绘制|重新繪製|删除|刪除|重写|重寫|改写|改寫",
    object: String.raw`(?:封面|书名|書名|(?:第\s*)?${CJK_NUMBER}\s*[页頁章])`
  },
  ja: {
    lead: "また|それから|あと|お願い",
    object: String.raw`(?:表紙|本のタイトル|第?${CJK_NUMBER}章|${CJK_NUMBER}ページ)を`,
    verb: "変更して(?:ください)?|変えて(?:ください)?|描き直して(?:ください)?|書き直して(?:ください)?|削除して(?:ください)?",
    objectFirst: true
  },
  ko: {
    lead: "또|추가로|제발",
    object: String.raw`(?:표지|책\s*제목|(?:제\s*)?\d{1,4}(?!\d)\s*(?:장|페이지))(?:를|을)`,
    verb: "바꿔|변경해|다시 그려|다시 써|삭제해",
    objectFirst: true
  }
};

const REQUESTS = Object.entries(GRAMMARS).map(([language, { lead, verb, object, objectFirst, thirdPersonOwner }]) => {
  const unspaced = language === "zh" || language === "ja";
  const gap = unspaced ? String.raw`\s*` : String.raw`\s+`;
  const open = `(?:(?:${lead})${gap}){0,3}`;
  // Romance languages also put "also" between the imperative and its object.
  const afterVerb = `(?:(?:${lead})${gap})?`;
  const instruction = objectFirst ? `${object}${gap}(?:${verb})` : `(?:${verb})${gap}${afterVerb}${object}`;
  return {
    request: new RegExp(arabicScriptFold(`^${open}${instruction}${language === "zh" ? "" : E}`), "iu"),
    matterRequest: new RegExp(arabicScriptFold(objectFirst
      ? `^${open}(?<object>.{1,160}?)${gap}(?:${verb})${E}`
      : `^${open}(?:${verb})${gap}${afterVerb}(?<object>.+)`), "iu"),
    thirdPersonOwner: thirdPersonOwner ? new RegExp(`^\\s+${thirdPersonOwner}`, "iu") : null
  };
});

/**
 * Whether this clause explicitly asks to edit a different part of the book.
 * In supplied prose, Romance present-tense verbs can look like imperatives:
 * "Cambia la copertina del suo quaderno" describes someone's notebook, whose
 * owner follows the matched noun. That qualification is part of the object;
 * "Cambia la copertina del libro" still names the book being edited.
 */
export function isLocalizedBookEditRequest(clause: string, given = false): boolean {
  const text = normalizeNumerals(arabicScriptFold(clause.normalize("NFKC"))).replace(/\s+/g, " ").trim();
  return REQUESTS.some(({ request, thirdPersonOwner }) => {
    const match = request.exec(text);
    return match !== null && !(given && thirdPersonOwner?.test(text.slice(match[0].length)));
  });
}

// Only explicit conjunctions and punctuation can open a clause. An additive
// word after a subject ("ma mère aussi…") must not split that subject's prose.
const JOINED_BOUNDARY = new RegExp(
  String.raw`[,;،；、—–]|${W}(?:y|et|und|e|и|ve|و|اور|और)${E}|并且|並且|然后|然後|そして|それから|그리고`,
  "giu"
);

/** Clause boundaries whose following words already prove a translated book edit. */
export function localizedBookEditBreaks(sentence: string, given = false): Array<{ index: number; end: number }> {
  return joinedBreaks(sentence, (clause) => isLocalizedBookEditRequest(clause, given));
}

/**
 * Before a matter request as well as a prose edit, for "rewrite chapter 3 and
 * change my author name". A translated field noun alone never starts a new
 * request: the same language grammar must also supply an imperative. Keep this
 * out of supplied prose, where that imperative can belong to the dedication.
 */
export function localizedBookMatterBreaks(sentence: string): Array<{ index: number; end: number }> {
  return joinedBreaks(sentence, (clause) => {
    if (isLocalizedBookEditRequest(clause)) return true;
    const text = normalizeNumerals(arabicScriptFold(clause.normalize("NFKC"))).replace(/\s+/g, " ").trim();
    return REQUESTS.some(({ matterRequest }) => {
      const object = matterRequest.exec(text)?.groups?.object;
      return object !== undefined && localizedBookMatterFieldsNamedIn(object).size > 0;
    });
  });
}

function joinedBreaks(sentence: string, opensRequest: (clause: string) => boolean): Array<{ index: number; end: number }> {
  return [...sentence.matchAll(JOINED_BOUNDARY)].flatMap((match) => {
    const end = match.index + match[0].length;
    // Every probe reads a bounded prefix, even in a 10k-character comma run.
    return opensRequest(sentence.slice(end, end + 200)) ? [{ index: match.index, end }] : [];
  });
}

/** Turkish ordinal page numbers carry a dot, which is not a sentence boundary. */
export function protectLocalizedOrdinalPeriods(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{M}\p{N}])(\p{Nd}{1,4})\.(?=\s*(?:sayfay[ıiİ]|b[öo]l[üu]m[üu])(?![\p{L}\p{M}\p{N}]))/giu,
    "$1\u2024"
  );
}
