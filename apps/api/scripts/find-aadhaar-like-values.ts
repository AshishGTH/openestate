/**
 * Read-only: lists where Aadhaar-like values already sit in custom fields.
 * Run via deploy/native/find-aadhaar-like-values.sh. Prints keys and counts,
 * never values; row ids only with --show-ids. Requires DATABASE_URL_SYSTEM.
 */
import { createSystemPrismaClient } from '@openestate/db';
import { renderReport, scanAadhaarLike } from './aadhaar-scan';

async function main() {
  const url = process.env.DATABASE_URL_SYSTEM;
  if (!url) throw new Error('DATABASE_URL_SYSTEM must be set.');
  const prisma = createSystemPrismaClient(url);
  try {
    console.log(renderReport(await scanAadhaarLike(prisma, { showIds: process.argv.includes('--show-ids') })));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
