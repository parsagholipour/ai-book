import type { CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";
import {
  runningCaseSchema,
  toolkitCaveatSchema,
  type InstructionalBookKind,
  type InstructionalSetting,
  type InstructionalToolkit
} from "../schemas/instructional.js";
import { LONG_SECTION_FORMS, PINNED_FORMS } from "./chapterFormPalette.js";
import { inferWritingMode, type WritingModePlan } from "./styleContract.js";

/**
 * A practical guide or a workbook, planned from what the reader walks away
 * with. Readers of the 2026-09-30/10-01 guides and workbooks (four editor
 * reviews, sixteen blind trials) found the history machinery running on how-to
 * books: episodes were documents ("GitLab Handbook, 1:1s"), sections owned
 * source titles, the writer was told a chapter "is built from the episodes … a
 * person, a place, a date and a document", "do not invent dialogue" turned
 * every script into a description of one, and the plan's continuityRules
 * ("label sample figures as illustrative", "keep tax guidance general") reached
 * every chapter, so every chapter repeated them. Here research supplies facts a
 * sentence uses, sections are deliverables with headings, the brief's asks are
 * checked for a home before drafting, and each caveat is stated in one chapter.
 *
 * The path is the reader's choice, never the category's: a book whose chosen
 * type is a practical guide or a workbook (or, chosen "auto", whose resolved
 * lane is one) and whose writing mode is instructional. Everything else —
 * a business history filed under Business included — composes exactly as before.
 */

export type { InstructionalBookKind, InstructionalSetting, InstructionalToolkit } from "../schemas/instructional.js";

const TOOLKIT_LANES: Readonly<Record<string, InstructionalBookKind>> = { practical_guide: "guide", workbook: "workbook" };

function mobileSettings(input: CreateProjectInput | undefined): Record<string, unknown> | undefined {
  const mobile = input?.mediaSettings && isRecord(input.mediaSettings) ? (input.mediaSettings as Record<string, unknown>).mobile : undefined;
  return isRecord(mobile) ? mobile : undefined;
}

/**
 * The book type the reader chose, resolved: `practical_guide` or `workbook`
 * directly, or, for `auto` (or no choice recorded), the lane the creation
 * advisor resolved it to. Every other type — lead magnet, offer guide, client
 * tool, any story — is not a toolkit book.
 */
export function toolkitBookKind(input: CreateProjectInput | undefined): InstructionalBookKind | undefined {
  const mobile = mobileSettings(input);
  if (!mobile) return undefined;
  const choice = typeof mobile.bookTypeChoice === "string" ? mobile.bookTypeChoice : undefined;
  if (choice && choice !== "auto") return TOOLKIT_LANES[choice];
  const recipe = isRecord(mobile.recipe) ? mobile.recipe : undefined;
  const resolved = [mobile.detectedLane, recipe?.lane].find((lane) => typeof lane === "string" && lane !== "auto");
  return typeof resolved === "string" ? TOOLKIT_LANES[resolved] : undefined;
}

/** Whether this book takes the toolkit path: the reader's book type and an instructional writing mode, both. */
export function usesToolkit(input: CreateProjectInput | undefined, plan?: WritingModePlan | undefined): boolean {
  return toolkitBookKind(input) !== undefined && inferWritingMode(input, plan) === "instructional";
}

/**
 * The toolkit the prompts may act on: the one passed, and only for a book on
 * the path. A book planned before the toolkit existed has none, and composes
 * with the prompts it always had.
 */
export function activeToolkit(
  input: CreateProjectInput | undefined,
  plan: WritingModePlan | undefined,
  toolkit: InstructionalToolkit | undefined
): InstructionalToolkit | undefined {
  return toolkit && usesToolkit(input, plan) ? toolkit : undefined;
}

// ---------------------------------------------------------------- research leads

/**
 * The plan-episodes prompt for a toolkit book: research the chapters will use
 * in a sentence, with the searches that find its authoritative text, and the
 * one country the book's rules belong to (a guide mixed US EEOC, UK Acas and UK
 * GDPR without saying which applied). The dossier downstream is unchanged: a
 * lead is an episode of kind figure or document.
 */
export function researchLeadSystemLines(title: string): string[] {
  return [
    `You are the author of "${title}", a practical book whose chapters are built from what the reader will face and use. Before any chapter is planned, list the research its chapters need: for every chapter of the plan, two or three research leads.`,
    "A research lead is one fact the chapter will use in a sentence to help the reader decide or act: a number, rate, threshold, deadline, legal or official rule, or a named study's finding. It is never the chapter's subject, never a book, framework or handbook to summarise, never a history of a study, and never an anecdote about a company.",
    "Decide setting first: the one country whose rules, money and dates the book uses — the requester's own when the request says or implies it, otherwise the country the request's details point to — with its currency and, where rules change by year, the year the reader is in (today is in the payload) unless the request names another. A lead that depends on a country — a law, a tax or benefit rule, a deadline, an official statistic — is that country's, and only such a lead's searchQueries name the country and the year.",
    "kind is figure (a number, rate, threshold, date or table the chapter will use) or document (a rule, official guidance or a named finding). title: the fact needed, as a short noun phrase. person: who publishes it — an agency, a researcher, an organisation. document: the page, form, report or paper that states it. place: the setting's country. date: the year it applies to. why: the decision in this chapter the fact serves, in one clause.",
    "searchQueries: two or three searches for the authoritative page itself — an official page or the original paper first, then a broader query. Select each lead for one chapter only.",
    "Return one JSON object shaped exactly like outputContract with two keys: setting, the object {country, currency, year}, and chapters, one entry per chapter of the plan in the plan's order and the plan's index numbers."
  ];
}

export const RESEARCH_LEAD_CONTRACT = {
  setting: { country: "", currency: "", year: "" },
  chapters: [
    {
      index: 1,
      episodes: [{ title: "", kind: "figure", person: "", place: "", date: "", document: "", why: "", searchQueries: ["", ""] }]
    }
  ]
};

/** A lead is never told as a scene: an unknown kind parses as `scene` (EPISODE_KINDS), and a scene episode opens its chapter through `composeScene`. */
export function asResearchLeadKind(kind: string): "figure" | "document" {
  return kind === "figure" ? "figure" : "document";
}

// ---------------------------------------------------------------- the form plan

export type RequirementRef = { id: string; text: string };

export function requirementRefs(requirements: readonly string[] | undefined): RequirementRef[] {
  return (requirements ?? []).map((requirement, index) => ({ id: `R${index + 1}`, text: requirement }));
}

/**
 * The form planner's rules for a toolkit book. Three of them are the pacing
 * assignments the first blind panel asked for (2026-10-01: new won 8/8 overall
 * and lost pacing 5/8 — one calculation run five times, a figure restated five
 * times, the agreed next step six): each figure, calculation and agreed outcome
 * is owned by one section; a worksheet is printed once filled and once blank;
 * the long section is a deliverable, never the opening situation.
 */
export function toolkitFormPlanRules(kind: InstructionalBookKind): string[] {
  return [
    "You are the book's structural editor for a practical book. Plan every chapter as an ordered list of sections, each delivering one thing the reader walks away with: a situation they will face, the words to say in it, a tool to copy, a rule that decides what to do.",
    `Return one JSON object exactly like outputContract: a chapters array — each chapter with chapterIndex, throughLine, sections, landing and avoid — and, beside it, cast, caveats and rules${kind === "workbook" ? " and runningCase" : ""}.`,
    "form says what the section delivers, from the palette. heading is the section's subheading as the reader will see it: a short concrete label of what the section gives (\"Thirty questions, sorted by purpose\", \"When the answer is no\"), never a question and never the chapter's title. subject says exactly what the section contains: for a tool or worksheet its contents — the categories and how many items, or its columns (five at most, so it fits a printed page) and rows; for a script who says what, and the pushback it answers; for a situation the person and the moment; for a decision-rule the trigger and the rule.",
    "owns names what this section alone delivers: the example person it introduces, the tool or rule it prints, and every figure, calculation or agreed outcome it works out — never a book, study, author, organisation or document. Each figure, calculation and agreed outcome is owned by one section in the whole book, the worksheet or worked example that works it out; every other section that needs it uses its result.",
    "research lists what each chapter's research will supply: facts, numbers and named findings. A research lead is used inside a section, in the sentence that needs it; it is never a section's subject or owns, and no section retells a study, a framework or a source.",
    "requirements lists what the request asks the book to deliver, each with an id. covers on a section lists the ids it delivers, and every id is covered. A specific deliverable — a named question bank, template, checklist, agenda, tracker or worksheet — is covered by one section only, a tool or worksheet section that prints it in full, never split across chapters; a general ask (\"include worksheets\") by the sections that meet it. A requirement about the whole book — its audience, tone or format — goes in covers of the first section of the first chapter and needs nothing in any subject.",
    "A tool is printed complete, never as a sample: a question bank covers every purpose the reader will need, five or more groups of at least five questions each; a checklist has every step; a template has every field.",
    "Where the subject has a standard method or an official number in setting — a rate, a formula, a threshold, a due date — the section uses the actual one and works with it; a referral to a professional is a caveat beside the method, never a replacement for it.",
    "Face the reader with the situations the subject really brings: the hard moments people in the reader's position meet often — an upset or defensive reaction, a no they have to deliver, a problem that keeps coming back, someone about to give up or leave — as well as the easy one, and before a rare case that belongs to a formal or legal process. At least one situation in every chapter where people are involved, each with a different example person or a different moment. A chapter about talking to someone carries at least one script.",
    kind === "workbook"
      ? "This book is a workbook, carried by one running case. runningCase is one person whose situation stays fixed for the whole book, {name, situation, figures}: figures lists every input the chapters compute from, each {label, value, year} — amounts, rates, hours, dates, including the rates taken from setting's actual rules for the running case's income (a tax rate, a threshold, a due date) — stated once here and never changed; year is the tax or calendar year a dated amount or a yearly rate belongs to. For a book about money that includes the tax rates that apply to the running case's income in setting and the set-aside they add up to, so the tax chapter computes a real amount. A figure is never a result: each chapter computes its own results from these inputs, so every chapter reaches a real answer, and a total adds only figures of one year. Check every chapter's worked-example and worksheet against the list: each input its calculation needs — a price, an hour count, a cost, a rate — is there. Every worked-example and worksheet uses runningCase's figures, every rule, rate and date is setting's, and each chapter's last section computes one answer for the running case. cast holds runningCase's person and at most one other, each {name, role, introducedIn}."
      : "cast: three or four recurring example people, each {name, role, introducedIn}: role says who they are in a clause — a job, a business, a household — never what happens to them in one scene; introducedIn is the chapter where the reader meets them, the only place their role is explained. The reader's own stand-in is one of them and has a name; different situations use different people. A one-off example person gets a name not in cast.",
    "caveats: only the warnings a reader could be hurt by missing — when to get professional, legal or medical help, the legal limit of a rule — including those among continuityRules, each {text, chapterIndex}: stated once, in the one chapter where it matters most. No two caveats say the same thing. Never a remark that a number, tool or plan is not a guarantee or not a prediction; the example people need no caveat, and a practice needs none for being adaptable.",
    `rules: at most five facts about the book's own content that a writer of a later chapter could get wrong — a term, a number, a format, a length of time — taken from continuityRules and your plan, each a plain statement of the fact. Never a hedge, a warning, a label for the examples or anything about the book's structure: a continuityRule of that kind goes to caveats, or nowhere. A continuityRule telling the book to stay general or to avoid rates and numbers is not a rule: the book uses setting's actual numbers, and the referral it asks for is a caveat. No rule says a method, rate or number is not used.${kind === "workbook" ? " runningCase already fixes the running case's numbers; rules does not repeat them." : ""}`,
    `landing is what the reader has in hand at the end of this chapter — the finished tool, the decision made${kind === "workbook" ? ", the running case's computed answer" : ""} — in one sentence particular to this chapter; never the book's thesis restated and never a negation followed by its correction. No two landings share a subject.`,
    "Each section carries a handoff: what it leaves for the next section. The last section's handoff is empty.",
    "The final chapter is new material too: its sections are tools the reader uses next, never a re-list of the earlier chapters.",
    "Variety, enforced after you answer: within a chapter no form other than situation, script, tool, worksheet or decision-rule takes more than half the sections or follows itself; no two chapters share the same form sequence; consecutive chapters do not open with the same form.",
    "Section counts per chapter are given as sectionCount; shares are fractions of the chapter's length and sum to 1. Give every chapter one section that takes at least its sustainedShare — a tool, worksheet, worked-example or script, never a situation — and one under 15%; a situation takes under a fifth of its chapter. A tool that prints thirty items or a worksheet with a filled and a blank table needs the room it takes.",
    "avoid names what earlier chapters already established that this chapter must not re-explain."
  ];
}

export const FIXED_TOOLKIT_RULE =
  "toolkit is what the book's earlier chapters already fixed: keep its setting, runningCase, caveats and rules as they are, and plan against them.";

/** Only where a figure shows what the text beside it cannot: the q2 guide's flow diagrams redrew the numbered list next to them. */
export const TOOLKIT_FIGURE_FORM_PLAN_RULE =
  "A section whose material is numbers the reader compares — a split of a whole, a trend, amounts side by side — may carry figure {kind: bar|line|pie, shows, source}; a section whose decision branches may carry {kind: flow, shows, source}. Never a figure that repeats a list, table or steps the section prints: a straight sequence of steps is a numbered list, not a flow diagram. At most one figure in a chapter, and only where it shows something the text beside it does not.";

export function toolkitOutputContract(kind: InstructionalBookKind, figures: boolean) {
  return {
    chapters: [
      {
        chapterIndex: 1,
        throughLine: "What this chapter gives the reader, in one sentence.",
        sections: [
          {
            form: "tool",
            heading: "The section's subheading.",
            subject: "Exactly what the section contains.",
            share: 0.3,
            owns: ["The person, tool, rule, figure or calculation this section alone delivers."],
            covers: ["R1"],
            handoff: "What this section leaves for the next.",
            note: "Optional: anything the writer must know about this section.",
            ...(figures ? { figure: { kind: "bar", shows: "What the figure shows, in one clause.", source: "Where its numbers come from." } } : {})
          }
        ],
        landing: "What the reader has in hand at the end of this chapter.",
        avoid: ["What earlier chapters already established."]
      }
    ],
    cast: [{ name: "A first name", role: "Who this person is, in one clause.", introducedIn: 1 }],
    ...(kind === "workbook"
      ? { runningCase: { name: "A first name", situation: "Their fixed situation, in one sentence.", figures: [{ label: "What the number is", value: "The number with its unit", year: "The year it belongs to" }] } }
      : {}),
    caveats: [{ text: "A warning or referral, stated once.", chapterIndex: 1 }],
    rules: ["A fact the book's content keeps fixed."]
  };
}

export type ToolkitSection = { form: string; covers?: string[] | undefined; owns: string[]; subject: string; heading?: string | undefined; share?: number | undefined };
export type ToolkitComposition = { chapterIndex: number; sections: ToolkitSection[] };

function coveringChapters(compositions: readonly ToolkitComposition[]): Map<string, Set<number>> {
  const homes = new Map<string, Set<number>>();
  for (const composition of compositions) {
    for (const section of composition.sections) {
      for (const id of section.covers ?? []) {
        const key = id.trim().toUpperCase();
        homes.set(key, (homes.get(key) ?? new Set()).add(composition.chapterIndex));
      }
    }
  }
  return homes;
}

/** Requirements no section covers, as messages the repair call can act on. */
export function requirementCoverageIssues(compositions: readonly ToolkitComposition[], requirements: readonly RequirementRef[]): string[] {
  const homes = coveringChapters(compositions);
  return requirements
    .filter((requirement) => !homes.get(requirement.id)?.size)
    .map((requirement) => `Requirement ${requirement.id} (${requirement.text}) is covered by no section; give it one.`);
}

/** Requirements covered in more than one chapter: a diagnostic only, since a general ask ("include worksheets") is met in many. */
export function sharedRequirements(compositions: readonly ToolkitComposition[], requirements: readonly RequirementRef[]): string[] {
  const homes = coveringChapters(compositions);
  return requirements
    .filter((requirement) => (homes.get(requirement.id)?.size ?? 0) > 1)
    .map((requirement) => `${requirement.id} in chapters ${[...homes.get(requirement.id)!].sort((left, right) => left - right).join(", ")}`);
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "your", "you", "that", "this", "from", "into", "their", "what", "how", "when", "one", "are"]);

function contentWords(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

/**
 * Without a repair call (Quick Draft's `formPlanRepair` is off) an uncovered
 * requirement is homed by code: the section sharing the most words with it,
 * a word in the section counting twice a word in its chapter's plan, ties to
 * a deliverable section. It is named in that section's owns so the writer sees it.
 */
export function homeUncoveredRequirements<T extends ToolkitComposition>(
  compositions: readonly T[],
  requirements: readonly RequirementRef[],
  chapters: ReadonlyArray<{ index: number; title: string; summary: string; keyBeats: readonly string[] }>
): { compositions: T[]; homed: string[] } {
  const covered = coveringChapters(compositions);
  const result = compositions.map((composition) => ({ ...composition, sections: composition.sections.map((section) => ({ ...section })) }));
  const homed: string[] = [];
  for (const requirement of requirements) {
    if (covered.get(requirement.id)?.size) continue;
    const needle = contentWords(requirement.text);
    let best: { chapter: number; section: number; score: number } | undefined;
    for (const [chapterPosition, composition] of result.entries()) {
      const chapter = chapters.find((entry) => entry.index === composition.chapterIndex);
      const chapterWords = contentWords([chapter?.title ?? "", chapter?.summary ?? "", ...(chapter?.keyBeats ?? [])].join(" "));
      for (const [sectionPosition, section] of composition.sections.entries()) {
        const sectionWords = contentWords([section.subject, section.heading ?? "", ...section.owns].join(" "));
        let score = PINNED_FORMS.has(section.form) ? 0.5 : 0;
        for (const word of needle) score += sectionWords.has(word) ? 2 : chapterWords.has(word) ? 1 : 0;
        if (!best || score > best.score) best = { chapter: chapterPosition, section: sectionPosition, score };
      }
    }
    if (!best) continue;
    const section = result[best.chapter]!.sections[best.section]!;
    section.covers = [...(section.covers ?? []), requirement.id];
    section.owns = [...section.owns, requirement.text];
    homed.push(`${requirement.id} → chapter ${result[best.chapter]!.chapterIndex}, section ${best.section + 1}`);
  }
  return { compositions: result as T[], homed };
}

/**
 * The chapter's long section is a deliverable. Asked in words, the planner
 * still gave a guide's opening situation 43% of its chapter (980 words of
 * narrative before the first script, 2026-10-01); swapping its share with the
 * largest deliverable section's is exact and moves nothing else.
 */
export function deliverableCarriesLength<T extends ToolkitComposition>(compositions: readonly T[]): T[] {
  return compositions.map((composition) => {
    const sections = composition.sections.map((section) => ({ ...section }));
    const shareOf = (index: number) => sections[index]!.share ?? 1 / sections.length;
    let longest = 0;
    for (let index = 1; index < sections.length; index += 1) if (shareOf(index) > shareOf(longest)) longest = index;
    if (LONG_SECTION_FORMS.has(sections[longest]!.form)) return { ...composition, sections };
    let carrier: number | undefined;
    for (const [index, section] of sections.entries()) {
      if (LONG_SECTION_FORMS.has(section.form) && (carrier === undefined || shareOf(index) > shareOf(carrier))) carrier = index;
    }
    if (carrier === undefined || sections.some((section) => section.share === undefined)) return { ...composition, sections };
    const long = sections[longest]!.share;
    sections[longest]!.share = sections[carrier]!.share;
    sections[carrier]!.share = long;
    return { ...composition, sections };
  });
}

/** The whole-book fields of a toolkit reply; an unreadable one is dropped, never the plan. */
export function toolkitFrom(
  raw: unknown,
  kind: InstructionalBookKind,
  setting: InstructionalSetting | undefined,
  chapterIndexes: readonly number[]
): InstructionalToolkit {
  const record = isRecord(raw) ? raw : {};
  const known = new Set(chapterIndexes);
  const caveats = Array.isArray(record.caveats)
    ? record.caveats
        .flatMap((entry) => {
          const parsed = toolkitCaveatSchema.safeParse(entry);
          return parsed.success && known.has(parsed.data.chapterIndex) ? [parsed.data] : [];
        })
        .slice(0, 12)
    : [];
  const rules = Array.isArray(record.rules)
    ? record.rules.flatMap((entry) => (typeof entry === "string" && entry.trim().length >= 3 ? [[...entry.trim()].slice(0, 300).join("")] : [])).slice(0, 10)
    : [];
  const runningCase = kind === "workbook" ? runningCaseSchema.safeParse(record.runningCase) : undefined;
  return {
    kind,
    ...(setting ? { setting } : {}),
    ...(runningCase?.success ? { runningCase: runningCase.data } : {}),
    caveats,
    rules
  };
}

// ---------------------------------------------------------------- the writer and the editor

/**
 * Each section under its own heading, and what the reader will use set to be
 * used. The paragraphs-only rule suited essays; a how-to printed 1,400–2,500
 * words with no subheading and its "worksheets" as blank two-column grids.
 */
export const TOOLKIT_LAYOUT_RULE =
  "Each section opens with its heading as a level-three Markdown heading — \"### \" and the heading given for it, exactly, or a short concrete one of your own where none is given — and nothing else is a heading: no title line, no chapter label, no page numbers or page breaks, no summary, no epigraph, no notes. Inside a section, what the reader will use is set to be used: steps as a numbered list; a script as dialogue lines, each starting with the speaker's name in bold and a colon; a question bank or checklist as a list, grouped under bold labels where it has groups; an agenda, template, tracker or worksheet as a Markdown table of at most five columns whose columns carry real headings. A worksheet or template the reader fills in is printed as exactly two tables: once filled in for the section's example, with no empty rows, then once blank with the same columns and at least three rows. Explanation stays in paragraphs.";

export const TOOLKIT_SHAPE_RULES = [
  "The sections are the chapter's tools in order: let each follow from the one before, and point back to an earlier person or tool in a clause when it bears on this one.",
  "The book's plan is not visible to the reader: never refer to a chapter by number, never say what another chapter showed or will show, and never mention the sections, forms, handoffs or notes you were given. A tool or person the book introduced earlier is pointed to in half a sentence, never re-introduced.",
  "A figure, calculation or agreed outcome named in a section's material is worked out in that section, once; any other section that needs it uses the result in a clause, without the working.",
  "The chapter ends where its last section ends.",
  "A fact from the research is used where it helps the reader decide or act — the number in the sentence that needs it, the finding named in a clause — once, without the study's history and without a sentence about what it cannot show. Rhetorical questions: at most one per section, never a run of them.",
  "Every section gives the reader something to use now: words they can say, a tool they can copy, a number they can apply, or a rule that settles what to do.",
  "Paragraphs are shaped by what they carry: a worked example may run on, a rule can stand alone in a sentence or two. Never a run of paragraphs of the same length, and do not open consecutive sentences or paragraphs with the same word or construction.",
  "Prefer one example developed in full to several named in passing. A sentence lists at most three items unless the section's form is a tool, a worksheet or a procedure.",
  "Do not restate what earlier chapters established; refer to it in a clause if you must. Do not recap this chapter anywhere inside it, and do not announce what comes next."
];

/**
 * In place of the nonfiction reconstruction rule. "Do not invent dialogue" is
 * why a guide described its scripts ("Nina can describe that sequence
 * plainly…"), and "never present an invented person as a real one" is where
 * "This is an illustrative scene, not a report of an actual meeting" came from.
 */
export const EXAMPLE_PEOPLE_RULE =
  "The people in cast, and anyone else in a situation or a script, are this book's own examples, made up for it: write what they do and say, and what is said back, as it would be said, and never call them illustrative, hypothetical, composite, invented or not real, nor say what their story is not. Real people, studies and organisations appear only for facts the research supplies.";

/** In place of the creative contract's quotation promise: a script's lines are the book's own words, not a quotation it has to vouch for. */
export const TOOLKIT_QUOTATION_RULE =
  "Quotation marks around a real person's or a document's words are a promise: use them only for words you are confident were said or written in that form, and say who said them. A script's lines are the book's own words for the reader to use, set as dialogue lines, not as quotations. A number you are not sure of is given as a range or with \"about\". Never attribute to a named person a work or a remark that is not theirs.";

export const TOOLKIT_FACTS_LINE =
  "`facts` lists this chapter's research leads — facts, numbers and named findings it can use — and `dossier` the passages found for them. Use a fact where it helps the reader decide or act, in the sentence that needs it, naming its source in a clause when a reader would want to know it (an agency, a study's authors and year). A source is never a section's subject: do not summarise a book or framework, tell a study's history, or weigh what a source can and cannot show. Quote a passage only where its exact words are what the reader needs, such as a rule, a deadline or a definition. Never print internal passage IDs or research-process commentary.";

export const TOOLKIT_LAST_CHAPTER_LINE =
  "This is the final chapter. It ends on what the reader does next, with its tools printed in full; do not re-list the earlier chapters.";

export function toolkitWriterLines(toolkit: InstructionalToolkit | undefined, chapterIndex: number): string[] {
  if (!toolkit) return [];
  const lines: string[] = [];
  if (toolkit.setting) {
    const currency = toolkit.setting.currency ? `, amounts in ${toolkit.setting.currency}` : "";
    const year = toolkit.setting.year ? `, for ${toolkit.setting.year}` : "";
    lines.push(`setting is fixed: every rule, rate and deadline in this book is the one that applies in ${toolkit.setting.country}${year}${currency}; no other country's rules appear.`);
  }
  if (toolkit.runningCase) {
    lines.push("runningCase is the one person this workbook follows, with the inputs every calculation uses: use those figures exactly and never change one, add up only figures of the same year, carry every calculation through to its number, and end the chapter on the running case's answer for this chapter. Where a calculation needs an input runningCase does not give, choose one realistic figure, state it once as part of the case, and compute with it; a result is never left \"not calculable\".");
  }
  if (toolkit.rules.length > 0) {
    lines.push("book.bookRules are facts the book keeps fixed, for consistency and not material: one returns in a clause only where a section needs it, never restated or re-explained.");
  }
  if (toolkit.caveats.some((caveat) => caveat.chapterIndex === chapterIndex)) {
    lines.push("cautions are the warnings this chapter is the place for: state each once, plainly, where it applies. The book's other warnings belong to other chapters.");
  }
  return lines;
}

export function toolkitPayload(toolkit: InstructionalToolkit | undefined, chapterIndex: number) {
  if (!toolkit) return {};
  const here = toolkit.caveats.filter((caveat) => caveat.chapterIndex === chapterIndex).map((caveat) => caveat.text);
  return {
    ...(toolkit.setting ? { setting: toolkit.setting } : {}),
    ...(toolkit.runningCase ? { runningCase: toolkit.runningCase } : {}),
    ...(here.length > 0 ? { cautions: here } : {})
  };
}

/**
 * The passage a how-to writer imitates in place of the history exemplar:
 * second person, a script with the pushback it meets, a rule with a number,
 * a short numbered list, a two-sentence paragraph. On a subject no practical
 * book here is about. Written for this purpose; not a quotation.
 */
export const TOOLKIT_EXEMPLAR = [
  "Send a dish back in the first two minutes, before you have eaten a third of it; after that, most kitchens treat it as a change of mind. Catch the server's eye rather than their sleeve, and leave the plate where it is.",
  "**You:** This risotto is still chalky in the middle. Could the kitchen make it again?\n**Server:** It's meant to have a bit of bite.\n**You:** It has more than a bite. I'd like it redone, or I'll have the sea bass instead.",
  "Say it once, at an ordinary volume, and stop. The pause is the part people skip.",
  "If the second plate comes back the same, do three things in this order:\n\n1. Eat something else from the table, so the evening is not about the rice.\n2. Ask for that dish to come off the bill, not for a discount on everything.\n3. Tip as you would have, because the server did not cook it.",
  "The manager who arrives at your table at the Anchor on Wharf Street has usually heard the story already in the pass. Let them speak first."
].join("\n\n");
