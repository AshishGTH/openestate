import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Plugin/webhook secret encryption at rest (AES-256-GCM), modeled
 * directly on PanEncryptionService's identical shape
 * (apps/api/src/common/pan-encryption.service.ts) — but keyed by its
 * OWN env var, `PLUGIN_SECRET_ENCRYPTION_KEYS`, not reused from PAN's or
 * TOTP's key. Same reasoning as every prior "separate key per domain"
 * decision in this codebase (Phase 1: TOTP_ENCRYPTION_KEY not reused
 * from PAN's — rotating/compromising one must not affect the other):
 * third-party plugin API keys are yet another rotation/trust domain.
 *
 * Unlike PanEncryptionService's `panKeyVersion` column (added Phase 4,
 * never actually wired up — noted honestly in that service's own doc
 * comment), key versioning here is real: `PLUGIN_SECRET_ENCRYPTION_KEYS`
 * lists one or more `version:hexkey` pairs (comma-separated), the
 * highest version number is used for all NEW encryptions, and
 * `decrypt()` takes the row's own stored `secretKeyVersion` so any
 * still-configured older key can still decrypt existing rows —
 * `apps/api/scripts/rotate-plugin-secrets.ts` is the rotation runbook
 * that re-encrypts every row under the current version and bumps it.
 *
 * Reads directly from process.env (not Nest's ConfigService), same
 * reason as PanEncryptionService: every Phase 4+ service in this
 * codebase is constructed directly in integration tests
 * (`new XxxService()`), and this keeps it constructible the same
 * zero-argument way.
 */
@Injectable()
export class PluginSecretEncryptionService {
  private readonly keysByVersion = new Map<number, Buffer>();
  private readonly currentVersion: number;

  constructor() {
    const raw = process.env.PLUGIN_SECRET_ENCRYPTION_KEYS;
    if (!raw) {
      throw new Error('PLUGIN_SECRET_ENCRYPTION_KEYS is not set');
    }
    for (const pair of raw.split(',')) {
      const [versionStr, hex] = pair.trim().split(':');
      const version = Number(versionStr);
      if (!Number.isInteger(version) || version < 1) {
        throw new Error(`Invalid key version in PLUGIN_SECRET_ENCRYPTION_KEYS: "${versionStr}"`);
      }
      const key = Buffer.from(hex ?? '', 'hex');
      if (key.length !== 32) {
        throw new Error(`PLUGIN_SECRET_ENCRYPTION_KEYS version ${version} must be 32 bytes (64 hex chars)`);
      }
      this.keysByVersion.set(version, key);
    }
    if (this.keysByVersion.size === 0) {
      throw new Error('PLUGIN_SECRET_ENCRYPTION_KEYS must list at least one version:hexkey pair');
    }
    this.currentVersion = Math.max(...this.keysByVersion.keys());
  }

  get currentKeyVersion(): number {
    return this.currentVersion;
  }

  /** Always encrypts under the current (highest) key version. */
  encrypt(plaintext: string): { ciphertext: string; keyVersion: number } {
    const key = this.keysByVersion.get(this.currentVersion)!;
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, encrypted]).toString('base64'),
      keyVersion: this.currentVersion,
    };
  }

  /** Decrypts under whichever key version the row was originally
   * encrypted with — never assumes "current". */
  decrypt(ciphertext: string, keyVersion: number): string {
    const key = this.keysByVersion.get(keyVersion);
    if (!key) {
      throw new Error(`No encryption key configured for version ${keyVersion} — check PLUGIN_SECRET_ENCRYPTION_KEYS`);
    }
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }
}
