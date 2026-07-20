import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Demo dataset (1 company, 2 projects, inquiries, bookings) ships in Phase 8.
  console.log('Seed:demo: not implemented until Phase 8.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
