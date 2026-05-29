# Home-Directory (`~`) Expansion in Stdlib Path Resolution — Implementation Plan

## Goal

Let users write `~/notes.md`, `~/.agency/memory`, etc. in any
filesystem-touching stdlib function and have `~` expand to the user's
home directory. Today the stdlib treats `~` as a literal directory
name, which silently does the wrong thing.

**Stronger requirement:** any path-resolving stdlib function — present
or future — should pick up `~` (and any later path-expansion rules)
**by going through one resolver, not by re-implementing the policy at
the call site.** This is the part of the plan that pays for itself
the next time we add a path rule (env-var expansion, normalization,
allow-list overlay, etc.).

## Verification before writing code

> Grep `lib/` for any existing path-expansion utility before adding a
> new one. As of writing:
>
> - `lib/stdlib/path.ts` exposes only thin wrappers around node `path`
>   (`_join`, `_resolve`, `_basename`, `_dirname`, `_extname`,
>   `_relative`, `_isAbsolute`) — no expansion.
> - `lib/stdlib/resolvePath.ts` resolves `(dir, filename)` against the
>   module directory with traversal / symlink-escape checks. No `~`
>   handling.
> - `os.homedir()` is used ad-hoc in `lib/stdlib/oauth.ts`,
>   `lib/cli/schedule/backends/{launchd,systemd}.ts`,
>   `lib/cli/schedule/index.ts`, `lib/mcp/setup.ts`,
>   `lib/serve/policyStore.ts`. None of those are a reusable helper.
>
> If something has been added since, prefer reusing it over creating
> a new one.

## Scope: which APIs

Every stdlib entry point that resolves a filesystem path. Concretely:

**Built-ins ([`lib/stdlib/builtins.ts`](../../../lib/stdlib/builtins.ts)):**
- `_read`, `_write`, `_readImage` — `dir` arg (filename stays relative).

**Shell tools ([`lib/stdlib/shell.ts`](../../../lib/stdlib/shell.ts)):**
- `_ls`, `_grep`, `_glob`, `_stat`, `_exists` — `dir` arg.
- `_exec`, `_bash` — `cwd` arg.
- `_which` — scans PATH, no user dir input; skip.

**Filesystem tools ([`lib/stdlib/fs.ts`](../../../lib/stdlib/fs.ts)):**
- `_copy`, `_move`, `_remove`, `_mkdir`, `_edit`, `_applyPatch`,
  etc. — every `src` / `dest` / `path` / `dir` arg.

**Allow-list policy fields ([`lib/stdlib/assertContained.ts`](../../../lib/stdlib/assertContained.ts)):**
- `allowedPaths: ["~/.agency", ...]` must expand the same way, or
  policies break for users who write `~` in them.

**Memory store path** (after the memory-config PR lands):
- `dir` passed to `enableMemory({ dir: "~/.agency/memory" })`. Comes
  for free because the memory plan resolves through this same helper.

## Design: one resolver, no inlined policy

### Anti-pattern this plan refuses

The naive approach is to insert `expandHome(dir)` at every existing
`path.resolve(moduleDir, dir)` site. That gives `~` expansion but
encodes the path-resolution policy ("expand, then resolve against
module dir") at ~15 call sites. The next rule we add (env vars, NFC
normalization, allow-list overlay) has to be inserted at all 15
sites again — and any *new* stdlib function added in the future has
to remember to do the same dance. That is the
[`inconsistent patterns`](../../dev/anti-patterns.md#inconsistent-patterns)
anti-pattern about to be born.

### What this plan does instead

Two layered helpers; call sites consume the second.

**Layer 1 — `expandPath(p)` in `lib/stdlib/expandPath.ts`** — pure
string transform. Single source of truth for "user-typed path string →
expanded string." Today it only handles leading `~`; the function
exists so the next expansion rule (env vars, NFC, anything) lands in
one place.

```ts
import os from "os";
import path from "path";

/**
 * Expand user-shorthand prefixes in a path string. Currently:
 *
 * - `~` alone → $HOME
 * - `~/foo` (or `~\foo` on Windows) → $HOME/foo
 * - `~user/...` throws (POSIX-only, platform complexity not worth it).
 * - everything else returns unchanged.
 *
 * This is the single owner of path-shorthand policy for the stdlib.
 * Future rules (env-var expansion, NFC normalization, etc.) land
 * here, not at call sites.
 *
 * Does NOT resolve to an absolute path — callers still pass the
 * result through path.resolve / resolvePath / resolveDir.
 */
export function expandPath(p: string): string;
```

Plus `expandPath.test.ts`.

**Layer 2 — `resolveDir(dir)` in `lib/stdlib/resolveDir.ts`** — the
"dir-only" resolver shared by every stdlib site that today writes
`path.resolve(moduleDir, dir)`. It runs `expandPath` first, then
resolves against the module dir, then asserts containment. This is
the resolver call sites consume.

```ts
import path from "path";
import { getModuleDir } from "../runtime/asyncContext.js";
import { expandPath } from "./expandPath.js";
import { assertContained } from "./assertContained.js";

/**
 * Resolve a directory argument the way every path-taking stdlib
 * function should: expand user shorthands, resolve against the
 * module dir, assert it lives under allowedPaths.
 *
 * Returns the absolute, validated directory.
 *
 * Mirrors what `resolvePath(dir, filename)` does at the `dir` level.
 * If you're writing a new stdlib function that takes a `dir`-like
 * arg, USE THIS — don't re-implement the policy.
 */
export async function resolveDir(
  dir: string,
  allowedPaths: string[] = [],
): Promise<string>;
```

The existing two-step
[`resolvePath(dir, filename)`](../../../lib/stdlib/resolvePath.ts)
delegates its dir step to `resolveDir`, so `read`/`write`/`edit` get
`~` support without further changes.

`assertContained` calls `expandPath` on each entry of `allowedPaths`
once on entry, so a policy that says `allowedPaths: ["~/.agency"]`
matches paths resolved under `os.homedir() + "/.agency"`.

### Call-site result

`shell.ts`, `fs.ts`, and `builtins.ts` lose every inlined
`path.resolve(moduleDir, dir)` and gain a single call:

```ts
// Before
const moduleDir = getModuleDir();
const root = path.resolve(moduleDir, dir);
await assertContained(root, allowedPaths ?? [], moduleDir);

// After
const root = await resolveDir(dir, allowedPaths);
```

The policy lives in `resolveDir` exclusively. Any future rule we add
to `expandPath` or `resolveDir` lands at every site automatically.

## Convention for future code

Add a one-paragraph note to
[`docs/dev/coding-standards.md`](../../dev/coding-standards.md) (or
its closest neighbor) that any new stdlib function taking a `dir` /
`cwd` / `path` argument MUST resolve it via `resolveDir` (for
directories) or `resolvePath` (for the dir-plus-filename case). Code
that calls `path.resolve` directly on user input is rejected at
review.

A structural lint check (added to `pnpm run lint:structure` per
[AGENTS.md](../../../AGENTS.md)) can enforce this cheaply by flagging
`path.resolve` calls inside `lib/stdlib/` that aren't in
`resolveDir.ts` / `resolvePath.ts`. Optional follow-up; the doc note
covers it for now.

## Edge cases & decisions

1. **Quoted `~`** — strings arrive from Agency source verbatim; no
   shell processing. `"~/foo"` and `'~/foo'` both reach the helper as
   `~/foo`.

2. **`~` in the middle of a path** — `/etc/~/foo` etc. Not expanded.
   `expandPath` only touches a leading `~`. Documented in the doc
   comment.

3. **No `HOME` env var** — `os.homedir()` falls back to platform-
   specific lookup on POSIX; rarely returns `undefined`. Defensive
   check: if `os.homedir()` returns falsy, throw with a clear
   message. Never silently keep `~`.

4. **Windows** — `os.homedir()` returns `C:\Users\Foo`; `path.join`
   handles separators. `~/foo` and `~\foo` both work via the
   `path.sep` check.

5. **Symlink-target check** in `resolvePath` / `resolveDir` runs
   *after* `~` expansion. No interaction.

6. **Existing absolute-path policy** — `read("/etc/passwd", "...")`
   still throws because *filename* is absolute. Tilde expansion of
   `~/foo` happens at the `dir` level only.

## Tests

### Unit — `lib/stdlib/expandPath.test.ts` (new)

- `expandPath("~")` returns `os.homedir()`
- `expandPath("~/foo")` returns `path.join(home, "foo")`
- `expandPath("~\\foo")` on Windows returns `path.join(home, "foo")`
- `expandPath("notilde")` returns input unchanged
- `expandPath("/abs/~/foo")` returns input unchanged (no mid-path
  expansion)
- `expandPath("~user/foo")` throws
- `expandPath("")` returns input unchanged

### Unit — `lib/stdlib/resolveDir.test.ts` (new)

- Resolves `~/proj` under `os.homedir()`
- Resolves `./sub` against module dir (existing behavior preserved)
- Enforces `allowedPaths` after expansion

### Unit — `lib/stdlib/resolvePath.test.ts` (extend)

- `resolvePath("~/notes", "x.md")` resolves under `os.homedir()`
- Still rejects absolute filename when dir is `~/...`
- Still rejects `..` traversal under `~/...`

### Unit — `lib/stdlib/assertContained.test.ts` (extend)

- A policy with `allowedPaths: ["~/proj"]` accepts a path resolved to
  `os.homedir() + "/proj/sub"`.

### Agency execution test — `tests/agency/tilde-paths.agency` (new)

```agency
import { stat } from "std::shell"

node main() {
  // Probe a path that should exist for any user.
  const r = stat("~", "")
  assert(r.exists)
  return "ok"
}
```

Side-effect-free — no writes under the user's home.

### Manual smoke

After the memory-config PR lands, verify
`enableMemory({ dir: "~/.agency/memory" })` creates
`$HOME/.agency/memory`.

### Test gaps — what could break that the tests above wouldn't catch

The listed tests cover the helper in isolation, but the **value** of
this PR is consistency across every stdlib path-taking function.
The biggest risk class is "one call site in `shell.ts` / `fs.ts` /
`builtins.ts` is forgotten in the migration, and `~` silently
half-works." Per-helper unit tests can't catch that.

**Gap 1: Per-function integration coverage.** Every migrated stdlib
function needs at least one call with `~/...` to prove `~` expands
on that specific code path. If `_glob`'s `dir` arg is missed during
migration but `_ls`'s isn't, only an integration test on `_glob`
exposes it.
**Add:** `tests/agency/tilde-paths.agency` extended to exercise
every migrated entry point at least once:

```agency
import { ls, glob, grep, stat, exists, bash, exec } from "std::shell"
import { read } from "std::"   // built-in

node main() {
  assert(stat("~", "").exists)
  assert(exists("~/", ""))                     // exists(filename, dir)
  // ls/glob/grep — empty dir output is fine; goal is "doesn't throw"
  ls("~", false)
  glob("*", "~")
  grep("nomatch_pattern_xyz", "~", "", 10)
  // exec/bash cwd
  exec("pwd", [], "~")
  bash("pwd", "~")
  return "ok"
}
```

Each line probes a distinct code path that the unit tests don't
cover. Side-effect-free (no writes under `$HOME`).

**Gap 2: Inline `path.resolve` regression guard.** If a future stdlib
function takes a `dir` arg and uses `path.resolve(moduleDir, dir)`
directly instead of `resolveDir`, none of the existing tests catch
it.
**Add:** structural-lint check in `pnpm run lint:structure` that
flags `path.resolve` calls inside `lib/stdlib/` outside of
`resolvePath.ts` and `resolveDir.ts`. This is the test for the
*convention*, not a specific bug. Without it, drift is inevitable.

Implementation: AST-grep the existing structural-lint script for the
forbidden pattern. Same shape as the other rules in
`scripts/lint-structure.ts` (or wherever it lives — confirm during
implementation).

**Gap 3: `allowedPaths` negative path.** Listed test covers
`allowedPaths: ["~/proj"]` accepting `$HOME/proj/sub`. Missing: a
path outside the allow-list (e.g., `/tmp/x`) is **rejected** after
the expansion. Without the negative case, a bug that expands
everything to a no-op allow-list would pass the positive test.
**Add:** to `lib/stdlib/assertContained.test.ts`, the rejection case.

**Gap 4: Symlink escape under `~/...`.** `resolvePath` has a symlink-
escape check that runs after path resolution. The check must continue
to fire when the input dir is `~/foo` (resolved to `$HOME/foo`) and
the symlinked target escapes.
**Add:** `lib/stdlib/resolvePath.test.ts` — set up a temp symlink
under a fake `HOME`, point a `~/...` path through it, assert escape
is detected.

**Gap 5: `HOME` env missing.** Helper throws when `os.homedir()`
returns falsy. Listed in design, no test.
**Add:** `lib/stdlib/expandPath.test.ts` — mock `os.homedir` to
return `""` (or `undefined`), assert `expandPath("~/foo")` throws
with a clear message. Vitest supports this via `vi.spyOn(os, "homedir")`.

**Gap 6: Absolute path unchanged.** `expandPath("/etc/passwd")` and
`expandPath("C:\\Users\\Foo")` must return the input unchanged. Bug
that mistakenly expands every input (e.g. a misplaced `||`) would
silently break unrelated absolute-path tests.
**Add:** explicit cases in `expandPath.test.ts`.

**Gap 7: Windows `~\foo`.** Listed but CI is presumably Linux/macOS.
The test needs to mock `path.sep` (or use `path.win32` explicitly)
so it runs cross-platform.
**Add:** to `expandPath.test.ts`, a case using `path.win32.sep`
explicitly rather than the platform-default `path.sep`, so the test
actually runs on POSIX CI.

**Gap 8: `~` inside an `exec`/`bash` *argument* (not cwd).** This
PR only expands path-argument fields (`dir`, `cwd`, `src`, `dest`,
`filename`, `allowedPaths`). It does **not** expand `~` inside the
shell command string of `bash("ls ~/foo")` — that's the shell's job
and we shouldn't pre-process command strings. Worth a test that
documents this boundary so a future change doesn't accidentally
expand them.
**Add:** to `tests/agency/tilde-paths.agency`, a comment + assertion
that `bash("echo ~", ".")` echoes `~` literally when stdin is empty
and no shell expansion happens (or echoes the path if the shell does
expand it). Either way the test documents which layer owns the
expansion.

**Gap 9: Module-dir resolution still works for non-`~` inputs.**
A bug in `resolveDir` that always expands or always routes through
`os.homedir()` would break every existing relative-path call.
**Add:** to `resolveDir.test.ts`, an explicit non-tilde relative
path case asserting it resolves against the module dir (not `$HOME`,
not cwd) — verifies the existing behavior is preserved.

**Gap 10: Frame fields propagated through `_read` / `_write`.**
After migrating `builtins.ts` (`_read`, `_write`, `_readImage`),
verify `read("notes.md", "~/proj")` resolves to `$HOME/proj/notes.md`
and `read("notes.md", "./local")` still resolves against the module
dir. The two should differ only in the `dir` value.
**Add:** to existing built-ins test file (or the agency execution
test), one case for each.

The listed tests stay; gaps above are additive.

## Migration & rollout

- **Backward compatible** unless a user has a literal `~` directory
  in their working dir AND relies on stdlib treating it as such. That
  combination is implausible; document the workaround (`./~`) if it
  ever surfaces.
- **No deprecations.** Additive — paths not starting with `~` behave
  identically.
- **Single PR.** Adds two new helper files + one new test file each,
  plus ~15 mechanical *deletions* and *replacements* across `shell.ts`,
  `fs.ts`, `builtins.ts`, `resolvePath.ts`, `assertContained.ts`.
- **Order vs. memory PR.** Independent. Either can land first.

## File checklist

New:
- [`lib/stdlib/expandPath.ts`](../../../lib/stdlib/expandPath.ts) — single owner of path-shorthand policy
- [`lib/stdlib/expandPath.test.ts`](../../../lib/stdlib/expandPath.test.ts)
- [`lib/stdlib/resolveDir.ts`](../../../lib/stdlib/resolveDir.ts) — dir-arg resolver shared by all stdlib sites
- [`lib/stdlib/resolveDir.test.ts`](../../../lib/stdlib/resolveDir.test.ts)

Modified — internal:
- [`lib/stdlib/resolvePath.ts`](../../../lib/stdlib/resolvePath.ts) — dir step delegates to `resolveDir`
- [`lib/stdlib/assertContained.ts`](../../../lib/stdlib/assertContained.ts) — expand each `allowedPaths` entry via `expandPath` on entry

Modified — call sites collapse to `resolveDir(dir, allowedPaths)`:
- [`lib/stdlib/shell.ts`](../../../lib/stdlib/shell.ts) — `_ls`, `_grep`, `_glob`, `_stat`, `_exists`, `_exec` cwd, `_bash` cwd
- [`lib/stdlib/fs.ts`](../../../lib/stdlib/fs.ts) — every `path.resolve(process.cwd(), …)` and `path.resolve(moduleDir, …)` site
- [`lib/stdlib/builtins.ts`](../../../lib/stdlib/builtins.ts) — `_read`, `_write`, `_readImage` (if not already routed through `resolvePath`)

Docs:
- [`docs/dev/coding-standards.md`](../../dev/coding-standards.md) — paragraph: "new path-taking stdlib functions must route through `resolveDir` / `resolvePath`"
- Optional: structural lint check enforcing the above; deferrable
- User-facing note in [`docs/site/guide/`](../../site/guide/)
  wherever path arguments are discussed; also call out `~` in
  [`docs/site/cli/policy.md`](../../site/cli/policy.md) for
  `allowedPaths`.

## Out of scope

- Environment variable expansion (`$HOME`, `$XDG_CONFIG_HOME`). Tilde
  is the common case; env vars need a separate decision and will land
  inside `expandPath` when they do.
- `~user/...` expansion. Documented as unsupported, throws clearly.
- Mid-path `~` expansion. Not supported — same reason.
- Changing where module dir vs. cwd is used to resolve relative
  non-tilde paths. Orthogonal design decision.
