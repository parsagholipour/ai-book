/**
 * Pure reads of a report's `targetSnapshot` for the AI-output report kinds:
 * a chat reply (book chat or creation chat), a book plan, a drawn picture of a
 * saved character, and a Writing Studio suggestion. The snapshots are written
 * by `apps/api/src/mobileSafety.ts` and `apps/api/src/aiOutputReports.ts`.
 *
 * The column is JSON and a row can predate a field, so every field is read
 * defensively — a malformed snapshot renders as "nothing recorded", never as a
 * crash in the middle of the queue (the same rule `shareModeration.ts` keeps).
 */

export type ChatReplySnapshot = {
  kind: "chat_reply";
  /** The creation chat's label; null for a book-chat reply, which has its book's title. */
  chatTitle: string | null;
  asked: string | null;
  reply: string | null;
  question: { prompt: string; options: string[] } | null;
  quickReplies: string[];
  sources: Array<{ title: string; url: string | null }>;
};

export type PlanSnapshot = {
  kind: "plan";
  title: string | null;
  subtitle: string | null;
  premise: string | null;
  audience: string | null;
  version: number | null;
  chapters: Array<{ index: number | null; title: string; summary: string }>;
  questions: Array<{ prompt: string; options: string[] }>;
};

export type CharacterPictureSnapshot = {
  kind: "character_picture";
  characterName: string | null;
  description: string | null;
  appearance: string | null;
  drawnAt: string | null;
  rewrittenPrompt: string | null;
};

export type StudioSuggestion =
  | { type: "text"; text: string }
  | { type: "image"; alt: string | null }
  | { type: "notes"; notes: Array<{ quote: string | null; note: string }> }
  | { type: "outline"; chapters: Array<{ title: string; notes: string }> };

export type StudioSuggestionSnapshot = {
  kind: "studio_suggestion";
  /** "stored": read from the server's own row. "app": the text the app said it showed. */
  origin: "stored" | "app" | null;
  assistKind: string | null;
  status: string | null;
  request: Array<{ label: string; text: string }>;
  suggestion: StudioSuggestion | null;
};

export type ReportSnapshot = ChatReplySnapshot | PlanSnapshot | CharacterPictureSnapshot | StudioSuggestionSnapshot;

/** The snapshot of an AI-output report, or null for a kind this screen renders elsewhere (or not at all). */
export function readReportSnapshot(targetType: string, value: unknown): ReportSnapshot | null {
  const record = asRecord(value) ?? {};
  switch (targetType) {
    case "chat_message":
    case "creation_chat_message":
      return readChatReply(record);
    case "book_plan":
      return readPlan(record);
    case "character_image":
      return {
        kind: "character_picture",
        characterName: text(record.characterName),
        description: text(record.description),
        appearance: text(record.appearance),
        drawnAt: text(record.drawnAt),
        rewrittenPrompt: text(record.rewrittenPrompt)
      };
    case "studio_suggestion":
      return readStudioSuggestion(record);
    default:
      return null;
  }
}

/** Whether the operator picture route can serve this report's picture. */
export function reportHasPicture(snapshot: ReportSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.kind === "character_picture") return true;
  return snapshot.kind === "studio_suggestion" && snapshot.suggestion?.type === "image";
}

/** `GET /api/admin/moderation/reports/:id/picture` — reads only the file the report's own snapshot names. */
export function reportPicturePath(reportId: string): string {
  return `/api/admin/moderation/reports/${encodeURIComponent(reportId)}/picture`;
}

const STUDIO_REQUEST_LABELS: Array<[key: string, label: string]> = [
  ["instruction", "Author asked"],
  ["prompt", "Picture asked for"],
  ["notes", "Author's notes"],
  ["passage", "Passage"],
  ["selection", "Selected text"]
];

function readChatReply(record: Record<string, unknown>): ChatReplySnapshot {
  const question = asRecord(record.question);
  const prompt = text(question?.prompt);
  return {
    kind: "chat_reply",
    chatTitle: text(record.chatTitle),
    asked: text(record.asked),
    reply: text(record.reply),
    question: prompt ? { prompt, options: strings(question?.options) } : null,
    quickReplies: strings(record.quickReplies),
    sources: list(record.researchSources)
      .map((entry) => {
        const source = asRecord(entry);
        const title = text(source?.title);
        return title ? { title, url: httpUrl(source?.url) } : null;
      })
      .filter((source): source is { title: string; url: string | null } => source !== null)
  };
}

function readPlan(record: Record<string, unknown>): PlanSnapshot {
  return {
    kind: "plan",
    title: text(record.title),
    subtitle: text(record.subtitle),
    premise: text(record.premise),
    audience: text(record.audience),
    version: typeof record.version === "number" ? record.version : null,
    chapters: list(record.chapters).map((entry) => {
      const chapter = asRecord(entry);
      return {
        index: typeof chapter?.index === "number" ? chapter.index : null,
        title: text(chapter?.title) ?? "",
        summary: text(chapter?.summary) ?? ""
      };
    }),
    questions: list(record.questions)
      .map((entry) => {
        const question = asRecord(entry);
        const prompt = text(question?.prompt);
        return prompt ? { prompt, options: strings(question?.options) } : null;
      })
      .filter((question): question is { prompt: string; options: string[] } => question !== null)
  };
}

function readStudioSuggestion(record: Record<string, unknown>): StudioSuggestionSnapshot {
  const origin = record.origin === "stored" || record.origin === "app" ? record.origin : null;
  const request = asRecord(record.request) ?? {};
  return {
    kind: "studio_suggestion",
    origin,
    assistKind: text(record.assistKind),
    status: text(record.status),
    request: STUDIO_REQUEST_LABELS.flatMap(([key, label]) => {
      const value = text(request[key]);
      return value ? [{ label, text: value }] : [];
    }),
    suggestion: readSuggestion(asRecord(record.suggestion))
  };
}

function readSuggestion(record: Record<string, unknown> | null): StudioSuggestion | null {
  switch (record?.type) {
    case "text": {
      const value = text(record.text);
      return value ? { type: "text", text: value } : null;
    }
    case "image":
      return { type: "image", alt: text(record.alt) };
    case "notes":
      return {
        type: "notes",
        notes: list(record.notes)
          .map((entry) => {
            const note = asRecord(entry);
            const body = text(note?.note);
            return body ? { quote: text(note?.quote), note: body } : null;
          })
          .filter((note): note is { quote: string | null; note: string } => note !== null)
      };
    case "outline":
      return {
        type: "outline",
        chapters: list(record.chapters).map((entry) => {
          const chapter = asRecord(entry);
          return { title: text(chapter?.title) ?? "", notes: text(chapter?.notes) ?? "" };
        })
      };
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/** Only an http(s) link becomes an anchor; anything else stays text. */
function httpUrl(value: unknown): string | null {
  const url = text(value);
  return url && /^https?:\/\//i.test(url) ? url : null;
}
