// Copied from packages/kokoro/src/ffmpeg.ts, with pcm and wav output and a
// speed filter added.
// spawnSync for the probe only: it runs before any interrupt, inside a
// synchronous check, and the host runs nothing synchronously.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { Host, RunResult } from "../host/host.js";
import { program } from "./abortable.js";
import { throwAbortReason } from "./abortReason.js";

export const TRANSCODE_FORMATS = ["wav", "mp3", "m4a", "pcm"] as const;
export type TranscodeFormat = (typeof TRANSCODE_FORMATS)[number];

/** Plenty for speech, and a fraction of the WAV size. */
export const BITRATE = "96k";
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
/** The probe blocks the event loop, so it gets a short limit. */
const PROBE_TIMEOUT_MS = 5000;

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
  const probe = spawnSync("ffmpeg", ["-version"], {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new FfmpegError(`ffmpeg -version did not finish within ${PROBE_TIMEOUT_MS} ms.`);
  }
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
 *  read back through the host's files, which refuse a symlink, and it is
 *  removed whether or not encoding succeeds. */
export async function transcode(
  host: Host,
  wav: Uint8Array,
  format: TranscodeFormat,
  speed: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const { files } = host;
  const tmp = await files.root(os.tmpdir());
  const name = `agency-speech-encode-${randomUUID()}.${format}`;
  const outputFile = await files.resolvePath(tmp, name);
  try {
    await runFfmpeg(host, buildTranscodeArgs(format, speed, outputFile), wav, signal);
    return await files.readBytes(tmp, name);
  } finally {
    if ((await files.stat(tmp, name)) !== null) {
      await files.remove(tmp, name);
    }
  }
}

async function runFfmpeg(
  host: Host,
  args: string[],
  input: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throwAbortReason(signal);
  }
  let result: RunResult;
  try {
    result = await host.subprocess.run(program("ffmpeg", args), {
      input,
      signal,
      timeoutMs: FFMPEG_TIMEOUT_MS,
      killSignal: "SIGKILL",
      collect: { stdout: false, stderr: true },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FfmpegError(`ffmpeg is not on PATH. ${installHint()}`);
    }
    throw new FfmpegError(`failed to start ffmpeg: ${(err as Error).message}`);
  }
  if (signal.aborted) {
    throwAbortReason(signal);
  }
  if (result.timedOut) {
    throw new FfmpegError(`ffmpeg exceeded ${FFMPEG_TIMEOUT_MS} ms`);
  }
  if (result.exitCode !== 0) {
    throw new FfmpegError(`ffmpeg exited with code ${result.exitCode}: ${result.stderr.trim()}`);
  }
}
