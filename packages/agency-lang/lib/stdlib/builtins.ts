import * as readline from "readline";
import process from "process";
import { classifyIterable } from "../utils/iteration.js";
import { decodeBase64Strict } from "./base64.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { detectPlatform } from "./utils.js";
import { fixedRoot, readText, readBytes, writeBytes, type WriteMode } from "./contained.js";
export type { WriteMode } from "./contained.js";
import { AgencyCancelledError } from "../runtime/errors.js";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { FakeClock } from "../runtime/clock.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";
import { abortableSleep } from "./abortable.js";
import { acceptsFailures } from "../runtime/failurePropagation.js";

const execFileAsync = promisify(execFile);

export function _print(...messages: any[]): void {
  console.log(...messages);
}

export function _printJSON(obj: any): void {
  console.log(JSON.stringify(obj, null, 2));
}

/**
 * SINGLE SOURCE OF TRUTH for stdlib TS helpers that legitimately receive
 * failure values (printing a failure is a debugging move). Add new
 * failure-tolerant helpers HERE, never as scattered acceptsFailures()
 * calls. Runtime-layer builtins have their own list —
 * FAILURE_TOLERANT_BUILTINS in lib/runtime/failurePropagation.ts — because
 * the runtime hot path must not import the stdlib graph.
 */
const FAILURE_TOLERANT_STDLIB_HELPERS: ReadonlyArray<(...args: any[]) => any> = [
  _print,
  _printJSON,
];
for (const fn of FAILURE_TOLERANT_STDLIB_HELPERS) {
  acceptsFailures(fn);
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
function inputImpl(ctx: RuntimeContext<any>, stack: StateStack, prompt: string): Promise<string> {
  // Waiting on a human must not count against a time budget. Pause every
  // guard on the active branch stack before blocking, resume after. These
  // are the same idempotent calls the runner makes on halt()/step entry;
  // CostGuard.pause() is a no-op, so only time budgets are affected.
  // pause() cancels only the guard's own timer — the composed abort signal
  // stays intact, so external cancellation (Ctrl-C, race-loser) still
  // releases the wait.
  stack.guards.forEach((g) => g.pause());
  const resumeGuards = () => stack.guards.forEach((g) => g.resume(stack));

  // Per-execution override first (REPL readline routing, test seams —
  // see RuntimeContext.inputOverride). The globalThis fallback exists
  // only for the TUI debugger, which cannot reach the ctx yet.
  const override =
    ctx.inputOverride ??
    ((globalThis as any).__agencyInputOverride as
      ((prompt: string) => Promise<string>) | undefined);
  if (override) {
    // Promise.resolve().then(...) so a synchronously-throwing override
    // still reaches the finally — otherwise the guards stay paused for
    // the rest of the run.
    return Promise.resolve()
      .then(() => override(prompt))
      .finally(resumeGuards);
  }
  const signal = ctx.getAbortSignal(stack);
  if (signal.aborted) {
    resumeGuards();
    return Promise.reject(new AgencyCancelledError("input cancelled"));
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      try {
        rl.close();
      } catch {}
      reject(new AgencyCancelledError("input cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const ask = () => {
      const askedAt = Date.now();
      rl.question(prompt, (answer: string) => {
        // A blank line that lands faster than a human could react to the
        // prompt was buffered while the program was busy — an Enter pressed
        // to check on a slow run, not an answer — and would otherwise become
        // an accidental (empty) submission. Discard it and re-ask; the next
        // buffered line (real type-ahead) is delivered normally. Deliberate
        // blank answers arrive after human-scale delay and are kept. Only
        // interactive stdin is filtered: piped input legitimately arrives
        // instantly. Real wall clock on purpose — this measures I/O latency,
        // and fake-clock tests use inputOverride, never this path.
        if (answer === "" && process.stdin.isTTY && Date.now() - askedAt < BUFFERED_BLANK_LINE_MS) {
          ask();
          return;
        }
        signal.removeEventListener("abort", onAbort);
        rl.close();
        resolve(answer);
      });
    };
    ask();
  }).finally(resumeGuards);
}

/** A blank line answered within this window of the prompt attaching cannot be
 *  a human reacting to the prompt (buffered lines arrive in ~1ms; human
 *  reaction to a newly-visible prompt is 150ms+). */
const BUFFERED_BLANK_LINE_MS = 25;

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

/** Test-only: install an input override that resolves after `delayMs`,
 *  used by guard fixtures to simulate a slow human without touching stdin.
 *  Installs on the EXECUTION's context, not globalThis, so it lives and
 *  dies with the run that called it. Exposed to fixtures as the
 *  non-exported `_installSlowInput` def in `stdlib/thread.agency`
 *  (test imports only). */
export function _installSlowInputImpl(delayMs: number, answer: string): void {
  const { ctx } = getRuntimeContext();
  ctx.inputOverride = (_prompt: string) =>
    new Promise<string>((resolve) => setTimeout(() => resolve(answer), delayMs));
}

/** Test-only: advance the run's fake clock by `ms`, firing any guard timer
 *  that comes due. Exposed to fixtures as the non-exported `_advanceTime`
 *  def in `stdlib/date.agency` (test imports only). Throws if the run holds
 *  the real clock, so a stray call outside a fake-clock test fails loudly
 *  rather than doing nothing.
 *
 *  `advance` lives on FakeClock only, not on the Clock type, so this branches
 *  on the concrete type. That is a deliberate trade: putting a test-only
 *  `advance` verb on the production Clock interface would be worse. The
 *  instanceof is confined to this one test-only helper and never runs on a
 *  production path. */
export function _advanceTimeImpl(ms: number): void {
  const { ctx } = getRuntimeContext();
  if (!(ctx.clock instanceof FakeClock)) {
    throw new Error('_advanceTime() needs a fake clock. Set "fakeClock": true on this test case.');
  }
  ctx.clock.advance(ms);
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
  rootDir: string,
  filename: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  return sliceLines(readText(fixedRoot(rootDir), filename), offset, limit);
}

/** The lines of `text` a read with `offset` and `limit` returns. Default:
 * the whole text. Only paginate (and emit a truncation note) when the
 * caller explicitly asks for it. A 0 (or unset) for both arguments means
 * "no pagination". */
export function sliceLines(text: string, offset?: number, limit?: number): string {
  const off = offset && offset > 0 ? offset : undefined;
  const lim = limit && limit > 0 ? limit : undefined;
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

export async function _write(
  rootDir: string,
  filename: string,
  content: string,
  mode: WriteMode = "overwrite",
): Promise<boolean> {
  writeBytes(fixedRoot(rootDir), filename, Buffer.from(content, "utf8"), { mode });
  return true;
}

export async function _writeBinary(
  rootDir: string,
  filename: string,
  base64: string,
  mode: WriteMode = "overwrite",
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Strict(base64);
  } catch (e) {
    // Add the operation context to the shared decoder's message.
    throw new Error(`writeBinary: ${(e as Error).message}`);
  }
  writeBytes(fixedRoot(rootDir), filename, Buffer.from(bytes), { mode });
  return true;
}

export async function _readBinary(rootDir: string, filename: string): Promise<string> {
  return readBytes(fixedRoot(rootDir), filename).toString("base64");
}

/** argv item 1 is the message, item 2 is the title. See `_notify`. */
const NOTIFY_SCRIPT = `on run argv
  display notification (item 1 of argv) with title (item 2 of argv)
end run`;

export async function _notify(title: string, message: string): Promise<boolean> {
  const platform = await detectPlatform();
  if (platform === "macos") {
    // The title and message arrive as argv rather than being spliced into the
    // script source, so AppleScript never parses them as code. `notify` is
    // reachable from model-authored text, and escaping only holds for as long
    // as the escape function keeps up with every AppleScript metacharacter.
    // No "-" before the arguments: osascript would pass it through as argv
    // item 1 and shift every real argument by one.
    await execFileAsync("osascript", ["-e", NOTIFY_SCRIPT, message, title]);
  } else if (platform === "linux") {
    await execFileAsync("notify-send", [title, message]);
  } else if (platform === "wsl") {
    console.error(
      `notify is not yet supported in WSL. ` +
        `WSL does not have reliable notification support.\n` +
        `Title: ${title}\nMessage: ${message}`,
    );
  } else if (platform === "windows") {
    console.error(
      `notify is not yet supported on Windows. ` +
        `Supported platforms: macOS, Linux.\n` +
        `Title: ${title}\nMessage: ${message}`,
    );
  } else {
    console.error(
      `notify is not supported on platform: ${platform}\n` + `Title: ${title}\nMessage: ${message}`,
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

/** The two-binder comprehension lowering target. Shares its notion of
 *  "what is iterable" with `Runner.loop` via classifyIterable, so
 *  `[f(x,i) for x, i in src]` and `for (x, i in src)` cannot disagree.
 *
 *  Unlike the loop, this genuinely does build a list: the comprehension
 *  desugars to `map(_pairsOf(src))`, and `map` needs a real array. Only
 *  the classification is shared, which is the part that would drift. */
export function _pairsOf(src: unknown): unknown[][] {
  const shape = classifyIterable(src);
  if (shape.kind === "array") {
    // Built by index, not Array.prototype.map: map skips sparse-array
    // holes and leaves holes in its result, while Runner.loop visits
    // every index up to length (yielding undefined). Index-building
    // keeps the two agreeing on sparse arrays too.
    const arr = src as unknown[];
    return Array.from({ length: arr.length }, (_, index) => [arr[index], index]);
  }
  if (shape.kind === "record") {
    const record = src as Record<string, unknown>;
    return shape.keys.map((key) => [key, record[key]]);
  }
  return [];
}

export function _range(startOrN: number, end?: number): number[] {
  if (end === undefined) {
    return Array.from({ length: startOrN }, (_, i) => i);
  }
  return Array.from({ length: end - startOrN }, (_, i) => i + startOrN);
}
