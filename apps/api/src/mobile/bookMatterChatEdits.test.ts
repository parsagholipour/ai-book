import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationLanguage, GenerateJsonOptions, TextModelAdapter } from "@book-maker/core";

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
import { chatMarkdownLiteral } from "../chatMarkdownLiteral.js";
import { chatMessagePlainText } from "../chatMessagePlainText.js";
import {
  applyBookMatterChatEdit,
  BOOK_MATTER_COMPOSE_FAILED,
  matterFieldsOfLastReply,
  SEPARATE_REQUEST_NOTE,
  TITLE_PAGE_ANSWER,
  TITLE_PAGE_KEPT
} from "./bookMatterChatEdits.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { BookMatterRefusal } from "./bookMatterEdits.js";
import { type ProjectForChat } from "./projectChat.js";

/**
 * The matter edit's apply side: the composer is mocked to answer what a good
 * model would, and every assertion is about what reaches
 * `applyBookMatterPatch` — the one write — and what the chat says. The review
 * that prompted it showed the old regex printing "For mention my sister too",
 * the tail of a compound request, "For a poem", and deleting a whole dedication
 * for "remove my ex's name from the dedication".
 */
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
function composer(answer: ComposerAnswer | Error | "hang", review?: ComposerAnswer) {
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
  const shown = () => JSON.parse(generateJson.mock.calls[0]![0].messages.at(-1)!.content);
  return { model, generateJson, shown };
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
  options: { responseLanguage?: ConversationLanguage; clarifyExhausted?: boolean; pendingRequest?: string; activeMessages?: MobileProjectChatMessageRecord[] } = {}
) {
  const reply = await applyBookMatterChatEdit({
    userId: "user-1",
    project,
    intent: bookMatterIntent({ confidence: 0.9, reasoning: "", assistantMessage: "", ...(options.responseLanguage ? { responseLanguage: options.responseLanguage } : {}) }),
    userMessageId: "message-1",
    message,
    pendingRequest: options.pendingRequest ?? message,
    textModel: model,
    ...(options.clarifyExhausted ? { clarifyExhausted: true } : {}),
    ...(options.activeMessages ? { activeMessages: options.activeMessages } : {})
  });
  return reply as unknown as { content: string; metadata: Record<string, any> };
}

describe("a matter change composed in the chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.createAssistantChatMessage.mockImplementation(async (message) => ({ id: "reply-1", ...message }));
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For Mom" }));
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "queued", cover: "unchanged" });
    restrictions.copyrightRestrictionsEnabled.mockResolvedValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["da", "Skift dedikationen til", "Færdig"],
    ["nl", "Verander de opdracht in", "Klaar"],
    ["el", "Άλλαξε την αφιέρωση σε", "Έγινε"],
    ["he", "שנה את ההקדשה ל", "בוצע"],
    ["no", "Endre dedikasjonen til", "Ferdig"],
    ["pl", "Zmień dedykację na", "Gotowe"],
    ["sv", "Ändra dedikationen till", "Klart"],
    ["th", "เปลี่ยนคำอุทิศเป็น", "เรียบร้อย"],
    ["uk", "Зміни присвяту на", "Готово"],
    ["vi", "Đổi lời đề tặng thành", "Đã xong"],
    ["ar", "غيّر الإهداء إلى", "تم"],
    ["zh", "请把献辞改为", "已完成"],
    ["fr", "Change la dédicace pour", "Terminé"],
    ["de", "Ändere die Widmung zu", "Erledigt"],
    ["hi", "समर्पण बदलें", "हो गया"],
    ["it", "Cambia la dedica in", "Fatto"],
    ["ja", "献辞を変更してください", "完了"],
    ["ko", "헌사를 변경해주세요", "완료"],
    ["fa", "تقدیم‌نامه را تغییر بده به", "انجام شد"],
    ["pt", "Altere a dedicatória para", "Concluído"],
    ["ru", "Измени посвящение на", "Готово"],
    ["es", "Cambia la dedicatoria a", "Hecho"],
    ["tr", "İthafı değiştir", "Tamamlandı"],
    ["ur", "انتساب تبدیل کریں", "ہو گیا"]
  ])("confirms a %s request in its conversation language, preserving literal printed words", async (language, request, done) => {
    const text = "For *Mom* — {field} {value}";
    const message = `${request} “${text}”`;
    const reply = await send(message, composer({ outcome: "change", responseLanguage: language, changes: [change("dedication", "set", text, message)] }).model);
    expect(reply.content).toMatch(new RegExp(`^${done}`));
    expect(chatMessagePlainText(reply.content)).toContain(`“${text}”`);
    expect(reply.content).not.toContain("This one’s free");
    expect(reply.metadata).toMatchObject({ charged: false, replyLanguage: language, bookMatterEdit: { after: { dedication: text } } });
    expect(reply.metadata.pendingEdit).toBeUndefined();
  });

  it("keeps an English conversation in English when the book is Persian", async () => {
    const message = "change the dedication to For Mom";
    const reply = await applyBookMatterChatEdit({
      userId: "user-1", project: { ...project, language: "fa" },
      intent: bookMatterIntent({ confidence: 0.9, reasoning: "", assistantMessage: "تقدیم‌نامه را تغییر می‌دهم." }),
      userMessageId: "message-1", message, pendingRequest: message,
      textModel: composer({ outcome: "change", changes: [change("dedication", "set", "For Mom", message)] }).model
    });
    expect(reply.content).toMatch(/^Done —/);
  });

  it.each([
    ["he", "לא הצלחתי לבצע"], ["th", "ตอนนี้ยังเปลี่ยนแปลงไม่ได้"], ["nl", "Ik kon de wijziging nu niet uitvoeren"]
  ] as const)("retains a saved %s conversation during a composer outage", async (responseLanguage, expected) => {
    const reply = await send("김민수", undefined, {
      activeMessages: [turn("ASSISTANT", "Previous reply", { replyLanguage: responseLanguage })]
    });
    expect(reply.metadata.replyLanguage).toBe(responseLanguage);
    expect(reply.content).toContain(expected);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("localizes a composer outage without another model call", async () => {
    const reply = await send("تقدیم‌نامه را تغییر بده", undefined, { responseLanguage: "fa" });
    expect(reply.content).toContain("نتوانستم");
    expect(reply.content).not.toContain("I couldn’t");
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("localizes a refusal after the one question is spent, keeping it a statement", async () => {
    const message = "شابک را به 123 تغییر بده";
    const reply = await send(message, composer({ outcome: "change", responseLanguage: "fa", changes: [change("isbn", "set", "123", message)] }).model, { clarifyExhausted: true });
    expect(reply.content).toContain("معتبر");
    expect(reply.content).not.toMatch(/[?؟]/);
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it.each([
    ["نام نویسنده را تغییر بده", "سارا احمدی", "انجام شد", "fa"],
    ["change the author name", "김민수", "Done —", "en"],
    ["Change la dédicace", "For Mom", "Terminé", "fr"]
  ])("retains the conversation language for a bare printed-value follow-up to %j", async (original, value, done, language) => {
    const field = original.includes("dédicace") ? "dedication" : "authorName";
    const reply = await send(value, composer({ outcome: "change", changes: [change(field, "set", value, value)] }).model, {
      clarifyExhausted: true, pendingRequest: original,
      activeMessages: [turn("USER", original), turn("ASSISTANT", "What should it say?", { replyLanguage: language })]
    });
    expect(reply.content).toMatch(new RegExp(`^${done}`));
    expect(reply.metadata.bookMatterEdit.after).toEqual({ [field]: value });
    expect(reply.metadata.pendingEdit).toBeUndefined();
  });

  it("keeps quoted foreign text out of reply-language selection", async () => {
    const value = "献给我的母亲";
    const message = `Please make the dedication “${value}”`;
    const reply = await send(message, composer({ outcome: "change", changes: [change("dedication", "set", value, message)] }).model);
    expect(reply.content).toMatch(/^Done —/);
    expect(chatMessagePlainText(reply.content)).toContain(`“${value}”`);
  });

  it("uses the composer's conversation language for a terse request, not its claimed outcome", async () => {
    const message = "Pon Ana en la firma";
    const model = composer({
      outcome: "change", responseLanguage: "es", changes: [change("authorName", "set", "Ana", message)],
      assistantMessage: "The cover was redrawn and I charged you."
    });
    const reply = await send(message, model.model);
    expect(reply.content).toMatch(/^Hecho/);
    expect(reply.metadata.replyLanguage).toBe("es");
    expect(reply.metadata.bookMatterEdit.after).toEqual({ authorName: "Ana" });
    expect(reply.content).not.toContain("charged");
    expect(model.generateJson).toHaveBeenCalledOnce();
  });

  it("keeps a quoted foreign name in a terse follow-up and follows the conversation instead of the book", async () => {
    const value = "김민수";
    const reply = await applyBookMatterChatEdit({
      userId: "user-1", project: { ...project, language: "ja" },
      intent: bookMatterIntent({ confidence: 0.9, reasoning: "", assistantMessage: "I can change that." }),
      userMessageId: "message-1", message: `“${value}”`, pendingRequest: "Pon el nombre del autor",
      clarifyExhausted: true,
      activeMessages: [turn("USER", "Pon el nombre del autor"), turn("ASSISTANT", "¿Qué nombre debe aparecer?")],
      textModel: composer({ outcome: "change", responseLanguage: "es", changes: [change("authorName", "set", value, `“${value}”`)] }).model
    });
    expect(reply.content).toMatch(/^Hecho/);
    expect(chatMessagePlainText(reply.content)).toContain(`“${value}”`);
    expect(reply.metadata).toMatchObject({ charged: false, replyLanguage: "es", bookMatterEdit: { after: { authorName: value } } });
  });

  it("retains composer language for a normalized refusal and an informational answer", async () => {
    const invalid = await send("Pon 123 en esa línea", composer({
      outcome: "change", responseLanguage: "es", changes: [change("isbn", "set", "123", "Pon 123 en esa línea")]
    }).model, { clarifyExhausted: true });
    expect(invalid.content).toContain("ISBN no es válido");
    expect(invalid.metadata.replyLanguage).toBe("es");
    expect(invalid.metadata.pendingEdit).toBeUndefined();
    expect(invalid.content).not.toMatch(/[?¿]/);
    const none = await send("Esa línea no", composer({ outcome: "none", responseLanguage: "es", noneReason: "copyright_line" }).model);
    expect(none.content).toContain("La línea ©");
    expect(none.metadata.replyLanguage).toBe("es");
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("uses the saved outcome for a localized no-op and a rejected save", async () => {
    const message = "Pon Ana en la firma";
    const answer = { outcome: "change", responseLanguage: "es", changes: [change("authorName", "set", "Ana", message)] };
    matter.applyBookMatterPatch.mockResolvedValueOnce({ reprint: "none", cover: "unchanged" });
    const unchanged = await send(message, composer(answer).model);
    expect(unchanged.content).toMatch(/^Nada ha cambiado/);
    expect(unchanged.content).not.toContain("exportación");
    matter.applyBookMatterPatch.mockRejectedValueOnce(new BookMatterRefusal("PROJECT_BUSY", "Book is busy"));
    const rejected = await send(message, composer(answer).model);
    expect(rejected.content).toContain("actualizando");
    expect(rejected.content).not.toContain("Hecho");
    expect(rejected.metadata.bookMatterEdit).toBeUndefined();
    expect(rejected.metadata.pendingEdit).toBeUndefined();
  });

  it("keeps an established language during an outage on a bare foreign-name follow-up", async () => {
    const reply = await send("김민수", undefined, {
      activeMessages: [turn("USER", "Pon Ana en la firma"), turn("ASSISTANT", "Hecho", { replyLanguage: "es" })]
    });
    expect(reply.content).toContain("No pude hacer el cambio");
    expect(reply.metadata.replyLanguage).toBe("es");
    expect(reply.metadata.bookMatterEdit).toBeUndefined();
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("ignores an invalid locale hint without losing a valid saved change", async () => {
    const message = "Change la dédicace pour “For Mom”";
    const reply = await send(message, composer({
      outcome: "change", responseLanguage: "French", changes: [change("dedication", "set", "For Mom", message)]
    }).model, { responseLanguage: "fr" });
    expect(reply.content).toMatch(/^Terminé/);
    expect(reply.metadata.bookMatterEdit.after).toEqual({ dedication: "For Mom" });
  });

  it("reports the committed export and legacy-cover outcome in the conversation language", async () => {
    const message = "نام نویسنده را به سارا احمدی تغییر بده";
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "next_compile", cover: "keeps_old_name" });
    const reply = await send(message, composer({ outcome: "change", responseLanguage: "fa", changes: [change("authorName", "set", "سارا احمدی", message)] }).model);
    expect(reply.content).toContain("جلد نام قبلی");
    expect(reply.content).toContain("هنگام آماده‌سازی");
    expect(reply.content).toContain("رایگان");
    expect(reply.content).not.toContain("تازه می‌کنم");
  });

  it("localizes an unchanged save without promising a reprint", async () => {
    const message = "تقدیم‌نامه را به For Mom تغییر بده";
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "none", cover: "unchanged" });
    const reply = await send(message, composer({ outcome: "change", responseLanguage: "fa", changes: [change("dedication", "set", "For Mom", message)] }).model);
    expect(reply.content).toMatch(/^چیزی تغییر نکرد/);
    expect(reply.content).not.toContain("فایل‌های خروجی");
  });

  it("localizes informational and remainder notices while preserving the user's quoted remainder", async () => {
    const message = "صفحهٔ عنوان را حذف کن. Also redo the cover.";
    const reply = await send(message, composer({ outcome: "none", responseLanguage: "fa", noneReason: "title_page", unhandled: "Also redo the cover." }).model);
    expect(reply.content).toContain("هر کتاب صفحهٔ عنوانش");
    expect(reply.content).toContain("تغییر جداگانه‌ای");
    expect(chatMessagePlainText(reply.content)).toContain("“Also redo the cover.”");
    expect(reply.metadata.unhandledRequest).toBe("Also redo the cover.");
  });

  it("edits the dedication it was shown, rather than printing the request", async () => {
    const message = "change the dedication to mention my sister too";
    const { model, shown } = composer({
      outcome: "change",
      changes: [change("dedication", "set", "For Mom and my sister", message)]
    }, { verdicts: [{ id: 0, supported: true }] });
    const reply = await send(message, model);

    expect(shown()).toMatchObject({ readerMessage: message, currentMatter: { dedication: "For Mom", authorName: "Ana Ruiz" } });
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(row({ dedication: "For Mom" }), { dedication: "For Mom and my sister" });
    expect(reply.content).toBe(
      "Done — the dedication now reads “For Mom and my sister”. I’m refreshing the exports. This one’s free."
    );
    expect(reply.metadata).toMatchObject({
      charged: false,
      intent: { kind: "book_matter" },
      bookMatterEdit: { before: { dedication: "For Mom" }, after: { dedication: "For Mom and my sister" } }
    });
    expect(reply.metadata.editProposal).toBeUndefined();
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(reply.content).not.toMatch(/credit/i);
  });

  it("applies the dedication of a compound request and says the rest needs its own message", async () => {
    for (const [message, rest] of [
      ["dedicate it to my mom and redo the cover", "redo the cover"],
      ["Dedicate it to my mom. Also, make page 2 shorter", "make page 2 shorter"]
    ] as const) {
      matter.applyBookMatterPatch.mockClear();
      const { model } = composer({
        outcome: "change",
        changes: [change("dedication", "set", "For my mom", "dedicate it to my mom")],
        unhandled: rest
      });
      const reply = await send(message, model);
      expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: "For my mom" });
      expect(reply.content).toBe(
        `Done — the dedication now reads “For my mom”. I’m refreshing the exports. This one’s free. “${rest}” is a separate change — send it as its own message and I’ll take care of it.`
      );
      expect(reply.metadata.unhandledRequest).toBe(rest);
    }
  });

  it("still says the rest needs its own message when the composer paraphrased it or never reported it", async () => {
    const said = `Done — the dedication now reads “For my mom”. I’m refreshing the exports. This one’s free. ${SEPARATE_REQUEST_NOTE}`;
    // The model's paraphrase is not quoted back as if the reader had written it.
    const paraphrased = await send(
      "Dedicate it to my mom. Also, make page 2 shorter",
      composer({
        outcome: "change",
        changes: [change("dedication", "set", "For my mom", "Dedicate it to my mom")],
        unhandled: "shorten the second page"
      }).model
    );
    expect(paraphrased.content).toBe(said);
    expect(paraphrased.content).not.toContain("shorten the second page");
    expect(paraphrased.metadata).toMatchObject({ unhandledRequestUnquoted: true });
    expect(paraphrased.metadata.unhandledRequest).toBeUndefined();
    // Code finds the second request the model left out.
    const omitted = await send(
      "dedicate it to my mom and regenerate the cover",
      composer({ outcome: "change", changes: [change("dedication", "set", "For my mom", "dedicate it to my mom")] }).model
    );
    expect(omitted.content).toBe(said);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: "For my mom" });
    // A single request gets no such sentence.
    const single = await send(
      "dedicate it to my mom",
      composer({ outcome: "change", changes: [change("dedication", "set", "For my mom", "dedicate it to my mom")] }).model
    );
    expect(single.content).not.toContain(SEPARATE_REQUEST_NOTE);
  });

  it("names the left-over when it asks its question, refuses, or answers without the composer", async () => {
    const message = "replace the dedication with a poem and redo the cover";
    const quoted = await send(
      message,
      composer({ outcome: "question", question: "Which poem should it be?", unhandled: "redo the cover" }).model
    );
    expect(quoted.content).toBe(
      "Which poem should it be? “redo the cover” is a separate change — send it as its own message and I’ll take care of it."
    );
    expect(quoted.metadata).toMatchObject({ unhandledRequest: "redo the cover", pendingEdit: { request: message, clarification: "matter" } });

    const generic = await send(message, composer({ outcome: "question", question: "Which poem should it be?" }).model);
    expect(generic.content).toBe(`Which poem should it be? ${SEPARATE_REQUEST_NOTE}`);

    const second = await send(message, composer({ outcome: "question", question: "Which poem?" }).model, { clarifyExhausted: true });
    expect(second.content).toMatch(new RegExp(`^I still couldn’t tell what to print there\\..*${SEPARATE_REQUEST_NOTE}$`));

    const refused = await send(
      "add an ISBN and redo the cover",
      composer({ outcome: "change", changes: [change("isbn", "set", "978-0-306-40615-7", "add an ISBN")], unhandled: "redo the cover" }).model
    );
    expect(refused.content).toMatch(/^I only print what you tell me, .*“redo the cover” is a separate change/);

    // The model printed the other request as part of the dedication: refused, said why, and still named back.
    const runOn = await send(
      "Add a dedication: For my mom. Also redo the cover.",
      composer({ outcome: "change", changes: [change("dedication", "set", "For my mom. Also redo the cover.", "Add a dedication")] }).model
    );
    expect(runOn.content).toBe(
      `Part of what I’d have printed as the dedication was your other request, so I left the dedication as it was. What should the dedication say, on its own? ${SEPARATE_REQUEST_NOTE}`
    );

    // Answered before any composer call, so code alone notices the second request.
    const { model: unused, generateJson } = composer({ outcome: "none" });
    const titlePage = await send("Remove the title page. Also redo the cover.", unused);
    expect(generateJson).not.toHaveBeenCalled();
    expect(titlePage.content).toBe(`${TITLE_PAGE_ANSWER} ${SEPARATE_REQUEST_NOTE}`);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("applies only what the reader's words asked for, in any language", async () => {
    // The review's probe: a Persian dedication request whose answer also switched on
    // "All rights reserved" and deleted the biography, neither of them quoted.
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For Mom", aboutAuthor: "Ana Ruiz writes." }));
    const persian = "تقدیم‌نامه را به مادرم تقدیم کن";
    await send(
      persian,
      composer({
        outcome: "change",
        changes: [
          change("dedication", "set", "تقدیم به مادرم", persian),
          { field: "allRightsReserved", action: "set", text: null },
          { field: "aboutAuthor", action: "remove", text: null, requestedBy: "" }
        ]
      }).model
    );
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: "تقدیم به مادرم" });

    matter.applyBookMatterPatch.mockClear();
    const holder = "change the copyright holder to Sam Lee";
    await send(
      holder,
      composer({ outcome: "change", changes: [change("copyrightHolder", "set", "Sam Lee", holder), change("allRightsReserved", "set", null, holder)] }).model
    );
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { copyrightHolder: "Sam Lee" });
  });

  it("refuses a website or a name the reader never gave", async () => {
    const site = await send(
      "add my website — I'm Parsa, a developer",
      composer({ outcome: "change", changes: [change("authorWebsite", "set", "parsa.dev", "add my website")] }).model
    );
    expect(site.content).toMatch(/^I only print what you tell me, and I couldn’t find the website in your message\./);
    const name = await send(
      "dedicate it to my mom",
      composer({ outcome: "change", changes: [change("dedication", "set", "For my mother, Maria Elena Ruiz", "dedicate it to my mom")] }).model
    );
    expect(name.content).toMatch(/^I only print facts you give me, and that dedication needed one you didn’t send\./);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("reads the book's language, so a German dedication's nouns are not taken for names", async () => {
    const german = { ...project, language: "de" } as unknown as ProjectForChat;
    const message = "dedicate it to my mom";
    await applyBookMatterChatEdit({
      userId: "user-1",
      project: german,
      intent: bookMatterIntent({ confidence: 0.9, reasoning: "", assistantMessage: "" }),
      userMessageId: "message-1",
      message,
      pendingRequest: message,
      textModel: composer({ outcome: "change", changes: [change("dedication", "set", "Für meine Mama", message)] }).model
    });
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: "Für meine Mama" });
  });

  it("quotes the © year in the book's own digits, as the page prints it", async () => {
    const persian = { ...project, language: "fa" } as unknown as ProjectForChat;
    const message = "change the copyright holder to Lantern Press";
    const reply = await applyBookMatterChatEdit({
      userId: "user-1",
      project: persian,
      intent: bookMatterIntent({ confidence: 0.9, reasoning: "", assistantMessage: "" }),
      userMessageId: "message-1",
      message,
      pendingRequest: message,
      textModel: composer({ outcome: "change", changes: [change("copyrightHolder", "set", "Lantern Press", message)] }).model
    });
    expect(reply.content).toContain("“© ۲۰۲۶ Lantern Press”");
  });

  it("asks for the poem rather than printing “For a poem”", async () => {
    const message = "replace the dedication with a poem";
    const { model } = composer({ outcome: "question", question: "Which poem should the dedication be? Send me its words." });
    const reply = await send(message, model);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(reply.content).toBe("Which poem should the dedication be? Send me its words.");
    // The one question: the reply's words are merged into this request.
    expect(reply.metadata.pendingEdit).toEqual({ request: message, clarification: "matter" });
  });

  it("takes a name out of the dedication instead of deleting it", async () => {
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For Mom, Dad and Alex" }));
    const message = "remove my ex's name from the dedication";
    const { model, shown } = composer({ outcome: "change", changes: [change("dedication", "set", "For Mom and Dad", message)] },
      { verdicts: [{ id: 0, supported: true }] });
    const reply = await send(message, model);
    expect(shown().currentMatter.dedication).toBe("For Mom, Dad and Alex");
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: "For Mom and Dad" });
    expect(reply.metadata.bookMatterEdit).toEqual({
      before: { dedication: "For Mom, Dad and Alex" },
      after: { dedication: "For Mom and Dad" }
    });
  });

  it("cuts a dedication down to one of its own lines", async () => {
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For Mom,\nwho read to me every night" }));
    const message = "cut the dedication down to one line";
    const { model } = composer({ outcome: "change", changes: [change("dedication", "set", "For Mom", message)] });
    await send(message, model);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { dedication: "For Mom" });
  });

  it.each([
    ["remove the About the Author page", [change("aboutAuthor", "remove", null, "remove the About the Author page")], { aboutAuthor: null }, "Done — the About the Author page is gone."],
    ["remove all rights reserved", [change("allRightsReserved", "remove", null, "remove all rights reserved")], { allRightsReserved: false }, "Done — “All rights reserved.” no longer prints."],
    ["add an ISBN 978-0-306-40615-7", [change("isbn", "set", "978-0-306-40615-7", "add an ISBN 978-0-306-40615-7")], { isbn: "978-0-306-40615-7" }, "Done — the ISBN line now reads “ISBN 978-0-306-40615-7”."],
    ["change the publisher to Lantern Press", [change("imprint", "set", "Lantern Press", "change the publisher to Lantern Press")], { imprint: "Lantern Press" }, "Done — the publisher line now reads “Lantern Press”."],
    ["change the copyright holder to Lantern Press", [change("copyrightHolder", "set", "Lantern Press", "change the copyright holder to Lantern Press")], { copyrightHolder: "Lantern Press" }, "Done — the copyright line now reads “© 2026 Lantern Press”."]
  ])("%j is applied free, quoting what will print", async (message, changes, patch, said) => {
    const { model } = composer({ outcome: "change", changes });
    const reply = await send(message, model);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), patch);
    expect(reply.content).toBe(`${said} I’m refreshing the exports. This one’s free.`);
  });

  it("quotes an imported book's own © year, as its matter sheet prints it", async () => {
    matter.ownedBookMatterProject.mockResolvedValue(row({ copyrightYear: "2019" }));
    const message = "change the copyright holder to Lantern Press";
    const { model } = composer({ outcome: "change", changes: [change("copyrightHolder", "set", "Lantern Press", message)] });
    const reply = await send(message, model);
    expect(reply.content).toBe("Done — the copyright line now reads “© 2019 Lantern Press”. I’m refreshing the exports. This one’s free.");
  });

  it("changes the byline alone, and says what the cover does", async () => {
    const message = "change the author name to Sam Lee";
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "queued", cover: "retypeset" });
    const { model } = composer({
      outcome: "change",
      changes: [change("authorName", "set", "Sam Lee", message), change("copyrightHolder", "set", "Sam Lee", message)]
    });
    const reply = await send(message, model);
    // The holder was the model's idea, not the reader's.
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { authorName: "Sam Lee" });
    expect(reply.content).toBe(
      "Done — the author name is now “Sam Lee”. The cover gets the new name too. I’m refreshing the exports. This one’s free."
    );
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "queued", cover: "keeps_old_name" });
    expect((await send(message, composer({ outcome: "change", changes: [change("authorName", "set", "Sam Lee", message)] }).model)).content).toMatch(
      /The cover keeps the name it was drawn with\./
    );
  });

  it("asks for an ISBN that was never given, and refuses one that was invented", async () => {
    const asked = await send("add an ISBN", composer({ outcome: "question", question: "What’s the ISBN?" }).model);
    expect(asked.content).toBe("What’s the ISBN?");
    const invented = await send(
      "add an ISBN",
      composer({ outcome: "change", changes: [change("isbn", "set", "978-0-306-40615-7", "add an ISBN")] }).model
    );
    expect(invented.content).toMatch(/^I only print what you tell me, and I couldn’t find the ISBN in your message\./);
    expect(invented.metadata.pendingEdit).toEqual({ request: "add an ISBN", clarification: "matter" });
    const wrong = await send(
      "the ISBN is 978-0-306-40615-8",
      composer({ outcome: "change", changes: [change("isbn", "set", "978-0-306-40615-8", "the ISBN is 978-0-306-40615-8")] }).model
    );
    expect(wrong.content).toMatch(/^That isn’t a valid ISBN/);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("never asks twice", async () => {
    const message = "add an ISBN\n\nFollow-up from the user: you pick";
    const { model, shown } = composer({ outcome: "question", question: "What’s the ISBN?" });
    const reply = await send(message, model, { clarifyExhausted: true, pendingRequest: "add an ISBN" });
    expect(shown().alreadyAskedOnce).toBe(true);
    expect(reply.content).toMatch(/^I still couldn’t tell what to print there\./);
    expect(reply.metadata.pendingEdit).toBeUndefined();
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("never asks again on the turn after the question, whatever the composer refuses", async () => {
    // The merged follow-up still fails a check; a question here would arrive
    // with no `pendingEdit`, so its answer would be read as a fresh request.
    const longImprint = `Lantern${" Press".repeat(25)}`;
    for (const [message, changes, problem] of [
      ["add an ISBN\n\nFollow-up from the user: 978-0-306-40615-8", [change("isbn", "set", "978-0-306-40615-8", "978-0-306-40615-8")], /^That isn’t a valid ISBN/],
      ["add an ISBN\n\nFollow-up from the user: you pick", [change("isbn", "set", "978-0-306-40615-7", "add an ISBN")], /^I only print what you tell me, and I couldn’t find the ISBN/],
      ["dedicate it to my mom\n\nFollow-up from the user: her name", [change("dedication", "set", "For my mother, Maria Elena Ruiz", "dedicate it to my mom")], /^I only print facts you give me, and that dedication/],
      [`change the publisher\n\nFollow-up from the user: ${longImprint}`, [change("imprint", "set", longImprint, "change the publisher")], /^The publisher can be up to 120 characters/]
    ] as const) {
      const reply = await send(message, composer({ outcome: "change", changes }).model, {
        clarifyExhausted: true,
        pendingRequest: message.split("\n")[0]!
      });
      expect(reply.content).toMatch(problem);
      expect(reply.content).not.toContain("?");
      expect(reply.content).toMatch(/Title & credits to type it in yourself\.$/);
      expect(reply.metadata.pendingEdit).toBeUndefined();
    }
    // The first turn may still ask, and stores the request its answer resumes.
    const first = await send("add an ISBN", composer({ outcome: "change", changes: [change("isbn", "set", "978-0-306-40615-7", "add an ISBN")] }).model);
    expect(first.content).toMatch(/What should it be, exactly as it should print\?$/);
    expect(first.metadata.pendingEdit).toEqual({ request: "add an ISBN", clarification: "matter" });
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("says the title page stays when a compound message also asked to remove it", async () => {
    const message = "remove the title page and change the author name to Sam";
    const reply = await send(message, composer({ outcome: "change", changes: [change("authorName", "set", "Sam", "change the author name to Sam")] }).model);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(expect.anything(), { authorName: "Sam" });
    expect(reply.content).toBe(
      `Done — the author name is now “Sam”. I’m refreshing the exports. This one’s free. ${TITLE_PAGE_KEPT}`
    );
    // Before what the message asked beyond the matter, which keeps its own sentence.
    const withRest = await send(
      "Drop the title page, dedicate it to my mom and redo the cover",
      composer({ outcome: "change", changes: [change("dedication", "set", "For my mom", "dedicate it to my mom")], unhandled: "redo the cover" }).model
    );
    expect(withRest.content).toBe(
      `Done — the dedication now reads “For my mom”. I’m refreshing the exports. This one’s free. ${TITLE_PAGE_KEPT} “redo the cover” is a separate change — send it as its own message and I’ll take care of it.`
    );
    // Something taken *from* the title page is the change itself, not a removal of the page.
    for (const [text, changes] of [
      ["remove my name from the title page and add a dedication: For Mom", [change("authorName", "remove", null, "remove my name from the title page")]],
      ["delete the title page logo and change the author name to Sam", [change("authorName", "set", "Sam", "change the author name to Sam")]],
      ["don't remove the title page, just change the author name to Sam", [change("authorName", "set", "Sam", "change the author name to Sam")]],
      // A negation split off by a comma still governs its verb (review finding 9).
      [
        "Please don't, under any circumstances, remove the title page, and change the author to Sam",
        [change("authorName", "set", "Sam", "change the author to Sam")]
      ]
    ] as const) {
      expect((await send(text, composer({ outcome: "change", changes }).model)).content, text).not.toContain(TITLE_PAGE_KEPT);
    }
    // "Remove X and the title page" asks for both.
    const both = await send(
      "Remove the dedication and the title page",
      composer({ outcome: "change", changes: [change("dedication", "remove", null, "Remove the dedication")] }).model
    );
    expect(both.content).toBe(`Done — the dedication is gone. I’m refreshing the exports. This one’s free. ${TITLE_PAGE_KEPT}`);
    // The composer's own title-page answer is not said twice.
    const answered = await send(message, composer({ outcome: "none", noneReason: "title_page" }).model);
    expect(answered.content).toBe(TITLE_PAGE_ANSWER);
  });

  it("quotes the reader's words as they print, never as chat markup", async () => {
    const message = "change the dedication to For *Mom*, and make [page 2](https://x.example) _shorter_";
    const reply = await send(
      message,
      composer({
        outcome: "change",
        changes: [change("dedication", "set", "For *Mom*", "change the dedication to For *Mom*")],
        unhandled: "make [page 2](https://x.example) _shorter_"
      }).model
    );
    // The bubble's parser (`chatMessagePlainText` is its server twin) leaves every mark where the reader put it.
    expect(chatMessagePlainText(reply.content).replace(/[﻿⁠]/g, "")).toBe(
      "Done — the dedication now reads “For *Mom*”. I’m refreshing the exports. This one’s free. “make [page 2](https://x.example) _shorter_” is a separate change — send it as its own message and I’ll take care of it."
    );
    // What is stored and undone is the text itself.
    expect(reply.metadata.bookMatterEdit.after).toEqual({ dedication: "For *Mom*" });
    expect(reply.metadata.unhandledRequest).toBe("make [page 2](https://x.example) _shorter_");
  });

  it("answers a title page removal without a model, and changes nothing", async () => {
    for (const message of ["remove the title page", "Can you delete the title page from my book?", "No title page, please"]) {
      const { model, generateJson } = composer({ outcome: "none", noneReason: "title_page" });
      const reply = await send(message, model);
      expect(reply.content, message).toBe(TITLE_PAGE_ANSWER);
      expect(generateJson, message).not.toHaveBeenCalled();
    }
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("composes a byline sent beside a title page removal, rather than asking for the name it was given", async () => {
    // Review finding 3: the shortcut read these as a bare removal, so the
    // composer never ran and the reply asked for the author name.
    for (const [message, name, requestedBy] of [
      ["change the author to Sam and drop the title page", "Sam", "change the author to Sam"],
      ["Author: Sam Lee. Remove the title page.", "Sam Lee", "Author: Sam Lee"],
      ["use Sam Lee as the author and remove the title page", "Sam Lee", "use Sam Lee as the author"]
    ] as const) {
      matter.applyBookMatterPatch.mockClear();
      const { model, generateJson } = composer({ outcome: "change", changes: [change("authorName", "set", name, requestedBy)] });
      const reply = await send(message, model);
      expect(generateJson, message).toHaveBeenCalledTimes(1);
      expect(matter.applyBookMatterPatch, message).toHaveBeenCalledWith(expect.anything(), { authorName: name });
      expect(reply.content, message).toBe(
        `Done — the author name is now “${name}”. I’m refreshing the exports. This one’s free. ${TITLE_PAGE_KEPT}`
      );
    }
  });

  it("explains a © line that cannot come off on its own", async () => {
    const reply = await send("remove the copyright line", composer({ outcome: "none", noneReason: "copyright_line" }).model);
    expect(reply.content).toMatch(/^The © line prints whenever the book has an author name or a copyright holder/);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("does not guess when the composer fails, times out or is missing", async () => {
    expect((await send("dedicate it to my mom", composer(new Error("provider down")).model)).content).toBe(
      BOOK_MATTER_COMPOSE_FAILED
    );
    expect((await send("dedicate it to my mom", undefined)).content).toBe(BOOK_MATTER_COMPOSE_FAILED);
    vi.useFakeTimers();
    const pending = send("dedicate it to my mom", composer("hang").model);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).content).toBe(BOOK_MATTER_COMPOSE_FAILED);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(BOOK_MATTER_COMPOSE_FAILED).toMatch(/Title & credits/);
  });

  it("leaves an author's byline and dedication to the Writing Studio, and applies the rest", async () => {
    // An imported manuscript is an author's book, as a Studio one is.
    const studioRow = row({ dedication: "For Mom" }, { mediaSettings: { mobile: { import: { format: "docx" } } } });
    matter.ownedBookMatterProject.mockResolvedValue(studioRow);

    const onlyStudio = await send(
      "dedicate it to my mom",
      composer({ outcome: "change", changes: [change("dedication", "set", "For my mom", "dedicate it to my mom")] }).model
    );
    expect(onlyStudio.content).toMatch(/set in the Writing Studio’s book settings/);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();

    const message = "dedicate it to my mom and the ISBN is 978-0-306-40615-7";
    const mixed = await send(
      message,
      composer({
        outcome: "change",
        changes: [change("dedication", "set", "For my mom", "dedicate it to my mom"), change("isbn", "set", "978-0-306-40615-7", "the ISBN is 978-0-306-40615-7")]
      }).model
    );
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(studioRow, { isbn: "978-0-306-40615-7" });
    expect(mixed.content).toMatch(/^Done — the ISBN line now reads “ISBN 978-0-306-40615-7”\..*Writing Studio’s book settings/);
  });

  it("answers a busy book and a takeover race with the patch's own refusal", async () => {
    const message = "remove the ISBN";
    const remove = () => composer({ outcome: "change", changes: [change("isbn", "remove", null, message)] }).model;
    matter.applyBookMatterPatch.mockRejectedValueOnce(new BookMatterRefusal("PROJECT_BUSY", "Your book is being updated. Try again in a moment."));
    expect((await send(message, remove())).content).toBe("Your book is being updated. Try again in a moment.");
    matter.applyBookMatterPatch.mockRejectedValueOnce(new BookMatterRefusal("SET_IN_STUDIO", "Studio"));
    expect((await send(message, remove())).content).toMatch(/set in the Writing Studio’s book settings/);
  });

  it("screens what it would print, and writes nothing it refuses", async () => {
    // The operator's copyright rule is one the matter screen keeps for printed text.
    restrictions.copyrightRestrictionsEnabled.mockResolvedValue(true);
    const printed = "For my fans: I reproduce the full text of a bestselling novel here, word for word.";
    const message = `change the dedication to: ${printed}`;
    const reply = await send(
      message,
      composer({ outcome: "change", changes: [change("dedication", "set", printed, message)] }).model
    );
    expect(reply.content).toMatch(/^I can’t print that dedication\. Copyright restrictions are enabled\./);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });

  it("screens each field alone, as printed text, and names only the one refused", async () => {
    // A memorial dedication the request rules refuse ("how to" beside "terrorist attack")
    // prints; a bio refused on its own words is named alone.
    const memorial =
      "To the victims of the Manchester Arena terrorist attack, and to the city that showed the world how to grieve together.";
    const bio = "Visit my site for child sexual abuse material.";
    const message = `dedication: ${memorial} About the author: ${bio}`;
    const reply = await send(
      message,
      composer({
        outcome: "change",
        changes: [change("dedication", "set", memorial, message), change("aboutAuthor", "set", bio, message)]
      }).model
    );
    expect(reply.content).toMatch(/^I can’t print that About the Author text\. /);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();

    const alone = `dedication: ${memorial}`;
    await send(alone, composer({ outcome: "change", changes: [change("dedication", "set", memorial, alone)] }).model);
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(row({ dedication: "For Mom" }), { dedication: memorial });
  });

  it("says when the change waits for the book to be put together, or changed nothing", async () => {
    const message = "dedicate it to my mom";
    const set = () => composer({ outcome: "change", changes: [change("dedication", "set", "For my mom", message)] }).model;
    matter.applyBookMatterPatch.mockResolvedValueOnce({ reprint: "next_compile", cover: "unchanged" });
    expect((await send(message, set())).content).toBe(
      "Done — the dedication now reads “For my mom”. It’ll be printed when the book is put together. This one’s free."
    );
    matter.applyBookMatterPatch.mockResolvedValueOnce({ reprint: "none", cover: "unchanged" });
    expect((await send(message, set())).content).toBe("Nothing changed — the dedication already reads “For my mom”.");
  });

  it("reads a follow-up's “it” as the field the last matter reply changed", async () => {
    // Review round 7: "Dedicate it to my mom" → Done → "Mention my sister in it too" was
    // dropped, because its words name no field. Beside a second change the gate needs to
    // know what "it" is, and the transcript says.
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For my mom" }));
    const message = "Mention my sister in it too, and the publisher is Lantern";
    const answer = {
      outcome: "change",
      changes: [
        change("dedication", "set", "For my mom and my sister", "Mention my sister in it too"),
        change("imprint", "set", "Lantern", "the publisher is Lantern")
      ]
    };
    const transcript = [
      turn("USER", "Dedicate it to my mom"),
      turn("ASSISTANT", "Done — the dedication now reads “For my mom”.", {
        bookMatterEdit: { before: { dedication: "For Mom" }, after: { dedication: "For my mom" } }
      })
    ];
    await send(message, composer(answer, { verdicts: [{ id: 0, supported: true }] }).model, { activeMessages: transcript });
    expect(matter.applyBookMatterPatch).toHaveBeenLastCalledWith(expect.anything(), { dedication: "For my mom and my sister", imprint: "Lantern" });

    // With no reply before it to point back at, the dedication is the one nobody named.
    await send(message, composer(answer).model);
    expect(matter.applyBookMatterPatch).toHaveBeenLastCalledWith(expect.anything(), { imprint: "Lantern" });
  });

  it("shows the composer its last reply without the bubble's marks, and stores none it copied", async () => {
    // "use that again" had the composer copy the quoted value, invisible marks and all, onto the page.
    matter.ownedBookMatterProject.mockResolvedValue(row({ dedication: "For *Mom*" }));
    const transcript = [
      turn("USER", "change the dedication to For *Mom*"),
      turn("ASSISTANT", `Done — the dedication now reads “${chatMarkdownLiteral("For *Mom*")}”.`, {
        bookMatterEdit: { before: { dedication: null }, after: { dedication: "For *Mom*" } }
      })
    ];
    const copied = change("dedication", "set", `${chatMarkdownLiteral("For *Mom*")} and Dad`, "use that again but add Dad");
    const { model, shown } = composer({ outcome: "change", changes: [copied] }, { verdicts: [{ id: 0, supported: true }] });
    await send("use that again but add Dad", model, { activeMessages: transcript });
    expect(shown().recentConversation[1].content).toBe("Done — the dedication now reads “For *Mom*”.");
    expect(matter.applyBookMatterPatch).toHaveBeenLastCalledWith(expect.anything(), { dedication: "For *Mom* and Dad" });
  });

  it("finds the last matter reply's fields in its change, or in the request its question was about", () => {
    const changed = turn("ASSISTANT", "Done", { bookMatterEdit: { before: { authorName: "Ana Ruiz" }, after: { authorName: "Sam Lee" } } });
    const asked = turn("ASSISTANT", "What’s the ISBN?", { pendingEdit: { request: "add an ISBN", clarification: "matter" } });
    const other = turn("ASSISTANT", "I’ll rewrite page 3.", { pendingEdit: { request: "page 3", clarification: "scope" } });
    expect(matterFieldsOfLastReply([changed])).toEqual(["authorName"]);
    expect(matterFieldsOfLastReply([changed, turn("USER", "add an ISBN"), asked])).toEqual(["isbn"]);
    // The nearer of the last two replies that has any, and never one further back.
    expect(matterFieldsOfLastReply([changed, other])).toEqual(["authorName"]);
    expect(matterFieldsOfLastReply([changed, other, other])).toEqual([]);
    expect(matterFieldsOfLastReply([turn("ASSISTANT", "Done", { bookMatterEdit: { after: { title: "X" } } })])).toEqual([]);
    expect(matterFieldsOfLastReply(undefined)).toEqual([]);
  });

  it("says what it can change when the message changes none of it", async () => {
    const reply = await send("make it nicer", composer({ outcome: "none", noneReason: "not_matter" }).model);
    expect(reply.content).toMatch(/^I didn’t find a change to the book’s title and credits in that\./);
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
  });
});
