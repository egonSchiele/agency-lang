# Settable, branch-scoped working directory for stdlib path tools

## Problem

When the agency agent is asked to operate on a relative path (e.g. "edit
`foo.agency`"), it has no reliable way to know which directory that path is
relative to. The underlying stdlib functions have two *different* default
bases (see `lib/stdlib/resolveDir.ts`):

- `read` / `write` / `edit` / `ls` / `glob` / `grep` resolve a relative
  `dir` against the **module directory** (where the calling `.agency`
  file's compiled JS lives) — intended for shipping co-located resource
  bundles (`prompts/`, `fixtures/`).
- `exec` / `bash` / `mkdir` / `copy` / `move` / `remove` resolve against
  **`process.cwd()`**.

So `read("foo.agency")` from the agent looks next to the *agent's own
code*, not the user's directory. The current mitigation — `Workspace` /
`openDir(cwd())` in `stdlib/fs.agency`, which binds an absolute dir into
each tool via `.partial(dir:…)` — is buggy by construction: it captures
`cwd()` at module-init time and its `setCwd` shim cannot re-anchor a
`static const`.

## How other agents solve this (research)

Every coding agent surveyed uses a single session-level cwd as the source
of truth that all tools honor:

- **opencode**: one per-session `instance.directory` in context. File
  tools resolve relative→absolute against it (schema asks the LLM for
  absolute paths); the shell tool runs in it with an optional per-call
  `workdir`.
- **Pi**: one mutable session cwd via `sessionManager.getCwd()`; tools are
  created with that cwd and resolve relative paths against it.
- **Claude Code**: file tools require absolute paths; the Bash tool keeps
  a persistent shell so `cd` persists.

## Decision

Adopt the single-source-of-truth model, implemented as a plain Agency
**global variable**. Agency globals are already per-run and per-branch
isolated (each `fork`/`race`/`parallel` branch gets its own snapshot), so
this requires no runtime, ALS, or stack plumbing — the branch-scoping the
session cwd needs comes for free.

Globals cannot be exported directly, so the variable is private to one
stdlib module and reached through exported `getAgentCwd()` /
`setAgentCwd()` functions. The `Agent` in the name distinguishes the
agent's settable working directory from `cwd()`, which returns the OS
process working directory. Every path-taking stdlib wrapper consults it; when set, it
overrides both default bases, otherwise behavior is unchanged.

## Design

### The global + API (`stdlib/system.agency`)

`system.agency` is the home (it already exports `cwd()` and only imports TS
builtins, so there is no import cycle with `index`/`shell`/`fs`).

```ts
// "" means "not set" — fall back to each function's default base.
let _agentCwd = ""

export safe def setAgentCwd(dir: string) {
  _agentCwd = dir
}

export safe def getAgentCwd(): string {
  return _agentCwd
}

// Resolve `dir` against the agent working directory when one is set;
// otherwise return `dir` unchanged so the caller keeps its existing
// default base. `resolve` short-circuits on an absolute `dir`, and
// `resolve(base, "")` returns `base`, so this one helper works for both
// the fs default (".") and the shell default ("").
export safe def applyAgentCwd(dir: string): string {
  const base = getAgentCwd()
  if (base == "") {
    return dir
  }
  return resolve(base, dir)   // std::path.resolve
}
```

`cwd()` is unchanged — it always returns the OS `process.cwd()`.
`getAgentCwd()` is the separate, possibly-unset agent override. The agent
sets the override with `setAgentCwd(cwd())`.

### Per-function change (one line each)

Each path-taking wrapper resolves its directory argument through
`applyAgentCwd` before doing anything else, then proceeds exactly as
today:

- `stdlib/index.agency`: `read`, `write` — `dir = applyAgentCwd(dir)`
- `stdlib/fs.agency`: `edit`, `mkdir`, `copy` (both `src`/`dest`),
  `move` (both `src`/`dest`), `remove`
- `stdlib/shell.agency`: `exec`, `bash` (their `cwd` param), `ls`,
  `glob`, `grep`, `exists`

Because `applyAgentCwd` returns an **absolute** path when the override is
set,
the existing TS `resolveDir`/`resolvePath` need no change — an absolute
`dir` already bypasses the module-dir/`process.cwd()` choice. When the
override is unset, `applyAgentCwd` returns the argument untouched, so all
current behavior (module-dir defaults, `process.cwd()` defaults,
co-located resource bundles) is preserved exactly.

`copy`/`move` apply `applyAgentCwd` to both `src` and `dest`. `applyPatch` is
out of scope (its paths live inside the patch text, not a `dir` arg) and
keeps its current behavior; note this explicitly.

**Absolute paths always bypass the agent cwd — only relative paths are
redirected.** For the `dir`/`cwd`-argument functions this is automatic
(`resolve(base, dir)` returns an absolute `dir` unchanged). `exists` and
`stat` are special: their path is the `filename` argument and they accept
an absolute `filename` today (with `dir` defaulting to `""`). They must
guard with `if (!isAbsolute(filename))` so an absolute `filename` keeps
working when a cwd is set. `read`/`write`/`edit`/`readImage` already reject
absolute `filename`s (existing sandboxing) and are unchanged.

### Containment / sandboxing

`resolvePath` still rejects `..` escapes relative to the resolved base, so
with the override set, relative file paths remain contained under the
working directory. Dropping `Workspace` removes the `allowedPaths`
defaults it bound on `ls`/`glob`/`grep`; the agent already relies on the
interrupt/policy layer (not `allowedPaths`) for approval, so this is
acceptable. Noted as a known reduction, not a regression in the agent's
safety model.

### Agent integration (`lib/agents/agency-agent`)

- At startup (in `setupSession`, before the first turn) call
  `setAgentCwd(cwd())` so the override is pinned to the user's launch
  directory. The override is one branch-scoped global, so the `code`,
  `oracle`, and `explorer` subagents — invoked as tool calls within the
  same run — all observe it.
- Expose `getAgentCwd` and `setAgentCwd` as tools (replacing the code
  subagent's no-op `setCwd` shim) so the user can ask the agent to change
  directory
  and have it persist across turns.
- Remove `static const workspace = openDir(cwd())` from `code.agency`,
  `oracle.agency`, and `explorer.agency`; replace the bundled
  `workspace.*` tools with the raw `read`/`write`/`edit`/`ls`/`glob`/
  `grep`/`bash` tools (plus the existing `agencyCli`).

### Remove `openDir` / `Workspace`

Delete `openDir` and the `Workspace` type from `stdlib/fs.agency`
entirely (only the three subagents referenced them). Update the `fs`
module docs accordingly.

## Testing

Agency execution tests (no LLM), e.g. under
`lib/agents/agency-agent/tests/` or `tests/agency/`:

- `getAgentCwd()` returns `""` before any `setAgentCwd`.
- After `setAgentCwd("/abs/dir")`, `getAgentCwd()` returns it and
  `applyAgentCwd("foo")` returns `/abs/dir/foo`; `applyAgentCwd("/other")`
  returns `/other`; `applyAgentCwd("")` returns `/abs/dir`.
- A `read`/`exec` of a relative path after `setAgentCwd(tmpdir)` hits a
  file created under `tmpdir` (end-to-end resolution).
- **Branch isolation:** a `fork` branch that calls `setAgentCwd(...)` does
  not change the parent's `getAgentCwd()` after the fork completes.
- With the override unset, a co-located resource read still resolves
  against the module dir (regression guard for existing behavior).

## Out of scope

- Persistent shell `cd` across `bash` calls (we keep the
  single-directory model, like Pi/opencode).
- `applyPatch` path rewriting.
- Per-call `workdir` override args on individual tools (the agent changes
  the one cwd via `setAgentCwd` instead).
