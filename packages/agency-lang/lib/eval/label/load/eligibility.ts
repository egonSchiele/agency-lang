import type { IngestSkip, IngestSkipReason } from "./types.js";

export type EligibilityLimits = {
  maxBytes: number;
};

/**
 * One policy, applied by every loader to whatever text it produces.
 *
 * An empty string in a JSON array is exactly as unlabelable as an empty file,
 * so files and array elements go through the same gate rather than each loader
 * inventing its own rules.
 */
export function checkEligibility(
  text: string,
  limits: EligibilityLimits,
): IngestSkipReason | undefined {
  if (text.trim().length === 0) {
    return "empty";
  }
  // Bytes, not characters: a cap measured in code points lets multi-byte text
  // through at several times the intended size.
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
    return "too-large";
  }
  return undefined;
}

/** Decode with `fatal: true`. Node's default substitutes U+FFFD for invalid
 *  bytes, which would let a corrupted file through as text that hashes to a
 *  stable, meaningless id. */
export function decodeUtf8Strict(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const SKIP_DESCRIPTIONS: Record<IngestSkipReason, string> = {
  empty: "empty or whitespace only, so there is nothing to judge.",
  "too-large":
    "larger than the size cap. Raise it with --max-bytes if this is real output.",
  "not-utf8": "not valid UTF-8. A binary file swept up by a broad glob?",
  symlink: "a symbolic link. Links are skipped: they make the item key ambiguous.",
  "run-failed":
    "the run failed. A failed run's salvaged record is evidence for diagnosis, not a result to judge.",
  "trace-unfinished":
    "the trace never reached its end (it was interrupted or killed mid-run), so its output is not final.",
  "record-unreadable": "no readable eval record for this input.",
  "legacy-record":
    "the record predates recorded eval outputs. Recapture the run; there is no way to say which output was final.",
  "missing-trace-id":
    "the record has no trace id, so this observation has no stable identity across recapture.",
  "invalid-task": "the input's task is missing or is not JSON data.",
  "no-output":
    "no output was recorded, so there is nothing to judge. Filesystem-oriented runs legitimately have none.",
  "truncated-output":
    "the recorded output is truncated, and a label on a truncation is not a judgement of the output. " +
    "Recapture with a larger STATELOG_EVAL_MAX_VALUE_BYTES.",
};

export function describeIngestSkip(skip: IngestSkip): string {
  return `${skip.item}: ${SKIP_DESCRIPTIONS[skip.reason]}`;
}
