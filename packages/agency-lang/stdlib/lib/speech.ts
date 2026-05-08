import { execFile, spawn } from "child_process";
import { readFile, writeFile, unlink } from "fs/promises";
import { promisify } from "util";
import { nanoid } from "nanoid";
import os from "os";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";

const execFileAsync = promisify(execFile);

export async function _speak(text: string, voice: string, rate: number, outputFile: string): Promise<void> {
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
        args.push("-o", path.resolve(process.cwd(), outputFile));
      }
      await execFileAsync("say", args);
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

export async function _record(outputFile: string, silenceTimeout: number): Promise<string> {
  const outPath = outputFile || path.join(os.tmpdir(), `agency-rec-${nanoid()}.wav`);

  const args = [outPath];
  if (silenceTimeout > 0) {
    const seconds = String(silenceTimeout / 1000);
    args.push("silence", "1", "0.1", "3%", "1", seconds, "3%");
  }

  const proc = spawn("rec", args, { stdio: ["pipe", "pipe", "pipe"] });

  await new Promise<void>((resolve, reject) => {
    proc.on("error", (err) => {
      reject(new Error(
        `Failed to start 'rec' command: ${err.message}. ` +
        `Make sure SoX is installed (e.g. 'brew install sox' on macOS, 'apt install sox' on Linux).`
      ));
    });
    proc.on("close", () => resolve());

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        proc.kill("SIGTERM");
      });
    }
  });

  return outPath;
}

export async function _transcribe(filepath: string, language: string): Promise<string> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "transcribe requires an OPENAI_API_KEY environment variable to be set."
    );
  }

  const resolvedPath = path.resolve(process.cwd(), filepath);
  const fileData = await readFile(resolvedPath);
  const filename = path.basename(resolvedPath);

  const formData = new FormData();
  formData.append("file", new Blob([fileData]), filename);
  formData.append("model", "whisper-1");
  if (language !== "") {
    formData.append("language", language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.json();
    const message = errorBody?.error?.message ?? JSON.stringify(errorBody);
    throw new Error(`Whisper API error (${response.status}): ${message}`);
  }

  const result = await response.json();
  return result.text;
}
