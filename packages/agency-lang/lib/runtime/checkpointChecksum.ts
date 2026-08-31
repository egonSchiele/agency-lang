import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "@/utils/canonicalize.js";
import type { Checkpoint, CheckpointJSON } from "./state/checkpointStore.js";

/** Both shapes a checkpoint travels as: the live class instance, and the
 *  plain parsed JSON the external resume path carries (`interrupt.checkpoint`
 *  after a round trip is not a Checkpoint instance). */
export type SignableCheckpoint = Checkpoint | CheckpointJSON;

const DOMAIN = "agency.checkpoint.v1";
const KEY_ENV_VAR = "AGENCY_CHECKPOINT_KEY";
const OLD_KEYS_ENV_VAR = "AGENCY_CHECKPOINT_KEY_OLD";
const MIN_KEY_BYTES = 32;

/** Thrown only when a key is PRESENT but shorter than 32 bytes. An unset key
 *  is not an error — it means signing is off. */
export class CheckpointKeyTooShortError extends Error {
  constructor(bytes: number) {
    super(`Checkpoint key is ${bytes} bytes; at least ${MIN_KEY_BYTES} are required.`);
    this.name = "CheckpointKeyTooShortError";
  }
}

/** Read the signing key from the environment. null = not configured (signing off). */
function resolveKey(): string | null {
  const raw = process.env[KEY_ENV_VAR];
  if (raw === undefined || raw === "") {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") < MIN_KEY_BYTES) {
    throw new CheckpointKeyTooShortError(Buffer.byteLength(raw, "utf8"));
  }
  return raw;
}

/** Retired keys accepted at verify time only: comma-separated, each subject to
 *  the same minimum length. Rotation = move the old key here, sign with a new
 *  one; outstanding checkpoints keep verifying. Nothing ever signs with these. */
function resolveOldKeys(): string[] {
  const raw = process.env[OLD_KEYS_ENV_VAR];
  if (raw === undefined || raw === "") {
    return [];
  }
  return raw.split(",").map((candidate) => {
    if (Buffer.byteLength(candidate, "utf8") < MIN_KEY_BYTES) {
      throw new CheckpointKeyTooShortError(Buffer.byteLength(candidate, "utf8"));
    }
    return candidate;
  });
}

/** The plain-object form of a checkpoint, whichever shape it arrived in.
 *  Duck-typed on `toJSON` rather than `instanceof Checkpoint` so this module
 *  never imports the class value (checkpointStore imports this module). */
function checkpointJson(cp: SignableCheckpoint): Record<string, unknown> {
  const maybeInstance = cp as { toJSON?: () => CheckpointJSON };
  const json = typeof maybeInstance.toJSON === "function" ? maybeInstance.toJSON() : cp;
  return { ...(json as Record<string, unknown>) };
}

/** The exact bytes the MAC is computed over: the whole checkpoint minus its
 *  own signature field, canonicalized (`canonicalize` key-sorts at every
 *  depth, so a parsed-and-reserialized checkpoint hashes identically
 *  regardless of key order), prefixed with a domain tag. */
function canonicalString(cp: SignableCheckpoint): string {
  const json = checkpointJson(cp);
  delete json.signature;
  return DOMAIN + "\n" + canonicalize(json);
}

function computeMac(cp: SignableCheckpoint, key: string): string {
  return createHmac("sha256", key).update(canonicalString(cp)).digest("hex");
}

function macMatches(cp: SignableCheckpoint, signature: string, key: string): boolean {
  const expected = Buffer.from(computeMac(cp, key), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** Embed a checksum in `cp.signature` when a key is configured; no-op otherwise. */
export function signCheckpoint(cp: SignableCheckpoint): void {
  const key = resolveKey();
  if (key === null) {
    return;
  }
  cp.signature = computeMac(cp, key);
}

/** True iff `cp` carries a signature valid under the configured key or one of
 *  the retired keys in AGENCY_CHECKPOINT_KEY_OLD, compared in constant time.
 *  False if the signature is absent, matches no key, or no key is configured —
 *  a stripped signature therefore reads as NOT verified (downgrade guard). */
export function verifyCheckpointChecksum(cp: SignableCheckpoint): boolean {
  const key = resolveKey();
  const signature = cp.signature;
  if (key === null || signature === undefined) {
    return false;
  }
  if (macMatches(cp, signature, key)) {
    return true;
  }
  return resolveOldKeys().some((oldKey) => macMatches(cp, signature, oldKey));
}
