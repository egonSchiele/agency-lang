// Copied from packages/kokoro/src/ffmpeg.ts, with pcm and wav output and a
// speed filter added. Kokoro still uses its own copy; see
// docs/dev/llm/local-speech.md.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { readBytes, remove, root, stat } from "./contained.js";
import { throwAbortReason } from "./abortReason.js";

export const TRANSCODE_FORMATS = ["wav", "mp3", "m4a", "pcm"] as const;
export type TranscodeFormat = (typeof TRANSCODE_FORMATS)[number];

/** Plenty for speech, and a fraction of the WAV size. */
export const BITRATE = "96k";
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

function installHint(): string {
  switch (process.platform) {
    case "darwin":
      return "Install it with: brew install ffmpeg";
    case "linux":
      return "Install it with: apt install ffmpeg, or your distribution's equivalent";
    case "win32":
      return "Install it from https://ffmpeg.org/download.html and put it on PATH";
    default:
      return "Install ffmpeg and put it on PATH";
  }
}

/** Throws when ffmpeg is not on PATH. Called before any interrupt, so
 *  nobody approves a file that cannot be written. */
export function assertFfmpegAvailable(): void {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new FfmpegError(
      `ffmpeg is needed to write mp3 or m4a files, or to change the speed, and it is not on PATH. ` +
        `${installHint()}. Or choose the wav format at speed 1.`,
    );
  }
}

const OUTPUT_ARGS: Record<TranscodeFormat, string[]> = {
  mp3: ["-codec:a", "libmp3lame", "-b:a", BITRATE],
  m4a: ["-codec:a", "aac", "-b:a", BITRATE, "-movflags", "+faststart"],
  // No LIST/INFO chunk, so the file is the header plus the samples.
  wav: ["-codec:a", "pcm_s16le", "-bitexact", "-map_metadata", "-1"],
  // ffmpeg cannot tell raw samples from a .pcm extension.
  pcm: ["-f", "s16le", "-codec:a", "pcm_s16le"],
};

/** Arguments that read a WAV stream from stdin, change its speed when
 *  `speed` is not 1, and write `outputFile`. The output path is one this
 *  module chose, never the caller's. */
export function buildTranscodeArgs(
  format: TranscodeFormat,
  speed: number,
  outputFile: string,
): string[] {
  const filter = speed === 1 ? [] : ["-filter:a", `atempo=${speed}`];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "wav",
    "-i",
    "pipe:0",
    ...filter,
    ...OUTPUT_ARGS[format],
    "-y",
    outputFile,
  ];
}

/** The bytes of `wav` at `speed`, encoded as `format`. ffmpeg writes a temp
 *  file, because the m4a container needs a seekable output. The file is
 *  read back through the contained helpers, which refuse a symlink, and it
 *  is removed whether or not encoding succeeds. */
export async function transcode(
  wav: Uint8Array,
  format: TranscodeFormat,
  speed: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const tmp = root(os.tmpdir());
  const name = `agency-speech-encode-${randomUUID()}.${format}`;
  const outputFile = path.join(tmp.real, name);
  try {
    await runFfmpeg(buildTranscodeArgs(format, speed, outputFile), wav, signal);
    return new Uint8Array(readBytes(tmp, name));
  } finally {
    if (stat(tmp, name) !== null) {
      remove(tmp, name);
    }
  }
}

function runFfmpeg(args: string[], input: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throwAbortReason(signal);
  }
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  const stderr: Buffer[] = [];
  proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  // ffmpeg closes stdin early when it rejects the input. The exit code
  // reports that; the write error is noise.
  proc.stdin!.on("error", () => undefined);
  proc.stdin!.end(Buffer.from(input));

  let killReason: string | null = null;
  const kill = (reason: string): void => {
    if (killReason === null) {
      killReason = reason;
      proc.kill("SIGKILL");
    }
  };
  const timer = setTimeout(
    () => kill(`ffmpeg exceeded ${FFMPEG_TIMEOUT_MS} ms`),
    FFMPEG_TIMEOUT_MS,
  );
  const onAbort = (): void => kill("cancelled");
  signal.addEventListener("abort", onAbort, { once: true });

  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    proc.on("error", (err: NodeJS.ErrnoException) => {
      finish();
      if (err.code === "ENOENT") {
        reject(new FfmpegError(`ffmpeg is not on PATH. ${installHint()}`));
      } else {
        reject(new FfmpegError(`failed to start ffmpeg: ${err.message}`));
      }
    });
    proc.on("close", (code: number | null) => {
      finish();
      if (signal.aborted) {
        try {
          throwAbortReason(signal);
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (killReason !== null) {
        reject(new FfmpegError(killReason));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new FfmpegError(`ffmpeg exited with code ${code}: ${detail}`));
        return;
      }
      resolve();
    });
  });
}
