import { scriptProfileForLanguage } from "../prompting/script.js";

type Relation = "mother" | "father";
type KinshipVocabulary = {
  language: string;
  mother: string;
  father: string;
  /** A possessive or dedication prefix in this vocabulary's own language. */
  before?: string;
  /** Some languages put the possessive after the relative. */
  after?: string;
  /** Inflections that themselves carry a possessive, as Turkish anneme does. */
  possessed?: Partial<Record<Relation, string>>;
};

/**
 * Finite everyday parent terms and grammatical forms, never stems. The target
 * language chooses what a capitalised word may mean; the source must actually
 * name that relation in a possessive/dedication phrase. In particular, an
 * English request about a person named Anne does not supply Turkish "mother".
 * This vocabulary is for composed prose only, never names, holders or imprints.
 */
const VOCABULARY: readonly KinshipVocabulary[] = [
  { language: "en", mother: "mother mom mum mommy mummy mama momma", father: "father dad daddy papa",
    before: "my|our|your|his|her|their|for|to|dear" },
  { language: "es", mother: "madre mamá mami mama", father: "padre papá papi papa",
    before: "mi|nuestra|nuestro|su|tu|para|querida|querido" },
  { language: "fr", mother: "mère maman", father: "père papa",
    before: "ma|mon|notre|sa|son|ta|ton|pour|chère|cher" },
  { language: "de", mother: "mutter mama mutti", father: "vater papa papi",
    before: "mein|meine|meinen|meinem|meiner|unser|unsere|unseren|unserem|unserer|für" },
  { language: "it", mother: "madre mamma mammina", father: "padre papà babbo",
    before: "mia|mio|nostra|nostro|sua|suo|tua|tuo|per|cara|caro" },
  { language: "pt", mother: "mãe mamãe mamã", father: "pai papai papá",
    before: "minha|meu|nossa|nosso|sua|seu|tua|teu|para|querida|querido" },
  { language: "nl", mother: "moeder mama mam", father: "vader papa pap",
    before: "mijn|onze|zijn|haar|jouw|voor|lieve" },
  { language: "tr", mother: "anne annem anneme annemi annemin annemde annemden anneciğim anneciğime",
    father: "baba babam babama babamı babamın babamda babamdan babacığım babacığıma",
    before: "benim|bizim",
    possessed: {
      mother: "annem anneme annemi annemin annemde annemden anneciğim anneciğime",
      father: "babam babama babamı babamın babamda babamdan babacığım babacığıma"
    } },
  { language: "ru", mother: "мама мамы маме маму мамой мамою мать матери матерью мамочка мамочки мамочке мамочку",
    father: "папа папы папе папу папой папою отец отца отцу отцом отце",
    before: "моя|моей|мою|мой|моего|моему|моим|наша|нашей|нашу|наш|нашего|нашему|нашим|для" },
  { language: "uk", mother: "мама мами мамі маму мамою мати матері матір матір'ю ненька неньки неньці",
    father: "тато тата татові тату татом батько батька батькові батьку батьком",
    before: "моя|моєї|моїй|мою|мій|мого|моєму|моїм|наша|нашої|нашій|нашу|наш|нашого|нашому|нашим|для" },
  { language: "el", mother: "μητέρα μητέρας μαμά μαμάς μάνα μάνας", father: "πατέρας πατέρα μπαμπάς μπαμπά",
    after: "μου|μας|σου|του|της|τους" },
  { language: "pl", mother: "matka matki matce matkę matką matko mama mamy mamie mamę mamą mamo",
    father: "ojciec ojca ojcu ojcem ojcze tata taty tacie tatę tatą tato",
    before: "moja|mojej|moją|mój|mojego|mojemu|moim|nasza|naszej|naszą|nasz|naszego|naszemu|naszym|dla" },
  { language: "sv", mother: "mor moder mamma", father: "far fader pappa", before: "min|vår|din|sin|till" },
  { language: "no", mother: "mor moder mamma", father: "far fader pappa", before: "min|vår|din|sin|til" },
  { language: "da", mother: "mor moder mamma", father: "far fader pappa", before: "min|vores|din|sin|til" },
  { language: "vi", mother: "mẹ má", father: "bố ba cha", before: "cho", after: "tôi|mình|con|em|ta" }
];

const START = String.raw`(?<![\p{L}\p{M}\p{N}])`;
const END = String.raw`(?![\p{L}\p{M}\p{N}])`;
const RELATIONS: readonly Relation[] = ["mother", "father"];

/**
 * A request can use a different script from the book. These source-only
 * phrases supply the same relation without adding target words to a capital
 * guard that never runs for uncased scripts. Arabic-script literals use the
 * same spelling as the folded sources (Persian yeh/kaf, no vocalisation).
 * Unspaced phrases carry their own possessive; Japanese additionally requires
 * a following particle, so 母校 (alma mater) never becomes a mother.
 */
const UNCASED_SOURCE: Record<Relation, readonly string[]> = {
  mother: [
    `${START}(?:مادرم|مامانم|مادرمان|مامانمان|(?:مادر|مامان)\\s+(?:من|ما))${END}`, // Persian
    `${START}(?:لامی|امی|والدتی|لوالدتی|امنا|والدتنا)${END}`, // Arabic
    `${START}(?:میری|ہماری)\\s+(?:ماں|والدہ|امی)${END}`, // Urdu
    `${START}(?:मेरी|हमारी|अपनी)\\s+(?:माँ|मां|माता|मम्मी)${END}`, // Hindi
    `(?:我的|我们的|我們的)(?:妈妈|媽媽|母亲|母親)`, // Chinese
    `私(?:たち)?の(?:母|お母さん)(?=に|へ|を|と|が|は|の|[\\s.!?。！？、]|$)`, // Japanese
    `${START}(?:제|저의|우리|내|나의)\\s*(?:어머니|엄마)(?=께|에게|를|는|가|와|의|[\\s.!?。！？、]|$)`, // Korean
    `${START}(?:ל)?(?:אמא|אימא|אם)\\s+(?:שלי|שלנו)${END}`, // Hebrew
    `แม่ของ(?:ฉัน|ผม|เรา)` // Thai
  ],
  father: [
    `${START}(?:پدرم|بابام|پدرمان|بابامان|(?:پدر|بابا)\\s+(?:من|ما))${END}`,
    `${START}(?:لابی|ابی|والدی|لوالدی|ابونا|والدنا)${END}`,
    `${START}(?:میرا|میرے|ہمارا|ہمارے)\\s+(?:باپ|والد|ابو)${END}`,
    `${START}(?:(?:मेरे|हमारे|अपने)\\s+(?:पिता|पापा)|(?:मेरा|हमारा|अपना)\\s+बाप)${END}`,
    `(?:我的|我们的|我們的)(?:爸爸|父亲|父親)`,
    `私(?:たち)?の(?:父|お父さん)(?=に|へ|を|と|が|は|の|[\\s.!?。！？、]|$)`,
    `${START}(?:제|저의|우리|내|나의)\\s*(?:아버지|아빠)(?=께|에게|를|는|가|와|의|[\\s.!?。！？、]|$)`,
    `${START}(?:ל)?(?:אבא|אב)\\s+(?:שלי|שלנו)${END}`,
    `พ่อของ(?:ฉัน|ผม|เรา)`
  ]
};

function sourcePatterns(relation: Relation): readonly RegExp[] {
  const cased = VOCABULARY.flatMap((vocabulary) => {
    const aliases = vocabulary[relation].split(" ").join("|");
    const patterns: string[] = [];
    if (vocabulary.before) patterns.push(`(?:${vocabulary.before})\\s+(?:${aliases})`);
    if (vocabulary.after) patterns.push(`(?:${aliases})\\s+(?:${vocabulary.after})`);
    const possessed = vocabulary.possessed?.[relation];
    if (possessed) patterns.push(`(?:${possessed.split(" ").join("|")})`);
    return patterns.map((pattern) => new RegExp(`${START}(?:${pattern})${END}`, "u"));
  });
  return [...cased, ...UNCASED_SOURCE[relation].map((pattern) => new RegExp(pattern, "u"))];
}
const SOURCE_PATTERNS: Record<Relation, readonly RegExp[]> = {
  mother: sourcePatterns("mother"), father: sourcePatterns("father")
};

/** A translated capitalised parent term whose same relation the reader supplied. */
export function isGroundedKinship(word: string, foldedSources: string, bookLanguage: string | null | undefined): boolean {
  const language = scriptProfileForLanguage(bookLanguage).code.split("-")[0]!;
  const vocabulary = VOCABULARY.find((entry) => entry.language === language);
  if (!vocabulary) return false;
  return RELATIONS.some((relation) => vocabulary[relation].split(" ").includes(word) &&
    SOURCE_PATTERNS[relation].some((pattern) => pattern.test(foldedSources)));
}
