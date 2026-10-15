import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { apiUrl } from "../../api.js";
import { dateTime, titleCase } from "./format.js";
import {
  readReportSnapshot,
  reportHasPicture,
  reportPicturePath,
  type CharacterPictureSnapshot,
  type ChatReplySnapshot,
  type PlanSnapshot,
  type StudioSuggestionSnapshot
} from "./reportSnapshots.js";
import type { ModerationReport } from "./types.js";

/**
 * What a reader reported, as it was when they reported it: a chat reply and
 * the message it answered, a plan as its card showed it, a drawn character
 * picture, or a Writing Studio suggestion. The snapshot is the evidence — the
 * chat may have branched, the plan been revised and the suggestion discarded
 * since — so it is rendered whole rather than linked to.
 *
 * Books, book pictures, voice calls and shares render elsewhere (or only as a
 * label); this returns nothing for them.
 */
export function ReportSnapshotView(props: { report: ModerationReport }) {
  const { report } = props;
  const snapshot = readReportSnapshot(report.targetType, report.targetSnapshot);
  if (!snapshot) return null;
  const picture = reportHasPicture(snapshot) ? (
    <ReportPicture reportId={report.id} alt={pictureAlt(snapshot)} />
  ) : null;
  return (
    <div className="report-snapshot">
      {snapshot.kind === "chat_reply" ? <ChatReply snapshot={snapshot} /> : null}
      {snapshot.kind === "plan" ? <Plan snapshot={snapshot} /> : null}
      {snapshot.kind === "character_picture" ? <CharacterPicture snapshot={snapshot} picture={picture} /> : null}
      {snapshot.kind === "studio_suggestion" ? <StudioSuggestion snapshot={snapshot} picture={picture} /> : null}
    </div>
  );
}

function ChatReply(props: { snapshot: ChatReplySnapshot }) {
  const { snapshot } = props;
  return (
    <>
      {snapshot.chatTitle ? <p className="muted">Creation chat · {snapshot.chatTitle}</p> : null}
      {snapshot.asked ? <TextBlock label="Reader asked" text={snapshot.asked} /> : null}
      {snapshot.reply ? <TextBlock label="AI replied" text={snapshot.reply} /> : <Nothing />}
      {snapshot.question ? (
        <TextBlock
          label="Question it asked"
          text={[snapshot.question.prompt, ...snapshot.question.options.map((option) => `• ${option}`)].join("\n")}
        />
      ) : null}
      {snapshot.quickReplies.length > 0 ? (
        <TextBlock label="Suggested replies" text={snapshot.quickReplies.map((option) => `• ${option}`).join("\n")} />
      ) : null}
      {snapshot.sources.length > 0 ? (
        <figure className="share-note">
          <figcaption>Web sources it cited</figcaption>
          <ul className="report-snapshot-list">
            {snapshot.sources.map((source, index) => (
              <li key={`${source.title}-${index}`}>
                {source.url ? (
                  <a className="share-link" href={source.url} target="_blank" rel="noreferrer noopener">
                    {source.title} <ExternalLink size={12} aria-hidden />
                  </a>
                ) : (
                  source.title
                )}
              </li>
            ))}
          </ul>
        </figure>
      ) : null}
    </>
  );
}

function Plan(props: { snapshot: PlanSnapshot }) {
  const { snapshot } = props;
  const heading = [snapshot.title, snapshot.subtitle].filter(Boolean).join(" — ");
  return (
    <>
      <p className="muted">
        Book plan{snapshot.version !== null ? ` · version ${snapshot.version}` : ""}
        {heading ? ` · ${heading}` : ""}
      </p>
      {snapshot.premise ? <TextBlock label="Premise" text={snapshot.premise} /> : null}
      {snapshot.audience ? <TextBlock label="Audience" text={snapshot.audience} /> : null}
      {snapshot.chapters.length > 0 ? (
        <figure className="share-note">
          <figcaption>Chapters ({snapshot.chapters.length})</figcaption>
          <ol className="report-snapshot-list">
            {snapshot.chapters.map((chapter, index) => (
              <li key={`${chapter.index ?? index}-${chapter.title}`} dir="auto">
                <strong>{chapter.title || "Untitled chapter"}</strong>
                {chapter.summary ? <span> — {chapter.summary}</span> : null}
              </li>
            ))}
          </ol>
        </figure>
      ) : (
        <Nothing />
      )}
      {snapshot.questions.length > 0 ? (
        <TextBlock
          label="Questions it asked"
          text={snapshot.questions
            .map((question) => [question.prompt, ...question.options.map((option) => `  • ${option}`)].join("\n"))
            .join("\n")}
        />
      ) : null}
    </>
  );
}

function CharacterPicture(props: { snapshot: CharacterPictureSnapshot; picture: ReactNode }) {
  const { snapshot } = props;
  return (
    <>
      <p className="muted">
        Saved character · {snapshot.characterName ?? "unnamed"}
        {snapshot.drawnAt ? ` · drawn ${dateTime(snapshot.drawnAt)}` : ""}
      </p>
      {props.picture}
      {snapshot.description ? <TextBlock label="Reader's description" text={snapshot.description} /> : null}
      {snapshot.appearance ? <TextBlock label="Appearance" text={snapshot.appearance} /> : null}
      {snapshot.rewrittenPrompt ? (
        <TextBlock label="Prompt it was drawn from (rewritten after a refusal)" text={snapshot.rewrittenPrompt} />
      ) : null}
    </>
  );
}

function StudioSuggestion(props: { snapshot: StudioSuggestionSnapshot; picture: ReactNode }) {
  const { snapshot } = props;
  const suggestion = snapshot.suggestion;
  return (
    <>
      <p className="muted">
        Writing Studio · {titleCase(snapshot.assistKind ?? "suggestion")}
        {snapshot.status ? ` · ${snapshot.status}` : ""}
      </p>
      {snapshot.origin === "app" ? (
        <p className="report-snapshot-caveat">
          Sent by the app: the server keeps no copy of quick suggestions, so this is the text the app says it showed.
        </p>
      ) : null}
      {snapshot.request.map((entry) => (
        <TextBlock key={entry.label} label={entry.label} text={entry.text} />
      ))}
      {!suggestion ? <Nothing /> : null}
      {suggestion?.type === "text" ? <TextBlock label="AI suggested" text={suggestion.text} /> : null}
      {suggestion?.type === "image" ? (
        <>
          {props.picture}
          {suggestion.alt ? <TextBlock label="Caption" text={suggestion.alt} /> : null}
        </>
      ) : null}
      {suggestion?.type === "notes" ? (
        <figure className="share-note">
          <figcaption>AI notes ({suggestion.notes.length})</figcaption>
          <ul className="report-snapshot-list">
            {suggestion.notes.map((note, index) => (
              <li key={index} dir="auto">
                {note.quote ? <q>{note.quote}</q> : null} {note.note}
              </li>
            ))}
          </ul>
        </figure>
      ) : null}
      {suggestion?.type === "outline" ? (
        <figure className="share-note">
          <figcaption>AI outline ({suggestion.chapters.length} chapters)</figcaption>
          <ol className="report-snapshot-list">
            {suggestion.chapters.map((chapter, index) => (
              <li key={index} dir="auto">
                <strong>{chapter.title || "Untitled chapter"}</strong>
                {chapter.notes ? <span> — {chapter.notes}</span> : null}
              </li>
            ))}
          </ol>
        </figure>
      ) : null}
    </>
  );
}

/**
 * The reported picture, read through the operator route. It 404s once the
 * owner deleted the picture or their account, which is a fact worth saying
 * rather than a broken image.
 */
function ReportPicture(props: { reportId: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <p className="muted">The picture is no longer stored — the owner deleted it or their account.</p>;
  }
  return (
    <figure className="report-picture">
      <img src={apiUrl(reportPicturePath(props.reportId))} alt={props.alt} loading="lazy" onError={() => setMissing(true)} />
    </figure>
  );
}

function TextBlock(props: { label: string; text: string }) {
  return (
    <figure className="share-note">
      <figcaption>{props.label}</figcaption>
      <blockquote dir="auto">{props.text}</blockquote>
    </figure>
  );
}

function Nothing() {
  return <p className="muted">Nothing was recorded for this report.</p>;
}

function pictureAlt(snapshot: ReturnType<typeof readReportSnapshot>): string {
  if (snapshot?.kind === "character_picture") return `Reported picture of ${snapshot.characterName ?? "a saved character"}`;
  if (snapshot?.kind === "studio_suggestion" && snapshot.suggestion?.type === "image") {
    return snapshot.suggestion.alt ?? "Reported Writing Studio picture";
  }
  return "Reported picture";
}
