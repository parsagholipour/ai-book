/**
 * Every reader-facing word the compiler writes that the book's own text did not
 * supply — the Contents heading, the word "Chapter", the Sources heading, image
 * alt text and the title page's byline.
 *
 * They live apart from the compiler because they are a vocabulary rather than
 * logic: adding a language is 7 lines of data here and nothing anywhere else.
 */
import { isEnglishLanguage, languageLabel } from "../prompting/language.js";

export type MarkdownLabels = {
  contentsEyebrow: string;
  contentsHeading: string;
  chapter: string;
  sources: string;
  illustration: string;
  bookCover: string;
  /**
   * The title page's byline word, written before the author's name. Languages
   * with no single-word equivalent of "by" use the noun instead ("author"),
   * which is how their own title pages are set.
   */
  by: string;
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
  bookCover: "Book cover",
  by: "by"
};

const MARKDOWN_LABELS_BY_LANGUAGE: Record<string, MarkdownLabels> = {
  arabic: {
    contentsEyebrow: "فهرس المحتويات",
    contentsHeading: "المحتويات",
    chapter: "الفصل",
    sources: "المصادر",
    illustration: "رسم توضيحي",
    bookCover: "غلاف الكتاب",
    by: "بقلم"
  },
  chinese: {
    contentsEyebrow: "目录",
    contentsHeading: "目录",
    chapter: "第",
    sources: "资料来源",
    illustration: "插图",
    bookCover: "书籍封面",
    by: "作者"
  },
  french: {
    contentsEyebrow: "Table des matières",
    contentsHeading: "Sommaire",
    chapter: "Chapitre",
    sources: "Sources",
    illustration: "Illustration",
    bookCover: "Couverture du livre",
    by: "par"
  },
  german: {
    contentsEyebrow: "Inhaltsverzeichnis",
    contentsHeading: "Inhalt",
    chapter: "Kapitel",
    sources: "Quellen",
    illustration: "Illustration",
    bookCover: "Buchcover",
    by: "von"
  },
  hindi: {
    contentsEyebrow: "विषय-सूची",
    contentsHeading: "विषय-सूची",
    chapter: "अध्याय",
    sources: "स्रोत",
    illustration: "चित्र",
    bookCover: "पुस्तक आवरण",
    by: "लेखक"
  },
  italian: {
    contentsEyebrow: "Indice",
    contentsHeading: "Indice",
    chapter: "Capitolo",
    sources: "Fonti",
    illustration: "Illustrazione",
    bookCover: "Copertina del libro",
    by: "di"
  },
  japanese: {
    contentsEyebrow: "目次",
    contentsHeading: "目次",
    chapter: "第",
    sources: "出典",
    illustration: "挿絵",
    bookCover: "本の表紙",
    by: "著者"
  },
  korean: {
    contentsEyebrow: "목차",
    contentsHeading: "목차",
    chapter: "장",
    sources: "출처",
    illustration: "삽화",
    bookCover: "책 표지",
    by: "저자"
  },
  persian: {
    contentsEyebrow: "فهرست مطالب",
    contentsHeading: "فهرست",
    chapter: "فصل",
    sources: "منابع",
    illustration: "تصویر",
    bookCover: "جلد کتاب",
    by: "نوشتهٔ"
  },
  portuguese: {
    contentsEyebrow: "Sumário",
    contentsHeading: "Sumário",
    chapter: "Capítulo",
    sources: "Fontes",
    illustration: "Ilustração",
    bookCover: "Capa do livro",
    by: "por"
  },
  russian: {
    contentsEyebrow: "Оглавление",
    contentsHeading: "Содержание",
    chapter: "Глава",
    sources: "Источники",
    illustration: "Иллюстрация",
    bookCover: "Обложка книги",
    by: "автор"
  },
  spanish: {
    contentsEyebrow: "Tabla de contenido",
    contentsHeading: "Contenido",
    chapter: "Capítulo",
    sources: "Fuentes",
    illustration: "Ilustración",
    bookCover: "Cubierta del libro",
    by: "por"
  },
  turkish: {
    contentsEyebrow: "İçindekiler",
    contentsHeading: "İçindekiler",
    chapter: "Bölüm",
    sources: "Kaynaklar",
    illustration: "İllüstrasyon",
    bookCover: "Kitap kapağı",
    by: "yazan"
  },
  urdu: {
    contentsEyebrow: "فہرست مضامین",
    contentsHeading: "فہرست",
    chapter: "باب",
    sources: "ذرائع",
    illustration: "تصویر",
    bookCover: "کتاب کا سرورق",
    by: "تحریر"
  }
};

/** Reader-facing chrome in the book's language, keyed the same way `scriptProfileForLanguage` is. */
export function markdownLabels(language: string | undefined): MarkdownLabels {
  if (isEnglishLanguage(language)) {
    return DEFAULT_MARKDOWN_LABELS;
  }
  return MARKDOWN_LABELS_BY_LANGUAGE[languageLabel(language).toLowerCase()] ?? DEFAULT_MARKDOWN_LABELS;
}
