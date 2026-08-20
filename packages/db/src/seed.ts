import { ensureSeedTemplates, prisma } from "./index.ts";

async function main() {
  await ensureSeedTemplates();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
