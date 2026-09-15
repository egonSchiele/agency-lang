import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { remove, root, stat } from "agency-lang/stdlib-lib/contained.js";
import { throwAbortReason } from "agency-lang/stdlib-lib/speech.js";
import type { AudioFormat } from "./audioFormat.js";

export type EncodedFormat = Exclude<AudioFormat, "wav">;

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

/** Throws when ffmpeg is not on PATH. `speak` calls this before it raises
 *  any interrupt, so nobody approves a file that cannot be written. */
export function assertFfmpegAvailable(): void {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (probe.error !== undefined) {
    throw new FfmpegError(
      `ffmpeg is needed to write mp3 and m4a files, and it is not on PATH. ${installHint()}. ` +
        `Or choose the wav format.`,
    );
  }
}

/** Arguments that read a WAV stream from stdin and write `outputFile`.
 *  The output path is one this package chose, never the caller's. */
export function buildEncodeArgs(format: EncodedFormat, outputFile: string): string[] {
  const codec =
    format === "mp3" ? ["-codec:a", "libmp3lame"] : ["-codec:a", "aac", "-movflags", "+faststart"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "wav",
    "-i",
    "pipe:0",
    ...codec,
    "-b:a",
    BITRATE,
    "-y",
    outputFile,
  ];
}

/** The bytes of `wav` encoded as `format`. ffmpeg writes a temp file,
 *  because the m4a container needs a seekable output. The temp file is
 *  removed whether or not encoding succeeds. */
export async function encodeWithFfmpeg(
  wav: Uint8Array,
  format: EncodedFormat,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const tmp = root(os.tmpdir());
  const name = `agency-kokoro-encode-${randomUUID()}.${format}`;
  const outputFile = path.join(tmp.real, name);
  try {
    await runFfmpeg(buildEncodeArgs(format, outputFile), wav, signal);
    return new Uint8Array(await fs.readFile(outputFile));
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
  const timer = setTimeout(() => kill(`ffmpeg exceeded ${FFMPEG_TIMEOUT_MS} ms`), FFMPEG_TIMEOUT_MS);
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
