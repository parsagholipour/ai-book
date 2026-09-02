import { BookOpenText } from "lucide-react";
import { useState } from "react";
import type { ProjectDetails, ResolvedGenerationStrategy } from "../../api.js";

/**
 * How a composed book was written, from the rows the pass left behind: the
 * strategy the router resolved, the author stance on the plan, and per chapter
 * the form plan, the word counts, whether the editor changed it, and what the
 * whole-manuscript read said. A per-page book shows only the resolved strategy.
 */

type ChapterComposition = {
  throughLine: string;
  sections: Array<{ form: string; subject: string; share?: number; owns?: string[] }>;
  landing: string;
  avoid?: string[];
};

type ChapterReport = {
  formPlanSource: string;
  formPlanIssues: string[];
  draftWords: number;
  editedWords: number;
  editorChanged: boolean;
  readNotes: string[];
  secondEditApplied: boolean;
  wordBudget: { min: number; target: number; max: number };
  paragraphCv: number | null;
  shapePassApplied: boolean;
};

type AuthorStance = { thesis: string; positions: string[]; refusals: string[]; voiceSample: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function readChapterComposition(brief: unknown): ChapterComposition | null {
  if (!isRecord(brief) || !isRecord(brief.composition)) return null;
  const composition = brief.composition;
  if (typeof composition.throughLine !== "string" || !Array.isArray(composition.sections)) return null;
  return {
    throughLine: composition.throughLine,
    sections: composition.sections.filter(isRecord).map((section) => ({
      form: String(section.form ?? ""),
      subject: String(section.subject ?? ""),
      ...(typeof section.share === "number" ? { share: section.share } : {}),
      owns: strings(section.owns)
    })),
    landing: typeof composition.landing === "string" ? composition.landing : "",
    avoid: strings(composition.avoid)
  };
}

export function readChapterReport(brief: unknown): ChapterReport | null {
  if (!isRecord(brief) || !isRecord(brief.report)) return null;
  const report = brief.report;
  const budget = isRecord(report.wordBudget) ? report.wordBudget : {};
  return {
    formPlanSource: typeof report.formPlanSource === "string" ? report.formPlanSource : "unknown",
    formPlanIssues: strings(report.formPlanIssues),
    draftWords: typeof report.draftWords === "number" ? report.draftWords : 0,
    editedWords: typeof report.editedWords === "number" ? report.editedWords : 0,
    editorChanged: report.editorChanged === true,
    readNotes: strings(report.readNotes),
    secondEditApplied: report.secondEditApplied === true,
    paragraphCv: typeof report.paragraphCv === "number" ? report.paragraphCv : null,
    shapePassApplied: report.shapePassApplied === true,
    wordBudget: {
      min: typeof budget.min === "number" ? budget.min : 0,
      target: typeof budget.target === "number" ? budget.target : 0,
      max: typeof budget.max === "number" ? budget.max : 0
    }
  };
}

export function readAuthorStance(plan: unknown): AuthorStance | null {
  if (!isRecord(plan) || !isRecord(plan.authorStance)) return null;
  const stance = plan.authorStance;
  if (typeof stance.thesis !== "string" || typeof stance.voiceSample !== "string") return null;
  return {
    thesis: stance.thesis,
    positions: strings(stance.positions),
    refusals: strings(stance.refusals),
    voiceSample: stance.voiceSample
  };
}

function StrategyLine(props: { strategy: ResolvedGenerationStrategy }) {
  const { strategy } = props;
  return (
    <p className="composition-strategy">
      <strong>{strategy.label}</strong>
      <span className={`pipeline-chip pipeline-chip-${strategy.pipeline}`}>
        {strategy.pipeline === "composed" ? "Composed chapters" : "Per-page pipeline"}
      </span>
      <span className="muted admin-subtle">
        <code>{strategy.id}</code> · {strategy.autoSelected ? "chosen by Auto" : `chosen explicitly (${strategy.requestedId})`}
        {strategy.switched ? " · switched from the requested strategy" : ""}
      </span>
      {strategy.warnings.map((warning) => (
        <span key={warning} className="composition-warning">{warning}</span>
      ))}
    </p>
  );
}

export function CompositionSection(props: { details: ProjectDetails | null }) {
  const [openChapter, setOpenChapter] = useState<number | null>(null);
  const [showSample, setShowSample] = useState(false);
  const details = props.details;
  if (!details?.resolvedStrategy) return null;
  const stance = readAuthorStance(details.currentPlan?.planningPackage);
  const chapters = (details.chapters ?? [])
    .map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      targetPages: chapter.targetPages,
      composition: readChapterComposition(chapter.productionBrief),
      report: readChapterReport(chapter.productionBrief)
    }))
    .filter((chapter) => chapter.composition !== null);
  const formPlan = chapters.find((chapter) => chapter.report)?.report;

  return (
    <section className="work-section composition-section">
      <div className="section-title">
        <BookOpenText size={18} aria-hidden />
        <h3>How this book is written</h3>
      </div>
      <StrategyLine strategy={details.resolvedStrategy} />
      {details.resolvedStrategy.pipeline !== "composed" ? (
        <p className="muted">
          Written page by page from a page map. The per-page rows on the Quality tab govern it; the composition
          details below only exist for composed books.
        </p>
      ) : null}

      {stance ? (
        <div className="composition-stance">
          <h4>Author stance</h4>
          <p><b>Thesis</b> {stance.thesis}</p>
          {stance.positions.length > 0 ? (
            <div><b>Positions</b><ul>{stance.positions.map((position) => <li key={position}>{position}</li>)}</ul></div>
          ) : null}
          {stance.refusals.length > 0 ? (
            <div><b>Refuses</b><ul>{stance.refusals.map((refusal) => <li key={refusal}>{refusal}</li>)}</ul></div>
          ) : null}
          <button type="button" className="admin-linkish" onClick={() => setShowSample((current) => !current)}>
            {showSample ? "Hide voice sample" : "Show voice sample"}
          </button>
          {showSample ? <blockquote className="composition-voice-sample">{stance.voiceSample}</blockquote> : null}
        </div>
      ) : details.resolvedStrategy.pipeline === "composed" ? (
        <p className="muted">No author stance recorded yet; the pass writes one onto the plan when it starts.</p>
      ) : null}

      {formPlan ? (
        <p className="muted">
          Form plan: {formPlan.formPlanSource}
          {formPlan.formPlanIssues.length > 0
            ? ` · ${formPlan.formPlanIssues.length} variety issue${formPlan.formPlanIssues.length === 1 ? "" : "s"} kept`
            : " · variety check passed"}
        </p>
      ) : null}

      {chapters.length > 0 ? (
        <div className="admin-table-scroll">
          <table className="admin-table composition-table">
            <thead>
              <tr>
                <th>Chapter</th>
                <th>Forms</th>
                <th className="numeric">Pages</th>
                <th className="numeric">Draft → edited words</th>
                <th>Editor</th>
                <th className="numeric">¶ length CV</th>
                <th>Read</th>
              </tr>
            </thead>
            <tbody>
              {chapters.map((chapter) => {
                const composition = chapter.composition!;
                const report = chapter.report;
                const open = openChapter === chapter.index;
                return (
                  <tr key={chapter.index} className={open ? "is-open" : ""} onClick={() => setOpenChapter(open ? null : chapter.index)}>
                    <td>
                      <span className="cost-name">{chapter.index}. {chapter.title}</span>
                      {open ? (
                        <div className="composition-detail">
                          <p><b>Through-line</b> {composition.throughLine}</p>
                          <ol>
                            {composition.sections.map((section, index) => (
                              <li key={index}>
                                <code>{section.form}</code>
                                {section.share !== undefined ? <span className="muted admin-subtle"> {Math.round(section.share * 100)}%</span> : null}
                                {" "}{section.subject}
                                {section.owns && section.owns.length > 0 ? <small> owns: {section.owns.join("; ")}</small> : null}
                              </li>
                            ))}
                          </ol>
                          <p><b>Landing</b> {composition.landing}</p>
                          {report && report.readNotes.length > 0 ? (
                            <div><b>Manuscript read notes</b><ul>{report.readNotes.map((note) => <li key={note}>{note}</li>)}</ul></div>
                          ) : null}
                          {report && report.formPlanIssues.length > 0 ? (
                            <div><b>Form-plan issues kept</b><ul>{report.formPlanIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className="composition-forms">
                        {composition.sections.map((section, index) => <code key={index}>{section.form}</code>)}
                      </span>
                    </td>
                    <td className="numeric">{chapter.targetPages}</td>
                    <td className="numeric">
                      {report ? `${report.draftWords} → ${report.editedWords}` : "—"}
                      {report && report.wordBudget.target ? <small className="muted admin-subtle"> of {report.wordBudget.target}</small> : null}
                    </td>
                    <td>{report ? (report.editorChanged ? "changed" : "kept draft") : "—"}</td>
                    <td className="numeric">
                      {report?.paragraphCv !== null && report?.paragraphCv !== undefined ? report.paragraphCv.toFixed(2) : "—"}
                      {report?.shapePassApplied ? <small className="muted admin-subtle"> reshaped</small> : null}
                    </td>
                    <td>
                      {report
                        ? report.readNotes.length === 0
                          ? "no notes"
                          : `${report.readNotes.length} note${report.readNotes.length === 1 ? "" : "s"}${report.secondEditApplied ? ", re-edited" : ""}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
