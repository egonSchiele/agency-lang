import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

// Default 10-minute wall clock per ffmpeg invocation. Overridable per-call so
// callers transcribing very long files can opt in to a higher cap.
export const DEFAULT_FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

// Default 2 GB cap on decoded PCM bytes (~2.4 hours of 16 kHz mono float32).
// Bounds memory growth on attacker-controlled or pathological input. Override
// per-call when intentionally transcribing very long audio.
export const DEFAULT_MAX_PCM_BYTES = 2 * 1024 * 1024 * 1024;

export type DecodeOptions = {
  timeoutMs?: number;
  maxPcmBytes?: number;
};

export function buildFfmpegArgs(filepath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    // Restrict ffmpeg to the local file protocol. Without this, a filepath of
    // "http://evil/x", "tcp://...", "concat:...", or "subfile,..." would make
    // ffmpeg perform outbound network requests or read arbitrary local files
    // outside the one we believe we're transcribing. Since transcribe() is
    // commonly called with LLM-driven tool arguments in Agency programs, this
    // matters: never let an attacker turn a transcription into a file read or
    // SSRF.
    "-protocol_whitelist",
    "file",
    "-i",
    filepath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "f32le",
    "-",
  ];
}

function ffmpegInstallHint(): string {
  switch (process.platform) {
    case "darwin":
      return "Install with: brew install ffmpeg";
    case "linux":
      return "Install with: apt install ffmpeg (or your distro's equivalent)";
    case "win32":
      return "Install from https://ffmpeg.org/download.html and ensure it's on PATH";
    default:
      return "Install ffmpeg and ensure it's on PATH";
  }
}

async function validateInputPath(filepath: string): Promise<void> {
  // Reject anything that looks like a CLI flag (e.g. "-version", "-i").
  // ffmpeg's positional input slot is occupied by the value after our literal
  // "-i", so a leading-dash filepath cannot smuggle a flag at *that*
  // position — but the `-protocol_whitelist file` argument earlier in the
  // command line still leaves us vulnerable to confused-deputy bugs if the
  // argument order ever changes. Reject up front; a real audio file never
  // starts with "-".
  if (filepath.startsWith("-")) {
    throw new FfmpegError(`refusing path that starts with '-': ${filepath}`);
  }
  let st;
  try {
    st = await fs.stat(filepath);
  } catch (err) {
    throw new FfmpegError(
      `input file not found or unreadable: ${filepath} (${(err as Error).message})`,
    );
  }
  if (!st.isFile()) {
    throw new FfmpegError(`input is not a regular file: ${filepath}`);
  }
}

export async function decodeToPcm(
  filepath: string,
  opts: DecodeOptions = {},
): Promise<Float32Array> {
  await validateInputPath(filepath);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  const maxPcmBytes = opts.maxPcmBytes ?? DEFAULT_MAX_PCM_BYTES;

  const args = buildFfmpegArgs(filepath);
  const proc = spawn("ffmpeg", args);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let oversizeRejected = false;

  // Force-kill the process and tag the rejection. SIGKILL (vs SIGTERM) is
  // intentional: a stuck or runaway ffmpeg may ignore TERM, and we'd rather
  // strand a partial decode than leave a zombie holding CPU.
  let killReason: string | null = null;
  const kill = (reason: string): void => {
    if (killReason) return;
    killReason = reason;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may already be gone; the close handler still fires.
    }
  };

  proc.stdout!.on("data", (c: Buffer) => {
    stdoutBytes += c.byteLength;
    if (stdoutBytes > maxPcmBytes && !oversizeRejected) {
      oversizeRejected = true;
      kill(
        `decoded output exceeded cap of ${maxPcmBytes} bytes ` +
          `(~${Math.round(maxPcmBytes / (16000 * 4))} seconds of audio at 16 kHz mono f32)`,
      );
      return;
    }
    stdoutChunks.push(c);
  });
  proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

  const timer = setTimeout(() => {
    kill(`ffmpeg exceeded timeout of ${timeoutMs} ms`);
  }, timeoutMs);

  return new Promise<Float32Array>((resolve, reject) => {
    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new FfmpegError(`ffmpeg not found on PATH. ${ffmpegInstallHint()}`),
        );
      } else {
        reject(new FfmpegError(`failed to spawn ffmpeg: ${err.message}`));
      }
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killReason !== null) {
        reject(new FfmpegError(killReason));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new FfmpegError(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const buf = Buffer.concat(stdoutChunks);
      if (buf.byteLength % 4 !== 0) {
        reject(
          new FfmpegError(
            `ffmpeg produced ${buf.byteLength} bytes, not a multiple of 4`,
          ),
        );
        return;
      }
      // Wrap the bytes as Float32 in one shot. This is ~100x faster than
      // looping with buf.readFloatLE(i) and is host-endian-safe on every
      // platform Node supports: V8 only ships on little-endian hosts (x86_64,
      // arm64, riscv64 in LE mode), and the f32le ffmpeg output we asked for
      // is also little-endian, so the two endiannesses match by construction.
      // We allocate a fresh ArrayBuffer because (a) it's guaranteed 4-byte
      // aligned, which Float32Array requires, and (b) Buffer.concat returns
      // memory whose byteOffset may not be aligned.
      const aligned = new ArrayBuffer(buf.byteLength);
      new Uint8Array(aligned).set(buf);
      const f32 = new Float32Array(aligned);
      resolve(f32);
    });
  });
}
