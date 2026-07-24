import { MECHANICAL_TEXT_PURPOSES } from "./modelTiers.js";
import type { TextModelSelection } from "../schemas/book.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  GenerateWithToolsOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "./types.js";

export type RoutedTextModel = {
  selection: TextModelSelection;
  adapter: TextModelAdapter;
};

/**
 * Routes each call to the prose or mechanical model based on its purpose.
 * Unknown purposes route to prose so quality is never silently degraded.
 */
export class RoutingTextModelAdapter implements TextModelAdapter {
  constructor(
    private readonly prose: RoutedTextModel,
    private readonly mechanical: RoutedTextModel
  ) {}

  selectionForPurpose(purpose: string | undefined): TextModelSelection {
    return this.routeForPurpose(purpose).selection;
  }

  generateText(options: GenerateTextOptions): Promise<TextResult> {
    return this.routeForPurpose(options.purpose).adapter.generateText(options);
  }

  generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    return this.routeForPurpose(options.purpose).adapter.generateJson(options);
  }

  streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    return this.routeForPurpose(options.purpose).adapter.streamText(options);
  }

  generateWithTools(options: GenerateWithToolsOptions): Promise<ToolCallsResult> {
    return this.routeForPurpose(options.purpose).adapter.generateWithTools(options);
  }

  private routeForPurpose(purpose: string | undefined): RoutedTextModel {
    return purpose && MECHANICAL_TEXT_PURPOSES.has(purpose) ? this.mechanical : this.prose;
  }
}
