import crypto from "crypto";
import type { Host } from "../host/host.js";
import { getSecret, setSecret, isKeyringAvailable, readSecret } from "./keyring.js";

const KEYRING_KEY = "oauth-encryption-key";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Get or create the encryption key for OAuth token files.
 * Priority: AGENCY_OAUTH_KEY env var > system keyring > null (plaintext fallback)
 * The keyring is reached through `host`, the run's host.
 */
export async function getEncryptionKey(host: Host): Promise<Buffer | null> {
  const envKey = process.env.AGENCY_OAUTH_KEY;
  if (envKey) {
    return crypto.createHash("sha256").update(envKey).digest();
  }

  if (await isKeyringAvailable(host)) {
    // A key that couldn't be read is not a missing key: making a new one
    // would overwrite it, and every saved token would no longer decrypt.
    // On Linux, `secret-tool` may answer a dismissed unlock prompt as it
    // answers a missing item, so there this guard may not hold.
    const stored = await readSecret(host, KEYRING_KEY);
    if (stored.kind === "failed") {
      throw new Error(`Couldn't read the OAuth key from the keyring: ${stored.reason}`);
    }
    if (stored.kind === "found" && stored.value) {
      const decoded = Buffer.from(stored.value, "hex");
      if (decoded.length !== KEY_LENGTH) {
        // Corrupted key — regenerate
        const newKey = crypto.randomBytes(KEY_LENGTH);
        await setSecret(host, KEYRING_KEY, newKey.toString("hex"));
        return newKey;
      }
      return decoded;
    }

    // Generate a new key, store it, then re-read to handle races
    const newKey = crypto.randomBytes(KEY_LENGTH);
    await setSecret(host, KEYRING_KEY, newKey.toString("hex"));

    // Re-read to converge on a single key if another process raced us
    const verify = await getSecret(host, KEYRING_KEY);
    if (verify) {
      return Buffer.from(verify, "hex");
    }
    return newKey;
  }

  return null;
}

/**
 * Encrypt a string using AES-256-GCM.
 * Returns a base64-encoded string: iv (12 bytes) + auth tag (16 bytes) + ciphertext
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded string produced by encrypt().
 * Layout: iv (12 bytes) + auth tag (16 bytes) + ciphertext
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const packed = Buffer.from(ciphertext, "base64");

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted token data (too short).");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf-8");
}
