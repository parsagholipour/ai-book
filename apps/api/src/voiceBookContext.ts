import type { RealtimeBookCastMember } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Loads the compact story roster used to ground live character calls.
 * Rejected here only means "not callable"; the person still exists in the
 * finished book and should remain known to the other characters.
 */
export async function loadVoiceBookCast(projectId: string): Promise<RealtimeBookCastMember[]> {
  const cast = await prisma.voiceCharacter.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: {
      name: true,
      role: true,
      description: true
    }
  });
  // A few API tests use deliberately partial Prisma mocks. Production Prisma
  // always returns an array, while this fallback keeps those fixtures honest.
  return cast ?? [];
}
