/**
 * Every reader-facing word the compiler writes that the book's own text did not
 * supply — the Contents heading, the word "Chapter", the Sources heading, image
 * alt text, the title page's byline and the few words of the matter pages.
 *
 * They live apart from the compiler because they are a vocabulary rather than
 * logic: adding a language is one entry here, plus its About the Author
 * heading, rights line and byline word in the importer's
 * `ingestion/manuscriptMatterWords.ts`, or a book exported in it re-imports
 * with its matter left in the pages. Every book language the app offers
 * (`CONVERSATION_LANGUAGES`) has an entry; `markdownLabels.test.ts` fails the
 * one that falls back to English.
 */
import { isEnglishLanguage, languageTableEntry } from "../prompting/language.js";

export type MarkdownLabels = {
  contentsEyebrow: string;
  contentsHeading: string;
  chapter: string;
  sources: string;
  illustration: string;
  /** The caption label of a chart or diagram, and the word before its source line. */
  figure: string;
  source: string;
  bookCover: string;
  /**
   * The title page's byline word, written before the author's name. Languages
   * with no single-word equivalent of "by" use the noun instead ("author"),
   * which is how their own title pages are set.
   */
  by: string;
  /** The heading of the back-matter biography. */
  aboutAuthor: string;
  /** The rights line under the © line, when the author asks for it. */
  allRightsReserved: string;
  /** The free tier's credit, brand name kept in Latin script. */
  madeWithTomeza: string;
};

/**
 * Exported for identity, not just for its values: `sanitizeCoverAlt` asks
 * `labels !== DEFAULT_MARKDOWN_LABELS` to tell an English book from a
 * translated one, so there must be exactly one of these objects.
 */
export const DEFAULT_MARKDOWN_LABELS: MarkdownLabels = {
  contentsEyebrow: "Table of Contents",
  contentsHeading: "Contents",
  chapter: "Chapter",
  sources: "Sources",
  illustration: "Illustration",
  figure: "Figure",
  source: "Source",
  bookCover: "Book cover",
  by: "by",
  aboutAuthor: "About the Author",
  allRightsReserved: "All rights reserved.",
  madeWithTomeza: "Made with Tomeza"
};

const MARKDOWN_LABELS_BY_LANGUAGE: Record<string, MarkdownLabels> = {
  arabic: {
    contentsEyebrow: "فهرس المحتويات",
    contentsHeading: "المحتويات",
    chapter: "الفصل",
    sources: "المصادر",
    illustration: "رسم توضيحي",
    figure: "شكل",
    source: "المصدر",
    bookCover: "غلاف الكتاب",
    by: "بقلم",
    aboutAuthor: "عن المؤلف",
    allRightsReserved: "جميع الحقوق محفوظة.",
    madeWithTomeza: "صُنع باستخدام Tomeza"
  },
  chinese: {
    contentsEyebrow: "目录",
    contentsHeading: "目录",
    chapter: "第",
    sources: "资料来源",
    illustration: "插图",
    figure: "图",
    source: "来源",
    bookCover: "书籍封面",
    by: "作者",
    aboutAuthor: "关于作者",
    allRightsReserved: "版权所有。",
    madeWithTomeza: "使用 Tomeza 制作"
  },
  danish: {
    contentsEyebrow: "Indholdsfortegnelse",
    contentsHeading: "Indhold",
    chapter: "Kapitel",
    sources: "Kilder",
    illustration: "Illustration",
    figure: "Figur",
    source: "Kilde",
    bookCover: "Bogomslag",
    by: "af",
    aboutAuthor: "Om forfatteren",
    allRightsReserved: "Alle rettigheder forbeholdes.",
    madeWithTomeza: "Lavet med Tomeza"
  },
  dutch: {
    contentsEyebrow: "Inhoudsopgave",
    contentsHeading: "Inhoud",
    chapter: "Hoofdstuk",
    sources: "Bronnen",
    illustration: "Illustratie",
    figure: "Figuur",
    source: "Bron",
    bookCover: "Boekomslag",
    by: "door",
    aboutAuthor: "Over de auteur",
    allRightsReserved: "Alle rechten voorbehouden.",
    madeWithTomeza: "Gemaakt met Tomeza"
  },
  french: {
    contentsEyebrow: "Table des matières",
    contentsHeading: "Sommaire",
    chapter: "Chapitre",
    sources: "Sources",
    illustration: "Illustration",
    figure: "Figure",
    source: "Source",
    bookCover: "Couverture du livre",
    by: "par",
    aboutAuthor: "À propos de l’auteur",
    allRightsReserved: "Tous droits réservés.",
    madeWithTomeza: "Réalisé avec Tomeza"
  },
  german: {
    contentsEyebrow: "Inhaltsverzeichnis",
    contentsHeading: "Inhalt",
    chapter: "Kapitel",
    sources: "Quellen",
    illustration: "Illustration",
    figure: "Abbildung",
    source: "Quelle",
    bookCover: "Buchcover",
    by: "von",
    aboutAuthor: "Über den Autor",
    allRightsReserved: "Alle Rechte vorbehalten.",
    madeWithTomeza: "Erstellt mit Tomeza"
  },
  greek: {
    contentsEyebrow: "Πίνακας περιεχομένων",
    contentsHeading: "Περιεχόμενα",
    chapter: "Κεφάλαιο",
    sources: "Πηγές",
    illustration: "Εικονογράφηση",
    figure: "Σχήμα",
    source: "Πηγή",
    bookCover: "Εξώφυλλο βιβλίου",
    by: "συγγραφέας",
    aboutAuthor: "Σχετικά με τον συγγραφέα",
    allRightsReserved: "Με επιφύλαξη παντός δικαιώματος.",
    madeWithTomeza: "Δημιουργήθηκε με το Tomeza"
  },
  hebrew: {
    contentsEyebrow: "תוכן העניינים",
    contentsHeading: "תוכן העניינים",
    chapter: "פרק",
    sources: "מקורות",
    illustration: "איור",
    figure: "תרשים",
    source: "מקור",
    bookCover: "כריכת הספר",
    by: "מאת",
    aboutAuthor: "על המחבר",
    allRightsReserved: "כל הזכויות שמורות.",
    madeWithTomeza: "נוצר עם Tomeza"
  },
  hindi: {
    contentsEyebrow: "विषय-सूची",
    contentsHeading: "विषय-सूची",
    chapter: "अध्याय",
    sources: "स्रोत",
    illustration: "चित्र",
    figure: "आकृति",
    source: "स्रोत",
    bookCover: "पुस्तक आवरण",
    by: "लेखक",
    aboutAuthor: "लेखक के बारे में",
    allRightsReserved: "सर्वाधिकार सुरक्षित।",
    madeWithTomeza: "Tomeza से बनाई गई"
  },
  italian: {
    contentsEyebrow: "Indice",
    contentsHeading: "Indice",
    chapter: "Capitolo",
    sources: "Fonti",
    illustration: "Illustrazione",
    figure: "Figura",
    source: "Fonte",
    bookCover: "Copertina del libro",
    by: "di",
    aboutAuthor: "L’autore",
    allRightsReserved: "Tutti i diritti riservati.",
    madeWithTomeza: "Realizzato con Tomeza"
  },
  japanese: {
    contentsEyebrow: "目次",
    contentsHeading: "目次",
    chapter: "第",
    sources: "出典",
    illustration: "挿絵",
    figure: "図",
    source: "出典",
    bookCover: "本の表紙",
    by: "著者",
    aboutAuthor: "著者について",
    allRightsReserved: "無断転載を禁じます。",
    madeWithTomeza: "Tomezaで制作"
  },
  korean: {
    contentsEyebrow: "목차",
    contentsHeading: "목차",
    chapter: "장",
    sources: "출처",
    illustration: "삽화",
    figure: "그림",
    source: "출처",
    bookCover: "책 표지",
    by: "저자",
    aboutAuthor: "저자 소개",
    allRightsReserved: "모든 권리 보유.",
    madeWithTomeza: "Tomeza로 제작"
  },
  norwegian: {
    contentsEyebrow: "Innholdsfortegnelse",
    contentsHeading: "Innhold",
    chapter: "Kapittel",
    sources: "Kilder",
    illustration: "Illustrasjon",
    figure: "Figur",
    source: "Kilde",
    bookCover: "Bokomslag",
    by: "av",
    aboutAuthor: "Om forfatteren",
    allRightsReserved: "Alle rettigheter forbeholdt.",
    madeWithTomeza: "Laget med Tomeza"
  },
  persian: {
    contentsEyebrow: "فهرست مطالب",
    contentsHeading: "فهرست",
    chapter: "فصل",
    sources: "منابع",
    illustration: "تصویر",
    figure: "شکل",
    source: "منبع",
    bookCover: "جلد کتاب",
    by: "نوشتهٔ",
    aboutAuthor: "دربارهٔ نویسنده",
    allRightsReserved: "همهٔ حقوق محفوظ است.",
    madeWithTomeza: "ساخته‌شده با Tomeza"
  },
  polish: {
    contentsEyebrow: "Spis treści",
    contentsHeading: "Spis treści",
    chapter: "Rozdział",
    sources: "Źródła",
    illustration: "Ilustracja",
    figure: "Rysunek",
    source: "Źródło",
    bookCover: "Okładka książki",
    by: "autor",
    aboutAuthor: "O autorze",
    allRightsReserved: "Wszelkie prawa zastrzeżone.",
    madeWithTomeza: "Utworzono w Tomeza"
  },
  portuguese: {
    contentsEyebrow: "Sumário",
    contentsHeading: "Sumário",
    chapter: "Capítulo",
    sources: "Fontes",
    illustration: "Ilustração",
    figure: "Figura",
    source: "Fonte",
    bookCover: "Capa do livro",
    by: "por",
    aboutAuthor: "Sobre o autor",
    allRightsReserved: "Todos os direitos reservados.",
    madeWithTomeza: "Feito com Tomeza"
  },
  russian: {
    contentsEyebrow: "Оглавление",
    contentsHeading: "Содержание",
    chapter: "Глава",
    sources: "Источники",
    illustration: "Иллюстрация",
    figure: "Рисунок",
    source: "Источник",
    bookCover: "Обложка книги",
    by: "автор",
    aboutAuthor: "Об авторе",
    allRightsReserved: "Все права защищены.",
    madeWithTomeza: "Создано в Tomeza"
  },
  spanish: {
    contentsEyebrow: "Tabla de contenido",
    contentsHeading: "Contenido",
    chapter: "Capítulo",
    sources: "Fuentes",
    illustration: "Ilustración",
    figure: "Figura",
    source: "Fuente",
    bookCover: "Cubierta del libro",
    by: "por",
    aboutAuthor: "Sobre el autor",
    allRightsReserved: "Todos los derechos reservados.",
    madeWithTomeza: "Hecho con Tomeza"
  },
  swedish: {
    contentsEyebrow: "Innehållsförteckning",
    contentsHeading: "Innehåll",
    chapter: "Kapitel",
    sources: "Källor",
    illustration: "Illustration",
    figure: "Figur",
    source: "Källa",
    bookCover: "Bokomslag",
    by: "av",
    aboutAuthor: "Om författaren",
    allRightsReserved: "Alla rättigheter förbehållna.",
    madeWithTomeza: "Skapad med Tomeza"
  },
  thai: {
    contentsEyebrow: "สารบัญ",
    contentsHeading: "สารบัญ",
    chapter: "บทที่",
    sources: "แหล่งข้อมูล",
    illustration: "ภาพประกอบ",
    figure: "แผนภาพ",
    source: "ที่มา",
    bookCover: "ปกหนังสือ",
    by: "โดย",
    aboutAuthor: "เกี่ยวกับผู้เขียน",
    allRightsReserved: "สงวนลิขสิทธิ์",
    madeWithTomeza: "สร้างด้วย Tomeza"
  },
  turkish: {
    contentsEyebrow: "İçindekiler",
    contentsHeading: "İçindekiler",
    chapter: "Bölüm",
    sources: "Kaynaklar",
    illustration: "İllüstrasyon",
    figure: "Şekil",
    source: "Kaynak",
    bookCover: "Kitap kapağı",
    by: "yazan",
    aboutAuthor: "Yazar hakkında",
    allRightsReserved: "Tüm hakları saklıdır.",
    madeWithTomeza: "Tomeza ile hazırlandı"
  },
  ukrainian: {
    contentsEyebrow: "Зміст",
    contentsHeading: "Зміст",
    chapter: "Розділ",
    sources: "Джерела",
    illustration: "Ілюстрація",
    figure: "Рисунок",
    source: "Джерело",
    bookCover: "Обкладинка книги",
    by: "автор",
    aboutAuthor: "Про автора",
    allRightsReserved: "Усі права захищено.",
    madeWithTomeza: "Створено за допомогою Tomeza"
  },
  urdu: {
    contentsEyebrow: "فہرست مضامین",
    contentsHeading: "فہرست",
    chapter: "باب",
    sources: "ذرائع",
    illustration: "تصویر",
    figure: "شکل",
    source: "ماخذ",
    bookCover: "کتاب کا سرورق",
    by: "تحریر",
    aboutAuthor: "مصنف کے بارے میں",
    allRightsReserved: "جملہ حقوق محفوظ ہیں۔",
    madeWithTomeza: "Tomeza سے تیار کردہ"
  },
  vietnamese: {
    contentsEyebrow: "Mục lục",
    contentsHeading: "Mục lục",
    chapter: "Chương",
    sources: "Nguồn tham khảo",
    illustration: "Hình minh họa",
    figure: "Hình",
    source: "Nguồn",
    bookCover: "Bìa sách",
    by: "tác giả",
    aboutAuthor: "Về tác giả",
    allRightsReserved: "Bảo lưu mọi quyền.",
    madeWithTomeza: "Được tạo bằng Tomeza"
  }
};

/** Reader-facing chrome in the book's language, keyed the same way `scriptProfileForLanguage` is. */
export function markdownLabels(language: string | undefined): MarkdownLabels {
  if (isEnglishLanguage(language)) {
    return DEFAULT_MARKDOWN_LABELS;
  }
  return languageTableEntry(MARKDOWN_LABELS_BY_LANGUAGE, language) ?? DEFAULT_MARKDOWN_LABELS;
}
