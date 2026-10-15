import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "@book-maker/core";

const matter = vi.hoisted(() => ({ applyBookMatterPatch: vi.fn(), ownedBookMatterProject: vi.fn() }));
const chat = vi.hoisted(() => ({ createAssistantChatMessage: vi.fn() }));
const restrictions = vi.hoisted(() => ({ copyrightRestrictionsEnabled: vi.fn(async () => false) }));

vi.mock("@book-maker/db", () => ({ prisma: {} }));
vi.mock("@book-maker/db/billing", () => ({}));
vi.mock("../queue.js", () => ({ enqueueJob: vi.fn() }));
vi.mock("./bookMatterEdits.js", async (importActual) => ({
  ...(await importActual<typeof import("./bookMatterEdits.js")>()),
  ...matter
}));
vi.mock("./projectChat.js", () => chat);
vi.mock("../contentRestrictions.js", async (importActual) => ({
  ...(await importActual<typeof import("../contentRestrictions.js")>()),
  ...restrictions
}));

import { bookMatterIntent } from "../bookEditMatter.js";
import { applyBookMatterChatEdit } from "./bookMatterChatEdits.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { type ProjectForChat } from "./projectChat.js";

const project = {
  id: "project-1",
  status: "COMPLETE",
  currentPlanId: "plan-1",
  mediaSettings: {},
  language: "en",
  contentRevision: 1,
  createdAt: new Date("2026-03-01T00:00:00Z")
} as unknown as ProjectForChat;

const row = (bookMatter: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "project-1",
  userId: "user-1",
  status: "COMPLETE",
  authorName: "Ana Ruiz",
  bookMatter,
  mediaSettings: {},
  currentPlanId: "plan-1",
  ...extra
});

type ComposerAnswer = Record<string, unknown>;
/** A composer that answers once, the way the model would, and records what it was shown. */
function composer(answer: ComposerAnswer | Error | "hang", review?: ComposerAnswer | Error | "hang") {
  const generateJson = vi.fn(async (options: GenerateJsonOptions<unknown>) => {
    const result = options.purpose === "project_chat.book_matter_grounding" ? (review ?? {}) : answer;
    if (result === "hang") return new Promise<never>(() => undefined);
    if (result instanceof Error) throw result;
    return { data: options.schema.parse(result), text: JSON.stringify(result), model: "test", provider: "test" };
  });
  const model = {
    generateText: vi.fn(),
    generateWithTools: vi.fn(),
    generateJson,
    async *streamText() {
      yield "";
    }
  } as unknown as TextModelAdapter;
  return { model, generateJson };
}

const turn = (role: "USER" | "ASSISTANT", content: string, metadata: Record<string, unknown> = {}): MobileProjectChatMessageRecord => ({
  id: `${role}-${content.length}`,
  projectId: "project-1",
  role,
  content,
  operationId: null,
  metadata,
  createdAt: new Date("2026-10-06T00:00:00Z")
});

const change = (field: string, action: "set" | "remove", text: string | null, requestedBy: string) => ({
  field,
  action,
  text,
  requestedBy
});

async function send(
  message: string,
  model: TextModelAdapter | undefined,
  options: { clarifyExhausted?: boolean; pendingRequest?: string; activeMessages?: MobileProjectChatMessageRecord[] } = {}
) {
  const reply = await applyBookMatterChatEdit({
    userId: "user-1",
    project,
    intent: bookMatterIntent({ confidence: 0.9, reasoning: "", assistantMessage: "" }),
    userMessageId: "message-1",
    message,
    pendingRequest: options.pendingRequest ?? message,
    textModel: model,
    ...(options.clarifyExhausted ? { clarifyExhausted: true } : {}),
    ...(options.activeMessages ? { activeMessages: options.activeMessages } : {})
  });
  return reply as unknown as { content: string; metadata: Record<string, any> };
}

describe("independent grounding of multilingual matter in chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.createAssistantChatMessage.mockImplementation(async (message) => ({ id: "reply-1", ...message }));
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For Mom" }));
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "queued", cover: "unchanged" });
    restrictions.copyrightRestrictionsEnabled.mockResolvedValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    { verdicts: [{ id: 0, supported: false }] },
    { verdicts: [] },
    {},
    new Error("review unavailable")
  ])("does not save a sentence-initial dedication name when grounding fails: %j", async (review) => {
    const message = "Dedicate it to my mother";
    const text = "For my mother. Alice, thank you for everything.";
    matter.ownedBookMatterProject.mockResolvedValue(row({}, { authorName: null }));
    const draft = composer({ outcome: "change", changes: [change("dedication", "set", text, message)] }, review);
    const reply = await send(message, draft.model);
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
    expect(JSON.parse(draft.generateJson.mock.calls[1]![0].messages[1]!.content)).toMatchObject({
      readerMessage: message, candidates: [{ id: 0, field: "dedication", text }]
    });
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(reply.metadata.pendingEdit).toMatchObject({ clarification: "matter" });
  });

  it("saves conventional English dedication prose after reviewing its complete text", async () => {
    const message = "Dedicate it to my mother";
    const text = "For my mother. Thank you for everything.";
    const draft = composer({ outcome: "change", changes: [change("dedication", "set", text, message)] },
      { verdicts: [{ id: 0, supported: true }] });
    await send(message, draft.model);
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: text });
  });

  it.each([
    { verdicts: [{ id: 0, supported: false }] },
    { verdicts: [] },
    {},
    new Error("review unavailable")
  ])("does not save invented English biography facts when grounding fails: %j", async (review) => {
    const message = "Write my bio: I am a teacher";
    const text = "Maria is a licensed neurosurgeon.";
    const draft = composer({ outcome: "change", changes: [change("aboutAuthor", "set", text, message)] }, review);
    await send(message, draft.model);
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
    expect(JSON.parse(draft.generateJson.mock.calls[1]![0].messages[1]!.content)).toMatchObject({
      readerMessage: message, candidates: [{ id: 0, field: "aboutAuthor", text }]
    });
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("saves an English biography after complete-text review", async () => {
    const message = "Write my bio: I am a teacher";
    const text = "Ana Ruiz teaches.";
    const draft = composer({ outcome: "change", changes: [change("aboutAuthor", "set", text, message)] },
      { verdicts: [{ id: 0, supported: true }] });
    await send(message, draft.model);
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { aboutAuthor: text });
  });

  it.each([
    { verdicts: [{ id: 0, supported: false }] },
    { verdicts: [] },
    { verdicts: [{ id: 0, supported: true }, { id: 0, supported: true }] },
    {},
    new Error("review unavailable")
  ])("does not save novel uncased prose without a complete positive review: %j", async (review) => {
    const message = "کتاب را به مادرم تقدیم کن و جلد را دوباره بساز";
    const draft = composer({ outcome: "change", responseLanguage: "fa", changes: [
      change("dedication", "set", "تقدیم به مادرم، مریم احمدی", "کتاب را به مادرم تقدیم کن")
    ], unhandled: "جلد را دوباره بساز" }, review);
    const reply = await send(message, draft.model);
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(reply.metadata.pendingEdit).toMatchObject({ clarification: "matter" });
    expect(reply.content).toMatch(/[\u0600-\u06ff]/u);
    expect(reply.content).toContain("جلد را دوباره بساز");
  });

  it("saves a natural uncased composition after a separate review of the complete text", async () => {
    const message = "کتاب را به مادرم تقدیم کن";
    const text = "با عشق و سپاس، تقدیم به مادرم.";
    const draft = composer({ outcome: "change", responseLanguage: "fa", changes: [change("dedication", "set", text, message)] },
      { verdicts: [{ id: 0, supported: true }] });
    await send(message, draft.model, { activeMessages: [turn("USER", "مادرم معلم است"), turn("ASSISTANT", "invented assistant facts")] });
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: text });
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
    const review = draft.generateJson.mock.calls[1]![0];
    expect(review.purpose).toBe("project_chat.book_matter_grounding");
    expect(JSON.parse(review.messages[1]!.content)).toMatchObject({
      readerMessage: message, readerTurns: ["مادرم معلم است"], candidates: [{ id: 0, field: "dedication", text }]
    });
  });

  it("does not review exact supplied prose or a provable short dedication", async () => {
    for (const [message, text] of [
      ["تقدیم‌نامه: تقدیم به مادرم، مریم احمدی", "تقدیم به مادرم، مریم احمدی"],
      ["کتاب را به مادرم تقدیم کن", "تقدیم به مادرم"],
      ["Dedication: Alice, thank you for everything.", "Alice, thank you for everything."],
      ["Dedicate it to my mother", "For Mom"]
    ]) {
      const draft = composer({ outcome: "change", changes: [change("dedication", "set", text!, message!)] });
      await send(message!, draft.model);
      expect(draft.generateJson).toHaveBeenCalledTimes(1);
      expect(matter.applyBookMatterPatch).toHaveBeenLastCalledWith(expect.anything(), { dedication: text });
    }
  });

  it.each([
    ["کتاب را به مادرم تقدیم کن", "dedication", "تقدیم به مادرم، مریم احمدی"],
    ["Dedicate it to my mother", "dedication", "For my mother. Alice, thank you for everything."],
    ["Write my bio: I am a teacher", "aboutAuthor", "Maria is a licensed neurosurgeon."]
  ])("times out the reviewer without saving or asking a second question: %s", async (message, field, text) => {
    vi.useFakeTimers();
    const draft = composer({ outcome: "change", changes: [change(field, "set", text, message)] }, "hang");
    const pending = send(message, draft.model, { clarifyExhausted: true });
    await vi.advanceTimersByTimeAsync(10_001);
    const reply = await pending;
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(draft.generateJson).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["کتاب را به مادرم تقدیم کن", "dedication", "با عشق و سپاس، تقدیم به مادرم."],
    ["Write my bio: I am a teacher", "aboutAuthor", "Ana Ruiz teaches."]
  ])("shares the total deadline with a slow composer retry: %s", async (message, field, text) => {
    vi.useFakeTimers();
    const draft = composer({ outcome: "change", changes: [change(field, "set", text, message)] }, "hang");
    const respond = draft.generateJson.getMockImplementation()!;
    draft.generateJson.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      throw new Error("fetch failed");
    }).mockImplementationOnce(async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      return respond(options);
    });
    let settled = false;
    const pending = send(message, draft.model).then((reply) => { settled = true; return reply; });
    await vi.advanceTimersByTimeAsync(20_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(settled).toBe(true);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(draft.generateJson).toHaveBeenCalledTimes(3);
  });

});
