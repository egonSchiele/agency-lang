import process from "process";
import { detectPlatform } from "./utils.js";
import { abortableExec } from "./abortable.js";
import { getModuleDir, getRuntimeContext } from "../runtime/asyncContext.js";
import { resolveDir } from "./resolveDir.js";
import type { RuntimeContext } from "../runtime/state/context.js";
import type { StateStack } from "../runtime/state/stateStack.js";
import type { ThreadStore } from "../runtime/state/threadStore.js";

export function _args(): string[] {
  return process.argv.slice(2);
}

export function _cwd(): string {
  return process.cwd();
}

/**
 * Return the absolute path of the directory containing the *compiled
 * JavaScript* of the Agency module that initiated the current run.
 * Reads through the ALS frame seeded by `runNode` / `runInBootstrapFrame`.
 * Falls back to `process.cwd()` when no Agency frame is active (e.g.
 * the helper is called from non-Agency code).
 */
export function _dirname(): string {
  return getModuleDir();
}

export function _env(name: string): string | null {
  const v = process.env[name];
  return v === undefined ? null : v;
}

export function _exit(code: number): void {
  process.exit(code);
}

export function _isTTY(): boolean {
  return process.stdin.isTTY === true;
}

export async function _readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function _setEnv(name: string, value: string): void {
  if (name.length === 0) {
    throw new Error("setEnv: name must not be empty");
  }
  if (name.includes("=") || name.includes("\0")) {
    throw new Error(
      `setEnv: name must not contain '=' or NUL bytes (got ${JSON.stringify(name)})`,
    );
  }
  if (value.includes("\0")) {
    throw new Error("setEnv: value must not contain NUL bytes");
  }
  process.env[name] = value;
}

/**
 * Open a URL in the user's default browser. macOS-only via the `open`
 * command; aborts the subprocess on Ctrl-C / race-loser / time-guard
 * abort.
 */
async function openUrlImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  url: string,
): Promise<void> {
  const platform = await detectPlatform();
  const signal = ctx.getAbortSignal(stack);

  if (platform === "macos") {
    await abortableExec("open", ["--", url], signal);
  } else {
    throw new Error(
      `openUrl is currently only supported on macOS (detected: ${platform}). ` +
      `Cross-platform support will be added in a future release.`,
    );
  }
}

/** Deprecated context-injected wrapper kept during the ALS migration;
 *  see `_openUrl`. */
export async function __internal_openUrl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  url: string,
): Promise<void> {
  return openUrlImpl(ctx, stack, url);
}

/** ALS-reading replacement for `__internal_openUrl`. */
export async function _openUrl(url: string): Promise<void> {
  const { ctx, stack } = getRuntimeContext();
  return openUrlImpl(ctx, stack, url);
}

/**
 * Take a screenshot. macOS uses `screencapture`, Linux uses `import`.
 * The subprocess is killed on Ctrl-C / race-loser / time-guard abort so
 * an interactive-region capture (which can sit waiting for the user)
 * doesn't outlive the agent.
 */
async function screenshotImpl(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  filepath: string,
  x: number,
  y: number,
  width: number,
  height: number,
  allowedPaths?: string[],
): Promise<void> {
  const platform = await detectPlatform();
  // Route through `resolveDir` (cwd-anchored) so `~` expansion and
  // allow-list enforcement land in one place — same pattern as
  // `_mkdir`/`_copy`/`_remove` in fs.ts.
  const resolvedPath = await resolveDir(filepath, allowedPaths ?? []);
  const hasRegion = x >= 0 && y >= 0 && width >= 0 && height >= 0;
  const signal = ctx.getAbortSignal(stack);

  if (platform === "macos") {
    if (hasRegion) {
      await abortableExec("screencapture", ["-R", `${x},${y},${width},${height}`, resolvedPath], signal);
    } else {
      await abortableExec("screencapture", ["-x", resolvedPath], signal);
    }
  } else if (platform === "linux") {
    if (hasRegion) {
      await abortableExec("import", ["-crop", `${width}x${height}+${x}+${y}`, "-window", "root", resolvedPath], signal);
    } else {
      await abortableExec("import", ["-window", "root", resolvedPath], signal);
    }
  } else {
    console.error(
      `screenshot is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS, Linux.`
    );
  }
}

/** Deprecated; see `_screenshot`. */
export async function __internal_screenshot(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  filepath: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return screenshotImpl(ctx, stack, filepath, x, y, width, height);
}

/** ALS-reading replacement for `__internal_screenshot`. */
export async function _screenshot(
  filepath: string,
  x: number,
  y: number,
  width: number,
  height: number,
  allowedPaths?: string[],
): Promise<void> {
  const { ctx, stack } = getRuntimeContext();
  return screenshotImpl(ctx, stack, filepath, x, y, width, height, allowedPaths);
}

export function _setTitle(title: string): void {
  process.title = title;
}