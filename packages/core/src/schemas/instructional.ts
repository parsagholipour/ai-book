import { z } from "zod";

/**
 * What the form plan decides once for a whole practical guide or workbook
 * (`generation/instructionalBook.ts`): the country its rules belong to, the
 * workbook's running case, the warnings each stated in one chapter, and the
 * facts the book keeps fixed. Stored on the plan as `toolkit`; every field is
 * optional or defaulted, so a plan stored before it existed parses unchanged.
 */

/** Strings are clipped, never refused: a running case lost whole to one long value is a workbook with no running case. */
const clipped = (max: number) =>
  z.preprocess((value) => {
    const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : value;
    return typeof raw === "string" ? [...raw].slice(0, max).join("").trim() : raw;
  }, z.string().min(1));

export const instructionalSettingSchema = z.object({
  country: clipped(80),
  currency: clipped(40).optional(),
  /** The tax, legal or school year the book's rules are stated for, when it matters. */
  year: clipped(40).optional()
});
export type InstructionalSetting = z.infer<typeof instructionalSettingSchema>;

export const runningCaseFigureSchema = z.object({
  label: clipped(160),
  value: clipped(240),
  /**
   * The tax or calendar year a dated amount belongs to. Without it a workbook
   * added 2025 receipts to a 2026 year-to-date total (blind panel, 2026-10-01).
   */
  year: clipped(20).optional().catch(undefined)
});

export const runningCaseSchema = z.object({
  name: clipped(60),
  situation: clipped(300),
  figures: z.array(runningCaseFigureSchema).min(1).transform((figures) => figures.slice(0, 30))
});
export type RunningCase = z.infer<typeof runningCaseSchema>;

export const toolkitCaveatSchema = z.object({ text: clipped(400), chapterIndex: z.number().int().positive() });

export const instructionalToolkitSchema = z.object({
  kind: z.enum(["guide", "workbook"]),
  setting: instructionalSettingSchema.optional(),
  runningCase: runningCaseSchema.optional(),
  caveats: z.array(toolkitCaveatSchema).max(12).default([]),
  rules: z.array(clipped(300)).max(10).default([])
});
export type InstructionalToolkit = z.infer<typeof instructionalToolkitSchema>;
export type InstructionalBookKind = InstructionalToolkit["kind"];
