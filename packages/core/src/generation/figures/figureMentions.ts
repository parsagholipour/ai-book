import { normalisedFigureText } from "./figureBlocks.js";
import type { FigureSpec } from "./figureSpec.js";

/**
 * Whether a reader's edit request names the chart or diagram, so a rewrite may
 * be shown the block and change or drop it. Finding, hiding and restoring
 * figure blocks lives in `figureBlocks.ts`.
 */

/**
 * What may follow "the figure" (or "the graphic") for the word to be the
 * artifact rather than a person, a number or an idiom: the end of the text, the
 * end of a sentence, or one of a short list of artifact continuations. A
 * whitelist rather than a blacklist of person continuations, because a
 * blacklist leaks ("this figure skating passage" walked through one). A comma
 * is deliberately not on it: "this figure, a man in grey" is an appositive as
 * often as a pause, and the appositive is the person reading.
 */
const ARTIFACT_CONTINUATIONS =
  String.raw`should|needs?|shows|here|smaller|bigger|larger|simpler|clearer|wider|narrower|horizontal|vertical|legible|readable|on\s+page|in\s+(?:section|chapter)`;

function artifactLookahead(continuations: string): string {
  return String.raw`(?=\s*$|\s*[.!?)\]"”’']|\s+(?:${continuations})\b)`;
}

const ARTIFACT_HEAD = artifactLookahead(String.raw`as|into|to|${ARTIFACT_CONTINUATIONS}`);
// `as`/`into`/`to` are how a figure is redirected ("the figure into section 2")
// and how a graph-theory edit continues ("the graph into an adjacency list").
const GRAPH_ARTIFACT_HEAD = artifactLookahead(ARTIFACT_CONTINUATIONS);

/**
 * The cues that a request names the chart or diagram. A word that names a
 * chart and nothing else counts on its own; a word that is also a person, a
 * story, a myth, a shape or an adjective counts only as the head of a phrase
 * about the artifact, or with a number, or beside a chart word. Persian جدول
 * and the Korean/Chinese words for a table are left out: a table is not a
 * figure kind this pipeline draws, and جدول زمانی is a timetable.
 */
const FIGURE_CUES: readonly RegExp[] = [
  /\b(?:charts?|diagrams?|flowcharts?|infographics?|histograms?|scatterplots?)\b/i,
  /\b(?:pie\s+slices?|[xy][- ]ax(?:is|es)|(?:vertical|horizontal|value|category|log|logarithmic|linear)\s+ax(?:is|es)|ax(?:is|es)\s+(?:labels?|ticks?|titles?|scale)|tick\s+labels?|data\s+series|trend\s*lines?|grid\s*lines?)\b/i,
  // A legend is a myth before it is a key to a chart: only its parts and
  // placement count, never the bare word.
  /\blegends?\s+(?:labels?|entries|entry|keys?|colou?rs?|swatch(?:es)?|text)\b/i,
  /\b(?:move|place|put)\s+(?:the\s+)?legends?\s+(?:to|on|at|below|above|under)\b/i,
  /\blegends?\s+(?:to|on|at)\s+(?:the\s+)?(?:bottom|top|left|right|side|centre|center)\b/i,
  // A plot is a story before it is a chart: only a chart-qualified plot counts.
  /\b(?:scatter|line|bar|box|dot|area)[- ]plots?\b/i,
  /\bplots?\s+of\s+(?:the\s+)?(?:data|numbers|values|series|results)\b/i,
  // A graph is a mathematical object before it is a chart. Bare `\bgraph\b`
  // matches the graph in graph-theory; only a chart-qualified graph counts.
  /\b(?:scatter|line|bar|box|dot|area|pie|column)[- ]graphs?\b/i,
  /\bgraphs?\s+of\s+(?:the\s+)?(?:data|numbers|values|series|results)\b/i,
  new RegExp(String.raw`\b(?:the|this|that)\s+graphs?\b${GRAPH_ARTIFACT_HEAD}`, "i"),
  // "figure" is a person, a number or an idiom, "graphic" an adjective: the
  // head of an artifact phrase, or a numbered figure, is what counts.
  new RegExp(String.raw`\b(?:the|this|that)\s+(?:figure|graphic)\b${ARTIFACT_HEAD}`, "i"),
  /\bfigure\s*\d+/i,
  // Persian and Arabic: نمودار is a chart; شکل is also "shape" and "way" (به این
  // شکل), so it needs a number or to be the object of the sentence (این شکل را);
  // محور is also the axis of an argument, so it needs a direction.
  /نمودار|فلوچارت|دیاگرام|اینفوگرافیک|هیستوگرام|رسم\s+بياني|رسم\s+بیانی/,
  /شکل\s*[\d۰-۹٠-٩]+|(?:این|آن)\s+شکل\s+را(?=\s|$)|محور\s+(?:عمودی|افقی|ایکس|وای)/,
  // Left letter-boundary only: a right lookaround would refuse gráfico / Diagramme,
  // which these stems are written to match. `photographique` fails because
  // graphique is not at a letter-run start.
  /(?<![\p{L}])(?:gráfic|graphique|diagramm|grafico|диаграмм|гистограмм|histogramm|histograma|histogramme)/iu,
  // Axes and legends in the European lists, qualified the same way: Achse is an
  // axle and the Axis powers, eje and axe are axles, Legende/leyenda/légende and
  // легенда are myths; ось is an axle.
  /[xy]-achse|achsenbeschriftung|legenden(?:beschriftung|eintr|text)|eje\s+(?:x|y|vertical|horizontal)|axe\s+(?:des\s+)?(?:x|y|vertical|horizontal|abscisses|ordonnées)|ос[ьи]\s+(?:x|y|абсцисс|ординат)|(?:вертикальн|горизонтальн)\S*\s+ос[ьи]/i,
  // Russian график is a schedule before it is a chart (график работы): it
  // needs a number, a chart adjective or a data continuation beside it.
  /график\s*\d+|(?:линейн|столбчат|кругов|точечн)\S*\s+график|график\S*\s+(?:данных|роста|зависимост|изменени|значений)/i,
  // CJK: the compounds are unambiguous; bare 图 (also a map or a picture) and
  // 図 (also inside 地図) need a number or a chart compound.
  /图表|(?:柱状|条形|折线|饼|流程|示意|直方)图|图\s*[\d０-９一二三四五六七八九十]+|图例|(?:横|纵|[xy])轴/i,
  /グラフ|図表|フローチャート|ヒストグラム|(?:フロー|概略|構成)図|図\s*[\d０-９]+|凡例|[xy]軸|(?:横|縦)軸/i,
  /차트|그래프|다이어그램|도표|순서도|히스토그램|범례|[xy]축|(?:가로|세로)축/i
];

/** One- and two-character titles are too short to quote as a name ("US", "a"). */
const MIN_TITLE_CUE_LENGTH = 3;

function appearsAsWholePhrase(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/**
 * Whether a reader's edit request names the figure — the chart or diagram —
 * so a rewrite may be shown the block and change or drop it. Biased toward
 * precision: a request this misses keeps the block aside and puts it back
 * unchanged, which the chat can re-ask for; a request this takes wrongly
 * shows the model the JSON and lets it change or drop a figure nobody asked
 * about. "Strengthen the plot twist", "a more sympathetic historical figure"
 * and "this figure skating passage" all used to do exactly that.
 *
 * With the page's own figures, a request that quotes one's title as a whole
 * phrase counts too. Its categories and series names do not: they are the
 * years, places and names the prose is about, so "describe 1950 more vividly"
 * and "mention the United States" would name the chart by accident.
 */
export function mentionsFigure(text: string, figures: readonly FigureSpec[] = []): boolean {
  if (FIGURE_CUES.some((cue) => cue.test(text))) return true;
  if (figures.length === 0) return false;
  const request = normalisedFigureText(text);
  return figures.some((figure) => {
    const title = normalisedFigureText(figure.title);
    return title.length >= MIN_TITLE_CUE_LENGTH && appearsAsWholePhrase(request, title);
  });
}
