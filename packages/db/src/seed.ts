import { ensureSeedTemplates, prisma } from "./index.js";

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
