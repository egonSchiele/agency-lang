import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export type Clipboard = {
  // Send `text` to the system clipboard. Throws on failure so the
  // caller can show "clipboard unavailable" in the status bar.
  write(text: string): void;
};

// One backend per platform we know how to drive. The first one that
// looks runnable (i.e. `--version` exits 0) is selected at probe time.
const BACKENDS: { cmd: string; args: string[] }[] = [
  { cmd: "pbcopy", args: [] },
  { cmd: "wl-copy", args: [] },
  { cmd: "xclip", args: ["-selection", "clipboard"] },
  { cmd: "clip.exe", args: [] },
];

// Resolved at first call; cached for the process lifetime so we don't
// spawn a probe on every paste.
let cached: Clipboard | null | undefined;

export function detectClipboard(
  spawn: typeof spawnSync = spawnSync,
): Clipboard | null {
  if (cached !== undefined) return cached;
  for (const backend of BACKENDS) {
    if (isRunnable(backend.cmd, spawn)) {
      cached = makeBackend(backend.cmd, backend.args, spawn);
      return cached;
    }
  }
  cached = null;
  return cached;
}

// Test-only: reset the cached probe result. Lets each test pick a
// fresh backend via dependency injection.
export function resetClipboardCache(): void {
  cached = undefined;
}

function isRunnable(cmd: string, spawn: typeof spawnSync): boolean {
  // `--version` is the most-supported "does this exist" probe across
  // pbcopy / xclip / wl-copy / clip.exe. We don't care about the exit
  // code — only whether the binary exists on PATH (which we infer
  // from `spawnSync.error` being unset).
  try {
    const r = spawn(cmd, ["--version"], {
      stdio: "ignore",
      timeout: 1_000,
    } satisfies SpawnSyncOptions);
    return !r.error;
  } catch {
    return false;
  }
}

function makeBackend(
  cmd: string,
  args: string[],
  spawn: typeof spawnSync,
): Clipboard {
  return {
    write(text: string): void {
      const r = spawn(cmd, args, {
        input: text,
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 3_000,
      } satisfies SpawnSyncOptions);
      if (r.error) throw r.error;
      if (r.status !== 0 && r.status !== null) {
        throw new Error(
          `${cmd} exited with status ${r.status}: ${r.stderr?.toString() ?? ""}`,
        );
      }
    },
  };
}
