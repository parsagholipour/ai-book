import { FakeTextModelAdapter } from "../../adapters/fake.js";
import type { GenerateJsonOptions } from "../../adapters/types.js";
import { makeFallbackPlan } from "../../prompting/templates.js";
import type { CreateProjectInput } from "../../schemas/book.js";
import { caseEvidencePacketSchema } from "../../schemas/episodes.js";

export const developmentInput = {
  prompt: "Explain how evidence and appeals change legal judgments.", category: "EDUCATION",
  targetPages: 12, complexity: 3, temperature: 0.4, language: "en", mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" }
} as CreateProjectInput;

export function originalDevelopmentPlan() {
  return { ...makeFallbackPlan(developmentInput), promises: ["Explain the consequence of appeal"], chapters: [
    { index: 1, title: "The claim", summary: "The claim and verdict", keyBeats: ["Who won initially"], targetPages: 4 },
    { index: 2, title: "The initial verdict", summary: "Why a verdict is provisional", keyBeats: ["Evidence before the jury"], targetPages: 4 },
    { index: 3, title: "Appeal", summary: "What an appeal changes", keyBeats: ["Distinguish verdict from final disposition"], targetPages: 4 }
  ] };
}

// An invented test record, clearly separate from any production research.
export function evidenceFixture(id = "case-1") {
  return caseEvidencePacketSchema.parse({
    id, sourceChapterIndex: 1, reviewVersion: 2,
    episode: { title: "Test shipping claim", kind: "document", person: "Test owner", place: "Test court", date: "1783", document: "Test court record" },
    claims: [
      { id: "initial", kind: "event", text: "The first jury found for the shipowners.", excerptIds: ["record"] },
      { id: "appeal", kind: "event", text: "The court later ordered another trial.", excerptIds: ["record"] }
    ],
    sequence: [], disagreements: [], unknowns: ["No dialogue is recorded."],
    excerpts: [{ id: "record", chapterIndex: 1, episodeTitle: "Test shipping claim", documentTitle: "Test court record", documentUrl: "https://example.org/test-record", text: "The first jury found for the shipowners. The court later ordered another trial.", words: 15 }]
  });
}

export function scriptedDevelopmentModel(responses: unknown[]) {
  const model = new FakeTextModelAdapter(developmentInput);
  const calls: GenerateJsonOptions<unknown>[] = [];
  model.generateJson = async (options) => {
    calls.push(options);
    if (!responses.length) throw new Error("Unexpected model call in test");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { data: options.schema.parse(response), text: JSON.stringify(response), model: "fixture", provider: "fixture" };
  };
  return { model, calls };
}
