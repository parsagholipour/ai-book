import { z } from "zod";

const text = z.string().trim().min(1);

/** A durable content plan, before any chapter rows or pages are written. */
export const bookDevelopmentSchema = z.object({
  version: z.literal(1),
  question: text,
  answer: text,
  coverage: z.array(z.object({ id: text, requirement: text })).min(1),
  chapters: z.array(z.object({
    index: z.number().int().positive(),
    title: text,
    summary: text,
    targetPages: z.number().int().positive(),
    keyBeats: z.array(text).min(1),
    /** What becomes understandable here, beyond what earlier chapters established. */
    contribution: text,
    requires: z.array(z.number().int().positive()),
    covers: z.array(text).min(1),
    /** Full treatment belongs to exactly one chapter. */
    caseIds: z.array(text),
    /** A return is permitted only for an explicitly different inference. */
    callbacks: z.array(z.object({ caseId: text, newInference: text }))
  })).min(1).max(80),
  /** Objections the plan reviewer still held after the bounded attempts: recorded for the developmental edit, never a reason to lose the book. */
  reviewNotes: z.array(text).optional()
});

export type BookDevelopment = z.infer<typeof bookDevelopmentSchema>;
