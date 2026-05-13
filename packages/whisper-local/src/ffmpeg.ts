import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

export function buildFfmpegArgs(filepath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
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

export async function decodeToPcm(filepath: string): Promise<Float32Array> {
  const args = buildFfmpegArgs(filepath);
  const proc = spawn("ffmpeg", args);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  proc.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
  proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

  return new Promise<Float32Array>((resolve, reject) => {
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new FfmpegError(`ffmpeg not found on PATH. ${ffmpegInstallHint()}`),
        );
      } else {
        reject(new FfmpegError(`failed to spawn ffmpeg: ${err.message}`));
      }
    });
    proc.on("close", (code: number | null) => {
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
      // Copy bytes into a fresh Float32Array (rather than wrapping the
      // underlying buffer) to handle the case where the buffer offset isn't
      // 4-byte aligned, which is rare but possible after Buffer.concat.
      const f32 = new Float32Array(buf.byteLength / 4);
      for (let i = 0; i < f32.length; i++) {
        f32[i] = buf.readFloatLE(i * 4);
      }
      resolve(f32);
    });
  });
}
