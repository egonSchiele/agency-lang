import crypto from "crypto";
import { _getSecret, _setSecret, _isKeyringAvailable } from "./keyring.js";

const KEYRING_KEY = "oauth-encryption-key";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Get or create the encryption key for OAuth token files.
 * Priority: AGENCY_OAUTH_KEY env var > system keyring > null (plaintext fallback)
 */
export async function getEncryptionKey(): Promise<Buffer | null> {
  // 1. Check env var
  const envKey = process.env.AGENCY_OAUTH_KEY;
  if (envKey) {
    // Derive a 256-bit key from the env var using SHA-256
    return crypto.createHash("sha256").update(envKey).digest();
  }

  // 2. Try system keyring
  if (await _isKeyringAvailable()) {
    const stored = await _getSecret(KEYRING_KEY);
    if (stored) {
      return Buffer.from(stored, "hex");
    }

    // Generate and store a new key
    const newKey = crypto.randomBytes(32);
    await _setSecret(KEYRING_KEY, newKey.toString("hex"));
    return newKey;
  }

  // 3. No encryption available
  return null;
}

/**
 * Encrypt a string using AES-256-GCM.
 * Returns a base64-encoded string containing: iv + ciphertext + auth tag
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: iv (12) + tag (16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded string that was encrypted with encrypt().
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
