import * as readline from "readline";
import process from "process";
import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { detectPlatform } from "./utils.js";
import { resolvePath } from "./resolvePath.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";
import { abortableSleep } from "./abortable.js";

const execFileAsync = promisify(execFile);

export function _print(...messages: any[]): void {
  console.log(...messages);
}

export function _printJSON(obj: any): void {
  console.log(JSON.stringify(obj, null, 2));
}

export function _parseJSON(text: string): any {
  return JSON.parse(text);
}

/**
 * Shared implementation for both the legacy `__internal_input`
 * (still called by `CONTEXT_INJECTED_BUILTINS`-rewritten call sites
 * during the ALS migration) and the new `_input` (ALS-reading). Both
 * paths must take the same code path so subtle differences cannot
 * sneak in while the registry is still populated. Cancellation:
 * Readline holds stdin exclusively, so a blocked `input("?")` after
 * Ctrl-C or a race-loser abort would otherwise sit there forever; on
 * abort we close the readline interface and reject with
 * `AgencyCancelledError`, which `__tryCall` re-throws so cancellation
 * actually propagates.
 */
function inputImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  prompt: string,
): Promise<string> {
  const override = (globalThis as any).__agencyInputOverride as
    | ((prompt: string) => Promise<string>)
    | undefined;
  if (override) {
    return override(prompt);
  }
  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) {
    return Promise.reject(new AgencyCancelledError("input cancelled"));
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try { rl.close(); } catch {}
      reject(new AgencyCancelledError("input cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.question(prompt, (answer: string) => {
      signal.removeEventListener("abort", onAbort);
      rl.close();
      resolve(answer);
    });
  });
}

/** Deprecated context-injected wrapper kept in place during the ALS
 *  migration so the registry/codegen path keeps working until the
 *  follow-up cleanup PR removes it. New stdlib `.agency` files should
 *  call `_input` instead. */
export function __internal_input(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  prompt: string,
): Promise<string> {
  return inputImpl(ctx, stack, prompt);
}

/** ALS-reading replacement. Same body as `__internal_input`. */
export function _input(prompt: string): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  return inputImpl(ctx, stack, prompt);
}

/** Shared impl for `__internal_sleep` and `_sleep`. */
function sleepImpl(ctx: RuntimeContext<any>, stack: StateStack, ms: number): Promise<void> {
  return abortableSleep(ms, ctx.getAbortSignal(stack));
}

/** Deprecated; see comment on `__internal_input`. */
export function __internal_sleep(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  ms: number,
): Promise<void> {
  return sleepImpl(ctx, stack, ms);
}

/** ALS-reading replacement for `__internal_sleep`. */
export function _sleep(ms: number): Promise<void> {
  const { ctx, stack } = getRuntimeContext();
  return sleepImpl(ctx, stack, ms);
}

export function _round(num: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(num * factor) / factor;
}

// `__internal_fetch`, `__internal_fetchJSON`, and `__internal_fetchMarkdown`
// are context-injected builtins (see lib/codegenBuiltins/contextInjected.ts)
// — they're imported directly from `./http.js` by the generated code, no
// re-export needed here.

export async function _read(
  dir: string,
  filename: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  const filePath = await resolvePath(dir, filename);
  const data = await readFile(filePath);
  const text = data.toString("utf8");
  const off = offset && offset > 0 ? offset : undefined;
  const lim = limit && limit > 0 ? limit : undefined;
  // Default: return the whole file. Only paginate (and emit a
  // truncation note) when the caller explicitly asks for it. A 0 (or
  // unset) for both arguments means "no pagination".
  if (off === undefined && lim === undefined) return text;
  const start = off ?? 1;
  const lines = text.split("\n");
  const remaining = lines.length - (start - 1);
  const count = lim ?? remaining;
  const slice = lines.slice(start - 1, start - 1 + count);
  const trailing =
    start - 1 + count < lines.length
      ? `\n... [truncated: showing ${start}-${start + slice.length - 1} of ${lines.length} lines]`
      : "";
  return slice.join("\n") + trailing;
}

const VALID_WRITE_MODES = ["overwrite", "append", "create-only"] as const;
export type WriteMode = typeof VALID_WRITE_MODES[number];

/** Single owner of the write-mode ladder. `data` is a string (written UTF-8 by
 *  Node's default) or a Buffer (raw bytes). `_write` / `_writeBinary` delegate
 *  here so mode semantics live in one place. */
async function _writeBytes(
  dir: string,
  filename: string,
  data: string | Buffer,
  mode: WriteMode = "overwrite",
): Promise<boolean> {
  if (!VALID_WRITE_MODES.includes(mode)) {
    throw new Error(
      `Invalid mode '${mode}'. Must be one of: ${VALID_WRITE_MODES.join(", ")}.`,
    );
  }
  const filePath = await resolvePath(dir, filename);
  if (mode === "create-only" && existsSync(filePath)) {
    throw new Error(`File already exists: '${filePath}' (mode is 'create-only').`);
  }
  const doWrite = mode === "append" ? appendFile : writeFile;
  await doWrite(filePath, data);
  return true;
}

export async function _write(
  dir: string,
  filename: string,
  content: string,
  mode: WriteMode = "overwrite",
): Promise<boolean> {
  return _writeBytes(dir, filename, content, mode);
}

export async function _writeBinary(
  dir: string,
  filename: string,
  base64: string,
  mode: WriteMode = "overwrite",
): Promise<boolean> {
  return _writeBytes(dir, filename, Buffer.from(base64, "base64"), mode);
}

export async function _readBinary(dir: string, filename: string): Promise<string> {
  const filePath = await resolvePath(dir, filename);
  const data = await readFile(filePath);
  return data.toString("base64");
}

export async function _notify(title: string, message: string): Promise<boolean> {
  const platform = await detectPlatform();
  if (platform === "macos") {
    // Escape for AppleScript string literals (backslashes and double quotes).
    // We use execFileAsync with an args array to bypass the shell entirely,
    // which eliminates all shell injection concerns.
    const escapeAS = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `display notification "${escapeAS(message)}" with title "${escapeAS(title)}"`;
    await execFileAsync("osascript", ["-e", script]);
  } else if (platform === "linux") {
    await execFileAsync("notify-send", [title, message]);
  } else if (platform === "wsl") {
    console.error(
      `notify is not yet supported in WSL. ` +
      `WSL does not have reliable notification support.\n` +
      `Title: ${title}\nMessage: ${message}`
    );
  } else if (platform === "windows") {
    console.error(
      `notify is not yet supported on Windows. ` +
      `Supported platforms: macOS, Linux.\n` +
      `Title: ${title}\nMessage: ${message}`
    );
  } else {
    console.error(
      `notify is not supported on platform: ${platform}\n` +
      `Title: ${title}\nMessage: ${message}`
    );
  }
  return true;
}

export function _mostCommon(items: any[]): any {
  const counts: Record<string, { value: any; count: number }> = {};
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!counts[key]) counts[key] = { value: item, count: 0 };
    counts[key].count++;
  }
  let best: any = undefined;
  let bestCount = 0;
  for (const entry of Object.values(counts)) {
    if (entry.count > bestCount) {
      best = entry.value;
      bestCount = entry.count;
    }
  }
  return best;
}

export function _keys(obj: any): string[] {
  return Object.keys(obj);
}

export function _values(obj: any): any[] {
  return Object.values(obj);
}

export function _entries(obj: any): { key: string; value: any }[] {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

export function _range(startOrN: number, end?: number): number[] {
  if (end === undefined) {
    return Array.from({ length: startOrN }, (_, i) => i);
  }
  return Array.from({ length: end - startOrN }, (_, i) => i + startOrN);
}
