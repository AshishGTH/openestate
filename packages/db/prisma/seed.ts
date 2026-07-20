import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Master-table seed data is added starting Phase 1.
  console.log('Seed: no domain models yet (Phase 0 scaffold).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
