/**
 * Rotation runbook for PLUGIN_SECRET_ENCRYPTION_KEYS (see
 * PluginSecretEncryptionService's doc comment). Usage:
 *
 *   1. Add a new "version:hexkey" pair to PLUGIN_SECRET_ENCRYPTION_KEYS
 *      with a HIGHER version number than any existing one, keeping the
 *      old pair(s) in the list too (so this script, which reads each
 *      row's OWN stored version, can still decrypt them).
 *   2. Run: pnpm --filter @openestate/api run rotate-plugin-secrets
 *      — re-encrypts every plugin_installations row under the new
 *      current version and bumps its stored secretKeyVersion.
 *   3. Once every row is confirmed on the new version (this script logs
 *      a count), the old key pair can be removed from
 *      PLUGIN_SECRET_ENCRYPTION_KEYS.
 *
 * Requires DATABASE_URL_SYSTEM (bypasses RLS — rotates across every
 * company in one run, same system-client convention as every other
 * cross-tenant script/job in this codebase, e.g. EscalationService's
 * tick).
 */
import { createSystemPrismaClient } from '@openestate/db';
import { PluginSecretEncryptionService } from '../src/plugins/plugin-secret-encryption.service';

async function main() {
  const systemUrl = process.env.DATABASE_URL_SYSTEM;
  if (!systemUrl) {
    throw new Error('DATABASE_URL_SYSTEM must be set.');
  }

  const systemPrisma = createSystemPrismaClient(systemUrl);
  const encryption = new PluginSecretEncryptionService();

  const rows = await systemPrisma.pluginInstallation.findMany({
    where: { configCiphertext: { not: null } },
  });

  let rotated = 0;
  let alreadyCurrent = 0;
  for (const row of rows) {
    if (row.secretKeyVersion === encryption.currentKeyVersion) {
      alreadyCurrent++;
      continue;
    }
    const plaintext = encryption.decrypt(row.configCiphertext!, row.secretKeyVersion!);
    const { ciphertext, keyVersion } = encryption.encrypt(plaintext);
    await systemPrisma.pluginInstallation.update({
      where: { id: row.id },
      data: { configCiphertext: ciphertext, secretKeyVersion: keyVersion },
    });
    rotated++;
  }

  console.log(
    `Rotation complete: ${rotated} row(s) re-encrypted under key version ${encryption.currentKeyVersion}, ` +
      `${alreadyCurrent} already current, ${rows.length} total.`,
  );

  await systemPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
