import { Prisma, PrismaClient } from "./generated/prisma/client.ts";
import { templateDefinitions } from "@book-maker/core";
import { PrismaPg } from "@prisma/adapter-pg";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://bookmaker:bookmaker@localhost:55432/bookmaker?schema=public";

const adapter = new PrismaPg({ connectionString: databaseUrl });

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.PRISMA_LOG === "true" ? ["query", "warn", "error"] : ["warn", "error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { PrismaClient, Prisma };
export * from "./generated/prisma/enums.ts";
export type * from "./generated/prisma/models.ts";

export async function ensureSeedTemplates() {
  for (const template of templateDefinitions) {
    await prisma.template.upsert({
      where: { slug: template.slug },
      create: {
        slug: template.slug,
        name: template.name,
        category: template.category,
        description: template.description,
        defaultConfig: template.defaultConfig,
        styleRules: template.styleRules
      },
      update: {
        name: template.name,
        category: template.category,
        description: template.description,
        defaultConfig: template.defaultConfig,
        styleRules: template.styleRules
      }
    });
  }
}
