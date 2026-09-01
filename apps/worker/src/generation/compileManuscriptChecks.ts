import {
  runDeterministicManuscriptChecks,
  type ManuscriptQualityIssue
} from "@book-maker/core";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";

type CompileManuscriptPage = Pick<ExportPageForRepair, "index" | "title" | "markdown" | "chapter">;

export function runCompileManuscriptChecks(options: {
  pages: CompileManuscriptPage[];
  expectedPageCount: number;
  language?: string;
}): ManuscriptQualityIssue[] {
  return runDeterministicManuscriptChecks({
    pages: options.pages.map(({ index, title, markdown, chapter }) => ({
      index,
      title,
      markdown,
      ...(chapter ? { chapterIndex: chapter.index } : {})
    })),
    expectedPageCount: options.expectedPageCount,
    ...(options.language ? { language: options.language } : {})
  });
}
