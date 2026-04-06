import { readFileSync } from "fs";

export type Platform = "macos" | "linux" | "windows" | "wsl" | "unknown";

let _cachedPlatform: Platform | null = null;

/**
 * Detect the current OS platform. Result is cached since it can't change at runtime.
 *
 * Returns:
 * - "macos" — macOS (Darwin)
 * - "linux" — Native Linux (not WSL)
 * - "windows" — Native Windows
 * - "wsl" — Windows Subsystem for Linux (reports as linux via process.platform,
 *            but is actually running under Windows)
 * - "unknown" — Anything else (FreeBSD, AIX, etc.)
 *
 * Detection approach follows the patterns used by popular Node packages
 * (sindresorhus/open, sindresorhus/is-wsl, node-notifier):
 * - process.platform is the primary signal (no import needed, synchronous)
 * - WSL is detected by reading /proc/version for "microsoft" (the standard approach
 *   used by the is-wsl package). This matters because process.platform returns "linux"
 *   in WSL even though the user is on Windows.
 * - Anything not darwin, win32, or linux is treated as "unknown"
 */
export function detectPlatform(): Platform {
  if (_cachedPlatform !== null) return _cachedPlatform;

  const p = process.platform;

  if (p === "darwin") {
    _cachedPlatform = "macos";
  } else if (p === "win32") {
    _cachedPlatform = "windows";
  } else if (p === "linux") {
    // Check for WSL — process.platform returns "linux" in WSL
    try {
      const version = readFileSync("/proc/version", "utf8");
      if (/microsoft/i.test(version)) {
        _cachedPlatform = "wsl";
      } else {
        _cachedPlatform = "linux";
      }
    } catch {
      _cachedPlatform = "linux";
    }
  } else {
    _cachedPlatform = "unknown";
  }

  return _cachedPlatform;
}
