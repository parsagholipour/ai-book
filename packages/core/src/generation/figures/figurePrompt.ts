import type { ChapterComposition } from "../chapterForms.js";
import type { FigureKind, FigurePlan } from "./figureSpec.js";

/**
 * Every sentence a model is shown about figures, in one place. The form
 * planner sees the rule and the key only for an eligible book; the writer
 * sees the syntax only for a chapter whose form plan carries a figure, and
 * sees one example, of the planned kind; the editor sees one line about the
 * stand-in. A chapter with no figure gets a prompt byte-identical to the one
 * it got before figures existed, which is the whole cost discipline.
 */

export const FIGURE_FORM_PLAN_RULE =
  "A section whose material compares quantities, or follows a growth, a trend or a share of a whole, carries figure — {kind: bar|line|pie, shows, source}; a section that walks through a procedure or an algorithm with distinct steps and decisions carries {kind: flow, shows, source}. Give one to every section where the material genuinely is quantitative or procedural and to none where it is not, at most one figure in a chapter: a book of methods, algorithms, data or procedures carries one in most chapters, a narrative history in a few. shows says what the figure shows in one clause; source names where its numbers or its steps come from: the notes, a named public record, or the procedure the section describes.";

export const FIGURE_FORM_PLAN_CONTRACT = {
  figure: { kind: "bar", shows: "What the figure shows, in one clause.", source: "Where its numbers or its steps come from." }
} as const;

export function plannedFigures(composition: Pick<ChapterComposition, "sections">): FigurePlan[] {
  return composition.sections.flatMap((section) => (section.figure ? [section.figure] : []));
}

const BAR_EXAMPLE =
  '```figure\n{"kind":"bar","title":"Share of the workforce in farming","categories":["1900","1950","2000"],"series":[{"name":"United States","values":[41,12,2]}],"unit":"%","source":"US Census Bureau, decennial censuses","caption":"Farm work as a share of all employment."}\n```';

const LINE_EXAMPLE =
  '```figure\n{"kind":"line","title":"Share of the workforce in farming","categories":["1900","1950","2000"],"series":[{"name":"United States","values":[41,12,2]}],"unit":"%","source":"US Census Bureau, decennial censuses","caption":"The farm share falls across the century."}\n```';

const PIE_EXAMPLE =
  '```figure\n{"kind":"pie","title":"United States employment by sector","categories":["Services","Goods-producing","Farming"],"series":[{"name":"United States","values":[80,18,2]}],"unit":"%","source":"US Census Bureau, 2000 census","caption":"Services hold most of all employment."}\n```';

const FLOW_EXAMPLE =
  '```figure\n{"kind":"flow","title":"How a claim moves through review","nodes":[{"id":"a","label":"Claim filed","shape":"start"},{"id":"b","label":"Triage within 48 hours"},{"id":"c","label":"File complete?","shape":"decision"},{"id":"d","label":"Request documents"},{"id":"e","label":"Assess and decide","shape":"end"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"},{"from":"c","to":"d","label":"No"},{"from":"d","to":"b"},{"from":"c","to":"e","label":"Yes"}],"source":"The procedure this chapter describes","caption":"Documents are requested until the file is complete."}\n```';

const FIGURE_EXAMPLES: Record<FigureKind, string> = {
  bar: BAR_EXAMPLE,
  line: LINE_EXAMPLE,
  pie: PIE_EXAMPLE,
  flow: FLOW_EXAMPLE
};

const CHART_VALUE_MAGNITUDE =
  "Values are plain numbers no larger than a thousand trillion in magnitude: express a bigger quantity in a larger unit rather than writing the zeros.";

const FIGURE_COMPOSE_KEYS: Record<FigureKind, string> = {
  bar: `Keys: kind (bar), title, categories, series (each with name and values, one value per category), unit, source, caption; a bar chart may add orientation: "horizontal" for long category names, and scale: "log" when its values span orders of magnitude. At most 4 series; up to 16 categories. ${CHART_VALUE_MAGNITUDE}`,
  line: `Keys: kind (line), title, categories, series (each with name and values, one value per category), unit, source, caption; a line chart adds scale: "log" when its values span orders of magnitude. At most 4 series; 2 to 30 points. ${CHART_VALUE_MAGNITUDE}`,
  pie: `Keys: kind (pie), title, categories, series (each with name and values, one value per category), unit, source, caption. One series of up to 8 slices. ${CHART_VALUE_MAGNITUDE}`,
  flow: "Keys: kind (flow), title, nodes (each with id, label and an optional shape: start, step, decision or end), edges (each with from, to and an optional label such as Yes or No), source, caption. Between 2 and 14 nodes, at most 20 edges, labels short enough to fit a box."
};

/** The writer's lines for a chapter whose form plan carries a figure; none otherwise. */
export function figureComposeRules(composition: Pick<ChapterComposition, "sections">): string[] {
  const figures = plannedFigures(composition);
  const figure = figures[0];
  if (!figure) return [];
  const sectionNumber = composition.sections.findIndex((section) => section.figure) + 1;
  const named = figure.kind !== "flow" ? `${figure.kind} chart` : "flow diagram";
  return [
    `This chapter carries one figure, in section ${sectionNumber}: a ${named} showing ${figure.shows}${figure.source ? ` (from ${figure.source})` : ""}. Write it as its own paragraph directly after the paragraph that introduces what it shows, as a fenced block tagged figure holding one JSON object, the only JSON anywhere in the chapter. For example:\n${FIGURE_EXAMPLES[figure.kind]}`,
    FIGURE_COMPOSE_KEYS[figure.kind],
    "Every number is one the chapter's prose, researchNotes or a well-known public record supplies, and source names which; an approximate or illustrative figure says so in caption. Never invented precision. The prose refers to it as the figure, never by a number, and does not repeat what a reader can read off it."
  ];
}

/** The editor's one line, only when the chapter it is editing carries a figure. */
export function figureEditRules(composition: Pick<ChapterComposition, "sections">): string[] {
  if (plannedFigures(composition).length === 0) return [];
  return [
    "A line reading [Figure: …] marks where the chapter's figure sits; keep it as its own paragraph, unchanged, after the paragraph that introduces what it shows."
  ];
}
