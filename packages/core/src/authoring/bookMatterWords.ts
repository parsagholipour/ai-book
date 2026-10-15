import { normalizeNumerals } from "../generation/replanSettings.js";
import type { BookMatterChatField } from "./bookMatterChatEdit.js";

/**
 * How the book-matter chat checks read the reader's words: one fold for every
 * comparison (compatibility forms, one Arabic-script spelling, Western digits,
 * lower case), the words that name each matter field, an ISBN as typed, and
 * whether a quote is words the reader really wrote. Pure and model-free; the
 * decisions built on them are in `bookMatterChatEdit.ts`.
 */

/**
 * Arabic-script spellings that are one letter to the reader: the Arabic and
 * Persian yeh and kaf, the hamza'd alefs, and the marks and tatweel a keyboard
 * may or may not add. Folded on both sides of every comparison — and into the
 * cue patterns below, so they can be written as the words are spelled.
 */
export function arabicScriptFold(text: string): string {
  return text
    .replace(/[\u064A\u0649]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/[\u064B-\u065F\u0670\u0640\u200C]/g, "");
}

/** A word start and end that know letters beyond ASCII (`\b` does not). */
const W = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;

type FieldCue = { all: RegExp; localized: RegExp };

/** The shared field vocabulary, also kept apart for the API's narrow English routing guard. */
function cue(english: readonly string[], localized: readonly string[]): FieldCue {
  const translated = localized.map(arabicScriptFold);
  return {
    all: new RegExp([...english, ...translated].join("|"), "iu"),
    localized: new RegExp(translated.join("|"), "iu")
  };
}

/**
 * "author" or "writer" as the byline ("change author to Sam Lee", "Author:
 * Sam Lee", "use Sam Lee as the author", "add Ana as co-author") — never the
 * About the Author page, a note or a compound: not after "about", "from",
 * "by", "to" or "for", not possessive, not before "bio", "page", "note",
 * "block" and their like, and not "the author of" anything but this book
 * ("she is the author of two novels" is a biography).
 */
const BYLINE_COMPOUND =
  "bio|biography|blurb|page|note|notes|info|profile|photo|picture|section|intro|introduction|letter|message|interview|" +
  "block|blocks|group|groups|room|retreat|workshop|workshops|conference|festival|circle|guild|club|event|events|tour|signing|signings|" +
  "copy|copies|program|programme|residency|award|awards|prize|life|career|journey|desk|cramp|strike|community|panel|website|site|" +
  "email|headshot|portrait|signature|character|characters|voice|tone|style|persona|perspective|statement|quote|quotes";
const BYLINE_NOUN = String.raw`(?<!(?:about|from|by|to|for)\s+(?:the\s+)?)(?:author|writer)s?(?!['’]s?${E})(?!\s+(?:${BYLINE_COMPOUND})${E})(?!\s+of${E}(?!\s+(?:this|the|my)\s+(?:book|novel|story)${E}))${E}`;
const BYLINE_VERB = String.raw`(?:set|change|replace|remove|update|fix|correct|edit|use|put|swap|switch|delete|drop|rename)`;
/** What follows "make the author" when the author is the book's voice, not its byline ("make the writer sound…"). */
const VOICE_FOLLOWS = String.raw`(?!\s+(?:sounds?|seems?|looks?|feels?|appears?|comes?|becomes?|acts?|speaks?|talks?|says?|writes?|thinks?|reads?|more|less|very|so|too|really|much|even|a|an|someone|somebody|younger|older|funnier|smarter|nicer|kinder|wiser|better|worse|happier|sadder|meaner|braver|stronger|bolder|warmer|friendlier|likable|likeable|relatable|sympathetic|confident)${E})`;
/** What follows "as the author" when it compares ("write it as the author would") rather than credits. */
const COMPARISON_FOLLOWS = String.raw`(?!\s+(?:would|will|did|does|do|might|may|could|can|should|must|had|has|have|was|is|were|intended|intends|meant|means|wanted|wants|wrote|writes|said|says|saw|sees|imagined|imagines|described|describes|planned|envisioned|originally|herself|himself|themselves|themself)${E})`;
/**
 * The same noun in Persian and Arabic, before an object marker, a colon or
 * "to", and outside the construct that makes it "the author's <page>"
 * ("درباره‌ی نویسنده", "نبذة عن المؤلف") — and not before "introduce"
 * ("نویسنده رو معرفی کن" asks for About the Author).
 */
const PERSIAN_NOT_BYLINE = String.raw`(?<!(?:درباره|معرفی|بیوگرافی|زندگی\s*نامه|یادداشت|سخن|مقدمه|پیام|عکس|صفحه)\s*(?:ی\s*)?)`;
const PERSIAN_BYLINE = String.raw`${PERSIAN_NOT_BYLINE}نویسنده\s*(?:ی\s*)?(?:کتاب\s*)?(?:را|رو|:)(?!\s*معرفی)`;
/**
 * "سارا نویسنده‌ی کتاب است", "نویسنده‌ی کتاب سارا باشه": "the book's author"
 * with "is" right after it, or a name and "be" — never "نویسنده‌ی کتاب کودک
 * است" (a children's-book writer) or "نویسنده‌ی کتاب‌های …", which are a bio.
 */
const PERSIAN_BYLINE_IS = String.raw`${PERSIAN_NOT_BYLINE}نویسنده\s*(?:ی\s*)?(?:این\s*)?کتاب(?:\s*(?:است|هست|هستم|هستیم)|(?:\s+[^\s.!?؟،]+){1,3}\s+(?:باشد|باشه|بشه|بشود|شود))(?=$|[\s.!?؟،])`;
/**
 * "نویسنده سارا احمدی باشه" — "the author" and "be" around a name, with no
 * "the book's" between — and "سارا احمدی رو نویسنده کن", a name made the
 * author. Never "make the main character a writer" (a character, a hero, the
 * narrator).
 */
const PERSIAN_BYLINE_BE = String.raw`${PERSIAN_NOT_BYLINE}نویسنده(?:\s+[^\s.!?؟،]+){1,3}\s+(?:باشد|باشه|بشه|بشود|شود)(?=$|[\s.!?؟،])`;
const PERSIAN_MADE_AUTHOR = String.raw`(?:را|رو)(?<!(?:شخصیت|قهرمان|کاراکتر|راوی)[^.!?؟،\n]{0,30}(?:را|رو))\s*(?:به\s*عنوان\s*)?نویسنده(?:\s*ی)?(?:\s*کتاب)?\s*(?:کن|بکن|کنید|بکنید|بذار|بگذار|بذارید|بگذارید)(?=$|[\s.!?؟،])`;
const ARABIC_BYLINE = String.raw`(?<!(?:عن|نبذة|سيرة|كلمة|ملاحظة|مقدمة|صورة|صفحة|رسالة)\s*)(?:المؤلف|الكاتب)ة?\s*(?::|إلى|الى|هو|هي)`;

/**
 * "author" in Spanish, French, German, Italian and Portuguese, as the byline
 * — the shapes the English noun has: "Autor: Sam Lee", "cambia el autor a…",
 * "l'autore è…", "o autor é…", "pon a Sam Lee como autor", "je suis
 * l'auteur". Never after "about / of / by / for / to" and their like ("sobre
 * el autor", "nota del autor", "droits d'auteur", "dedícalo al autor"), and
 * never "the author of" anything but this book ("autora de dos novelas").
 */
const EU_ARTICLE = String.raw`(?:(?:el|la|los|las|o|a|os|as|le|les|il|lo|gli|den|die|der|dem|des)\s+|l['’]\s*)`;
const EU_BEFORE = String.raw`(?:sobre|acerca\s+de|propos\s+de|sur|über|uber|su|sul|sulla|di|de|del|da|do|dos|das|von|vom|zum|par|por|para|pour|für|fur|per|dal|dalla|della|dello|du|al|au|aux|ao|à|nota|note|notes|biografía|biografia|biographie|pagina|sezione)`;
const EU_BOOK = String.raw`(?:(?:este|esta|ese|esa|ce|cet|cette|questo|questa|dieses|diesem|deste|desta|el|le|il|o|dem|mi|mon|ma|meu|minha|mein|meinem)\s+)?(?:libro|livre|livro|buch|novela|roman|romanzo|romance)${E}`;
const EU_NOUN =
  String.raw`(?<!${W}${EU_BEFORE}\s+${EU_ARTICLE}?)(?<!${W}(?:dell|dall|sull|nell|d)['’]\s*)(?:autor(?:a|in)?|auteure?|autore|autrice|verfasser(?:in)?)${E}` +
  String.raw`(?!\s+(?:de|del|di|dei|della|dello|von|vom|des|du|da|do|dos|das)${E}(?!\s+${EU_BOOK}))`;
const EU_VERB =
  "cambia|cambiar|cambie|pon|poner|ponga|usa|usar|actualiza|reemplaza|corrige|quita|elimina|borra|define|defina|" +
  "change|changez|changer|mets|mettez|mettre|remplace|remplacez|modifie|modifiez|corrigez|supprime|supprimez|enlève|enlevez|utilise|" +
  "ändere|ändern|änder|setze|setzen|ersetze|ersetzen|korrigiere|entferne|lösche|nimm|" +
  "metti|mettere|imposta|sostituisci|modifica|correggi|togli|rimuovi|" +
  "muda|mude|mudar|troca|troque|coloca|coloque|altera|altere|corrija|remova|apaga|apague|tira|tire";
const EU_BYLINE = [
  String.raw`${W}${EU_NOUN}\s*[:=]`,
  String.raw`${W}${EU_ARTICLE}${EU_NOUN}\s+(?:a|en|in|por|zu|auf|è|é|es|est|ist|sea|soit|sia|seja|será|sera|sarà|wird|soll|sollte|muss|debe|deve|doit|devrait|dovrebbe|deveria|tiene\s+que|tem\s+que)${E}`,
  String.raw`${W}(?:${EU_VERB})\s+${EU_ARTICLE}?${EU_NOUN}`,
  // After the name it credits, and never "works as an author" ("Ich arbeite
  // als Autorin") or a sentence that opens "As an author, …", which are a bio.
  String.raw`(?<=[\p{L}\p{N}.]\s+)(?<!(?:arbeit|tätig|trabaj|travaill|lavor|trabalh|work)\p{L}*\s+)(?:como|comme|come|als)\s+(?:co-?|(?:segund[oa]|second[ae]?|secondo|deuxi[eè]me|zweite[rn]?)\s+)?${EU_NOUN}`,
  String.raw`${W}(?:es|est|ist|è|é|soy|sou|suis|bin|sono|sei|eres)\s+${EU_ARTICLE}(?:co-?)?${EU_NOUN}`,
  String.raw`${W}${EU_NOUN}\s+(?:de|del|di|von|du|do|da)\s+${EU_BOOK}`
];

/**
 * Turkish names take possessive and object suffixes: "yazar adını", "kalem
 * adımı", "yazarın ismini". The noun "yazar" alone is also a profession, so
 * only its name, a credit label, or an explicit request to credit it counts.
 * Spell dotted/dotless I here: JavaScript's case folding does not unite them.
 */
const TURKISH_NAME = String.raw`(?:ad(?:[ıiİ](?:[mn][ıiİ]?)?)?|[iİ]sim|[iİ]sm[iİ](?:[mn][iİ]?)?)`;
const TURKISH_BYLINE = [
  String.raw`${W}(?:yazar(?:[ıiİ]n)?|kalem|takma|m[üu]stear)\s+${TURKISH_NAME}${E}`,
  String.raw`${W}mahlas(?:[ıiİ](?:[mn][ıiİ]?)?)?${E}`,
  String.raw`${W}yazar\s*[:=]`,
  String.raw`${W}yazar\s+olarak\s+(?:ekle(?:y[iİ]n)?|bel[iİ]rt(?:[iİ]n)?|g[öo]ster(?:[iİ]n)?|yaz(?:[ıiİ]n)?|kaydet|kayded[iİ]n)${E}`,
  String.raw`${W}yazar[ıiİ]\s+(?:de[ğg][iİ][şs]t[iİ]r(?:[iİ]n)?|kald[ıiİ]r(?:[ıiİ]n)?|s[iİ]l(?:[iİ]n)?)${E}`
];

/**
 * Bare 作者 / 著者 count beside a byline command, never as a profession or
 * the start of 作者简介 / 著者紹介. A Chinese removal ends at the noun or
 * continues into the next command; its object cannot be the author's page.
 */
const CHINESE_BYLINE = String.raw`(?<!(?:关于|關於|介绍|介紹)\s*)作者`;
const CHINESE_BYLINE_REMOVE = String.raw`(?:删除|刪除|移除|去掉)`;
const CHINESE_BYLINE_END = String.raw`(?=\s*(?:$|[，,。.!！?？;；]|并|並|和|及|然后|然後))`;
// "Change to a paragraph introducing the author" is still biography prose.
const JAPANESE_BYLINE_VALUE = String.raw`(?=\S)(?:(?!(?:紹介|説明|描写|写真|画像|文章|ページ))[^、，,。.!！?？;；\n]){1,80}?`;
const CJK_BYLINE = [
  String.raw`${CHINESE_BYLINE}\s*(?:(?:更改|改|换|換)(?:为|為|成)|(?:设置|設置|设|設)(?:为|為)|${CHINESE_BYLINE_REMOVE}${CHINESE_BYLINE_END})`,
  String.raw`${CHINESE_BYLINE_REMOVE}\s*作者${CHINESE_BYLINE_END}`,
  String.raw`著者\s*を\s*${JAPANESE_BYLINE_VALUE}\s*に\s*(?:変更|設定)`,
  String.raw`著者\s*を\s*(?:削除|消去|取り除|外して)`
];

/**
 * The byline shapes that need a name to read as one, so they are matched
 * case-sensitively: "put Sam Lee on the title page", "publish it as Sam
 * Lee", "make it by Sam Lee", "it should say by Sam Lee" — never "put a
 * picture on the title page", "publish it as an ebook" or "make it by
 * Friday". The cover is left out: "put Max on the cover" is a picture of a
 * character as often as a byline, and "my name … on the cover" already says.
 *
 * A name word reads at most 42 characters, and never starts inside a word —
 * after a letter, a mark, or a letter's apostrophe or hyphen ("O'Neil",
 * "Jean-Luc"); a quote or an initial before it is fine ("'Sam Lee' wrote this
 * book", "S.J. Lee"). "X wrote this book" is tried at every start, and a
 * capital after each "’" of "Ab’Ab’…" used to start a word that read to the end
 * of the run: 1.3 s of event loop at 10,000 characters.
 */
const NAME_WORD =
  String.raw`(?<![\p{L}\p{N}\p{M}][-'’]?)` +
  String.raw`(?!(?:The|A|An|This|That|My|Our|Your|His|Her|Their|Its|Some|Any|More|Another|New|Old|Kindle|PDF|EPUB|Word|Amazon|Audible|` +
  String.raw`Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Christmas|Easter|Halloween)${E})` +
  String.raw`(?:\p{Lu}\.|\p{Lu}(?:[\p{Ll}\p{M}]|['’]\p{Lu})[\p{L}\p{M}'’-]{0,40})`;
const NAME_RUN = String.raw`${NAME_WORD}(?:\s+(?:(?:de|da|del|van|von|der|la|le|bin|ibn|al|el)\s+)?${NAME_WORD}){0,3}${E}`;
/** A comma or a space between a name and what follows it — one of the two, never an optional comma between optional spaces. */
const AFTER_NAME = String.raw`(?:\s*,\s*|\s+)`;
const NAMED_BYLINE = new RegExp(
  [
    String.raw`${W}[Pp]ut\s+${NAME_RUN}${AFTER_NAME}on\s+(?:the\s+)?(?:title\s+page|spine)${E}`,
    String.raw`${W}[Pp]ublish(?:ed|ing)?\s+(?:(?:it|this|the\s+book|my\s+book)\s+)?(?:as|under)\s+${NAME_RUN}`,
    String.raw`${W}[Mm]ake\s+(?:it|this|the\s+book)\s+by\s+${NAME_RUN}`,
    String.raw`${W}(?:say|says|saying|show|shows|print|prints)\s+["“'‘]?by\s+${NAME_RUN}`,
    // "credited to Sam Lee", "Sam Lee wrote this book", "sign it as Sam Lee" —
    // never "credited to the publisher".
    String.raw`${W}credited\s+to\s+${NAME_RUN}`,
    String.raw`${W}${NAME_RUN}\s+(?:wrote|has\s+written|is\s+writing)\s+(?:this(?:\s+(?:book|novel|story))?|the\s+(?:book|novel|story))${E}`,
    String.raw`${W}[Ss]ign\s+(?:it|this|the\s+book)\s+as\s+${NAME_RUN}`,
    // "as an author", never "as a writer": "cast Max as a writer in chapter 2" is the story's.
    String.raw`${W}(?:${NAME_RUN}|me|myself)${AFTER_NAME}as\s+(?:a|an|another|(?:a\s+)?(?:second|third|joint))\s+(?:co[-\s]?)?author${E}`,
    // "El libro es de Lucía Gómez" — a name, never "de aventuras"; in German, where
    // every noun is capitalised ("von Anfang an"), a first and a last name.
    String.raw`${W}(?:[Ee]l\s+libro\s+es|[Ll]e\s+livre\s+est|[Oo]\s+livro\s+é|[Ii]l\s+libro\s+è)\s+(?:de|di)\s+${NAME_RUN}`,
    String.raw`${W}[Dd]as\s+Buch\s+ist\s+von\s+${NAME_WORD}\s+${NAME_WORD}${E}`
  ].join("|"),
  "u"
);

/**
 * "owner" as the © holder: the copyright's or the rights' owner, "Owner: …",
 * "the owner should be …", "make Ruiz Media the owner" — never "a proud dog
 * owner", "the owner of a small farm" or "the bookshop owner who let me read",
 * which are a biography's and a dedication's words.
 */
const OWNER = String.raw`owner${E}(?!['’])`;
const OWNER_CUES = [
  String.raw`${W}(?:copyright|rights?)\s+owners?${E}`,
  String.raw`${W}owners?\s+of\s+(?:the\s+)?(?:copyright|rights)${E}`,
  String.raw`${W}owner\s*[:=]`,
  String.raw`${W}(?:the\s+)?${OWNER}\s+(?:to|is|should|must|will|would|needs?\s+to|has\s+to)${E}`,
  String.raw`${W}be\s+(?:the\s+)?${OWNER}(?!\s+of${E})`,
  String.raw`${W}(?:make|set|change|put|list|name|use)\s+(?:[\p{L}\p{M}.,'’-]+\s+){0,4}(?:the|as)\s+(?:new\s+)?${OWNER}`,
  String.raw`${W}as\s+(?:the\s+)?${OWNER}`
];

/**
 * The words that name each field, in the languages the chat is written in
 * most: English, Persian and Arabic, then Spanish, French, German, Italian,
 * Portuguese and the others' nouns. `bookMatterAskedFor.ts` reads them to tell
 * a field the reader named from one the model added: "change the author name
 * to Sam Lee" is not a change of copyright holder too, and "change the
 * copyright holder to Sam Lee" can never switch on "All rights reserved" —
 * that line is never asserted by default, so only words about it set it. A
 * cue is a word as a request uses it: one a biography or a dedication uses as
 * often ("a proud dog owner", "a web designer") names nothing.
 */
const FIELD_CUES: Record<BookMatterChatField, FieldCue> = {
  authorName: cue(
    [
      String.raw`${W}pen[\s-]?names?${E}`, String.raw`${W}author(?:['’]s)?\s+name`, String.raw`${W}by-?line`,
      String.raw`${W}my\s+(?:pen\s+)?name${E}`, String.raw`${W}name\s+(?:on|of)\s+(?:it|the\s+(?:book|cover|title\s+page))${E}`,
      String.raw`${W}written\s+by${E}`, String.raw`${W}${BYLINE_NOUN}\s*[:=]`,
      String.raw`${W}my\s+(?:real|full|legal|maiden|actual|birth)\s+name${E}`,
      String.raw`${W}(?:the\s+)?${BYLINE_NOUN}\s+(?:to|as|should|is|be)${E}`,
      String.raw`${W}as\s+(?:the\s+|my\s+|(?:the\s+|this\s+)?book['’]s\s+)?${BYLINE_NOUN}${COMPARISON_FOLLOWS}`,
      String.raw`${W}${BYLINE_VERB}\s+(?:the\s+|my\s+)?(?:book['’]s\s+)?${BYLINE_NOUN}`,
      String.raw`${W}make\s+(?:the\s+|my\s+)?(?:book['’]s\s+)?${BYLINE_NOUN}${VOICE_FOLLOWS}`,
      String.raw`${W}make\s+(?:[\p{L}\p{M}.'’-]+\s+){1,4}(?:the|its)\s+(?:co[-\s]?)?${BYLINE_NOUN}`,
      String.raw`(?:${W}(?:is|am|are|be|been)|['’](?:m|s|re))\s+(?:now\s+|actually\s+|really\s+|also\s+)?(?:the|its|this\s+book['’]s)\s+(?:co[-\s]?)?${BYLINE_NOUN}`,
      String.raw`${W}${BYLINE_NOUN}\s+of\s+(?:this|the|my)\s+(?:book|novel|story)${E}`, String.raw`${W}co[-\s]?${BYLINE_NOUN}`,
      String.raw`${W}(?:(?:the|this|my)\s+)?(?:book|novel|story)(?:\s+is|['’]s|\s+should\s+be|\s+will\s+be)\s+(?:now\s+)?(?:written\s+)?by${E}(?!\s+far${E})`,
      String.raw`${W}credit(?:ed)?\s+(?:it|this|(?:(?:the|this|my)\s+)?(?:book|novel|story))\s+to${E}`,
      // "the author needs to be Sam Lee" — not "needs to be more likable".
      String.raw`${W}(?:the\s+)?${BYLINE_NOUN}\s+(?:must|needs?\s+to|has\s+to|have\s+to|ought\s+to|shall|will|would|has\s+got\s+to)\s+(?:now\s+)?be${E}${VOICE_FOLLOWS}`,
      String.raw`${W}(?:publish(?:ed|ing)?|releas(?:e|ed|ing)|print(?:ed|ing)?|credit(?:ed|ing)?|list(?:ed|ing)?|put|go(?:es)?\s+out|comes?\s+out|appear(?:s|ed)?)\s+(?:(?:it|this|the\s+book|my\s+book)\s+)?under\s+(?:the|my|a|her|his|their)\s+(?:(?:pen|real|own|full)\s+)?name${E}`,
      // "the book should be credited to Sam Lee" — "to the publisher" names the imprint.
      String.raw`${W}(?:book|novel|story|it|this)\s+(?:(?:should|must|will|would|can|could|needs?\s+to|has\s+to)\s+be|is|be)\s+credited\s+to${E}(?!\s+(?:(?:the|my|our)\s+)?(?:publishers?|imprint|press|publishing)${E})`,
      String.raw`${W}credited\s+to\s+(?:me|myself|us)${E}`, String.raw`${W}credit\s+(?:me|myself|us)\s+as${E}`,
      String.raw`${W}list\s+(?:me|myself|us)\s+(?:as|under)${E}`, String.raw`${W}authored\s+by${E}`
    ],
    [
      String.raw`${W}nom\s+de\s+plume`,
      String.raw`${W}(?:escrit[oa]\s+por|[ée]crite?\s+par|geschrieben\s+von|scritt[oa]\s+da)${E}`,
      ...EU_BYLINE,
      ...TURKISH_BYLINE,
      ...CJK_BYLINE,
      String.raw`${W}nombre\s+del?\s+autora?`, String.raw`${W}p?seud[oóô]nim[oa]s?${E}`, String.raw`${W}pseudonym(?:e|s)?${E}`,
      String.raw`${W}nom\s+de\s+l['’]auteure?`, String.raw`${W}autorenname`, String.raw`${W}name\s+des\s+autors`,
      String.raw`${W}k[üu]nstlername`, String.raw`${W}nome\s+dell['’]autore`, String.raw`${W}nome\s+d[oa]\s+autora?`,
      String.raw`${W}(?:mi|mon|il\s+mio|meu)\s+(?:nombre|nom|nome)${E}`, String.raw`${W}mein(?:en)?\s+namen?${E}`,
      String.raw`(?:نام|اسم)\s*(?:نویسنده|مستعار|قلمی|من)`, "اسمم", "نامم", String.raw`به\s*قلم`, "بقلم",
      PERSIAN_BYLINE, PERSIAN_BYLINE_IS, PERSIAN_BYLINE_BE, PERSIAN_MADE_AUTHOR, String.raw`به\s*عنوان\s*نویسنده`,
      // The name starts on a letter, so a run of spaces is read once, not once per space.
      String.raw`(?:به|با)\s*(?:اسم|نام)\s*[^\s.!?؟،\n][^.!?؟،\n]{0,39}?\s*(?:منتشر|چاپ)`,
      String.raw`اسم\s*(?:المؤلف|الكاتب)`, String.raw`الاسم\s*المستعار`, String.raw`مصنف\s*کا\s*نام`, ARABIC_BYLINE,
      String.raw`(?:غير|بدل|اجعل|ضع|استبدل|عدل|احذف|امسح|اكتب)\s*(?:اسم\s*)?(?:المؤلف|الكاتب)`, "كمؤلف", "ككاتب",
      String.raw`имя\s+автора`, "псевдоним", String.raw`שם\s+(?:המחבר|הסופר|עט)`, String.raw`लेखक\s+का\s+नाम`, "उपनाम",
      "著者名", "作者名", "作者姓名", "ペンネーム", "筆名", "笔名", String.raw`(?:저자|작가)\s*(?:명|이름)`, "필명"
    ]
  ),
  dedication: cue(
    [
      String.raw`${W}dedic`
    ],
    [
      String.raw`${W}ded(?:i(?:c(?!at(?:e|ed|es|ing|ion)s?${E})|qu)|í(?:c|qu))`,
      String.raw`${W}(?:dédica|dedica(?!t(?:e|ed|es|ing|ion)s?${E}))`, String.raw`${W}d[ée]di(?:e|er|é|ée|ez)${E}`, String.raw`${W}(?:ge)?widm`,
      String.raw`${W}[iİ]thaf`, String.raw`${W}dedyk`, String.raw`${W}opdr(?:agen|acht)${E}`,
      "تقدیم", "اهدا(?!ف)", "أهدي", "انتساب", "посвящ", "посвят", "הקדש", "הקדיש", "समर्पण", "समर्पित",
      "献辞", "献詞", "献呈", "献给", "獻給", "题献", "題獻", "献词", "獻詞", "헌사", "헌정", "바칩니다", "바친다"
    ]
  ),
  aboutAuthor: cue(
    [
      String.raw`${W}about\s+(?:the\s+)?author${E}`, String.raw`${W}bio${E}`, String.raw`${W}biograph`, String.raw`${W}about\s+me${E}`,
      String.raw`${W}author(?:['’]s)?\s+(?:page|blurb|info|note|profile|bio)`
    ],
    [
      String.raw`${W}biogra(?:ph(?!(?:y|ies|ical)${E})|f)`,
      String.raw`${W}(?:sobre|acerca\s+de)\s+(?:el|la|o|a)\s+autora?${E}`, String.raw`${W}sobre\s+m[ií]${E}`,
      String.raw`${W}(?:[àa]\s+propos\s+de\s+l['’]|sur\s+l['’])auteure?${E}`, String.raw`${W}[üu]ber\s+(?:den|die)\s+autor(?:in)?${E}`,
      String.raw`${W}[üu]ber\s+mich${E}`, String.raw`${W}autorenprofil`, String.raw`${W}sull['’]autore${E}`,
      // The Italian page label also means "the author"; require the page or section.
      String.raw`${W}(?:pagina|sezione)\s+["“«]?l['’]autore${E}`,
      String.raw`${W}b[iİ]yograf[iİ]\p{L}{0,6}${E}`, String.raw`${W}[öo]zge[çc]m[iİ][şs]\p{L}{0,6}${E}`,
      String.raw`${W}(?:yazar(?:[ıiİ]n)?\s+hakk[ıiİ]nda(?:k[iİ])?|hakk[ıiİ]mda)${E}`,
      String.raw`درباره\s*(?:ی\s*)?(?:نویسنده|من)`, "بیوگرافی", String.raw`زندگی\s*نامه`, String.raw`معرفی\s*نویسنده`,
      String.raw`نویسنده\s*(?:ی\s*)?(?:کتاب\s*)?(?:را|رو)\s*معرفی`,
      String.raw`عن\s*(?:المؤلف|الكاتب)`, String.raw`(?:ال)?سيرة\s*(?:ال)?ذاتية`, String.raw`مصنف\s*کے\s*بارے`,
      String.raw`об\s+авторе`, "биограф", String.raw`על\s+(?:המחבר|הסופר)`, "ביוגרפי", String.raw`लेखक\s+(?:के\s+बारे|परिचय)`,
      "著者紹介", "作者紹介", "作者简介", "作者簡介", "著者について", "作者について", "关于作者", "關於作者", "プロフィール",
      String.raw`(?:저자|작가)\s*소개`, "약력"
    ]
  ),
  authorWebsite: cue(
    [
      String.raw`${W}web\s*(?:site|page)`, String.raw`${W}web\s+(?:address|link)`, String.raw`${W}url${E}`,
      // A bare "site" only as the author's — "my site", "the site link", "Site:" —
      // never "an archaeological site" or "the site for our library", and a bare
      // "web" never: "a web designer" is a biography.
      String.raw`${W}(?:my|the|your|her|his|their|our|author(?:['’]s)?)\s+site${E}(?!\s+(?:of|for)${E})`, String.raw`${W}site\s*(?:[:=]|address|link|url)`,
      String.raw`${W}homepage`, String.raw`${W}www\.`,
      // Starts only at the front of a dotted or hyphenated run: from inside one,
      // every label would read the rest of the run again.
      String.raw`(?<![\p{L}\p{N}.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|dev|io|co|me|blog|app|ir|uk|de|fr|es|it|nl|ca|au|in|us|eu|info|xyz|site|online|art|page|ai|tv|ink|press|studio|link|ru|jp|cn|kr|br|mx|tr)${E}`
    ],
    [
      String.raw`${W}(?:sitio|sito)${E}`, String.raw`${W}webseite`,
      String.raw`${W}site\s+web${E}`,
      // Portuguese "my site", not an archaeological site or a site for something.
      String.raw`${W}(?:meu|seu|nosso)\s+site${E}(?!\s+(?:de|para)${E})`,
      String.raw`${W}(?:[iİ]nternet|web|yazar(?:[ıiİ]n)?)\s+s[iİ]te\p{L}{0,6}${E}`,
      String.raw`وب\s*سایت`, "سایت", "وبلاگ", "الموقع", String.raw`موقع\s*(?:ال)?إلكتروني`, String.raw`ویب\s*سائٹ`, "сайт", "אתר",
      "वेबसाइट", "ウェブサイト", "ホームページ", "サイト", "网站", "網站", "网址", "網址", String.raw`웹\s*사이트`, "홈페이지", "블로그"
    ]
  ),
  copyrightHolder: cue(
    [
      String.raw`${W}copyright`, "©", String.raw`\(c\)`, String.raw`${W}rights?\s+holder`, ...OWNER_CUES
    ],
    [
      String.raw`${W}derechos\s+de\s+autor`, String.raw`${W}titular\s+de\s+los\s+derechos`, String.raw`${W}titular\s+dos\s+direitos`,
      String.raw`${W}droits?\s+d['’]auteur`, String.raw`${W}titulaire\s+des\s+droits`, String.raw`${W}urheberrecht`,
      String.raw`${W}rechteinhaber`, String.raw`${W}diritt[oi]\s+d['’]autore`, String.raw`${W}titolare\s+dei\s+diritti`,
      String.raw`${W}direitos\s+(?:autorais|de\s+autor)`,
      String.raw`${W}tel[iİ]f\s+hak(?:k[ıiİ]|lar[ıiİ])\p{L}{0,6}${E}`,
      String.raw`حق\s*(?:نشر|تکثیر|چاپ|مؤلف)`, String.raw`کپی\s*رایت`, String.raw`صاحب\s*حق`, String.raw`دارنده\s*(?:ی\s*)?حق`,
      String.raw`حقوق\s*(?:النشر|الطبع|المؤلف)`, String.raw`حق\s*المؤلف`, String.raw`صاحب\s*الحقوق`, String.raw`авторск\p{L}{0,4}\s+прав`,
      String.raw`حقوق\s*کے\s*مالک`,
      "правообладател", String.raw`זכויות\s+יוצרים`, "कॉपीराइट", "著作権", "版权", "版權", "저작권"
    ]
  ),
  imprint: cue(
    [
      String.raw`${W}imprint`, String.raw`${W}publish(?:er|ers|ing|ed\s+by)${E}`, String.raw`${W}editorial${E}`
    ],
    [
      String.raw`${W}(?:la|mi|tu|una)\s+editorial${E}`,
      String.raw`${W}[ée]diteur`, String.raw`${W}maison\s+d['’][ée]dition`, String.raw`${W}verlag`, String.raw`${W}herausgeber`,
      String.raw`${W}casa\s+editrice`, String.raw`${W}edit(?:ore|ora)${E}`,
      String.raw`${W}yay[ıiİ]nev[iİ]\p{L}{0,6}${E}`, String.raw`${W}yay[ıiİ]nc[ıiİ]\p{L}{0,6}${E}`,
      "ناشر", "انتشارات", String.raw`بنگاه\s*نشر`, String.raw`دار\s*(?:ال)?نشر`, "издательств", "издател", "הוצאה", "הוצאת",
      "प्रकाशक", "出版社", "出版者", "出版商", "出版方", "発行元", "发行方", "출판사", "발행처"
    ]
  ),
  isbn: cue([String.raw`${W}isbn${E}`], ["شابک", "ردمك", "书号", "書號", 'מסת"ב', "מסת״ב"]),
  allRightsReserved: cue(
    [
      String.raw`${W}rights?\s+reserved`, String.raw`${W}all\s+rights${E}`
    ],
    [
      String.raw`${W}derechos\s+reservados`,
      String.raw`${W}droits\s+r[ée]serv`, String.raw`${W}rechte\s+vorbehalten`, String.raw`${W}diritti\s+riservati`,
      String.raw`${W}direitos\s+reservados`,
      String.raw`${W}(?:t[üu]m|b[üu]t[üu]n)\s+haklar[ıiİ]\s+sakl[ıiİ](?:d[ıiİ]r)?${E}`,
      String.raw`حقوق[^.؟!\n]{0,40}محفوظ`, String.raw`حق[^.؟!\n]{0,20}محفوظ`, String.raw`(?:کلیه|تمام|تمامی|همه)\s*(?:ی\s*)?حقوق`,
      String.raw`جميع\s*الحقوق`, String.raw`все\s+права\s+защищены`, String.raw`כל\s+הזכויות\s+שמורות`, String.raw`सर्वाधिकार\s+सुरक्षित`,
      String.raw`${W}rechtevorbehalt(?:s)?${E}`, String.raw`${W}строк(?:а|у|е|и|ой|ою)\s+об\s+охране\s+прав${E}`,
      String.raw`${W}haklar\s+sakl[ıiİ]d[ıiİ]r\s+sat[ıiİ]r[ıiİ](?:n[ıiİ]n?)?${E}`,
      "保留所有权利声明", "保留所有權利聲明", "権利留保の表示", String.raw`권리\s*보유\s*문구`,
      String.raw`版权所有(?![者人])`, String.raw`版權所有(?![者人])`, "無断転載", "無断複製", "不許複製", String.raw`모든\s*권리`, String.raw`판권\s*소유`, String.raw`무단\s*전재`
    ]
  )
};

export function namesField(words: string, field: BookMatterChatField): boolean {
  return namedIn(cueText(words), words, field);
}

/**
 * The words as the cues read them: compatibility-folded, one Arabic-script
 * spelling, and every run of whitespace one space — or one line break, when
 * it holds one. A cue's `\s+` then never meets a long run, so the lookbehinds
 * that read back over whitespace at every position stay constant.
 */
function cueText(words: string): string {
  return arabicScriptFold(words.normalize("NFKC")).replace(/\s+/g, (run) => (run.includes("\n") ? "\n" : " "));
}

function namedIn(folded: string, words: string, field: BookMatterChatField): boolean {
  // A typed ISBN names the ISBN wherever it stands: "978-0-306-40615-7" is
  // the whole answer to "What's the ISBN?".
  if (FIELD_CUES[field].all.test(folded)) return true;
  if (field === "authorName") return NAMED_BYLINE.test(folded);
  return field === "isbn" && numbersTypedIn(words).some((run) => normalizeIsbn(run) !== null);
}

/** The fields some words name; empty when they name none. Folds the words once for every field. */
export function bookMatterFieldsNamedIn(message: string): Set<BookMatterChatField> {
  const folded = cueText(message);
  return new Set((Object.keys(FIELD_CUES) as BookMatterChatField[]).filter((field) => namedIn(folded, message, field)));
}

/** Translated field names only; routing keeps its existing, narrower English prose exclusions. */
export function localizedBookMatterFieldsNamedIn(message: string): Set<BookMatterChatField> {
  const folded = cueText(message);
  return new Set((Object.keys(FIELD_CUES) as BookMatterChatField[]).filter((field) => FIELD_CUES[field].localized.test(folded)));
}

/**
 * An ISBN-10 or ISBN-13 with a valid check digit, as the reader typed it with
 * the word "ISBN" and any label taken off — the page prints "ISBN" itself.
 */
export function normalizeIsbn(text: string): { printed: string; compact: string } | null {
  // Supported numeral folds preserve string offsets, including a label such
  // as ISBN-۱۳. Only validation folds the number's own digits and separators.
  const label = normalizeNumerals(text).match(/^\s*isbn(?:[-\s]?1[03](?!\d))?\s*[:#]?\s*/i)?.[0];
  const printed = text.slice(label?.length ?? 0).trim();
  const compact = normalizeNumerals(printed).replace(/[\s‐-―-]/g, "").toUpperCase();
  if (/^97[89]\d{10}$/.test(compact)) {
    const sum = [...compact].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? { printed, compact } : null;
  }
  if (/^\d{9}[\dX]$/.test(compact)) {
    const sum = [...compact].reduce((total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
    return sum % 11 === 0 ? { printed, compact } : null;
  }
  return null;
}

/** Compared forms: compatibility-folded, Arabic-script letters unified, Western digits, lower case. */
export function fold(text: string): string {
  return normalizeNumerals(arabicScriptFold(text.normalize("NFKC"))).toLowerCase();
}

export function wordsIn(text: string): string[] {
  return text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/**
 * Scripts written without spaces between words, where a "word" run is a whole
 * clause (出版社を山田出版にして) and a value can only be found inside one.
 */
export const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Every run of digits the text spells, with the spaces and hyphens inside it taken out. */
export function numbersTypedIn(text: string): string[] {
  return (normalizeNumerals(text).replace(/[‐-―]/g, "-").match(/\d[\d\s-]*[\dXx]|\d/g) ?? []).map((run) =>
    run.replace(/[\s-]/g, "").toUpperCase()
  );
}

/** The pronouns a retelling swaps: "I write my songs" is printed as "She writes her songs". */
const PERSONAL_PRONOUNS: ReadonlySet<string> = new Set(
  "i me my mine myself we us our ours ourselves you your yours yourself he him his himself she her hers herself they them their theirs themselves themself".split(" ")
);

/**
 * A word as {@link looselyQuotedFrom} compares it: every personal pronoun is
 * one word, and an English word loses a rough inflection — "make", "makes" and
 * "making" are one word, and so are "quilt" and "quilts", "fix" and "fixes".
 * Equal inputs always give equal stems; what it merges beyond that only makes
 * a clause read as printed more readily.
 */
function looseWord(word: string): string {
  if (PERSONAL_PRONOUNS.has(word)) return "\u00b7";
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word;
  let stem = /ie[sd]$/.test(word) ? `${word.slice(0, -3)}y` : /[^su]s$/.test(word) ? word.slice(0, -1) : word;
  const bare = stem.replace(/(?:ing|ed)$/, "");
  if (bare !== stem && bare.length >= 3) stem = bare.replace(/([b-df-hj-kmnp-rtv-y])\1$/, "$1");
  return stem.length > 3 && stem.endsWith("e") ? stem.slice(0, -1) : stem;
}

/** A text's words, each read by {@link looseWord}: every personal pronoun is "·". */
export function looseWordsIn(text: string): string[] {
  return wordsIn(fold(text)).map(looseWord);
}

/**
 * One person under several everyday words: "For Mom" from "dedicate it to my
 * mother" names nobody new. Only words that can stand for one another.
 */
const KINSHIP: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ["mom", "mum", "mother", "mommy", "mummy", "mama", "momma"],
    ["dad", "father", "daddy", "papa"],
    ["grandma", "grandmother", "granny", "gran"],
    ["grandpa", "grandfather", "granddad", "grandad"]
  ].flatMap((group) => group.map((word) => [word, group] as const))
);

/** The everyday words for the person a folded word names, when it names one in {@link KINSHIP}. */
export function sameKin(word: string): readonly string[] {
  return KINSHIP.get(word) ?? [];
}

/** A text's words read loosely ({@link looseWordsIn}), one word for each person {@link KINSHIP} names. */
export function kinWordsIn(text: string): string[] {
  return looseWordsIn(text).map((word) => KINSHIP.get(word)?.[0] ?? word);
}

/** Words that carry nothing a request asks for: "add my dad too" asks for "dad". */
const FILLER: ReadonlySet<string> = new Set([
  "·",
  ...looseWordsIn(
    "a an the to too also as well of in on at for with from that this these those is am are was were be been being have has had " +
      "do does did please just some any very really so and or but it its into onto about there here s t d ll re ve m one again " +
      "instead now both line sentence note mention word words bit something thing"
  )
]);

/** What some words ask for, as {@link kinWordsIn} reads them, the {@link FILLER} taken out. */
export function contentWordsIn(text: string): string[] {
  return kinWordsIn(text).filter((word) => !FILLER.has(word));
}

/**
 * An instruction about how the field just changed is written, never a change
 * of anything else: its person, tense, tone or voice, the name or pronouns it
 * uses, a detail kept out of it, how it makes the reader sound. Whole
 * requests only: "use a scary voice for the villain" is not one.
 */
const ABOUT_THE_CHANGE = new RegExp(
  String.raw`^(?:` +
    [
      String.raw`(?:use|write|keep)\s+(?:in\s+)?(?:the\s+)?(?:first|second|third|1st|2nd|3rd)[\s-]*person`,
      String.raw`(?:use|write|keep)\s+(?:in\s+)?(?:the\s+)?(?:past|present|future)\s+tense`,
      // Each of the name's words after a comma or a space, never an optional
      // one: "Use her name " + 5,000 letters split three ways was a cubic scan.
      String.raw`use\s+(?:my|her|his|their)\s+(?:(?:real|full|first|last|middle|maiden|given|legal|nick)\s*)?names?(?:(?:\s*,\s*|\s+)[\p{L}\p{M}'’.-]+){0,3}`,
      String.raw`use\s+(?:(?:my|her|his|their)\s+pronouns|(?:she|he|they)\s*\/\s*(?:her|him|them)(?:\s+pronouns)?)`,
      String.raw`(?:use|keep)\s+(?:(?:a|an|the|my)\s+)?(?:[\p{L}-]+\s+){0,2}(?:tone|voice|register)(?:\s+[\p{L}-]+)?`,
      String.raw`keep\s+(?:my|her|his|their|the|any)\s+(?:[\p{L}'’-]+\s+){0,3}out(?:\s+of\s+(?:it|this|that|there|the\s+(?:bio|biography|dedication)))?`,
      String.raw`(?:drop|remove|cut|delete)\s+(?:my|her|his|their)\s+(?:age|(?:last|family|middle|full|maiden)\s+name|surname|location|city|address|email|phone(?:\s+number)?)`,
      String.raw`make\s+me\s+(?:sound|seem|look|come\s+across)(?:\s+[\p{L}'’-]+){0,4}`
    ].join("|") +
    String.raw`)(?:\s+(?:please|too|instead|throughout|only|for\s+(?:it|this|that|me)|in\s+(?:it|this|that|the\s+(?:bio|biography|dedication))))*$`,
  "iu"
);

/** The longest request read as a style instruction; every one of them is a short sentence. */
const STYLE_INSTRUCTION_LIMIT = 200;

/** Whether a request ("use third person", "keep my age out of it") is about how the field it rides with is written. */
export function instructsTheChange(request: string): boolean {
  const text = request.replace(/\s+/g, " ").trim();
  return text.length <= STYLE_INSTRUCTION_LIMIT && ABOUT_THE_CHANGE.test(text);
}

/** A text's words as {@link looselyQuotedFrom} looks for a quote among them. */
export function looseQuotable(text: string): Quotable {
  const words = wordsIn(fold(text)).map(looseWord);
  return { spaced: ` ${words.join(" ")} `, joined: words.join("") };
}

/**
 * Whether a clause's words were printed in a text retold from them — its words
 * in order, each read by {@link looseWord}. For deciding that a clause is
 * content already printed, never for a refusal: {@link quotedFrom} is that test.
 */
export function looselyQuotedFrom(quote: string, text: Quotable): boolean {
  return quotedIn(wordsIn(fold(quote)).map(looseWord), text);
}

/** A text's words as {@link quotedFrom} looks for a quote among them. */
export type Quotable = { spaced: string; joined: string };

export function quotable(text: string): Quotable {
  const words = wordsIn(fold(text));
  return { spaced: ` ${words.join(" ")} `, joined: words.join("") };
}

/**
 * Whether the quote is the reader's own words: its words, in order, as whole
 * words of the message — so a quote that differs by punctuation, case or
 * spacing still matches, and "all rights" is not found in "overall rights".
 * A quote in a script written without spaces is looked for inside the message.
 */
export function quotedFrom(quote: string, message: string | Quotable): boolean {
  return quotedIn(wordsIn(fold(quote)), typeof message === "string" ? quotable(message) : message);
}

function quotedIn(needle: readonly string[], haystack: Quotable): boolean {
  if (needle.length === 0) return false;
  if (needle.some((word) => UNSPACED_SCRIPT.test(word))) return haystack.joined.includes(needle.join(""));
  return haystack.spaced.includes(` ${needle.join(" ")} `);
}

/**
 * The words a changed field prints, each read by {@link looseWord}: as a set,
 * and as a text a phrase is looked for in. What of a message the change prints
 * is the change's content, whatever field's cue it happens to spell — "a proud
 * dog owner", "worked in publishing", "who always asked about me".
 */
export type Printed = { words: ReadonlySet<string>; text: Quotable };

export function printedIn(value: string): Printed {
  const words = looseWordsIn(value);
  return { words: new Set(words), text: { spaced: ` ${words.join(" ")} `, joined: words.join("") } };
}

/** Whether loose words ({@link looseWordsIn}) stand in a printed value as a phrase, in order. */
export function printsPhrase(printed: Printed, words: readonly string[]): boolean {
  return quotedIn(words, printed.text);
}

/**
 * Some words with every word a printed value carries taken out, in the form
 * the cues read: what the words name beyond that value's content. One pass
 * over the words.
 */
export function wordsBesides(words: string, printed: ReadonlySet<string>): string {
  if (printed.size === 0) return words;
  return arabicScriptFold(words.normalize("NFKC")).replace(/[\p{L}\p{M}\p{N}]+/gu, (word) => (printed.has(looseWord(fold(word))) ? " " : word));
}

/** Words that only ask, never say what: "add that …", "mention …", "say it too". */
const ASKING: ReadonlySet<string> = new Set(
  looseWordsIn("add mention say write put include insert append make change set use tell state note please also too that the a an and to it")
);

/** What a quote asks for: its loose words ({@link looseWordsIn}) beyond the ones that only ask. */
export function askedWordsIn(quote: string): string[] {
  return looseWordsIn(quote).filter((word) => !ASKING.has(word));
}
