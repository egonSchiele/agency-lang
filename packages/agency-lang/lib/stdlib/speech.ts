import { spawn } from "child_process";
import { performance } from "node:perf_hooks";
import { nanoid } from "nanoid";
import os from "os";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";
import { abortableExec } from "./abortable.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { assertContained } from "./assertContained.js";
import {
  root,
  wholePath,
  fixedPath,
  resolveUnder,
  stat as statUnder,
  remove,
  readStream,
  writeText,
  writeBytes,
} from "./contained.js";
import {
  meteredDispatch,
  recordUsage,
  recordUnresolvedAttempt,
} from "../runtime/recordPaidUsage.js";
import { addTokens } from "../runtime/cost.js";
import { projectProviderTokenUsage } from "../runtime/invocationUsage.js";
import { SPEAK_FORMATS, SPEECH_FORMAT_TO_MIME, type SpeakFormat } from "../runtime/audioFormats.js";
import { PROMPT_PREVIEW_MAX } from "../statelogClient.js";
import { _resolveModel, _mlxServedName } from "./localModels.js";
import { mlxBaseUrl } from "./mlxServerModels.js";
import { sentencePieces } from "./speechPieces.js";
import { wavFile, concatBytes } from "./wavFile.js";
import type { Result } from "smoltalk";
import type {
  AudioInput,
  LLMClient,
  SpeakConfig,
  SpeechResult,
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
    const tmpDir = root(os.tmpdir());
    const tmpName = `agency-speak-${nanoid()}.txt`;
    const tmpFile = path.join(tmpDir.real, tmpName);
    // Only a file this call created is removed afterwards. A create that
    // fails because the name was taken must not delete someone else's file.
    let owned = false;
    try {
      writeText(tmpDir, tmpName, text, { mode: "create-only" });
      owned = true;
      const args: string[] = ["-f", tmpFile];
      if (voice !== "") {
        args.push("-v", voice);
      }
      if (rate > 0) {
        args.push("-r", String(rate));
      }
      if (outputFile !== "") {
        args.push("-o", await outputPath(outputFile, allowedPaths));
      }
      await abortableExec("say", args, ctx.getAbortSignal(stack));
    } finally {
      if (owned) {
        try {
          remove(tmpDir, tmpName);
        } catch {}
      }
    }
  } else {
    console.error(
      `speak is not supported on platform: ${platform}. ` + `Supported platforms: macOS.`,
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
        "so that Enter can stop the recording. Either run in a TTY or set a positive silenceTimeout.",
    );
  }

  const outPath = outputFile
    ? await outputPath(outputFile, allowedPaths)
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
      if (!outputFile) removeQuietly(outPath);
      reject(
        new Error(
          `Failed to start 'rec' command: ${err.message}. ` +
            `Make sure SoX is installed (e.g. 'brew install sox' on macOS, 'apt install sox' on Linux).`,
        ),
      );
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      cleanupStdin(onData);
      if (cancelled) {
        if (!outputFile) removeQuietly(outPath);
        reject(new AgencyCancelledError("record cancelled"));
        return;
      }
      if (code !== 0 && code !== null && !stoppedByUser) {
        if (!outputFile) removeQuietly(outPath);
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

/** An output file an external program will write: a whole path the
 *  interrupt named, checked against the program's own allow-list, whose
 *  final name is never followed. */
export async function outputPath(
  outputFile: string,
  allowedPaths: string[] | undefined,
): Promise<string> {
  await assertContained(outputFile, allowedPaths ?? []);
  const located = fixedPath(outputFile);
  return resolveUnder(located.root, located.target);
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
 *  string/object/null reason can matter to cancellation handling). Only
 *  synthesize an error when the reason is genuinely `undefined` (an explicit
 *  `null` is a valid reason and is preserved). */
export function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason !== undefined) {
    throw signal.reason;
  }
  throw new AgencyCancelledError("operation cancelled");
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
function normalizeFormat<T extends string>(format: string, allowed: readonly T[], name: string): T {
  const normalized = format.toLowerCase().replace(/^\./, "");
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new Error(`${name}: unsupported format "${format}" (supported: ${allowed.join(", ")}).`);
  }
  return normalized as T;
}

function normalizeSpeakFormat(format: string): SpeakFormat {
  return normalizeFormat(format, SPEAK_FORMATS, "speak");
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

  // Local preflight before the metered boundary, so a missing path never
  // looks like paid work. A symlink at the final name is reported missing.
  // The client then opens the pathname itself, so it can apply its size cap
  // before reading. That leaves the check-then-open window that
  // docs/dev/stdlib/contained-files.md describes for pathname operations.
  await assertContained(filepath, allowedPaths ?? []);
  const located = fixedPath(filepath);
  const resolvedPath = resolveUnder(located.root, located.target);
  const info = statUnder(located.root, located.target);
  if (info === null) {
    throw new Error(`transcribe: no such file: ${resolvedPath}`);
  }
  if (!info.isFile()) {
    throw new Error(`transcribe: not a regular file: ${resolvedPath}`);
  }
  // Readability preflight: opening the file here throws EACCES before any
  // paid dispatch, and validates the descriptor the way every read does.
  readStream(located.root, located.target).destroy();

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
 * Publish synthesized audio to `finalPath` without overwriting an existing
 * file. `create-only` writes the whole file beside the target and links it
 * into place, so the target appears complete or not at all, and a file that
 * appeared after the preflight makes the publish fail rather than be
 * replaced. Cancellation is checked last, right before the write.
 */
export async function publishSpeechOutput(
  finalPath: string,
  audio: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const located = fixedPath(finalPath);
  if (signal.aborted) throwAbortReason(signal);
  writeBytes(located.root, located.target, Buffer.from(audio), { mode: "create-only" });
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

  const client = speakClient();
  const config: SpeakConfig = {
    model,
    voice,
    format: canonicalFormat,
    speed,
  };
  if (provider) config.provider = provider;
  if (apiKey) config.apiKey = { openAi: apiKey };

  return synthesizeToFile({
    name: "speak",
    text,
    outputFile,
    format: canonicalFormat,
    allowedPaths,
    model,
    voice,
    produce: (signal) => client.speak!(text, config, signal),
  });
}

/** The active client's speak, or a clear error when it has none. */
function speakClient(): LLMClient {
  const client = getRuntimeContext().ctx.llmClient;
  if (!client.speak) {
    throw new Error(
      "The active LLM client does not support text-to-speech. Use the default client or register one with speak() support.",
    );
  }
  return client;
}

/** What one synthesis needs from its caller: the words for the trace, where
 *  the file goes, and how to produce the audio. `produce` runs inside the
 *  metered dispatch, so however many requests it makes count as one. */
type Synthesis = {
  /** For messages: "speak" or "speakLocal". */
  name: string;
  text: string;
  outputFile: string;
  format: SpeakFormat;
  allowedPaths: string[];
  /** What the usage record and the trace name. */
  model: string;
  voice: string;
  produce: (signal: AbortSignal) => Promise<Result<SpeechResult>>;
};

/** The file, accounting and publish steps both speak paths share. Resolves +
 *  authorizes the output path and refuses to overwrite an existing file
 *  BEFORE any dispatch, then accounts the work and publishes atomically. */
async function synthesizeToFile(s: Synthesis): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) throwAbortReason(signal); // preflight: no dispatch

  // Resolve + authorize the destination. An empty outputFile auto-generates a
  // runtime-owned temp path (exempt from allowedPaths, like record()).
  let finalPath: string;
  if (s.outputFile) {
    finalPath = await outputPath(s.outputFile, s.allowedPaths);
    const explicitExt = path.extname(finalPath).replace(/^\./, "").toLowerCase();
    if (explicitExt && explicitExt !== s.format) {
      throw new Error(
        `${s.name}: output file extension ".${explicitExt}" does not match format "${s.format}".`,
      );
    }
  } else {
    // The real spelling of the temp dir, so the no-follow check below sees
    // no link in it (/var is a link on macOS).
    finalPath = path.join(root(os.tmpdir()).real, `agency-tts-${nanoid()}.${s.format}`);
  }
  // No-clobber preflight: new speech output never overwrites an existing file.
  if (await pathExists(finalPath)) {
    throw new Error(`${s.name}: output file already exists: ${finalPath}`);
  }

  const start = performance.now();
  const result = await meteredDispatch(ctx, stack, "speech", () => s.produce(signal));
  const timeTaken = performance.now() - start;

  if (!result.success) {
    recordUnresolvedAttempt(ctx, stack, "speech");
    throw new Error(`${s.name} failed: ${result.error}`);
  }
  const speech = result.value;

  // Account + trace the paid work BEFORE guards, and BEFORE any file mechanics,
  // so a later write failure or MIME mismatch never un-bills real spend.
  recordUsage(ctx, stack, {
    type: "provider",
    kind: "speech",
    configuredModel: s.model,
    cost: speech.cost,
    tokens: undefined, // TTS is per-character; no token usage
  });
  ctx.statelogClient.speechSynthesis({
    textPreview: s.text.slice(0, PROMPT_PREVIEW_MAX),
    model: s.model,
    voice: s.voice,
    format: s.format,
    timeTaken,
    cost: projectStatelogCost(speech.cost),
  });
  stack.enforceGuards(); // LAST accounting gate — a trip means no file is written

  const expectedMime = SPEECH_FORMAT_TO_MIME[s.format];
  if (speech.mimeType !== expectedMime) {
    // Usage is already accounted; we simply do not publish a mismatched artifact.
    throw new Error(
      `${s.name}: provider returned "${speech.mimeType}" but format "${s.format}" expects "${expectedMime}".`,
    );
  }

  await publishSpeechOutput(finalPath, speech.audio, signal);
  return finalPath;
}

/** Formats a local model can write. WAV is the server's PCM with a header
 *  added here; anything else would need ffmpeg, which core does not have. */
const LOCAL_SPEECH_FORMATS = ["wav", "pcm"] as const;
type LocalSpeechFormat = (typeof LOCAL_SPEECH_FORMATS)[number];

/** The most text one request to the local server carries. A cancelled call
 *  holds the server for at most one piece. */
export const LOCAL_PIECE_CHARS = 500;

/** The sample rate to write in the header. smoltalk reports 24000 for every
 *  pcm reply rather than reading the server's own rate, and both served
 *  families are 24 kHz. */
const DEFAULT_SAMPLE_RATE = 24000;

/** Pre-interrupt validation hook for `std::speech.speakLocal` — see
 *  speech.agency. An unknown model or format never prompts. */
export function _validateSpeakLocalArgs(text: string, model: string, format: string): void {
  // Whitespace alone would pass the server's own check and publish an
  // empty file, so it is refused here, before anything prompts.
  if (text.trim() === "") {
    throw new Error("speakLocal text cannot be empty");
  }
  if (model === "") {
    throw new Error("speakLocal model cannot be empty");
  }
  const resolved = _resolveModel(model); // throws "Unknown local model" with the known names
  if (resolved.backend !== "mlx") {
    throw new Error(
      `speakLocal: "${model}" is a GGUF model. Local speech models are MLX models served by agency local serve --speech.`,
    );
  }
  normalizeFormat(format, LOCAL_SPEECH_FORMATS, "speakLocal");
}

/** True for the failure smoltalk returns when nothing listens at the base
 *  URL. */
function isNoServer(error: string): boolean {
  return /connection error|ECONNREFUSED|fetch failed/i.test(error);
}

/** The PCM of every piece, in order, and the sample rate for the header.
 *  Stops at the first failure or when the signal fires between pieces; a
 *  piece in flight is stopped by the signal itself. */
async function speakPieces(
  client: LLMClient,
  pieces: string[],
  config: SpeakConfig,
  signal: AbortSignal,
): Promise<Result<{ chunks: Uint8Array[]; sampleRate: number }>> {
  const chunks: Uint8Array[] = [];
  let sampleRate = DEFAULT_SAMPLE_RATE;
  for (const piece of pieces) {
    if (signal.aborted) {
      throwAbortReason(signal);
    }
    const result = await client.speak!(piece, config, signal);
    if (!result.success) {
      return result;
    }
    if (result.value.mimeType !== SPEECH_FORMAT_TO_MIME.pcm) {
      return {
        success: false,
        error: `provider returned "${result.value.mimeType}" for a pcm request.`,
      };
    }
    chunks.push(result.value.audio);
    sampleRate = result.value.pcm?.sampleRateHz ?? sampleRate;
  }
  return { success: true, value: { chunks, sampleRate } };
}

/** One SpeechResult from the pieces: a WAV with one header, or the raw PCM
 *  joined. The cost is zero; the server is on this machine. */
function assemble(
  chunks: Uint8Array[],
  sampleRate: number,
  format: LocalSpeechFormat,
): SpeechResult {
  const audio = format === "wav" ? wavFile(chunks, sampleRate) : concatBytes(chunks);
  return {
    audio,
    mimeType: SPEECH_FORMAT_TO_MIME[format],
    cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
  };
}

/**
 * Backs `std::speech.speakLocal`. Sends the text to the mlx provider in
 * pieces, asking for raw PCM for each, joins the samples, and writes the
 * file through the same accounting and publish path as `speak`.
 */
export async function _speakLocal(
  text: string,
  outputFile: string,
  model: string,
  voice: string,
  instructions: string,
  format: string,
  allowedPaths: string[],
): Promise<string> {
  // Again at the runtime boundary, for a direct or deterministic caller
  // that bypassed speech.agency's pre-interrupt check.
  _validateSpeakLocalArgs(text, model, format);
  const localFormat = normalizeFormat(format, LOCAL_SPEECH_FORMATS, "speakLocal");
  const resolved = _resolveModel(model);
  const client = speakClient();
  const baseUrl = mlxBaseUrl();
  const config: SpeakConfig = {
    model: _mlxServedName(resolved),
    voice,
    format: "pcm",
    provider: "mlx",
    baseUrl: { mlx: baseUrl },
  };
  if (instructions !== "") {
    config.instructions = instructions;
  }
  const pieces = sentencePieces(text, LOCAL_PIECE_CHARS);

  return synthesizeToFile({
    name: "speakLocal",
    text,
    outputFile,
    format: localFormat,
    allowedPaths,
    model,
    voice,
    produce: async (signal) => {
      const spoken = await speakPieces(client, pieces, config, signal);
      if (!spoken.success) {
        if (isNoServer(spoken.error)) {
          return {
            success: false,
            error: `no MLX server answered at ${baseUrl}. Start one with:\n  agency local serve --speech ${model}`,
          };
        }
        return spoken;
      }
      return {
        success: true,
        value: assemble(spoken.value.chunks, spoken.value.sampleRate, localFormat),
      };
    },
  });
}

/** True when `p` exists. A symlink at `p`, dangling or not, throws from
 *  `resolveUnder`, so paid synthesis never proceeds toward a commit that
 *  would be refused. */
export async function pathExists(p: string): Promise<boolean> {
  const located = fixedPath(p);
  resolveUnder(located.root, located.target);
  return statUnder(located.root, located.target) !== null;
}

/** Best-effort removal of a runtime-owned temp file. */
function removeQuietly(p: string): void {
  try {
    const located = wholePath(p);
    remove(located.root, located.target);
  } catch {}
}
