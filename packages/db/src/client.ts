import { Prisma, PrismaClient } from "./generated/prisma/client.ts";
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
