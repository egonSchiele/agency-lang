import { spawn } from "child_process";
import { readFile, writeFile, unlink } from "fs/promises";
import { nanoid } from "nanoid";
import os from "os";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";
import { abortableExec } from "./abortable.js";
import { runHttp } from "./http.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

/**
 * Context-injected: `say` blocks until the whole utterance has been
 * spoken, which can be many seconds. SIGTERM stops playback
 * immediately on abort.
 */
export async function __internal_speak(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  text: string,
  voice: string,
  rate: number,
  outputFile: string,
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
        args.push("-o", path.resolve(process.cwd(), outputFile));
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

/**
 * Context-injected: a `record()` call without a `silenceTimeout`
 * runs until the user hits Enter (or the recording detects silence).
 * Abort fires the same teardown as the keypress path — kills `rec`,
 * restores stdin out of raw mode, releases stdin — and rejects with
 * `AgencyCancelledError`.
 */
export async function __internal_record(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  outputFile: string,
  silenceTimeout: number,
): Promise<string> {
  const isTTY = process.stdin.isTTY;

  if (silenceTimeout <= 0 && !isTTY) {
    throw new Error(
      "record() with silenceTimeout=0 requires an interactive terminal (TTY) " +
      "so that Enter can stop the recording. Either run in a TTY or set a positive silenceTimeout."
    );
  }

  const outPath = outputFile
    ? path.resolve(process.cwd(), outputFile)
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

/**
 * Context-injected: uploading audio to Whisper can take a long time
 * for large files. Threads `ctx.getAbortSignal(stack)` into `fetch`
 * via `runHttp` (the same helper http.ts uses) so the in-flight upload
 * tears down on cancel.
 */
export async function __internal_transcribe(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  filepath: string,
  language: string,
): Promise<string> {
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

  const url = "https://api.openai.com/v1/audio/transcriptions";
  const signal = ctx.getAbortSignal(stack);
  return runHttp(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: formData,
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.json();
      const message = errorBody?.error?.message ?? JSON.stringify(errorBody);
      throw new Error(`Whisper API error (${response.status}): ${message}`);
    }

    const result = await response.json();
    return result.text;
  }, url);
}
