import { defaultHost } from "#default-host";
import { canonicalize } from "@/utils/canonicalize.js";
import { hmacSha256, toHex } from "@/utils/hash.js";
import type { HostSettings } from "../host/host.js";
import { utf8ByteLength } from "../stdlib/base64.js";
import type { Checkpoint, CheckpointJSON } from "./state/checkpointStore.js";

/** Both shapes a checkpoint travels as: the live class instance, and the
 *  plain parsed JSON the external resume path carries. */
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

/** Read the signing key from the host's settings. null = not configured
 *  (signing off). */
function resolveKey(settings: HostSettings): string | null {
  const raw = settings.read(KEY_ENV_VAR);
  if (raw === null || raw === "") {
    return null;
  }
  if (utf8ByteLength(raw) < MIN_KEY_BYTES) {
    throw new CheckpointKeyTooShortError(utf8ByteLength(raw));
  }
  return raw;
}

/** Retired keys accepted at verify time only: comma-separated, each subject to
 *  the same minimum length. Rotation = move the old key here, sign with a new
 *  one; outstanding checkpoints keep verifying. Nothing ever signs with these. */
function resolveOldKeys(settings: HostSettings): string[] {
  const raw = settings.read(OLD_KEYS_ENV_VAR);
  if (raw === null || raw === "") {
    return [];
  }
  return raw.split(",").map((candidate) => {
    if (utf8ByteLength(candidate) < MIN_KEY_BYTES) {
      throw new CheckpointKeyTooShortError(utf8ByteLength(candidate));
    }
    return candidate;
  });
}

/** The plain-object form, whichever shape it arrived in. Duck-typed on
 *  `toJSON` so this module never imports the class value (checkpointStore
 *  imports this module). */
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
  return toHex(hmacSha256(key, canonicalString(cp)));
}

/** Whether two strings are equal, taking the same time for every pair of
 *  the same length, so the time taken says nothing about where the first
 *  difference is. The lengths are compared first; a signature is always
 *  64 hex characters, so a length mismatch gives nothing away. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function macMatches(cp: SignableCheckpoint, signature: string, key: string): boolean {
  // Hex is hex in either case.
  return constantTimeEqual(computeMac(cp, key), signature.toLowerCase());
}

/** Embed a checksum in `cp.signature` when `settings`, the settings of the
 *  run's host, hold a key; no-op otherwise. The caller passes the host's
 *  settings because signing happens after awaits, where the current run
 *  cannot be read. */
export function signCheckpoint(cp: SignableCheckpoint, settings: HostSettings): void {
  const key = resolveKey(settings);
  if (key === null) {
    return;
  }
  cp.signature = computeMac(cp, key);
}

/** True iff `cp` carries a signature valid under the configured key or one of
 *  the retired keys in AGENCY_CHECKPOINT_KEY_OLD, compared in constant time.
 *  False if the signature is absent, matches no key, or no key is configured —
 *  a stripped signature therefore reads as NOT verified (downgrade guard).
 *  The keys come from `settings`: the run's host inside the runtime, and the
 *  platform's default host (the environment, on Node) for a host that
 *  verifies a checkpoint outside any run. */
export function verifyCheckpointChecksum(
  cp: SignableCheckpoint,
  settings: HostSettings = defaultHost().settings,
): boolean {
  const key = resolveKey(settings);
  const signature = cp.signature;
  if (key === null || signature === undefined) {
    return false;
  }
  if (macMatches(cp, signature, key)) {
    return true;
  }
  return resolveOldKeys(settings).some((oldKey) => macMatches(cp, signature, oldKey));
}
