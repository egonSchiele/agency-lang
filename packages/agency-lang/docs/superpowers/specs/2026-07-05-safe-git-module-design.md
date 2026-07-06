# Safe `std::git` module — design

**Date:** 2026-07-05
**Status:** Approved design, ready for implementation planning
**Owner:** Aditya Bhargava

## Problem

The agency agent (and any Agency agent) currently does git through the general
`bash`/`exec` tools. That leaves two bad options:

1. **Leave git-via-bash prompting on every call.** Safe, but every `git status`
   / `git diff` interrupts the user — unacceptable friction for the most common
   read operations.
2. **Auto-approve git in a policy rule** (e.g. approve `exec` when
   `command == "git"`, or approve `git diff`). This is *unsafe*: git subcommands
   that look read-only can write arbitrary files or execute arbitrary commands
   via flags and config, so a rule that auto-approves "git diff" actually
   auto-approves file writes and RCE. Concrete vectors:
   - `git diff --output=PATH` / `git format-patch -o PATH` — write attacker-chosen files.
   - `git -c core.pager='!cmd' log`, `git -c core.fsmonitor=cmd status`,
     `GIT_EXTERNAL_DIFF=cmd git diff` — arbitrary command execution.
   - `git ls-remote --upload-pack='cmd'` — RCE. Git's **abbreviated-flag** parsing
     means `--upload-pa` is accepted as `--upload-pack`, defeating exact-string
     blocklists.
   - `git -C /other/repo …` / `git --no-pager commit` — leading global options
     before the subcommand defeat naive `startsWith("git commit")` matching.

We want the agent to auto-approve git **reads** while **writes** prompt — soundly.

## Prior art (why we can beat it)

Research across Claude Code, OpenHands, opencode, pi, Aider, Cursor, Windsurf:

- **Nobody solves flag-based git file-writes with allowlists — because you can't.**
  Every tool that classifies git by command/prefix string (opencode's tree-sitter
  arity, Windsurf's substring lists, Claude Code's read-only-git set) is provably
  bypassable via `-c core.pager=`, `--output=`, alias injection, or abbreviated
  flags. Claude Code's own docs concede argument-constraining patterns are
  "fragile" and point users to an OS sandbox as the real boundary.
- The tools with actual containment (Claude Code OS sandbox, OpenHands Docker)
  win by **isolating the filesystem**, not by parsing git.
- One reusable technique: opencode hardens its *own* internal git calls by always
  prepending `--no-optional-locks -c core.fsmonitor=false …`.

**Agency's advantage:** every one of those tools starts from a general shell tool
and tries to claw back safety by pattern-matching an adversarial *string*. Agency's
effect system lets us invert the problem: the **tool constructs argv from typed
parameters**, so the model never supplies a raw flag string at all. There is no
`--output=` to smuggle because "write output to a file" is not a parameter the diff
tool exposes. This is categorically stronger than allowlist/AST matching — the same
reason `exec()` (argv array, no shell) beats `bash()` in the existing stdlib.

## Approach

A new stdlib module `std::git` exposing **typed, `git`-prefixed tools** whose
argv is built internally. Each operation raises a **per-subcommand effect**
(`std::git::<op>`). Reads are auto-approved via the agent's default policy; writes
propagate and prompt. Three **effect sets** (`Git` / `GitRead` / `GitWrite`) give a
capability vocabulary for `raises` clauses. Return types are **structured**, parsed
from git's porcelain / `--format` output.

### Design decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Tool/argv model | **Typed tools, no raw flags** | Soundly closes the `--output=`/`-c core.pager=` class; the model never supplies a flag string. |
| Effect granularity | **Per-subcommand** (`std::git::<op>`) | Lets policy auto-approve `gitAdd` while always prompting `gitBranchDelete`; two coarse effects couldn't. |
| Effect sets | **`Git` / `GitRead` / `GitWrite`**, declared **in `git.agency`** | Capability vocabulary for `raises` clauses; static, compiler-enforced. Co-located with the tools, not in `capabilities.agency`. Separate layer from runtime policy. |
| Coverage (v1) | **Core everyday set** | ~95% of agent git use; excludes remote + destructive ops. |
| Return types | **Structured, porcelain-backed, narrow** | Nicer + cheaper for the LLM; removes the format-string injection surface. Fixed-domain fields (status codes) are **unions, not `string`**. |
| Restriction | **PFA-friendly params** (`cwd`, path allow-lists, protected-branch lists, `force`/`all` toggles) | A host can `.partial()`-bind these to hand the agent a pre-restricted (optionally `.preapprove()`d) tool. |
| Code placement | **Pure TS core + thin Agency layer; no mutable TS module state** | Process spawn requires TS; parsers/argv are pure so isolation-safe. Any per-run state (none in v1) stays in Agency globals. |
| Naming | **Flat `gitStatus` / `gitDiff`** | Matches stdlib style; reads as clean tool names. |
| `checkout` + `switch` | **Both** | `switch` is the safe modern path; `checkout` kept for compatibility. |
| Bash git bypass | **Not gated** | `std::bash`/`std::exec` already prompt (not in the auto-approve policy), so bash git is a safe, always-prompting escape hatch — not a silent bypass. Accepted limitation. |

## Components

### 1. `stdlib/git.agency` + `lib/stdlib/git.ts` + `lib/runtime/git.ts`

- `stdlib/git.agency` — the Agency-facing tools, effect declarations, and
  docstrings (which become the LLM tool descriptions). Imports the JS helper.
- `lib/stdlib/git.ts` (compiled to `stdlib/git.js`) — thin bridge exposing
  `_gitRun` and the parsers to the `.agency` module (mirrors how `shell.agency`
  imports `_exec` from `agency-lang/stdlib-lib/shell.js`).
- `lib/runtime/git.ts` — the testable core: the argv builder, positional-hardening,
  the `execFile` runner, env scrubbing, and one pure parser per output format.
  Per the repo convention ("push functionality to the runtime — it's testable and
  type-safe"), the real logic lives here.

### 2. The tools (Core everyday set)

**Reads** (auto-approved): `gitStatus`, `gitLog`, `gitDiff`, `gitShow`,
`gitBranchList`, `gitRemoteList`, `gitBlame`, `gitStashList`.

**Writes** (prompt): `gitAdd`, `gitCommit`, `gitCheckout`, `gitSwitch`,
`gitBranchCreate`, `gitBranchDelete`, `gitStashPush`, `gitStashPop`, `gitRestore`.

Each takes typed scalar/boolean/enum parameters only — **no `args: string[]`**.
Signatures are designed so a host can **restrict capability via `.partial()`**
(see "Restriction via partial application" below), so every tool carries a `cwd`
param (pinnable to a repo) and writes carry explicit safety-scoping params.

```
gitLog(n: number = 20, oneline: boolean = false, path: string = "",
       ref: string = "", author: string = "", cwd: string = ""): GitLog
```

### 3. Effects (per-subcommand) — declared in `git.agency`

```
effect std::git::status     { cwd: string }
effect std::git::log        { cwd: string, ref: string, path: string }
effect std::git::diff       { cwd: string, ref: string, staged: boolean, path: string }
effect std::git::show       { cwd: string, ref: string }
effect std::git::branchList { cwd: string }
effect std::git::remoteList { cwd: string }
effect std::git::blame      { cwd: string, path: string }
effect std::git::stashList  { cwd: string }
effect std::git::add        { cwd: string, paths: string[], all: boolean }
effect std::git::commit     { cwd: string, message: string }
effect std::git::checkout   { cwd: string, target: string, force: boolean }
effect std::git::switch     { cwd: string, branch: string, create: boolean }
effect std::git::branchCreate { cwd: string, branch: string }
effect std::git::branchDelete { cwd: string, branch: string, force: boolean }
effect std::git::stashPush  { cwd: string, message: string }
effect std::git::stashPop   { cwd: string }
effect std::git::restore    { cwd: string, paths: string[], staged: boolean }
```

Data fields carry the policy-relevant params (always `cwd`, plus mutation params
like `branch`/`message` and the danger toggles `force`/`all`) so users can write
scoped or conditional rules (e.g. auto-approve `commit` only under a given repo dir
via a `match` on `cwd`, or approve `branchDelete` only when `force` is `false`).

Each tool mirrors `shell.agency`'s `exec()` shape — raise the interrupt, then run
on approval:

```
export def gitStatus(cwd: string = ""): GitStatus raises <std::git::status> {
  """Show the working-tree status … (docstring = tool description)"""
  cwd = applyAgentCwd(cwd)
  return interrupt std::git::status("Run git status?", { cwd })
  return _parseStatus(_gitRun(["status", "--porcelain=v2", "--branch", "-z"], cwd))
}
```

### 4. Effect sets — declared in `git.agency` itself (co-located with the tools)

```
export effectSet GitRead  = <std::git::status, std::git::log, std::git::diff, std::git::show,
                             std::git::branchList, std::git::remoteList, std::git::blame, std::git::stashList>
export effectSet GitWrite = <std::git::add, std::git::commit, std::git::checkout, std::git::switch,
                             std::git::branchCreate, std::git::branchDelete, std::git::stashPush,
                             std::git::stashPop, std::git::restore>
export effectSet Git      = <GitRead, GitWrite>
```

Kept **in the git module** (not `capabilities.agency`) so the sets live next to the
functions and effects they describe — one cohesive unit, imported as
`import { GitRead } from "std::git"`. (The pre-existing `capabilities.agency` sets
predate this module; we don't split git's definitions across two files.)

These are the **static `raises`/capability layer** — an agent node can declare
`raises <GitRead, FileRead>` and have the compiler *guarantee* it performs no git
writes. Each tool still declares its own concrete effect. Effect sets are separate
from — and do **not** auto-generate — the runtime auto-approve policy.

### 5. Default policy wiring — `lib/agents/agency-agent/lib/defaultPolicy.agency`

`recommendedAutoApprovePolicy` gains an explicit auto-approve entry per **read**
effect (concrete keys — the effect set does not expand here, mirroring how the
existing policy enumerates each `std::` effect):

```
"std::git::status": [{ action: "approve" }],
"std::git::log":    [{ action: "approve" }],
"std::git::diff":   [{ action: "approve" }],
"std::git::show":   [{ action: "approve" }],
"std::git::branchList": [{ action: "approve" }],
"std::git::remoteList": [{ action: "approve" }],
"std::git::blame":  [{ action: "approve" }],
"std::git::stashList": [{ action: "approve" }],
// writes omitted → propagate → prompt
```

The git tools are added to the relevant agent tool lists (`mainAgentTools` and/or
the code subagent's tools).

**Conditional (match-based) approval is also available**, not just blanket
approval. Because each effect carries policy-relevant data fields, a rule can
approve *conditionally* — e.g. auto-approve `branchDelete` only when it's
non-destructive, or scope any op to a specific repo:

```
"std::git::branchDelete": [{ match: { force: "false" }, action: "approve" }],  // safe deletes only; force prompts
"std::git::commit":       [{ match: { cwd: "{/repo,/repo/**}" }, action: "approve" }],  // this repo only
```

### 6. Restriction via partial application

Beyond policy, a host can restrict a tool *before handing it to the agent* by
`.partial()`-binding parameters (the bound params are stripped from the LLM's view
and from `@param` docstrings; a restricted tool can then be `.preapprove()`d). This
mirrors the stdlib email `allowList`/`blockList` pattern. So the signatures
deliberately expose safety-scoping params, each defaulting to the safe value:

| Tool | Restriction params (bindable via `.partial()`) |
|---|---|
| *all* | `cwd` — pin to a specific repo (`gitStatus.partial(cwd: repo)`) |
| `gitAdd` | `all: boolean = false` (pin off to forbid `-A`), `allowedPaths: string[] = []` |
| `gitRestore` | `allowedPaths: string[] = []` (contain data-loss to a subtree) |
| `gitBranchDelete` | `force: boolean = false` (pin off), `protectedBranches: string[] = []` (reject e.g. `main`/`master`) |
| `gitCheckout` | `force: boolean = false` (pin off to prevent clobbering local changes) |
| `gitSwitch` | `create: boolean = false` |
| `gitDiff`/`gitLog`/reads | `allowedPaths: string[] = []` (scope reads to a subtree) |

These params are **enforced in the pure TS validator** (reject a path outside
`allowedPaths`, reject a `protectedBranch`, etc.) and documented with `@param` so
they strip cleanly when bound. Three composable safety levers result:
`.partial()` (wiring-time) + policy `match` (runtime rule) + effect sets in `raises`
(static capability bound).

## The safety core — four enforced layers

1. **Tool owns argv.** Booleans/enums map to a fixed, known flag set. The model
   supplies no flag strings, so `--output=`, `--ext-diff`, `-O`, pager flags, etc.
   don't exist as inputs.

2. **Positional-value hardening.** A typed scalar can still be a *flag-shaped
   string* (e.g. `ref: "--output=/etc/x"` → argv `["diff","--output=/etc/x"]`,
   which git would interpret as a flag). So every user-supplied positional
   (refs, paths, branch names) is:
   - inserted after git's `--end-of-options` and/or `--` separators, and
   - **rejected if it starts with `-`** (legit refs/branches don't).

   Message-like values are passed as the *value* of a flag (`commit -m <message>`),
   where git never re-interprets them as options. This is the one place the "no
   raw flags" promise needs active enforcement — sound because the positions and
   separators are fixed and known, unlike general flag-allowlisting.

3. **Defense-in-depth on the process.** Run via `execFile("git", …)` (no shell),
   with hardened config prepended —
   `-c core.pager=cat -c core.fsmonitor=false --no-optional-locks` — and a
   **scrubbed environment** that drops the config/pager/diff-driver RCE vectors:
   `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_SSH_COMMAND`, `GIT_CONFIG*`,
   `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and friends.

4. **Effect/policy/handler layer.** Each op raises its `std::git::<op>` effect;
   reads auto-approve, writes propagate → prompt. Unchanged existing machinery.

`_gitRun` additionally **requires an explicit, absolute, pre-validated repo dir
and never inherits `process.cwd()`** — if the dir is missing/empty it errors
rather than defaulting. This removes the "silently target whatever repo the
process is in" footgun in production, and is load-bearing for test isolation
(below).

## Return types (structured, porcelain-backed)

Git has **no native JSON output** for these commands. Porcelain is a *stability
contract* — a columnar/record text format guaranteed not to change across git
versions or user config. We author the `--format`/`--porcelain`/`-z` strings
ourselves (ASCII unit/record separators `%x1f`/`%x1e` cannot occur in paths or
messages), so parsing is unambiguous and robust against multi-line commit bodies
and spaces-in-paths. One pure parser per format lives in `lib/runtime/git.ts`.

Types are kept **narrow** — fixed-domain fields are unions, not `string` (final
field lists settled during implementation):

```
// git's porcelain change codes are a closed set — model them as a union:
//   "." = unmodified          "M" = modified
//   "A" = added               "D" = deleted
//   "R" = renamed             "C" = copied
//   "U" = unmerged (conflict) "T" = type changed (e.g. file → symlink)
type ChangeCode = "." | "M" | "A" | "D" | "R" | "C" | "U" | "T"
type FileStatus = { path: string, index: ChangeCode, worktree: ChangeCode, renamedFrom?: string }
type GitStatus  = { branch: string, upstream: string, ahead: number, behind: number, entries: FileStatus[] }
type GitCommit  = { sha: string, author: string, email: string, date: string, subject: string, body: string }
type GitLog     = { commits: GitCommit[] }
type FileDiff   = { path: string, status: ChangeCode, additions: number | null, deletions: number | null }  // null = binary
type GitDiff    = { files: FileDiff[], patch: string }   // structured summary + raw unified patch
type GitBranch  = { name: string, current: boolean, upstream: string, sha: string }
type BlameLine  = { sha: string, author: string, line: number, content: string }
```

- `gitStatus`: `git status --porcelain=v2 --branch -z`.
- `gitLog`: `git log --format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x1e`.
- `gitDiff`/`gitShow`: **one invocation** — run the patch and derive the per-file
  summary from its headers/hunks (see the decided open question below), so the
  summary and patch describe one atomic snapshot. Binary files get `null` counts.
- `gitBranchList`: `git for-each-ref --format=…`.
- `gitBlame`: `git blame --porcelain`.
- Writes return small typed results (`gitCommit → { sha, subject }`,
  `gitBranchCreate → { name }`, etc.).

## Testing

Three tiers. v1 has **no fetch/push/pull tools**, so nothing in the module can
touch a network remote — the tests are network-free by construction.

### Tier 1 — pure policy tests (`tests/…/gitPolicy.agency`)
Like the existing `execPolicy.agency`: no git, no fs, no LLM. Assert `checkPolicy`
auto-approves every read effect and propagates (prompts) every write effect.
Deterministic, instant.

### Tier 2 — runtime parser/argv unit tests (`lib/runtime/git.test.ts`)
The bulk of coverage, 100% deterministic and safe — **never spawns a git process**:
- Feed captured porcelain / `--format` fixture strings; assert the parsed structs.
- Assert the argv builder inserts `--end-of-options`/`--` and **rejects
  flag-shaped positionals** (`ref: "--output=x"` → error).
- Assert the restriction validators reject out-of-scope paths / protected branches.
- Assert hardening flags (`-c core.pager=cat`, …) and env scrubbing are present.

Because every helper here is a **pure function** (no mutable module state), these
tests need no isolation setup and are unaffected by the execution-model concern.

### Tier 3 — one end-to-end execution test (`tests/agency/git.agency`)
Exercises the real interrupt → approve → execute path against real git. Isolation
is **fail-closed**, in layers:
1. **Design property:** `_gitRun` requires an explicit absolute repo dir and never
   inherits `process.cwd()`.
2. Create a throwaway repo with `mktemp -d` **outside the project tree**, so no
   ancestor directory is a real repo.
3. Hard-disable git discovery: set `GIT_CEILING_DIRECTORIES` to the sandbox's
   parent (no upward `.git` traversal) and pin `GIT_DIR`/`GIT_WORK_TREE` (or the
   required explicit cwd) to the sandbox.
4. **Fail-closed preflight:** before any mutating command, assert
   `git -C <sandbox> rev-parse --show-toplevel` resolves to the sandbox; on
   mismatch or error, abort the test *before* the write runs.
5. Teardown removes the temp dir; any leak is confined to OS temp.

For the tool to modify a real repo, layers 1–4 would all have to fail at once and
the sandbox path would have to coincidentally be a real repo — while the majority
of tests (tiers 1–2) can't spawn git at all.

> The `.agency` test file lives under `tests/agency/` (for its node_modules); only
> the *repo it operates on* is in OS temp. Do **not** create the temp repo nested
> inside the project's git tree — git would resolve to the parent repo.

## Scope boundaries (v1 non-goals)

- **Remote + destructive ops** — fetch, push, pull, merge, rebase, reset, clean,
  cherry-pick, tag — stay on the always-prompting bash escape hatch until v2. The
  genuinely destructive ones (`push --force`, `reset --hard`, `clean -fd`) need
  careful tool design and must never be auto-approved.
- **Parsed diffs** beyond the per-file summary (status + counts) + raw patch — v2
  (e.g. structured hunks/line-level data).
- **Gating git-via-bash** — deliberately out of scope; bash git already prompts.

## Code placement & execution model

Agency's isolation model gives *each agent run* its own copy of Agency-defined
globals; **state defined in TypeScript is shared across all runs in the process**
unless hand-isolated. That constrains where logic may live:

- **Must be TS:** the process-spawn runner (`_gitRun`). Agency can only spawn
  processes through TS helpers (like `_exec`), and we need a runner that executes
  git *without* raising `std::exec` (we raise our own `std::git::<op>` instead).
- **Best in TS (and safe there):** the argv builder, positional/restriction
  validators, env scrub, and the porcelain/format parsers — they're fiddly and
  benefit from fast vitest fixture tests. This is safe under the execution model
  **because they are pure functions**: input → output, no mutable module state, so
  there is nothing to leak between runs. The isolation rule governs *mutable per-run
  state*, of which this module has none.
- **In Agency:** the LLM-facing layer — types, effects, effect sets, tool
  signatures (with PFA restriction params + docstrings), interrupt raising, and
  orchestration. Thin, auditable, and where any future per-run state would live
  (as an Agency global) to inherit isolation automatically.

**Hard rule for implementation:** no mutable module-level variables in
`lib/runtime/git.ts` or `lib/stdlib/git.ts`. Everything is request/response.

## Implementation sequencing — parser core first

The porcelain/patch parsers are the fiddliest, highest-risk part and are
**independently testable** (pure functions + fixtures, no dependency on the effect
or tool machinery). So the work splits into two sequential plans, each separately
verifiable:

- **Plan 1 (prerequisite): the runtime core** — `lib/runtime/git.ts`: argv builder,
  positional hardening, restriction validators, env scrub, `_gitRun` runner, and
  one parser per output format, with exhaustive vitest fixture tests (Tier 2). The
  patch parser (deriving the diff summary) is the riskiest unit and is proven here
  before anything consumes it. **Land and verify this before Plan 2.**
- **Plan 2: the Agency module + wiring** — `stdlib/git.agency` (+ `lib/stdlib/git.ts`
  bridge): types, effects, effect sets, PFA-friendly tools, default-policy wiring,
  Tier-1 policy test, Tier-3 e2e test — consuming the proven Plan 1 core.

## Reusability

Because the tools **and** the effect sets live in `std::git`, any Agency agent uses
them via `import { gitStatus, GitRead } from "std::git"`. The agency-agent-specific
wiring is confined to `defaultPolicy.agency` and the agent's tool lists.

## Resolved decisions (previously open)

- **`gitDiff` invocation count → one.** Run the patch and derive the per-file
  summary (status + add/delete counts) from its headers and hunks. Rationale:
  atomic consistency (summary and patch describe the same snapshot), one spawn, one
  source of truth. Cost is a more careful parser (new/deleted/renamed/binary), which
  Plan 1 proves against fixtures. Binary files yield `null` counts.
- **Data-loss prompts for `gitRestore` / `gitBranchDelete` → explicit message +
  preview.** The interrupt `message` states the stakes plainly ("Discard
  uncommitted changes to N files? Cannot be undone.") and, where feasible, the
  `data` carries a preview of what would be lost (the discarded diff for restore;
  unmerged commits for an unmerged branch delete), rendered in the prompt like
  `std::edit`'s diff. Not adding typed-confirmation or blocking blanket-approve —
  the user controls their own policy, and `force` is available for conditional
  match-based approval.

## Open questions for the implementation plan

- Exact `--format` field lists and the final field names of each return type.
- The precise env-scrub allow-list vs. block-list for `GIT_*` variables.
- Whether the discarded-work *preview* (for restore/branch-delete) is worth the
  extra pre-write read in v1, or deferred to v2 with the plain explicit message
  shipping first.
