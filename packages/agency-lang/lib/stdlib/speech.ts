import { spawn } from "child_process";
import { constants as fsConstants } from "fs";
import { writeFile, unlink, lstat, access, link, open } from "fs/promises";
import { performance } from "node:perf_hooks";
import { nanoid } from "nanoid";
import os from "os";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";
import { abortableExec } from "./abortable.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { resolveDir } from "./resolveDir.js";
import {
  meteredDispatch,
  recordUsage,
  recordUnresolvedAttempt,
} from "../runtime/recordPaidUsage.js";
import { addTokens } from "../runtime/cost.js";
import { projectProviderTokenUsage } from "../runtime/invocationUsage.js";
import {
  SPEAK_FORMATS,
  SPEECH_FORMAT_TO_MIME,
  isSpeakFormat,
  type SpeakFormat,
} from "../runtime/audioFormats.js";
import { PROMPT_PREVIEW_MAX } from "../statelogClient.js";
import type {
  AudioInput,
  SpeakConfig,
  TranscribeConfig,
} from "../runtime/llmClient.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";

/** TTS speed bounds (OpenAI). Validated before the interrupt in speech.agency
 *  and again defensively at the runtime boundary for direct/deterministic callers. */
const MIN_SPEECH_SPEED = 0.25;
const MAX_SPEECH_SPEED = 4;

/** Transcription timestamp granularities `std::speech.transcribe` accepts;
 *  `""` requests none. */
const TRANSCRIBE_GRANULARITIES = ["", "segment", "word"] as const;

/**
 * `say` blocks until the whole utterance has been spoken, which can be
 * many seconds. SIGTERM stops playback immediately on Ctrl-C /
 * race-loser / time-guard abort.
 */
async function speakImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  text: string,
  voice: string,
  rate: number,
  outputFile: string,
  allowedPaths?: string[],
): Promise<void> {
  if (text === "") return;

  const platform = await detectPlatform();
  if (platform === "macos") {
    const tmpFile = path.join(os.tmpdir(), `agency-speak-${nanoid()}.txt`);
    try {
      await writeFile(tmpFile, text, "utf8");
      const args: string[] = ["-f", tmpFile];
      if (voice !== "") {
        args.push("-v", voice);
      }
      if (rate > 0) {
        args.push("-r", String(rate));
      }
      if (outputFile !== "") {
        // `resolveDir` (cwd-anchored) handles `~` expansion + allow-list
        // enforcement uniformly with the fs.ts call sites.
        const outPath = await resolveDir(outputFile, allowedPaths ?? []);
        args.push("-o", outPath);
      }
      await abortableExec("say", args, ctx.getAbortSignal(stack));
    } finally {
      try { await unlink(tmpFile); } catch {}
    }
  } else {
    console.error(
      `speak is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS.`
    );
  }
}

/** Backs `std::speech.say` (local macOS text-to-speech playback). */
export async function _say(
  text: string,
  voice: string,
  rate: number,
  outputFile: string,
  allowedPaths?: string[],
): Promise<void> {
  const { ctx, stack } = getRuntimeContext();
  return speakImpl(ctx, stack, text, voice, rate, outputFile, allowedPaths);
}

/**
 * A `record()` call without a `silenceTimeout` runs until the user
 * hits Enter (or the recording detects silence). Abort fires the same
 * teardown as the keypress path — kills `rec`, restores stdin out of
 * raw mode, releases stdin — and rejects with `AgencyCancelledError`.
 */
async function recordImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  outputFile: string,
  silenceTimeout: number,
  allowedPaths?: string[],
): Promise<string> {
  const isTTY = process.stdin.isTTY;

  if (silenceTimeout <= 0 && !isTTY) {
    throw new Error(
      "record() with silenceTimeout=0 requires an interactive terminal (TTY) " +
      "so that Enter can stop the recording. Either run in a TTY or set a positive silenceTimeout."
    );
  }

  const outPath = outputFile
    ? await resolveDir(outputFile, allowedPaths ?? [])
    : path.join(os.tmpdir(), `agency-rec-${nanoid()}.wav`);

  const args = [outPath];
  if (silenceTimeout > 0) {
    const seconds = String(silenceTimeout / 1000);
    args.push("silence", "1", "0.1", "3%", "1", seconds, "3%");
  }

  const proc = spawn("rec", args, { stdio: ["pipe", "ignore", "ignore"] });

  const cleanupStdin = (listener: (data: Buffer) => void) => {
    if (isTTY) {
      process.stdin.removeListener("data", listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };

  let stoppedByUser = false;
  let cancelled = false;
  const signal = ctx.getAbortSignal(stack);

  await new Promise<void>((resolve, reject) => {
    const onData = (data: Buffer) => {
      const key = data[0];
      // Only stop on Enter (CR or LF) or Ctrl+C
      if (key === 0x0d || key === 0x0a || key === 0x03) {
        stoppedByUser = true;
        cleanupStdin(onData);
        proc.kill("SIGTERM");
      }
    };

    const onAbort = () => {
      cancelled = true;
      cleanupStdin(onData);
      proc.kill("SIGTERM");
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      cleanupStdin(onData);
      if (!outputFile) unlink(outPath).catch(() => {});
      reject(new Error(
        `Failed to start 'rec' command: ${err.message}. ` +
        `Make sure SoX is installed (e.g. 'brew install sox' on macOS, 'apt install sox' on Linux).`
      ));
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      cleanupStdin(onData);
      if (cancelled) {
        if (!outputFile) unlink(outPath).catch(() => {});
        reject(new AgencyCancelledError("record cancelled"));
        return;
      }
      if (code !== 0 && code !== null && !stoppedByUser) {
        if (!outputFile) unlink(outPath).catch(() => {});
        reject(new Error(`'rec' exited with code ${code}`));
      } else {
        resolve();
      }
    });

    if (isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    }
  });

  return outPath;
}

/** Backs `std::speech.record`. */
export async function _record(
  outputFile: string,
  silenceTimeout: number,
  allowedPaths?: string[],
): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  return recordImpl(ctx, stack, outputFile, silenceTimeout, allowedPaths);
}

// === Cloud speech (STT / TTS) via the active LLM client ==================
//
// `transcribe` (STT) and `speak` (cloud TTS) route through `ctx.llmClient` the
// same way `std::image.generateImage` routes through `ctx.llmClient.image`
// (lib/stdlib/image.ts). That gives them cost accounting, spend guards, and
// statelog for free. Agency keeps ownership of the path allow-list and the
// approval interrupt (raised in speech.agency BEFORE these run); smoltalk owns
// provider mechanics, loading, size caps, and MIME.
//
// Both helpers THROW on failure (the std::speech / std::fs idiom) — a smoltalk
// failure Result becomes a thrown Error with its already-redacted message.

/** Throw the branch signal's abort reason UNCHANGED (identity preserved — a
 *  string/object reason can matter to cancellation handling). Only synthesize an
 *  error when the reason is genuinely absent. */
function throwAbortReason(signal: AbortSignal): never {
  throw signal.reason ?? new AgencyCancelledError("operation cancelled");
}

/** Strip cost to its total for statelog (never the raw provider cost object). */
function projectStatelogCost(cost: { totalCost?: number } | undefined) {
  if (!cost) return undefined;
  return { totalCost: cost.totalCost };
}

/** Normalize a caller-supplied format (case + a leading dot) to the canonical
 *  form, or throw if it is not a supported format. Used by the runtime helpers so
 *  a direct/deterministic caller cannot slip an unsupported format past the
 *  extension / MIME checks. */
function normalizeSpeakFormat(format: string): SpeakFormat {
  const normalized = format.toLowerCase().replace(/^\./, "");
  if (!isSpeakFormat(normalized)) {
    throw new Error(
      `speak: unsupported format "${format}" (supported: ${SPEAK_FORMATS.join(", ")}).`,
    );
  }
  return normalized;
}

/** Validate speak's format + speed. Runs BEFORE the interrupt (via
 *  `_validateSpeakArgs`) and again at the runtime boundary. */
function validateSpeakArgs(format: string, speed: number): void {
  normalizeSpeakFormat(format); // throws on an unsupported format
  if (!Number.isFinite(speed) || speed < MIN_SPEECH_SPEED || speed > MAX_SPEECH_SPEED) {
    throw new Error(
      `speak: speed must be a finite number in [${MIN_SPEECH_SPEED}, ${MAX_SPEECH_SPEED}] (got ${speed}).`,
    );
  }
}

/** Validate transcribe's timestamp granularity. */
function validateTranscribeGranularity(granularity: string): void {
  if (!(TRANSCRIBE_GRANULARITIES as readonly string[]).includes(granularity)) {
    throw new Error(
      `transcribe: timestampGranularity must be one of ${TRANSCRIBE_GRANULARITIES.map((g) => `"${g}"`).join(", ")} (got "${granularity}").`,
    );
  }
}

/** Pre-interrupt validation hook for `std::speech.speak` — see speech.agency. */
export function _validateSpeakArgs(format: string, speed: number): void {
  validateSpeakArgs(format, speed);
}

/** Pre-interrupt validation hook for `std::speech.transcribe` — see speech.agency. */
export function _validateTranscribeArgs(timestampGranularity: string): void {
  validateTranscribeGranularity(timestampGranularity);
}

/**
 * Backs `std::speech.transcribe` (speech-to-text). Resolves + authorizes the
 * audio path (Agency's allow-list) and verifies it is a readable regular file
 * BEFORE any paid dispatch — preserving today's local missing-file failure and
 * keeping it off the metered path. Then routes through `ctx.llmClient.transcribe`
 * with cost/guards/statelog. Throws on failure.
 */
export async function _transcribe(
  filepath: string,
  language: string,
  allowedPaths: string[],
  model: string,
  provider: string,
  prompt: string,
  timestampGranularity: string,
  apiKey: string,
): Promise<string> {
  validateTranscribeGranularity(timestampGranularity);

  const { ctx, stack } = getRuntimeContext();
  const client = ctx.llmClient;
  if (!client.transcribe) {
    throw new Error(
      "The active LLM client does not support transcription. Use the default client or register one with transcribe() support.",
    );
  }

  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) throwAbortReason(signal); // preflight: no dispatch

  // Local preflight — Agency's allow-list + a real, readable, regular file —
  // before the metered boundary, so a missing/unreadable path never looks like
  // paid work. `lstat` (no symlink follow) surfaces a dangling symlink here
  // rather than as a post-dispatch link() EEXIST; `access` proves readability,
  // which `stat`/`isFile` alone does not.
  const resolvedPath = await resolveDir(filepath, allowedPaths ?? []);
  const info = await lstat(resolvedPath); // throws ENOENT for a missing file
  if (!info.isFile()) {
    throw new Error(`transcribe: not a regular file: ${resolvedPath}`);
  }
  await access(resolvedPath, fsConstants.R_OK); // throws EACCES if unreadable

  const source: AudioInput = { kind: "path", path: resolvedPath };
  const config: TranscribeConfig = { model };
  if (provider) config.provider = provider;
  if (language) config.language = language;
  if (prompt) config.prompt = prompt;
  if (timestampGranularity) {
    config.timestampGranularity = timestampGranularity as "segment" | "word";
  }
  if (apiKey) config.apiKey = { openAi: apiKey };

  const start = performance.now();
  const result = await meteredDispatch(ctx, stack, "transcription", () =>
    client.transcribe!(source, config, signal),
  );
  const timeTaken = performance.now() - start;

  if (!result.success) {
    // Smoltalk never rejects; a resolved failure after entering the client
    // boundary is conservatively one unresolved paid attempt (plan §6).
    recordUnresolvedAttempt(ctx, stack, "transcription");
    throw new Error(`transcribe failed: ${result.error}`);
  }
  const tr = result.value;

  // One projection feeds the meter (via recordUsage), the branch total (addTokens),
  // and statelog — so they agree and no audio-token field leaks to a sink.
  const projected = projectProviderTokenUsage(tr.usage, "transcription").usage;
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "transcription",
    configuredModel: model,
    cost: tr.cost,
    tokens: tr.usage,
  });
  addTokens(projected.totalTokens);
  ctx.statelogClient.transcription({
    textPreview: tr.text.slice(0, PROMPT_PREVIEW_MAX),
    model,
    durationSeconds: tr.durationSeconds,
    timeTaken,
    usage: projected,
    cost: projectStatelogCost(tr.cost),
  });
  stack.enforceGuards(); // LAST — a trip still leaves spend accounted + traced
  return tr.text;
}

/**
 * Atomically publish synthesized audio to `finalPath` WITHOUT overwriting an
 * existing file. Writes to an exclusive invocation-owned sibling stage, checks
 * cancellation (the commit point), then `link()`s the stage onto `finalPath`
 * (fails with EEXIST rather than clobbering a file that appeared after
 * preflight). Cleanup removes only the owned stage. See plan §13.
 */
export async function publishSpeechOutput(
  finalPath: string,
  audio: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const dir = path.dirname(finalPath);
  const stage = path.join(
    dir,
    `.${path.basename(finalPath)}.agency-tts-${nanoid()}.part`,
  );
  // Open with "wx" FIRST and only mark ownership once the exclusive create
  // SUCCEEDS. A failed open (e.g. an EEXIST collision on an unowned path) must
  // never lead cleanup to delete a path we do not own. A create that succeeds
  // then fails mid-write (ENOSPC) leaves an owned partial stage that cleanup
  // must remove — hence ownership tracks the open, not the write.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(stage, "wx");
  } catch (openError) {
    throw openError; // never created the stage — nothing owned to clean up
  }
  try {
    await handle.writeFile(audio);
    await handle.close();
    if (signal.aborted) throwAbortReason(signal); // last abort check before commit
    await link(stage, finalPath); // atomic no-clobber commit (EEXIST if target appeared)
  } catch (primaryError) {
    await handle.close().catch(() => {}); // idempotent; already closed on the happy path
    try {
      await unlink(stage);
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Speech output failed and staging cleanup failed",
      );
    }
    throw primaryError;
  }
  // Committed: the published file is preserved even if removing the stage fails.
  try {
    await unlink(stage);
  } catch (cleanupError) {
    console.error(
      `Failed to remove published speech staging file '${stage}' for '${finalPath}'`,
      cleanupError,
    );
  }
}

/**
 * Backs `std::speech.speak` (cloud text-to-speech). Resolves + authorizes the
 * output path and refuses to overwrite an existing file BEFORE any paid
 * dispatch. Routes through `ctx.llmClient.speak` with cost/guards/statelog, then
 * publishes the audio atomically. Returns the output file path; throws on failure.
 */
export async function _synthesizeSpeech(
  text: string,
  outputFile: string,
  voice: string,
  model: string,
  provider: string,
  format: string,
  speed: number,
  allowedPaths: string[],
  apiKey: string,
): Promise<string> {
  // Normalize + validate before any work: an unsupported format or out-of-range
  // speed must never reach dispatch or publish a mislabeled artifact, even for a
  // direct/deterministic caller that bypassed speech.agency's pre-interrupt check.
  const canonicalFormat = normalizeSpeakFormat(format);
  validateSpeakArgs(canonicalFormat, speed);

  const { ctx, stack } = getRuntimeContext();
  const client = ctx.llmClient;
  if (!client.speak) {
    throw new Error(
      "The active LLM client does not support text-to-speech. Use the default client or register one with speak() support.",
    );
  }

  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) throwAbortReason(signal); // preflight: no dispatch

  // Resolve + authorize the destination. An empty outputFile auto-generates a
  // runtime-owned temp path (exempt from allowedPaths, like record()).
  let finalPath: string;
  if (outputFile) {
    finalPath = await resolveDir(outputFile, allowedPaths ?? []);
    const explicitExt = path.extname(finalPath).replace(/^\./, "").toLowerCase();
    if (explicitExt && explicitExt !== canonicalFormat) {
      throw new Error(
        `speak: output file extension ".${explicitExt}" does not match format "${canonicalFormat}".`,
      );
    }
  } else {
    finalPath = path.join(os.tmpdir(), `agency-tts-${nanoid()}.${canonicalFormat}`);
  }
  // No-clobber preflight: new speech output never overwrites an existing file.
  if (await pathExists(finalPath)) {
    throw new Error(`speak: output file already exists: ${finalPath}`);
  }

  const config: SpeakConfig = {
    model,
    voice,
    format: canonicalFormat,
    speed,
  };
  if (provider) config.provider = provider;
  if (apiKey) config.apiKey = { openAi: apiKey };

  const start = performance.now();
  const result = await meteredDispatch(ctx, stack, "speech", () =>
    client.speak!(text, config, signal),
  );
  const timeTaken = performance.now() - start;

  if (!result.success) {
    recordUnresolvedAttempt(ctx, stack, "speech");
    throw new Error(`speak failed: ${result.error}`);
  }
  const speech = result.value;

  // Account + trace the paid work BEFORE guards, and BEFORE any file mechanics,
  // so a later write failure or MIME mismatch never un-bills real spend.
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "speech",
    configuredModel: model,
    cost: speech.cost,
    tokens: undefined, // TTS is per-character; no token usage
  });
  ctx.statelogClient.speechSynthesis({
    textPreview: text.slice(0, PROMPT_PREVIEW_MAX),
    model,
    voice,
    format: canonicalFormat,
    timeTaken,
    cost: projectStatelogCost(speech.cost),
  });
  stack.enforceGuards(); // LAST accounting gate — a trip means no file is written

  const expectedMime = SPEECH_FORMAT_TO_MIME[canonicalFormat];
  if (speech.mimeType !== expectedMime) {
    // Usage is already accounted; we simply do not publish a mismatched artifact.
    throw new Error(
      `speak: provider returned "${speech.mimeType}" but format "${canonicalFormat}" expects "${expectedMime}".`,
    );
  }

  await publishSpeechOutput(finalPath, speech.audio, signal);
  return finalPath;
}

/** True when `p` exists (any kind, symlink NOT followed). Only a genuine
 *  ENOENT counts as "missing" and returns false; EACCES / ELOOP / I/O errors
 *  rethrow so paid synthesis never proceeds toward a predictably-failing commit,
 *  and a dangling symlink (which `stat` would mask as ENOENT) is surfaced. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
