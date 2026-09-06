import { unsupportedGenerateWithTools } from "../../adapters/fake.js";
import type { TextModelAdapter } from "../../adapters/types.js";
import { makeFallbackPlan } from "../../prompting/templates.js";
import type { CreateProjectInput } from "../../schemas/book.js";

export const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 10,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

/**
 * The provenance an imported manuscript carries — `mediaSettings.mobile.import`,
 * written by the import route and carried through `planInputSnapshot` into the
 * plan version's input snapshot, which is what `compileExport` rebuilds `input`
 * from before it runs final QA. Only that record separates it from `input`.
 */
export const importedInput: CreateProjectInput = {
  ...input,
  mediaSettings: {
    ...input.mediaSettings,
    mobile: { bookType: "custom", import: { importId: "imp_1", fileName: "chapel.docx", format: "docx" } }
  }
};

export const plan = makeFallbackPlan(input);

export function goodMarkdown(): string {
  return [
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
    "",
    '"You promised you would wait," Mara said from the stairwell.',
    "",
    "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him. He lifted the latch, stepped through, and let Mara see the scar over his left eyebrow catch the candlelight."
  ].join("\n");
}

/**
 * A page-1 draft long enough to have overrun the old 4,000-character opening
 * cap. `goodMarkdown` is ~700 characters, so the padding is what carries it
 * past both the old ceiling and the new one.
 */
export function paddedOpening(minLength: number): string {
  const parts = [goodMarkdown()];
  let entry = 0;
  while (parts.join("\n\n").length < minLength) {
    entry += 1;
    parts.push(
      `The clerk wrote entry ${entry} into the parish ledger, pressed the blotter flat over the ink, and counted ${entry + 4} coins back into the tin before he let himself look at the chapel door again.`
    );
  }
  return parts.join("\n\n");
}

export function capturingReviewModel(rawData: unknown): {
  model: TextModelAdapter;
  payload?: Record<string, unknown>;
  system?: string;
} {
  const capture: { model: TextModelAdapter; payload?: Record<string, unknown>; system?: string } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}
