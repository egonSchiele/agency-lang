import os from "node:os";
import path from "node:path";

/**
 * Expand user-shorthand prefixes in a path string. Currently:
 *
 * - `~` alone → `$HOME`
 * - `~/foo` (or `~\foo` on Windows) → `$HOME/foo`
 * - `~user/...` throws (POSIX-only; the platform complexity isn't
 *   worth the small payoff — also lets people write a literal
 *   `~user-typed-name` dir at the project root by quoting `./~user...`).
 * - everything else returns unchanged.
 *
 * This is the single owner of path-shorthand policy for the stdlib.
 * Future rules (env-var expansion, NFC normalization, etc.) land
 * here, not at call sites. Anything in `lib/stdlib/` that resolves
 * a user-typed path string MUST route through `resolvePath` /
 * `resolveDir`, which call this helper first — never re-implement
 * the policy locally.
 *
 * Layering: `expandPath` is intentionally a **pure string transform**
 * with no async, no ALS access, and no base-directory awareness. The
 * "resolve relative paths against the cwd" policy lives one layer
 * up: `resolveDir` (which also asserts allow-list containment) and
 * `resolvePath` for the dir+filename case (which deliberately
 * enforces no containment — callers that take `allowedPaths` layer
 * `assertContained` themselves). Keeping the layers
 * split means `expandPath` is trivially testable in isolation, and
 * each caller picks the base it wants without this helper having to
 * fan out into runtime context.
 *
 * Does NOT resolve to an absolute path — callers still pass the
 * result through `path.resolve` / `resolvePath` / `resolveDir`.
 *
 * `expandPath("")` returns `""` unchanged so empty-string sentinels
 * pass through (callers that disallow empty dir handle that
 * themselves with a clearer error).
 */
export function expandPath(p: string): string {
  if (p === "" || p === undefined || p === null) return p;
  if (!p.startsWith("~")) return p;

  // `~user/...` is unsupported — reject it explicitly. The condition
  // "starts with `~` and the next char is a non-separator other char"
  // catches both `~root` and `~root/foo`.
  if (p.length > 1 && p[1] !== "/" && p[1] !== path.sep && p[1] !== "\\") {
    throw new Error(
      `expandPath: \`~user/...\` (per-user home) is not supported; got "${p}". Use $HOME or an absolute path instead.`,
    );
  }

  const home = os.homedir();
  if (!home) {
    throw new Error(
      "expandPath: cannot expand `~` because os.homedir() returned no value (no HOME env var on POSIX, no USERPROFILE on Windows).",
    );
  }

  // p is now either `~` exactly, or `~` + separator + tail.
  if (p === "~") return home;
  // Strip the leading `~` plus the separator character (length 2).
  const tail = p.slice(2);
  return path.join(home, tail);
}
