import { z } from "zod";

export const resetMessageAllowanceSchema = z.object({
  resetToken: z.string().regex(/^\d{4}-\d{2}-\d{2}:\d+:\d+$/).max(40),
  expectedCredits: z.number().int().min(0).max(100_000)
}).strict();

export const resetMessageAllowanceOpenApiBody = {
  type: "object", additionalProperties: false, required: ["resetToken", "expectedCredits"],
  properties: {
    resetToken: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}:\\d+:\\d+$", maxLength: 40 },
    expectedCredits: { type: "integer", minimum: 0, maximum: 100_000 }
  }
} as const;
