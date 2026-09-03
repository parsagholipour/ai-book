import { z } from "zod";

/**
 * The book's arc — one question, one verified opponent, one answer, and a job
 * per chapter (`generation/bookArc.ts` plans and applies it). It lives under
 * `schemas/` because `bookPlanSchema` stores it typed: a plan is written to a
 * JSON column as-is, so every field on it has to be JSON-shaped, and a stored
 * arc that no longer parses is dropped by the plan schema rather than failing
 * the plan.
 */
export const ARC_KINDS = ["case", "argument", "portrait", "document", "complication", "method", "resolution"] as const;
export type ArcKind = (typeof ARC_KINDS)[number];

const arcKindSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(ARC_KINDS)
);

const arcSideSchema = z.object({ name: z.string().default(""), claim: z.string().default("") });

const arcChapterSchema = z.object({
  index: z.number().int().positive(),
  kind: arcKindSchema.catch("case"),
  pages: z.number().int().positive(),
  job: z
    .object({
      believesSoFar: z.string().default(""),
      does: z.string().default(""),
      adds: z.string().default(""),
      leavesOpen: z.string().default("")
    })
    .default({ believesSoFar: "", does: "", adds: "", leavesOpen: "" }),
  cast: z.array(z.string()).default([]),
  dispute: z
    .object({
      sideA: arcSideSchema.default({ name: "", claim: "" }),
      sideB: arcSideSchema.default({ name: "", claim: "" }),
      atStake: z.string().default("")
    })
    .optional()
});

export const bookArcSchema = z.object({
  question: z.string().min(1),
  opponent: z
    .object({
      name: z.string().default(""),
      work: z.string().default(""),
      year: z.union([z.number(), z.string()]).optional(),
      claim: z.string().default(""),
      whereRight: z.string().default(""),
      whereTheBookBreaks: z.string().default(""),
      sourceUrl: z.string().optional()
    })
    .optional(),
  answer: z.string().min(1),
  turn: z.object({ chapterIndex: z.number().int().positive(), trouble: z.string().default(""), repair: z.string().default("") }).optional(),
  chapters: z.array(arcChapterSchema).min(1),
  proposal: z.string().default("")
});

export type BookArc = z.infer<typeof bookArcSchema>;
export type ArcChapter = BookArc["chapters"][number];
