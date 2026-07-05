# Safe `std::git` Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `std::git` stdlib module of typed git tools whose argv is built internally (no raw flags), so an agent can safely auto-approve git *reads* while *writes* prompt.

**Architecture:** A pure TypeScript core (`lib/stdlib/gitCore.ts`: argv builders, pure validators, env scrub, output parsers) + a thin runner/enforcement layer (`lib/stdlib/git.ts`: `gitRunImpl`/`_gitRun` spawn with the explicit-cwd contract, plus `assertPathsContained` reusing the shared symlink-aware `assertContained`), consumed by an Agency module (`stdlib/git.agency`: types, per-subcommand `std::git::*` effects, `Git`/`GitRead`/`GitWrite` effect sets, and the tool functions). Each tool raises its own effect; the agency-agent's default policy auto-approves the read effects. Built in two phases — the pure core lands and is verified first, then the Agency layer consumes it.

**Tech Stack:** TypeScript (compiled via `pnpm run build` → `dist/lib/stdlib/*.js`, importable from `.agency` as `agency-lang/stdlib-lib/*.js`), Agency (`.agency`, compiled via `make stdlib`), vitest (TS unit tests), and the Agency test runner (`pnpm run a test <file>`).

**Spec:** `docs/superpowers/specs/2026-07-05-safe-git-module-design.md`

## Deviations from the spec (intentional; spec is stale on these)

1. **File placement.** Spec says `lib/runtime/git.ts`; this plan uses `lib/stdlib/gitCore.ts` + `lib/stdlib/git.ts`, matching the real precedent (`lib/stdlib/shell.ts` is where `_exec` lives, imported as `agency-lang/stdlib-lib/shell.js`). The plan is right; the spec is stale.
2. **Runner.** Spec says `execFile("git", …)`; this plan uses `abortableSpawn` (no-shell `spawn` with abort-signal propagation + timeout), reusing tested infra and the ALS abort signal. Output is capped in `gitRunImpl` (see R1) to replace `execFile`'s `maxBuffer`.
3. **Log format.** Spec: `…%s%x1f%B%x1e`. Plan splits subject (`%s`) and body (`%b`) into separate fields (better structure); parser and format stay in sync.
4. **Path-restriction placement.** Spec implies restriction validation in the pure core. Because symlink-aware containment (`assertContained`) is `async` + fs-touching, path-allow enforcement lives in the runner/tool layer (`assertPathsContained`), not the pure builders. Only `protectedBranches` (a pure string check) stays in the builder. This reuses the shared helper `exec`/`bash`/`fs` all use, closing a symlink-escape hole a lexical check would leave open.
5. **Tier-3 isolation.** Spec lists five fail-closed layers incl. `GIT_CEILING_DIRECTORIES`/`GIT_DIR` pinning on every git call. That pinning is deliberately NOT applied to the git *tool* spawns: forcing `GIT_DIR`/ceiling in production would break `gitStatus(cwd: repo/subdir)` (git must walk up to the repo root). So the tool-call guarantee is instead: `gitRunImpl`'s explicit-absolute-cwd contract (unit-proven, Task 9) + a repo created at the root of an OS-temp `mktemp -d` dir (no project ancestor) + a clean-tree preflight that aborts before any write. `GIT_CEILING_DIRECTORIES` is set only on the test's *setup* shell as cheap extra defense. See Task 13.

## Verifications already done (recorded so executors don't redo them)

- **Agency boolean/comparison operators are `&&`/`||`, not `and`/`or`.** (`tests/agency/attach-to-reply.agency:64`.)
- **The agency-agent sets the agent cwd at startup** — `agent.agency:1029` `setAgentCwd(cwd())` inside `setupSession`. So in the agency-agent, `gitStatus()` with no `cwd:` resolves to the process cwd. In any *other* host that does not call `setAgentCwd`, the git tools require an explicit `cwd:` (they refuse to inherit `process.cwd()` — that is by design; see B2 handling in Task 10/14).
- **Neither `subagents/code.agency` nor `agent.agency` declares a `raises` clause.** So wiring git tools into them (Task 15) needs no capability-set widening. Guard note: if a future node adds a `raises` clause, widen it to include `GitRead`/`GitWrite` (or `Git`).

## Reuse decisions (checked against the codebase)

- **Path containment → reuse `assertContained`** (`lib/stdlib/assertContained.ts`), the same symlink-aware helper `exec`/`bash`/`fs` use via `resolveDir`. The only new code is `assertPathsContained` (Task 9), a 4-line loop that runs `assertContained(p, allowedPaths, repoDir)` per path and no-ops on an empty list. (`resolveDir` can't be reused directly here: it only bases against `"cwd"`/`"moduleDir"`, but git paths must resolve against the repo dir, which `assertContained`'s explicit `baseDir` supports.)
- **Diff parsing is NOT covered by `std::syntax`.** `syntax.agency`'s `diff()`/`patch()` (backed by `lib/utils/diff.ts`: `computeHunks`/`renderDiff`/`renderPatch`) *generate* a diff from two strings — the opposite direction from `parseDiff`, which *parses* git's diff output. So it can't back `parseDiff`. Two forward pointers, not v1 work: (a) `diff()` is the right tool for the deferred gitRestore/branchDelete **"preview what will be lost"** feature; (b) `lib/utils/diff.ts`'s `Hunk`/`DiffLine` types are what to align with if `GitDiff` gains hunk-level structure in v2.
- **Parser strategy:** delimiter-framed formats (status `-z`, log/branch/blame/remote/stash) use `String.split` — the `-z`/`%x1f`/`%x1e` framing is designed for unambiguous splitting. Only `parseDiff` (a real line-grammar) uses tarsec (Task 7).

## Global Constraints

- **No mutable module-level state in TS.** Every function in `gitCore.ts`/`git.ts` is request/response (pure, or spawn/fs-per-call). Per Agency's execution model, TS module state is shared across all agent runs; this module keeps none. (`docs/dev/globalstore.md`.)
- **No dynamic imports.** Static `import` only. (CLAUDE.md)
- **Objects not maps; arrays not sets; `type` not `interface`.** (CLAUDE.md)
- **Reuse shared helpers.** Path containment uses `assertContained` (`lib/stdlib/assertContained.ts`) — symlink-aware — not a new lexical check. (`docs/dev/anti-patterns.md`: don't duplicate existing code.)
- **Block-form `if` statements** (`docs/dev/coding-standards.md`); no one-line `if`. Multi-word names over single chars where not idiomatic.
- **Never inherit `process.cwd()`.** `gitRunImpl` requires an explicit absolute existing repo dir and throws otherwise.
- **No raw flags from callers.** Tool params are typed scalars/booleans/enums; argv is assembled in `gitCore.ts`. Any user-supplied positional (ref/path/branch) goes after `--end-of-options`/`--` and is rejected if it starts with `-`.
- **Run `make` (or `pnpm run build && make stdlib`) after changing `.agency` stdlib or the TS bridge**, before agency tests — the CLI runs from `dist/`. (CLAUDE.md.)
- **Agency syntax:** `def`/`node` with parens + braces; `if (...) {}`; `let`/`const` before use; `for (x in xs)`; `&&`/`||`; docstrings in `"""..."""` with `@param name - desc`. (`docs/site/guide/basic-syntax.md`.)
- **Commit message / PR body via file, not inline** (apostrophe escaping). End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

# Phase 1 — Pure runtime core

Phase 1 has no Agency dependency and is fully unit-tested in vitest (including real-git round-trips against temp repos). **Land and verify all of Phase 1 before starting Phase 2.**

Run Phase-1 tests with: `pnpm exec vitest run lib/stdlib/gitCore.test.ts lib/stdlib/git.test.ts 2>&1 | tee /tmp/git-phase1.log`.

---

### Task 0: Preflight verifications (parse + git-version assumptions)

**Files:** none (verification only; record results in a scratch note).

- [ ] **Step 1: Confirm `switch`/`show`/`restore` are valid effect-path segments and `raises` accepts them**

Create `/tmp/gitfx.agency`:

```
effect std::git::switch { cwd: string }
effect std::git::show { cwd: string }
effect std::git::restore { cwd: string }
def f(): number raises <std::git::switch, std::git::show, std::git::restore> { return 1 }
```

Run: `pnpm run ast /tmp/gitfx.agency > /tmp/gitfx.json 2>&1`
Expected: parses without error (no "expected effect" / reserved-word failure). If it fails, rename the offending effect segment (e.g. `switchBranch`) and update Tasks 11–13 consistently.

- [ ] **Step 2: Confirm `--end-of-options` is supported by the target git**

Run: `git --version` (record it) and `cd $(mktemp -d) && git init -q && git log --end-of-options 2>&1 | head -1`
Expected: git ≥ 2.24; `--end-of-options` does not error with "unknown option". Record the minimum version in the plan/PR. If the environment's git is older, the safety story needs `--` only — stop and escalate.

- [ ] **Step 3: Commit the recorded results**

```bash
# (no code) — note git version + parse result in the PR description or a scratch file.
```

---

### Task 1: Shared types + positional hardening

**Files:**
- Create: `lib/stdlib/gitCore.ts`
- Test: `lib/stdlib/gitCore.test.ts`

**Interfaces:**
- Produces: `type ChangeCode` (includes `"?"`/`"!"`), `type FileStatus`, `type GitStatus`, `type GitCommit`, `type GitLog`, `type FileDiff`, `type GitDiff`, `type GitBranch`, `type BlameLine`, `type GitRemote`, `type GitStash`; `hardenPositional(value: string, label: string): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/stdlib/gitCore.test.ts
import { describe, it, expect } from "vitest";
import { hardenPositional } from "./gitCore.js";

describe("hardenPositional", () => {
  it("passes through a normal ref/path/branch", () => {
    expect(hardenPositional("HEAD~1", "ref")).toBe("HEAD~1");
    expect(hardenPositional("src/index.ts", "path")).toBe("src/index.ts");
    expect(hardenPositional("feature/x", "branch")).toBe("feature/x");
  });
  it("rejects a flag-shaped value (the injection vector)", () => {
    expect(() => hardenPositional("--output=/etc/x", "ref")).toThrow(/ref/);
    expect(() => hardenPositional("-O", "path")).toThrow(/path/);
  });
  it("rejects empty values", () => {
    expect(() => hardenPositional("", "branch")).toThrow(/branch/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/gitCore.test.ts`
Expected: FAIL — `hardenPositional` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/stdlib/gitCore.ts
// Pure git helpers: shared types, argv builders, the pure protected-branch
// check, env scrubbing, and output parsers. NO mutable module state, NO
// process spawning, NO fs, NO AsyncLocalStorage. Path-containment (which is
// async + symlink-aware) lives in git.ts, not here.

// git's porcelain change codes are a closed set:
//   "." = unmodified          "M" = modified
//   "A" = added               "D" = deleted
//   "R" = renamed             "C" = copied
//   "U" = unmerged (conflict) "T" = type changed (e.g. file -> symlink)
//   "?" = untracked           "!" = ignored
export type ChangeCode = "." | "M" | "A" | "D" | "R" | "C" | "U" | "T" | "?" | "!";

export type FileStatus = {
  path: string;
  index: ChangeCode;
  worktree: ChangeCode;
  renamedFrom?: string;
};
export type GitStatus = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  entries: FileStatus[];
};
export type GitCommit = {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
};
export type GitLog = { commits: GitCommit[] };
export type FileDiff = {
  path: string;
  status: ChangeCode;
  additions: number | null; // null for binary files
  deletions: number | null;
};
export type GitDiff = { files: FileDiff[]; patch: string };
export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string;
  sha: string;
};
export type BlameLine = {
  sha: string;
  author: string;
  line: number;
  content: string;
};
export type GitRemote = { name: string; url: string; direction: "fetch" | "push" };
export type GitStash = { ref: string; description: string };

/**
 * Guard a user-supplied positional (ref, path, branch) before it becomes an
 * argv element. A value beginning with "-" would be parsed by git as an
 * option (e.g. `--output=`), so reject it. Callers still place these after
 * `--end-of-options` / `--` in the argv; this is the second, belt-and-braces
 * layer. NOTE: this also rejects legitimate filenames that start with "-"
 * (e.g. "-foo.txt"); document that limitation in the tool `@param`s.
 */
export function hardenPositional(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`git: empty ${label} is not allowed`);
  }
  if (value.startsWith("-")) {
    throw new Error(
      `git: ${label} "${value}" may not start with "-" (looks like a flag)`,
    );
  }
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run lib/stdlib/gitCore.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/gitCore.ts lib/stdlib/gitCore.test.ts
git commit -F <msg-file>   # "feat(git): gitCore types + positional hardening"
```

---

### Task 2: Protected-branch validator (pure)

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:**
- Produces: `assertBranchAllowed(branch: string, protectedBranches: string[]): void` (throws on a protected branch; no-op when the list is empty).

> Path containment is intentionally NOT here — it is async + symlink-aware and lives in `git.ts` (`assertPathsContained`, Task 10). See Deviation #4.

- [ ] **Step 1: Write the failing test**

```typescript
// add to lib/stdlib/gitCore.test.ts
import { assertBranchAllowed } from "./gitCore.js";

describe("assertBranchAllowed", () => {
  it("no-ops when protectedBranches is empty", () => {
    expect(() => assertBranchAllowed("main", [])).not.toThrow();
  });
  it("rejects a protected branch", () => {
    expect(() => assertBranchAllowed("main", ["main", "master"])).toThrow(/protected/);
  });
  it("allows a non-protected branch", () => {
    expect(() => assertBranchAllowed("feature/x", ["main", "master"])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm exec vitest run lib/stdlib/gitCore.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to lib/stdlib/gitCore.ts
export function assertBranchAllowed(branch: string, protectedBranches: string[]): void {
  if (protectedBranches.includes(branch)) {
    throw new Error(`git: branch "${branch}" is protected and may not be modified`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git commit -F <msg-file>` ("feat(git): protected-branch validator").

---

### Task 3: Hardening constants + env scrub

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:**
- Produces: `GIT_HARDENING_FLAGS: string[]`; `scrubEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv`; `FIELD_SEP`, `RECORD_SEP`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to lib/stdlib/gitCore.test.ts
import { GIT_HARDENING_FLAGS, scrubEnv } from "./gitCore.js";

describe("GIT_HARDENING_FLAGS", () => {
  it("is exactly the expected paired -c flags", () => {
    // Exact match: each -c must be paired with its value (a shuffled/broken
    // array would pass a mere `.contains` check).
    expect(GIT_HARDENING_FLAGS).toEqual([
      "-c", "core.pager=cat",
      "-c", "core.fsmonitor=false",
      "--no-optional-locks",
    ]);
  });
});

describe("scrubEnv", () => {
  it("drops every listed git command-injection var", () => {
    const out = scrubEnv({
      PATH: "/usr/bin",
      GIT_EXTERNAL_DIFF: "x", GIT_PAGER: "x", GIT_SSH_COMMAND: "x",
      GIT_SSH: "x", GIT_PROXY_COMMAND: "x", GIT_ALTERNATE_OBJECT_DIRECTORIES: "x",
      GIT_CONFIG_GLOBAL: "x", GIT_CONFIG_COUNT: "1",
    });
    expect(out.PATH).toBe("/usr/bin");
    for (const k of ["GIT_EXTERNAL_DIFF","GIT_PAGER","GIT_SSH_COMMAND","GIT_SSH",
      "GIT_PROXY_COMMAND","GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_CONFIG_GLOBAL","GIT_CONFIG_COUNT"]) {
      expect(out[k]).toBeUndefined();
    }
  });
  it("keeps lookalikes that must survive (boundary)", () => {
    const out = scrubEnv({ GIT_AUTHOR_NAME: "Amy", GITHUB_TOKEN: "t" });
    expect(out.GIT_AUTHOR_NAME).toBe("Amy"); // NOT stripped by a too-wide GIT* rule
    expect(out.GITHUB_TOKEN).toBe("t");
  });
  it("does not mutate the input", () => {
    const base = { GIT_PAGER: "x" };
    scrubEnv(base);
    expect(base.GIT_PAGER).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to lib/stdlib/gitCore.ts

// Record/field separators for our custom --format strings. These bytes are
// practically never present in paths or commit messages, so splitting on
// them is effectively unambiguous. (Git technically permits arbitrary bytes
// in a commit message; the parsers degrade gracefully — extra fields are
// ignored — rather than crash.)
export const FIELD_SEP = "\x1f";  // %x1f
export const RECORD_SEP = "\x1e"; // %x1e

/** Config flags prepended to every invocation (before the subcommand). */
export const GIT_HARDENING_FLAGS: string[] = [
  "-c", "core.pager=cat",
  "-c", "core.fsmonitor=false",
  "--no-optional-locks",
];

// Env vars that let git run arbitrary commands or load attacker config.
// A trailing "*" matches any var starting with that prefix.
const SCRUB_ENV_KEYS: string[] = [
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG*", // GIT_CONFIG, GIT_CONFIG_GLOBAL/SYSTEM, GIT_CONFIG_COUNT/KEY_n/VALUE_n
];

/** Shallow copy of `base` with git command-injection vars removed. */
export function scrubEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(out)) {
    for (const rule of SCRUB_ENV_KEYS) {
      const matches = rule.endsWith("*")
        ? key.startsWith(rule.slice(0, -1))
        : key === rule;
      if (matches) {
        delete out[key];
        break;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — ("feat(git): hardening flags + env scrub").

---

### Task 4: Argv builders (one per subcommand)

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:** Consumes `hardenPositional`, `assertBranchAllowed`, `FIELD_SEP`, `RECORD_SEP`. Produces builders returning `string[]` (starting with the subcommand; hardening flags are prepended later by the runner). Path-restriction is NOT here (moved to the tool layer). Signatures:
- `statusArgs(): string[]`
- `logArgs(o: { n: number; oneline: boolean; path: string; ref: string; author: string }): string[]`
- `diffArgs(o: { ref: string; ref2: string; staged: boolean; path: string }): string[]`
- `showArgs(o: { ref: string }): string[]`
- `branchListArgs(): string[]`, `remoteListArgs(): string[]`, `stashListArgs(): string[]`
- `blameArgs(o: { path: string; ref: string }): string[]`
- `addArgs(o: { paths: string[]; all: boolean }): string[]`
- `commitArgs(o: { message: string }): string[]`
- `checkoutArgs(o: { target: string; force: boolean }): string[]`
- `switchArgs(o: { branch: string; create: boolean }): string[]`
- `branchCreateArgs(o: { branch: string }): string[]`
- `branchDeleteArgs(o: { branch: string; force: boolean; protectedBranches: string[] }): string[]`
- `stashPushArgs(o: { message: string }): string[]`, `stashPopArgs(): string[]`
- `restoreArgs(o: { paths: string[]; staged: boolean }): string[]`

- [ ] **Step 1: Write the failing test** (exhaustive — every builder, exact assertions)

```typescript
// add to lib/stdlib/gitCore.test.ts
import {
  statusArgs, logArgs, diffArgs, showArgs, branchListArgs, remoteListArgs,
  blameArgs, stashListArgs, addArgs, commitArgs, checkoutArgs, switchArgs,
  branchCreateArgs, branchDeleteArgs, stashPushArgs, stashPopArgs, restoreArgs,
} from "./gitCore.js";

describe("argv builders", () => {
  it("statusArgs", () => {
    expect(statusArgs()).toEqual(["status", "--porcelain=v2", "--branch", "-z"]);
  });
  it("branchListArgs / remoteListArgs / stashListArgs / stashPopArgs are fixed", () => {
    expect(branchListArgs()[0]).toBe("for-each-ref");
    expect(remoteListArgs()).toEqual(["remote", "-v"]);
    expect(stashListArgs()).toEqual(["stash", "list"]);
    expect(stashPopArgs()).toEqual(["stash", "pop"]);
  });
  it("logArgs maps typed params and separates ref (after --end-of-options) and path (after --)", () => {
    const a = logArgs({ n: 5, oneline: true, path: "src/", ref: "HEAD~3", author: "amy" });
    expect(a[0]).toBe("log");
    expect(a).toContain("-n"); expect(a).toContain("5");
    expect(a).toContain("--author=amy");
    expect(a).toContain("--end-of-options");
    expect(a[a.length - 1]).toBe("src/");
    expect(a[a.length - 2]).toBe("--");
  });
  it("logArgs rejects a flag-shaped ref", () => {
    expect(() => logArgs({ n: 5, oneline: false, path: "", ref: "--output=x", author: "" })).toThrow();
  });
  it("diffArgs emits the patch and places -- immediately before the path", () => {
    const a = diffArgs({ ref: "HEAD", ref2: "", staged: false, path: "src/x.ts" });
    expect(a[0]).toBe("diff");
    expect(a).toContain("--patch");
    expect(a[a.indexOf("src/x.ts") - 1]).toBe("--");
  });
  it("diffArgs staged + two refs", () => {
    const a = diffArgs({ ref: "A", ref2: "B", staged: true, path: "" });
    expect(a).toContain("--staged");
    expect(a.indexOf("A")).toBeGreaterThan(a.indexOf("--end-of-options"));
    expect(a.indexOf("B")).toBeGreaterThan(a.indexOf("A"));
  });
  it("showArgs", () => {
    expect(showArgs({ ref: "HEAD" })).toEqual(["show", "--patch", "-M", "--end-of-options", "HEAD"]);
  });
  it("blameArgs hardens path and (optional) ref", () => {
    expect(blameArgs({ path: "a.ts", ref: "" })).toEqual(["blame", "--porcelain", "--end-of-options", "--", "a.ts"]);
    expect(() => blameArgs({ path: "-x", ref: "" })).toThrow(/path/);
  });
  it("addArgs forbids -A only when all=false", () => {
    expect(addArgs({ paths: ["a.ts"], all: false })).toEqual(["add", "--", "a.ts"]);
    expect(addArgs({ paths: [], all: true })).toEqual(["add", "-A"]);
    expect(() => addArgs({ paths: ["-x"], all: false })).toThrow(/path/);
  });
  it("commitArgs passes the message as the value of -m; rejects empty", () => {
    expect(commitArgs({ message: "--amend looking msg" })).toEqual(["commit", "-m", "--amend looking msg"]);
    expect(() => commitArgs({ message: "" })).toThrow(/empty/);
  });
  it("checkoutArgs / switchArgs", () => {
    expect(checkoutArgs({ target: "main", force: false })).toEqual(["checkout", "--end-of-options", "main"]);
    expect(checkoutArgs({ target: "main", force: true })).toEqual(["checkout", "--force", "--end-of-options", "main"]);
    expect(switchArgs({ branch: "x", create: true })).toEqual(["switch", "-c", "--end-of-options", "x"]);
  });
  it("branchCreateArgs / branchDeleteArgs (force + protected)", () => {
    expect(branchCreateArgs({ branch: "x" })).toEqual(["branch", "--end-of-options", "x"]);
    expect(branchDeleteArgs({ branch: "x", force: false, protectedBranches: [] })).toEqual(["branch", "-d", "--end-of-options", "x"]);
    expect(branchDeleteArgs({ branch: "x", force: true, protectedBranches: [] })).toEqual(["branch", "-D", "--end-of-options", "x"]);
    expect(() => branchDeleteArgs({ branch: "main", force: true, protectedBranches: ["main"] })).toThrow(/protected/);
  });
  it("stashPushArgs / restoreArgs", () => {
    expect(stashPushArgs({ message: "" })).toEqual(["stash", "push"]);
    expect(stashPushArgs({ message: "wip" })).toEqual(["stash", "push", "-m", "wip"]);
    expect(restoreArgs({ paths: ["a.ts"], staged: false })).toEqual(["restore", "--", "a.ts"]);
    expect(restoreArgs({ paths: ["a.ts"], staged: true })).toEqual(["restore", "--staged", "--", "a.ts"]);
    expect(() => restoreArgs({ paths: ["-x"], staged: false })).toThrow(/path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (builders not exported).

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to lib/stdlib/gitCore.ts
export function statusArgs(): string[] {
  return ["status", "--porcelain=v2", "--branch", "-z"];
}

export function logArgs(o: { n: number; oneline: boolean; path: string; ref: string; author: string }): string[] {
  const args: string[] = ["log"];
  if (o.n > 0) {
    args.push("-n", String(o.n));
  }
  const fmt = o.oneline
    ? `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}${RECORD_SEP}`
    : `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  args.push(fmt);
  if (o.author) {
    args.push(`--author=${o.author}`);
  }
  args.push("--end-of-options");
  if (o.ref) {
    args.push(hardenPositional(o.ref, "ref"));
  }
  if (o.path) {
    args.push("--", hardenPositional(o.path, "path"));
  }
  return args;
}

export function diffArgs(o: { ref: string; ref2: string; staged: boolean; path: string }): string[] {
  const args: string[] = ["diff", "--patch", "-M"];
  if (o.staged) {
    args.push("--staged");
  }
  args.push("--end-of-options");
  if (o.ref) {
    args.push(hardenPositional(o.ref, "ref"));
  }
  if (o.ref2) {
    args.push(hardenPositional(o.ref2, "ref"));
  }
  if (o.path) {
    args.push("--", hardenPositional(o.path, "path"));
  }
  return args;
}

export function showArgs(o: { ref: string }): string[] {
  const args: string[] = ["show", "--patch", "-M", "--end-of-options"];
  if (o.ref) {
    args.push(hardenPositional(o.ref, "ref"));
  }
  return args;
}

export function branchListArgs(): string[] {
  return [
    "for-each-ref",
    `--format=%(refname:short)${FIELD_SEP}%(HEAD)${FIELD_SEP}%(upstream:short)${FIELD_SEP}%(objectname)${RECORD_SEP}`,
    "refs/heads",
  ];
}

export function remoteListArgs(): string[] {
  return ["remote", "-v"];
}

export function blameArgs(o: { path: string; ref: string }): string[] {
  const args: string[] = ["blame", "--porcelain", "--end-of-options"];
  if (o.ref) {
    args.push(hardenPositional(o.ref, "ref"));
  }
  args.push("--", hardenPositional(o.path, "path"));
  return args;
}

export function stashListArgs(): string[] {
  return ["stash", "list"];
}

export function addArgs(o: { paths: string[]; all: boolean }): string[] {
  if (o.all) {
    return ["add", "-A"];
  }
  const hardened = o.paths.map((p) => hardenPositional(p, "path"));
  return ["add", "--", ...hardened];
}

export function commitArgs(o: { message: string }): string[] {
  if (o.message.length === 0) {
    throw new Error("git: commit message may not be empty");
  }
  return ["commit", "-m", o.message];
}

export function checkoutArgs(o: { target: string; force: boolean }): string[] {
  const args: string[] = ["checkout"];
  if (o.force) {
    args.push("--force");
  }
  args.push("--end-of-options", hardenPositional(o.target, "target"));
  return args;
}

export function switchArgs(o: { branch: string; create: boolean }): string[] {
  const args: string[] = ["switch"];
  if (o.create) {
    args.push("-c");
  }
  args.push("--end-of-options", hardenPositional(o.branch, "branch"));
  return args;
}

export function branchCreateArgs(o: { branch: string }): string[] {
  return ["branch", "--end-of-options", hardenPositional(o.branch, "branch")];
}

export function branchDeleteArgs(o: { branch: string; force: boolean; protectedBranches: string[] }): string[] {
  assertBranchAllowed(o.branch, o.protectedBranches);
  return ["branch", o.force ? "-D" : "-d", "--end-of-options", hardenPositional(o.branch, "branch")];
}

export function stashPushArgs(o: { message: string }): string[] {
  const args: string[] = ["stash", "push"];
  if (o.message) {
    args.push("-m", o.message);
  }
  return args;
}

export function stashPopArgs(): string[] {
  return ["stash", "pop"];
}

export function restoreArgs(o: { paths: string[]; staged: boolean }): string[] {
  const args: string[] = ["restore"];
  if (o.staged) {
    args.push("--staged");
  }
  const hardened = o.paths.map((p) => hardenPositional(p, "path"));
  args.push("--", ...hardened);
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — ("feat(git): per-subcommand argv builders").

---

### Task 5: Parse-framing helpers + `parseStatus`

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:** Produces `splitRecords(stdout: string): string[][]`, `nonEmptyLines(stdout: string): string[]`, `parseStatus(stdout: string): GitStatus`.

- [ ] **Step 1: Write the failing test** (includes space-in-path and unmerged record — T2)

```typescript
// add to lib/stdlib/gitCore.test.ts
import { parseStatus } from "./gitCore.js";

describe("parseStatus", () => {
  it("parses branch headers, modified/added, a space-in-path, a rename, an unmerged record, and untracked", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 hhh iii src/mod.ts",
      "1 A. N... 000000 100644 100644 000 jjj my file.ts",   // space in path
      "2 R. N... 100644 100644 100644 kkk lll R100 dst.ts",
      "old.ts",                                              // origPath NUL field
      "u UU N... 100644 100644 100644 100644 m1 m2 m3 conflict.ts",
      "? untracked.ts",
    ].join("\0") + "\0";
    const s = parseStatus(out);
    expect(s.branch).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.entries).toContainEqual({ path: "src/mod.ts", index: ".", worktree: "M" });
    expect(s.entries).toContainEqual({ path: "my file.ts", index: "A", worktree: "." });
    expect(s.entries).toContainEqual({ path: "dst.ts", index: "R", worktree: ".", renamedFrom: "old.ts" });
    expect(s.entries).toContainEqual({ path: "conflict.ts", index: "U", worktree: "U" });
    expect(s.entries).toContainEqual({ path: "untracked.ts", index: "?", worktree: "?" });
    expect(s.entries).toHaveLength(5);
  });
});
```

> Capture a real fixture to sanity-check the byte layout:
> `cd $(mktemp -d) && git init -q && printf x > 'a b' && git add . && git status --porcelain=v2 --branch -z | cat -v`

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to lib/stdlib/gitCore.ts

/** Split RECORD_SEP-delimited output into per-record FIELD_SEP arrays,
 *  dropping git's inter-record newline and blank records. */
export function splitRecords(stdout: string): string[][] {
  return stdout
    .split(RECORD_SEP)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim() !== "")
    .map((rec) => rec.split(FIELD_SEP));
}

/** Non-blank lines of newline-delimited output. */
export function nonEmptyLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

function toCode(ch: string): ChangeCode {
  return (ch === " " ? "." : ch) as ChangeCode;
}

// porcelain-v2 record layouts (space-separated fields BEFORE the path):
//   type "1" ordinary:   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>   -> path starts at field 8
//   type "2" rename/copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>  -> path at field 9 (+ origPath = next NUL token)
//   type "u" unmerged:   u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> -> path at field 10
const ORDINARY_PATH_FIELD = 8;
const RENAME_PATH_FIELD = 9;
const UNMERGED_PATH_FIELD = 10;

export function parseStatus(stdout: string): GitStatus {
  const result: GitStatus = { branch: "", upstream: "", ahead: 0, behind: 0, entries: [] };
  const tokens = stdout.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") {
    tokens.pop(); // trailing empty token after the final NUL (NOT a useless special case)
  }
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i];
    if (rec.startsWith("# branch.head ")) {
      result.branch = rec.slice("# branch.head ".length);
    } else if (rec.startsWith("# branch.upstream ")) {
      result.upstream = rec.slice("# branch.upstream ".length);
    } else if (rec.startsWith("# branch.ab ")) {
      const m = rec.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
    } else if (rec.startsWith("# ")) {
      // other branch header (branch.oid) — ignore
    } else if (rec.startsWith("1 ")) {
      const parts = rec.split(" ");
      const xy = parts[1];
      result.entries.push({ path: parts.slice(ORDINARY_PATH_FIELD).join(" "), index: toCode(xy[0]), worktree: toCode(xy[1]) });
    } else if (rec.startsWith("2 ")) {
      const parts = rec.split(" ");
      const xy = parts[1];
      const renamedFrom = tokens[i + 1] ?? "";
      i++; // consume the origPath NUL field
      result.entries.push({ path: parts.slice(RENAME_PATH_FIELD).join(" "), index: toCode(xy[0]), worktree: toCode(xy[1]), renamedFrom });
    } else if (rec.startsWith("u ")) {
      result.entries.push({ path: rec.split(" ").slice(UNMERGED_PATH_FIELD).join(" "), index: "U", worktree: "U" });
    } else if (rec.startsWith("? ")) {
      result.entries.push({ path: rec.slice(2), index: "?", worktree: "?" });
    } else if (rec.startsWith("! ")) {
      result.entries.push({ path: rec.slice(2), index: "!", worktree: "!" });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — ("feat(git): parse-framing helpers + parseStatus").

---

### Task 6: `parseLog` + `parseBranchList` (via `splitRecords`)

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:** Produces `parseLog(stdout: string): GitLog`, `parseBranchList(stdout: string): GitBranch[]`.

- [ ] **Step 1: Write the failing test** (fixtures include the inter-record `\n` git actually emits — T-BLOCK2; assert length)

```typescript
// add to lib/stdlib/gitCore.test.ts
import { parseLog, parseBranchList, FIELD_SEP as FS, RECORD_SEP as RS } from "./gitCore.js";

describe("parseLog", () => {
  it("parses commits with multi-line bodies; tolerates git's inter-record newline", () => {
    const rec = (f: string[]) => f.join(FS);
    // git emits "<record>%x1e\n<record>%x1e" — include the \n so splitRecords' drop is exercised.
    const out =
      rec(["sha1", "Amy", "amy@x.com", "2026-01-01T00:00:00Z", "subj one", "body\nline2"]) + RS + "\n" +
      rec(["sha2", "Bob", "bob@x.com", "2026-01-02T00:00:00Z", "subj two", ""]) + RS + "\n";
    const log = parseLog(out);
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0]).toEqual({
      sha: "sha1", author: "Amy", email: "amy@x.com",
      date: "2026-01-01T00:00:00Z", subject: "subj one", body: "body\nline2",
    });
    expect(log.commits[1].body).toBe("");
  });
  it("returns no commits for empty output", () => {
    expect(parseLog("").commits).toEqual([]);
  });
});

describe("parseBranchList", () => {
  it("marks current, captures upstream + sha; asserts full array", () => {
    const out =
      ["main", "*", "origin/main", "aaa"].join(FS) + RS + "\n" +
      ["feature/x", " ", "", "bbb"].join(FS) + RS + "\n";
    expect(parseBranchList(out)).toEqual([
      { name: "main", current: true, upstream: "origin/main", sha: "aaa" },
      { name: "feature/x", current: false, upstream: "", sha: "bbb" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to lib/stdlib/gitCore.ts
export function parseLog(stdout: string): GitLog {
  const commits = splitRecords(stdout).map((f) => ({
    sha: f[0] ?? "",
    author: f[1] ?? "",
    email: f[2] ?? "",
    date: f[3] ?? "",
    subject: f[4] ?? "",
    body: (f[5] ?? "").replace(/\n$/, ""),
  }));
  return { commits };
}

export function parseBranchList(stdout: string): GitBranch[] {
  return splitRecords(stdout).map((f) => ({
    name: f[0] ?? "",
    current: (f[1] ?? "").trim() === "*",
    upstream: f[2] ?? "",
    sha: f[3] ?? "",
  }));
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — ("feat(git): parseLog + parseBranchList").

---

### Task 7: `parseDiff` (patch → summary, the riskiest unit) — via **tarsec**

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:** Produces `parseDiff(patch: string): GitDiff`.

> **Why tarsec here (and only here):** the delimiter-framed parsers (status `-z`,
> log/branch/blame/remote/stash) stay `String.split` — those formats are designed
> for unambiguous field-splitting, so a combinator grammar buys nothing. The unified
> diff is the one genuine line-*grammar* and the riskiest parser, so it uses tarsec
> (house style — cf. `shell.ts`'s glob parser and `lib/parsers/parsers.ts`). tarsec
> frames the per-file blocks robustly; a small pure `summarizeFile` fold does the
> `+`/`-` counting (a fold, not a grammar concern). Verify combinator signatures
> against the tarsec docs (https://egonschiele.github.io/tarsec/) while implementing.

- [ ] **Step 1: Write the failing test** (adds rename, text-new-file, multi-hunk — T2)

```typescript
// add to lib/stdlib/gitCore.test.ts
import { parseDiff } from "./gitCore.js";

describe("parseDiff", () => {
  it("derives status + counts across modified, deleted, renamed, text-new, and binary files", () => {
    const patch = [
      "diff --git a/mod.ts b/mod.ts",
      "index 111..222 100644",
      "--- a/mod.ts", "+++ b/mod.ts",
      "@@ -1,2 +1,3 @@", " ctx", "-old", "+new1", "+new2",
      "@@ -10 +11,2 @@", " ctx2", "+another",        // second hunk (multi-hunk)
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts", "+++ /dev/null",
      "@@ -1 +0,0 @@", "-bye",
      "diff --git a/moved.ts b/moved2.ts",
      "similarity index 100%", "rename from moved.ts", "rename to moved2.ts",
      "diff --git a/fresh.ts b/fresh.ts",
      "new file mode 100644", "--- /dev/null", "+++ b/fresh.ts",
      "@@ -0,0 +1,2 @@", "+a", "+b",
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/logo.png differ",
    ].join("\n") + "\n";
    const d = parseDiff(patch);
    expect(d.patch).toBe(patch);
    expect(d.files).toContainEqual({ path: "mod.ts", status: "M", additions: 3, deletions: 1 });
    expect(d.files).toContainEqual({ path: "gone.ts", status: "D", additions: 0, deletions: 1 });
    expect(d.files).toContainEqual({ path: "moved2.ts", status: "R", additions: 0, deletions: 0 });
    expect(d.files).toContainEqual({ path: "fresh.ts", status: "A", additions: 2, deletions: 0 });
    expect(d.files).toContainEqual({ path: "logo.png", status: "A", additions: null, deletions: null });
    expect(d.files).toHaveLength(5);
  });
  it("returns no files for an empty diff (general path handles it — no special case)", () => {
    expect(parseDiff("")).toEqual({ files: [], patch: "" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Write minimal implementation** (tarsec framing + a pure counting fold)

```typescript
// add near the top of lib/stdlib/gitCore.ts (with the other imports)
import {
  str, capture, map, many, seqC, optional, newline, noneOf, not, eof,
  manyWithJoin, type Parser,
} from "tarsec";

// add to lib/stdlib/gitCore.ts

// The rest of the current line as a string (newline NOT consumed).
const restOfLineStr: Parser<string> = manyWithJoin(noneOf("\n"));

// "diff --git a/<x> b/<y>" header → the b/ side (the path).
// `.*` is greedy: a filename literally containing " b/" is mis-split, but git
// quotes such paths, so this is a known low-risk edge, not a v1 goal.
const diffGitLine: Parser<string> = map(
  seqC(str("diff --git "), capture(restOfLineStr, "hdr"), optional(newline)),
  (c: { hdr: string }) => {
    const m = c.hdr.match(/ b\/(.*)$/);
    return m ? m[1] : "";
  },
);

// Any line that does NOT begin a new file block. `not(eof)` prevents a
// zero-consumption success at end-of-input (which would spin `many` forever).
const bodyLine: Parser<string> = map(
  seqC(not(eof), not(str("diff --git ")), capture(restOfLineStr, "line"), optional(newline)),
  (c: { line: string }) => c.line,
);

// One file block: its `diff --git` header + all following body lines.
const fileBlock: Parser<FileDiff> = map(
  seqC(capture(diffGitLine, "path"), capture(many(bodyLine), "lines")),
  (c: { path: string; lines: string[] }) => summarizeFile(c.path, c.lines),
);

// `many` yields [] for empty/non-matching input, so parseDiff("") -> {files:[]}
// needs no special-case guard.
const patchParser: Parser<FileDiff[]> = many(fileBlock);

// Pure fold over one file block's captured lines. Counting `+`/`-` is a fold,
// not a grammar concern, so it stays plain. Merge commits produce a combined
// diff (`diff --cc`, `@@@`, `++`/`--`) this miscounts — documented in gitShow.
function summarizeFile(path: string, lines: string[]): FileDiff {
  let status: ChangeCode = "M";
  let additions: number | null = 0;
  let deletions: number | null = 0;
  let finalPath = path;
  for (const line of lines) {
    if (line.startsWith("new file mode")) {
      status = "A";
    } else if (line.startsWith("deleted file mode")) {
      status = "D";
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      status = "R";
    } else if (line.startsWith("Binary files")) {
      additions = null;
      deletions = null;
    } else if (line.startsWith("+++ b/")) {
      finalPath = line.slice("+++ b/".length);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (additions !== null) {
        additions++;
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (deletions !== null) {
        deletions++;
      }
    }
  }
  return { path: finalPath, status, additions, deletions };
}

export function parseDiff(patch: string): GitDiff {
  const result = patchParser(patch);
  // tarsec result: { success, rest, result }. On a well-formed patch `rest`
  // is "" and `result` is FileDiff[]; degrade to [] rather than throw.
  const files = result.success ? (result.result as FileDiff[]) : [];
  return { files, patch };
}
```

> Implementer note: if `many(bodyLine)` ever hangs, the culprit is a
> zero-consumption success — confirm `not(eof)` short-circuits at end-of-input
> and that `restOfLineStr` + `optional(newline)` always consume on a real line.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — ("feat(git): parseDiff patch-derived summary").

---

### Task 8: `parseBlame`, `parseRemoteList`, `parseStashList`

**Files:** Modify `lib/stdlib/gitCore.ts`; Test `lib/stdlib/gitCore.test.ts`

**Interfaces:** Produces `parseBlame(stdout: string): BlameLine[]`, `parseRemoteList(stdout: string): GitRemote[]`, `parseStashList(stdout: string): GitStash[]`.

- [ ] **Step 1: Write the failing test** (realistic ≥7-hex shas — T-BLOCK1)

```typescript
// add to lib/stdlib/gitCore.test.ts
import { parseBlame, parseRemoteList, parseStashList } from "./gitCore.js";

describe("parseBlame", () => {
  it("pairs each porcelain header (real hex sha) with its content line", () => {
    const out = [
      "1a2b3c4d5e6f7a8b 1 1 1", "author Amy", "\tconst x = 1",
      "9f8e7d6c5b4a3210 2 2 1", "author Bob", "\tconst y = 2",
    ].join("\n") + "\n";
    expect(parseBlame(out)).toEqual([
      { sha: "1a2b3c4d5e6f7a8b", author: "Amy", line: 1, content: "const x = 1" },
      { sha: "9f8e7d6c5b4a3210", author: "Bob", line: 2, content: "const y = 2" },
    ]);
  });
});

describe("parseRemoteList", () => {
  it("parses name/url/direction", () => {
    const out = "origin\tgit@x:y.git (fetch)\norigin\tgit@x:y.git (push)\n";
    expect(parseRemoteList(out)).toEqual([
      { name: "origin", url: "git@x:y.git", direction: "fetch" },
      { name: "origin", url: "git@x:y.git", direction: "push" },
    ]);
  });
});

describe("parseStashList", () => {
  it("splits ref from description", () => {
    const out = "stash@{0}: WIP on main: abc msg\nstash@{1}: On main: other\n";
    expect(parseStashList(out)).toEqual([
      { ref: "stash@{0}", description: "WIP on main: abc msg" },
      { ref: "stash@{1}", description: "On main: other" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to lib/stdlib/gitCore.ts
export function parseBlame(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  let sha = "";
  let author = "";
  let finalLine = 0;
  for (const line of stdout.split("\n")) {
    if (/^[0-9a-f]{7,40} \d+ \d+/.test(line)) {
      const parts = line.split(" ");
      sha = parts[0];
      finalLine = Number(parts[2]);
    } else if (line.startsWith("author ")) {
      author = line.slice("author ".length);
    } else if (line.startsWith("\t")) {
      out.push({ sha, author, line: finalLine, content: line.slice(1) });
    }
  }
  return out;
}

export function parseRemoteList(stdout: string): GitRemote[] {
  const out: GitRemote[] = [];
  for (const line of nonEmptyLines(stdout)) {
    const m = line.match(/^(\S+)\t(.*)\s+\((fetch|push)\)$/);
    if (m) {
      out.push({ name: m[1], url: m[2], direction: m[3] as "fetch" | "push" });
    }
  }
  return out;
}

export function parseStashList(stdout: string): GitStash[] {
  const out: GitStash[] = [];
  for (const line of nonEmptyLines(stdout)) {
    const idx = line.indexOf(": ");
    if (idx === -1) {
      out.push({ ref: line, description: "" });
    } else {
      out.push({ ref: line.slice(0, idx), description: line.slice(idx + 2) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — ("feat(git): blame/remote/stash parsers").

---

### Task 9: Spawn runner + path-containment (`git.ts`) with real-git round-trips

**Files:** Create `lib/stdlib/git.ts`; Test `lib/stdlib/git.test.ts`

**Interfaces:**
- Consumes: `GIT_HARDENING_FLAGS`, `scrubEnv`, all builders/parsers/types (from `gitCore.js`); `abortableSpawn` (`./abortable.js`); `assertContained` (`./assertContained.js`); `getRuntimeContext` (`../runtime/asyncContext.js`).
- Produces:
  - `gitRunImpl(cwd: string, args: string[], opts?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number }): Promise<string>`
  - `_gitRun(cwd: string, args: string[]): Promise<string>` (ALS wrapper)
  - `assertPathsContained(paths: string[], allowedPaths: string[], cwd: string): Promise<void>`
  - Re-exports everything from `gitCore.js`.

- [ ] **Step 1: Write the failing test** (explicit-cwd contract + env-scrub integration + real-git round-trips for every format/parser pair — T-BLOCK2, T4, B2, T5)

```typescript
// lib/stdlib/git.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  gitRunImpl, assertPathsContained,
  statusArgs, parseStatus, logArgs, parseLog, diffArgs, parseDiff,
  branchListArgs, parseBranchList, blameArgs, parseBlame,
} from "./git.js";

const pexec = promisify(execFile);

async function seedRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gitrun-"));
  await pexec("git", ["init", "-q"], { cwd: repo });
  await pexec("git", ["config", "user.email", "t@t.com"], { cwd: repo });
  await pexec("git", ["config", "user.name", "t"], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  await pexec("git", ["add", "a.txt"], { cwd: repo });
  await pexec("git", ["commit", "-q", "-m", "seed subject"], { cwd: repo });
  return repo;
}

describe("gitRunImpl explicit-cwd contract", () => {
  let repo: string;
  beforeAll(async () => { repo = await seedRepo(); });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("runs against an explicit repo and returns stdout", async () => {
    const status = parseStatus(await gitRunImpl(repo, statusArgs()));
    expect(status.branch.length).toBeGreaterThan(0);
  });
  it("THROWS on empty cwd (never inherits process.cwd())", async () => {
    await expect(gitRunImpl("", statusArgs())).rejects.toThrow(/absolute|repo directory/i);
  });
  it("THROWS on a relative cwd", async () => {
    await expect(gitRunImpl("relative/dir", statusArgs())).rejects.toThrow(/absolute|repo directory/i);
  });
  it("THROWS on a non-existent cwd", async () => {
    await expect(gitRunImpl(path.join(repo, "nope"), statusArgs())).rejects.toThrow(/exist|repo directory/i);
  });
  it("THROWS on a git error surfacing stderr", async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), "notrepo-"));
    try {
      await expect(gitRunImpl(nonRepo, statusArgs())).rejects.toThrow(/not a git repository/i);
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("format/parser round-trips against real git", () => {
  let repo: string;
  beforeAll(async () => { repo = await seedRepo(); });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("log", async () => {
    const log = parseLog(await gitRunImpl(repo, logArgs({ n: 10, oneline: false, path: "", ref: "", author: "" })));
    expect(log.commits[0].subject).toBe("seed subject");
    expect(log.commits[0].sha.length).toBeGreaterThanOrEqual(7);
  });
  it("diff (staged edit → counts)", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
    await pexec("git", ["add", "a.txt"], { cwd: repo });
    const d = parseDiff(await gitRunImpl(repo, diffArgs({ ref: "", ref2: "", staged: true, path: "" })));
    const f = d.files.find((x) => x.path === "a.txt");
    expect(f).toBeTruthy();
    expect(f!.additions).toBe(1);
    expect(f!.deletions).toBe(0);
  });
  it("branchList", async () => {
    const branches = parseBranchList(await gitRunImpl(repo, branchListArgs()));
    expect(branches.some((b) => b.current)).toBe(true);
  });
  it("blame", async () => {
    const lines = parseBlame(await gitRunImpl(repo, blameArgs({ path: "a.txt", ref: "" })));
    expect(lines[0].content).toBe("one");
    expect(lines[0].sha.length).toBeGreaterThanOrEqual(7);
  });
});

describe("env-scrub integration (the safety control end-to-end)", () => {
  let repo: string;
  let sentinel: string;
  beforeAll(async () => { repo = await seedRepo(); sentinel = path.join(repo, "PWNED"); });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("GIT_EXTERNAL_DIFF passed to gitRunImpl does NOT execute", async () => {
    // If scrubEnv were not applied, git would run this external diff driver.
    await fs.writeFile(path.join(repo, "a.txt"), "changed\n");
    const evilEnv = { ...process.env, GIT_EXTERNAL_DIFF: `sh -c 'touch ${sentinel}'` };
    await gitRunImpl(repo, diffArgs({ ref: "", ref2: "", staged: false, path: "" }), { env: evilEnv });
    await expect(fs.access(sentinel)).rejects.toBeTruthy(); // sentinel was NOT created
  });
});

describe("assertPathsContained (symlink-aware, shared helper)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "contain-"));
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "a.ts"), "x");
  });
  afterAll(async () => { await fs.rm(repo, { recursive: true, force: true }); });

  it("no-ops when allowedPaths empty", async () => {
    await expect(assertPathsContained(["anything"], [], repo)).resolves.toBeUndefined();
  });
  it("allows paths inside an allowed prefix", async () => {
    await expect(assertPathsContained(["src/a.ts"], ["src"], repo)).resolves.toBeUndefined();
  });
  it("rejects a path outside every allowed prefix", async () => {
    await expect(assertPathsContained(["../escape.ts"], ["src"], repo)).rejects.toThrow();
  });
  it("rejects a sibling with a shared prefix (boundary: srcfoo vs src)", async () => {
    await fs.mkdir(path.join(repo, "srcfoo"), { recursive: true });
    await fs.writeFile(path.join(repo, "srcfoo", "x.ts"), "x");
    await expect(assertPathsContained(["srcfoo/x.ts"], ["src"], repo)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`./git.js` missing).

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/stdlib/git.ts
import path from "path";
import { statSync } from "fs";
import process from "process";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { abortableSpawn } from "./abortable.js";
import { assertContained } from "./assertContained.js";
import { GIT_HARDENING_FLAGS, scrubEnv } from "./gitCore.js";

// Re-export the pure core so stdlib/git.agency imports everything from one
// "agency-lang/stdlib-lib/git.js".
export * from "./gitCore.js";

// Default 30s wall-clock cap; abortableSpawn maps a timeout to exitCode 1.
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
// Cap returned output so an auto-approved read can't blow context/memory.
// (spawn has no maxBuffer; we truncate the returned string.)
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;

/**
 * Run git against an EXPLICIT repo directory. Never inherits process.cwd():
 * empty/relative/missing cwd throws, so a lost directory can never silently
 * target the process's own repo. Prepends hardening flags, scrubs the env,
 * enforces a timeout, throws on non-zero exit (stderr as message), truncates
 * oversized output, and returns stdout.
 */
export async function gitRunImpl(
  cwd: string,
  args: string[],
  opts?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number },
): Promise<string> {
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error(
      `git: no repo directory — pass an explicit absolute "cwd" or set the agent working directory (got "${cwd}")`,
    );
  }
  let st;
  try {
    st = statSync(cwd);
  } catch {
    throw new Error(`git: repo directory does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`git: repo directory is not a directory: ${cwd}`);
  }
  const env = scrubEnv(opts?.env ?? process.env);
  const res = await abortableSpawn(
    "git",
    [...GIT_HARDENING_FLAGS, ...args],
    { cwd, env, signal: opts?.signal, timeout: opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS },
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `git exited with code ${res.exitCode}`);
  }
  const cap = opts?.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (res.stdout.length > cap) {
    return res.stdout.slice(0, cap) + `\n[git output truncated at ${cap} bytes]`;
  }
  return res.stdout;
}

/** ALS-reading wrapper Agency calls; mirrors `_exec` in shell.ts. */
export async function _gitRun(cwd: string, args: string[]): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  return gitRunImpl(cwd, args, { signal: ctx.getAbortSignal(stack) });
}

/**
 * Enforce `allowedPaths` on a set of repo-relative paths using the shared
 * symlink-aware `assertContained` (the same check `exec`/`bash`/`fs` use).
 * No-op when allowedPaths is empty. Paths resolve against `cwd` (the repo).
 */
export async function assertPathsContained(
  paths: string[],
  allowedPaths: string[],
  cwd: string,
): Promise<void> {
  if (allowedPaths.length === 0) {
    return;
  }
  for (const p of paths) {
    await assertContained(p, allowedPaths, cwd);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `pnpm exec vitest run lib/stdlib/git.test.ts` → PASS (all groups).

- [ ] **Step 5: Full Phase-1 verification + commit**

```bash
pnpm exec vitest run lib/stdlib/gitCore.test.ts lib/stdlib/git.test.ts 2>&1 | tee /tmp/git-phase1.log
git add lib/stdlib/git.ts lib/stdlib/git.test.ts
git commit -F <msg-file>   # "feat(git): runner (explicit-cwd, env-scrub, timeout, cap) + path containment"
```

**Phase 1 gate:** All of `gitCore.test.ts` and `git.test.ts` pass, including the real-git round-trips and the env-scrub sentinel test. Do not start Phase 2 until this holds.

---

# Phase 2 — Agency module + agent wiring

**After any change to `stdlib/git.agency` or `lib/stdlib/*.ts`, run `make` (or `pnpm run build && make stdlib`) before agency tests** — the CLI executes from `dist/`.

---

### Task 10: `stdlib/git.agency` — types, effects, effect sets, read tools

**Files:** Create `stdlib/git.agency`; verify via `pnpm run build && make stdlib`.

**Interfaces:** Consumes `_gitRun`, `assertPathsContained`, the builders/parsers, and the types (`GitStatus`/`GitLog`/`GitDiff`/`GitBranch`/`BlameLine`/`GitRemote`/`GitStash`) from `agency-lang/stdlib-lib/git.js`; `applyAgentCwd` from `std::index`. Produces the `std::git::*` effects, the effect sets, and the read tools.

- [ ] **Step 1: Write the module (types, effects, effect sets, read tools)**

```
// stdlib/git.agency
import { applyAgentCwd } from "std::index"
import {
  _gitRun, assertPathsContained,
  statusArgs, logArgs, diffArgs, showArgs, branchListArgs,
  remoteListArgs, blameArgs, stashListArgs,
  parseStatus, parseLog, parseDiff, parseBranchList,
  parseRemoteList, parseBlame, parseStashList,
  GitStatus, GitLog, GitDiff, GitBranch, BlameLine, GitRemote, GitStash,
 } from "agency-lang/stdlib-lib/git.js"

/** @module
  Typed, safe git tools. Each tool builds its own argv internally, so the
  model never supplies a raw flag — closing the `git diff --output=` /
  `-c core.pager=` class of abuse. Reads raise `std::git::<op>` effects the
  agent policy can auto-approve; writes prompt. Restrict any tool before
  handing it to an agent with `.partial()` (e.g. `gitCommit.partial(cwd: repo)`,
  `gitBranchDelete.partial(force: false, protectedBranches: ["main"])`).

  Note: positional values (refs/paths/branches) may not start with "-".
*/

// Read effects
effect std::git::status     { cwd: string }
effect std::git::log        { cwd: string, ref: string, path: string }
effect std::git::diff       { cwd: string, ref: string, ref2: string, staged: boolean, path: string }
effect std::git::show       { cwd: string, ref: string }
effect std::git::branchList { cwd: string }
effect std::git::remoteList { cwd: string }
effect std::git::blame      { cwd: string, path: string }
effect std::git::stashList  { cwd: string }
// Write effects
effect std::git::add        { cwd: string, paths: string[], all: boolean }
effect std::git::commit     { cwd: string, message: string }
effect std::git::checkout   { cwd: string, target: string, force: boolean }
effect std::git::switch     { cwd: string, branch: string, create: boolean }
effect std::git::branchCreate { cwd: string, branch: string }
effect std::git::branchDelete { cwd: string, branch: string, force: boolean }
effect std::git::stashPush  { cwd: string, message: string }
effect std::git::stashPop   { cwd: string }
effect std::git::restore    { cwd: string, paths: string[], staged: boolean }

/** Read-only git effects — auto-approvable. */
export effectSet GitRead  = <std::git::status, std::git::log, std::git::diff, std::git::show,
                             std::git::branchList, std::git::remoteList, std::git::blame, std::git::stashList>
/** Mutating git effects — should prompt. */
export effectSet GitWrite = <std::git::add, std::git::commit, std::git::checkout, std::git::switch,
                             std::git::branchCreate, std::git::branchDelete, std::git::stashPush,
                             std::git::stashPop, std::git::restore>
/** All git effects. */
export effectSet Git      = <GitRead, GitWrite>

export def gitStatus(cwd: string = ""): GitStatus raises <std::git::status> {
  """
  Show the working-tree status (branch, ahead/behind, changed files) as
  structured data. Requires a repo: pass `cwd` or run where the agent
  working directory is set.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::status("Show git status", { cwd: dir })
  return parseStatus(_gitRun(dir, statusArgs()))
}

export def gitLog(
  n: number = 20, oneline: boolean = false, path: string = "",
  ref: string = "", author: string = "", allowedPaths: string[] = [],
  cwd: string = "",
): GitLog raises <std::git::log> {
  """
  Show commit history as structured commits.
  @param n - Max number of commits (default 20).
  @param oneline - Omit commit bodies.
  @param path - Limit to commits touching this path (may not start with "-").
  @param ref - Start from this revision (e.g. HEAD~5, a branch, a sha).
  @param author - Filter by author substring.
  @param allowedPaths - Restrict `path` to these prefixes (bind via .partial()).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  if (path != "") {
    assertPathsContained([path], allowedPaths, dir)
  }
  return interrupt std::git::log("Show git log", { cwd: dir, ref: ref, path: path })
  return parseLog(_gitRun(dir, logArgs({ n: n, oneline: oneline, path: path, ref: ref, author: author })))
}

export def gitDiff(
  ref: string = "", ref2: string = "", staged: boolean = false,
  path: string = "", allowedPaths: string[] = [], cwd: string = "",
): GitDiff raises <std::git::diff> {
  """
  Show a diff as a structured per-file summary plus the raw unified patch.
  @param ref - Compare against this revision (default: working tree vs index).
  @param ref2 - Optional second revision to diff ref..ref2.
  @param staged - Diff the index (staged changes) instead of the working tree.
  @param path - Limit the diff to this path (may not start with "-").
  @param allowedPaths - Restrict `path` to these prefixes (bind via .partial()).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  if (path != "") {
    assertPathsContained([path], allowedPaths, dir)
  }
  return interrupt std::git::diff("Show git diff", { cwd: dir, ref: ref, ref2: ref2, staged: staged, path: path })
  return parseDiff(_gitRun(dir, diffArgs({ ref: ref, ref2: ref2, staged: staged, path: path })))
}

export def gitShow(ref: string = "HEAD", cwd: string = ""): GitDiff raises <std::git::show> {
  """
  Show a commit as a structured per-file summary plus the raw patch. Line
  counts are approximate for merge commits (combined diffs are not counted).
  @param ref - The revision to show (default HEAD).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::show("Show git commit", { cwd: dir, ref: ref })
  return parseDiff(_gitRun(dir, showArgs({ ref: ref })))
}

export def gitBranchList(cwd: string = ""): GitBranch[] raises <std::git::branchList> {
  """
  List local branches with their current-marker, upstream, and sha.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::branchList("List git branches", { cwd: dir })
  return parseBranchList(_gitRun(dir, branchListArgs()))
}

export def gitRemoteList(cwd: string = ""): GitRemote[] raises <std::git::remoteList> {
  """
  List configured remotes with their fetch/push URLs.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::remoteList("List git remotes", { cwd: dir })
  return parseRemoteList(_gitRun(dir, remoteListArgs()))
}

export def gitBlame(path: string, ref: string = "", cwd: string = ""): BlameLine[] raises <std::git::blame> {
  """
  Show line-by-line authorship for a file.
  @param path - The file to blame (may not start with "-").
  @param ref - Optional revision to blame at.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::blame("Show git blame", { cwd: dir, path: path })
  return parseBlame(_gitRun(dir, blameArgs({ path: path, ref: ref })))
}

export def gitStashList(cwd: string = ""): GitStash[] raises <std::git::stashList> {
  """
  List stashes with their ref and description.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::stashList("List git stashes", { cwd: dir })
  return parseStashList(_gitRun(dir, stashListArgs()))
}
```

- [ ] **Step 2: Build and confirm it compiles**

Run: `pnpm run build && make stdlib 2>&1 | tee /tmp/git-build.log`
Expected: no compile/typecheck errors; `stdlib/git.js` produced.

- [ ] **Step 3: Commit** — ("feat(git): std::git read tools, effects, effect sets").

---

### Task 11: `stdlib/git.agency` — write tools (PFA-restrictable, data-loss messages)

**Files:** Modify `stdlib/git.agency`; verify via build.

**Interfaces:** Consumes the write builders + `assertPathsContained`. Produces `gitAdd`, `gitCommit`, `gitCheckout`, `gitSwitch`, `gitBranchCreate`, `gitBranchDelete`, `gitStashPush`, `gitStashPop`, `gitRestore`.

- [ ] **Step 1: Add write-builder imports + the write tools**

Add to the `import { ... } from "agency-lang/stdlib-lib/git.js"` block: `addArgs, commitArgs, checkoutArgs, switchArgs, branchCreateArgs, branchDeleteArgs, stashPushArgs, stashPopArgs, restoreArgs, assertBranchAllowed`. Then append (note: `gitBranchDelete` checks `assertBranchAllowed` **before** the interrupt so a protected-branch attempt fails fast without prompting):

```
export def gitAdd(paths: string[] = [], all: boolean = false, allowedPaths: string[] = [], cwd: string = ""): string raises <std::git::add> {
  """
  Stage changes for commit.
  @param paths - Files to stage (may not start with "-").
  @param all - Stage all changes (git add -A). Bind `all: false` via .partial() to forbid.
  @param allowedPaths - Restrict `paths` to these prefixes (bind via .partial()).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  assertPathsContained(paths, allowedPaths, dir)
  return interrupt std::git::add("Stage changes", { cwd: dir, paths: paths, all: all })
  _gitRun(dir, addArgs({ paths: paths, all: all }))
  return "Staged changes"
}

export def gitCommit(message: string, cwd: string = ""): string raises <std::git::commit> {
  """
  Create a commit from the staged changes.
  @param message - The commit message.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::commit("Create commit: ${message}", { cwd: dir, message: message })
  return _gitRun(dir, commitArgs({ message: message }))
}

export def gitCheckout(target: string, force: boolean = false, cwd: string = ""): string raises <std::git::checkout> {
  """
  Check out a branch, commit, or path.
  @param target - The branch/commit/path (may not start with "-").
  @param force - Discard local changes (git checkout --force). Bind `force: false` via .partial().
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  let msg = "Checkout ${target}"
  if (force) {
    msg = "Force checkout ${target} (DISCARDS local changes, cannot be undone)"
  }
  return interrupt std::git::checkout(msg, { cwd: dir, target: target, force: force })
  return _gitRun(dir, checkoutArgs({ target: target, force: force }))
}

export def gitSwitch(branch: string, create: boolean = false, cwd: string = ""): string raises <std::git::switch> {
  """
  Switch to a branch (optionally creating it).
  @param branch - The branch to switch to (may not start with "-").
  @param create - Create the branch first (git switch -c).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::switch("Switch to branch ${branch}", { cwd: dir, branch: branch, create: create })
  return _gitRun(dir, switchArgs({ branch: branch, create: create }))
}

export def gitBranchCreate(branch: string, cwd: string = ""): string raises <std::git::branchCreate> {
  """
  Create a new branch at HEAD (does not switch to it).
  @param branch - The new branch name (may not start with "-").
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::branchCreate("Create branch ${branch}", { cwd: dir, branch: branch })
  _gitRun(dir, branchCreateArgs({ branch: branch }))
  return "Created branch ${branch}"
}

export def gitBranchDelete(branch: string, force: boolean = false, protectedBranches: string[] = [], cwd: string = ""): string raises <std::git::branchDelete> {
  """
  Delete a local branch.
  @param branch - The branch to delete (may not start with "-").
  @param force - Delete even if unmerged (git branch -D). Bind `force: false` via .partial().
  @param protectedBranches - Branch names that may never be deleted (bind via .partial(), e.g. ["main","master"]).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  assertBranchAllowed(branch, protectedBranches)
  let msg = "Delete branch ${branch}"
  if (force) {
    msg = "Force-delete branch ${branch} (may discard unmerged commits, cannot be undone)"
  }
  return interrupt std::git::branchDelete(msg, { cwd: dir, branch: branch, force: force })
  _gitRun(dir, branchDeleteArgs({ branch: branch, force: force, protectedBranches: protectedBranches }))
  return "Deleted branch ${branch}"
}

export def gitStashPush(message: string = "", cwd: string = ""): string raises <std::git::stashPush> {
  """
  Stash the working-tree changes.
  @param message - Optional stash message.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::stashPush("Stash changes", { cwd: dir, message: message })
  return _gitRun(dir, stashPushArgs({ message: message }))
}

export def gitStashPop(cwd: string = ""): string raises <std::git::stashPop> {
  """
  Apply and drop the most recent stash.
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  return interrupt std::git::stashPop("Pop the latest stash", { cwd: dir })
  return _gitRun(dir, stashPopArgs())
}

export def gitRestore(paths: string[], staged: boolean = false, allowedPaths: string[] = [], cwd: string = ""): string raises <std::git::restore> {
  """
  Restore files, discarding changes (or unstaging with `staged`).
  @param paths - Files to restore (may not start with "-").
  @param staged - Restore the staged version (unstage) instead of discarding working-tree changes.
  @param allowedPaths - Restrict `paths` to these prefixes (bind via .partial()).
  @param cwd - Repo directory; resolved against the agent working directory.
  """
  const dir = applyAgentCwd(cwd)
  assertPathsContained(paths, allowedPaths, dir)
  let msg = "Discard working-tree changes to ${paths.length} file(s) (cannot be undone)"
  if (staged) {
    msg = "Unstage ${paths.length} file(s)"
  }
  return interrupt std::git::restore(msg, { cwd: dir, paths: paths, staged: staged })
  _gitRun(dir, restoreArgs({ paths: paths, staged: staged }))
  return "Restored ${paths.length} file(s)"
}
```

- [ ] **Step 2: Build and confirm it compiles** — `pnpm run build && make stdlib 2>&1 | tee /tmp/git-build2.log` → clean.

- [ ] **Step 3: Commit** — ("feat(git): std::git write tools with PFA restriction params").

---

### Task 12: Default policy wiring + exhaustive Tier-1 policy test

**Files:** Modify `lib/agents/agency-agent/lib/defaultPolicy.agency`; Create `lib/agents/agency-agent/tests/gitPolicy.agency`.

**Interfaces:** Consumes `checkPolicy` (`std::policy`), `recommendedAutoApprovePolicy`/`minimalAutoApprovePolicy`. Produces read `std::git::*` auto-approved in `recommendedAutoApprovePolicy`.

- [ ] **Step 1: Write the failing test** (exhaustive over ALL reads and ALL writes — T-BLOCK3)

```
// lib/agents/agency-agent/tests/gitPolicy.agency
/*
 * The recommended policy auto-approves EVERY read-only git effect; EVERY
 * write effect prompts (never auto-approved). Pure policy logic — no git,
 * no LLM. Exhaustive because a write leaking into auto-approve is the
 * worst-case bug for this module.
 */
import { checkPolicy } from "std::policy"
import {
  minimalAutoApprovePolicy,
  recommendedAutoApprovePolicy,
 } from "../lib/defaultPolicy.agency"

static const GIT_READS = [
  "std::git::status", "std::git::log", "std::git::diff", "std::git::show",
  "std::git::branchList", "std::git::remoteList", "std::git::blame", "std::git::stashList",
]
static const GIT_WRITES = [
  "std::git::add", "std::git::commit", "std::git::checkout", "std::git::switch",
  "std::git::branchCreate", "std::git::branchDelete", "std::git::stashPush",
  "std::git::stashPop", "std::git::restore",
]

def intr(effect: string): any {
  return { effect: effect, data: { cwd: "/repo" } }
}

node recommendedApprovesEveryRead(): boolean {
  for (e in GIT_READS) {
    if (checkPolicy(recommendedAutoApprovePolicy, intr(e)).type != "approve") {
      return false
    }
  }
  return true
}

node recommendedPromptsEveryWrite(): boolean {
  for (e in GIT_WRITES) {
    if (checkPolicy(recommendedAutoApprovePolicy, intr(e)).type == "approve") {
      return false
    }
  }
  return true
}

node minimalApprovesNoGitRead(): boolean {
  // git reads live in the RECOMMENDED policy only, not the minimal one.
  for (e in GIT_READS) {
    if (checkPolicy(minimalAutoApprovePolicy, intr(e)).type == "approve") {
      return false
    }
  }
  return true
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build && make agents && pnpm run a test lib/agents/agency-agent/tests/gitPolicy.agency 2>&1 | tee /tmp/git-policy.log`
Expected: FAIL — `recommendedApprovesEveryRead` false (no git rules yet). (`make agents` here just needs the policy object; the tools aren't wired until Task 14 — that's expected.)

- [ ] **Step 3: Add the read effects to `recommendedAutoApprovePolicy`**

In `lib/agents/agency-agent/lib/defaultPolicy.agency`, add to the `recommendedAutoApprovePolicy` object (alongside `std::read` etc.):

```
  "std::git::status": [{
    action: "approve"
  }],
  "std::git::log": [{
    action: "approve"
  }],
  "std::git::diff": [{
    action: "approve"
  }],
  "std::git::show": [{
    action: "approve"
  }],
  "std::git::branchList": [{
    action: "approve"
  }],
  "std::git::remoteList": [{
    action: "approve"
  }],
  "std::git::blame": [{
    action: "approve"
  }],
  "std::git::stashList": [{
    action: "approve"
  }],
```

- [ ] **Step 4: Run test to verify it passes** — rerun Step-2 command → PASS.

- [ ] **Step 5: Commit** — ("feat(git): auto-approve read effects in recommended policy").

---

### Task 13: Tier-3 end-to-end agency test (isolated temp repo, fail-closed)

**Files:** Create `tests/agency/git.agency`.

**Interfaces:** Consumes the `std::git` tools; `exec` from `std::shell`.

Isolation rests on: `gitRunImpl`'s explicit-cwd contract (Task 9, unit-proven), a temp repo under the OS temp dir with `GIT_CEILING_DIRECTORIES` set at creation, an explicit `cwd:` on every tool call, and a clean-tree preflight that aborts before any write. Also covers the B2 agent-cwd paths (set → works; unset → clear error).

- [ ] **Step 1: Write the test** (uses `&&`/`||`; `exec` not interpolated `bash`; both agent-cwd paths; a restriction e2e)

```
// tests/agency/git.agency
import { exec } from "std::shell"
import { setAgentCwd } from "std::index"
import { gitStatus, gitBranchList, gitBranchCreate, gitCommit, gitAdd, gitBranchDelete } from "std::git"

// Create an isolated throwaway repo in the OS temp dir (NOT under this
// project). `git init` makes `dir` its own repo; GIT_CEILING_DIRECTORIES
// (set inline in the setup shell — exec has no env param) is belt-and-
// suspenders against upward .git discovery during setup. The load-bearing
// guarantee for the TOOL calls below is: each passes an explicit absolute
// `cwd`, and gitRunImpl refuses an empty/relative cwd (unit-proven, Task 9),
// so a bug cannot reach the project repo.
def makeSandbox(): string {
  const mk = exec("mktemp", ["-d"]) with approve
  const dir = mk.stdout.trim()
  exec("sh", ["-c", "GIT_CEILING_DIRECTORIES=${dir} git init -q && git config user.email t@t.com && git config user.name t && printf hi > a.txt && git add a.txt && git commit -q -m seed"],
    cwd: dir) with approve
  return dir
}

def teardown(dir: string) {
  if (dir != "") {
    exec("rm", ["-rf", dir]) with approve
  }
}

// Fail-closed preflight: a fresh sandbox has a clean tree. If gitStatus saw
// a DIFFERENT repo (e.g. this project), entries would be non-empty. Proves
// the happy path AND guards against mistargeting before any write test.
node preflightSandboxIsClean(): boolean {
  const dir = makeSandbox()
  const s = gitStatus(cwd: dir) with approve
  const ok = s.entries.length == 0
  teardown(dir)
  return ok
}

node readsBranchList(): boolean {
  const dir = makeSandbox()
  const branches = gitBranchList(cwd: dir) with approve
  const ok = branches.length >= 1 && branches[0].current
  teardown(dir)
  return ok
}

node writeThenReadRoundtrips(): boolean {
  const dir = makeSandbox()
  gitBranchCreate("feature/x", cwd: dir) with approve
  const branches = gitBranchList(cwd: dir) with approve
  let found = false
  for (b in branches) {
    if (b.name == "feature/x") {
      found = true
    }
  }
  teardown(dir)
  return found
}

node commitRoundtrips(): boolean {
  const dir = makeSandbox()
  exec("sh", ["-c", "printf more > b.txt"], cwd: dir) with approve
  gitAdd(["b.txt"], cwd: dir) with approve
  gitCommit("add b", cwd: dir) with approve
  const s = gitStatus(cwd: dir) with approve
  const clean = s.entries.length == 0
  teardown(dir)
  return clean
}

// B2: with an agent cwd set, gitStatus() with NO cwd arg works.
node agentCwdSetLetsStatusOmitCwd(): boolean {
  const dir = makeSandbox()
  setAgentCwd(dir)
  const s = gitStatus() with approve
  setAgentCwd("")
  teardown(dir)
  return s.entries.length == 0
}

// (The "no agent cwd + no explicit cwd → clear error" path is covered
// deterministically at the unit level in Task 9 — gitRunImpl("", …) throws
// "no repo directory". Not re-tested here to avoid the unproven
// `try … with approve` combination.)

// Restriction reaches real git: protectedBranches rejects deleting main.
// gitBranchDelete checks assertBranchAllowed BEFORE raising the interrupt,
// so this throws with no approval needed and `try` catches it.
node protectedBranchRejected(): boolean {
  const dir = makeSandbox()
  const r = try gitBranchDelete("main", force: true, protectedBranches: ["main"], cwd: dir)
  teardown(dir)
  return isFailure(r) && r.error.includes("protected")
}
```

> Isolation notes for the reviewer: every tool call passes an explicit `cwd`
> under the OS temp dir; `gitRunImpl` throws on empty/relative/missing cwd
> (unit-tested, Task 9); `makeSandbox` uses `mktemp -d`. Do NOT "simplify" by
> pointing `cwd` at the project or dropping `GIT_CEILING_DIRECTORIES`.

- [ ] **Step 2: Parse-check then build and run**

Run: `pnpm run ast tests/agency/git.agency > /dev/null && pnpm run build && make stdlib && pnpm run a test tests/agency/git.agency 2>&1 | tee /tmp/git-e2e.log`
Expected: parses; all nodes PASS. (If `try`/`isFailure` shape differs from your codebase's Result API, mirror an existing `try`-using agency test — e.g. `tests/agency/` files that use `try` — for the exact `is success`/`isFailure` idiom.)

- [ ] **Step 3: Confirm the project repo is untouched**

Run: `git status --short`
Expected: only intended files; NO stray changes (the test operated solely in `/tmp`).

- [ ] **Step 4: Commit** — ("test(git): isolated end-to-end agency test").

---

### Task 14: Wire git tools into the agency-agent + docs

**Files:** Modify `lib/agents/agency-agent/subagents/code.agency`; regenerate stdlib docs.

**Interfaces:** Consumes the `std::git` tools. Produces: the code agent can call them; reads auto-approve.

- [ ] **Step 1: Import and add the git tools to the code agent's tool list**

In `lib/agents/agency-agent/subagents/code.agency`, add to the imports:

```
import {
  gitStatus, gitLog, gitDiff, gitShow, gitBranchList, gitRemoteList, gitBlame, gitStashList,
  gitAdd, gitCommit, gitCheckout, gitSwitch, gitBranchCreate, gitBranchDelete,
  gitStashPush, gitStashPop, gitRestore,
 } from "std::git"
```

Locate the existing `tools: [...]` array in the code agent's `llm(...)` call (the one that includes `agencyCli`, `read`, `write`, `edit`) and append the git tools. No `.partial()` is needed for default wiring — each tool resolves `cwd` via `applyAgentCwd`, and the agency-agent sets the agent cwd at startup (`agent.agency:1029`), so `gitStatus()` etc. work with no `cwd:` arg. (Guard note: neither `code.agency` nor `agent.agency` declares a `raises` clause today; if one is added later, widen it to include `GitRead`/`GitWrite`.)

- [ ] **Step 2: Build the agent bundle** — `make agents 2>&1 | tee /tmp/git-agents.log` → clean; the code agent lists the git tools.

- [ ] **Step 3: Regenerate stdlib docs** — `make doc 2>&1 | tee /tmp/git-doc.log` → `docs/site/stdlib/git.md` generated from the docstrings.

- [ ] **Step 4: Commit** — ("feat(git): expose std::git tools to the agency-agent + docs").

---

### Task 15: Full-suite verification + branch finish

**Files:** none (verification only)

- [ ] **Step 1: Run the git TS suites** — `pnpm exec vitest run lib/stdlib/gitCore.test.ts lib/stdlib/git.test.ts 2>&1 | tee /tmp/git-final-unit.log` → all green.
- [ ] **Step 2: Run the git agency tests** — `pnpm run build && make && pnpm run a test tests/agency/git.agency lib/agents/agency-agent/tests/gitPolicy.agency 2>&1 | tee /tmp/git-final-agency.log` → all nodes pass.
- [ ] **Step 3: Confirm clean tree** — `git status --short` → nothing stray.
- [ ] **Step 4: Push + PR only if the user asks.** Write the PR body to a file; `gh pr create --body-file`.

---

## Self-Review

**1. Spec + review coverage** — every spec section and every accepted review finding maps to a task:
- Typed tools / no raw flags → Tasks 1, 4, 10, 11. Positional hardening → Tasks 1, 4. Per-subcommand effects → Task 10. Effect sets in `git.agency` → Task 10. Narrow types incl. `ChangeCode`+`?`/`!` (T2), `GitRemote`/`GitStash` (T1), `ref2` in diff effect (T3) → Tasks 1, 10.
- `gitDiff` one invocation → Tasks 4, 7. Restriction via PFA + symlink-aware containment (A1) → Tasks 2, 9, 10, 11. Conditional/blanket policy → Task 12 (blanket; effect data carries `force`/`all`/`ref2`).
- Defense-in-depth: no-shell spawn + hardening + env scrub + timeout (R2) + output cap (R1) → Tasks 3, 9. Explicit-cwd, never inherit `process.cwd()` + clear error (B2) → Task 9 (+ Task 13 both paths). Code placement / no mutable TS state → Global Constraints, Tasks 1–9.
- Data-loss prompts → Task 11. DRY parse framing (A2) → Tasks 5, 6, 8. No useless special case (A3) → Task 7. Named offsets (A4) → Task 5. Merge-commit (R3), path-regex (R4), leading-dash (R5), separator (R6) → notes in Tasks 1, 7, 3.
- Tests: exhaustive policy (T-BLOCK3) → Task 12; real-git round-trips (T-BLOCK2) + env-scrub integration (T4) + containment boundary (T1) → Task 9; blame fixture (T-BLOCK1) → Task 8; parser cases (T2) → Tasks 5, 7; exhaustive builder tests (T1) + exact assertions (T3) → Task 4; e2e cwd + restriction (T5) → Task 13. Preflight parse/version (B4) → Task 0.
- Reusability → Task 10; agent wiring → Task 14. Bash-git not gated → intentionally untouched.
- **B3 dispositioned as verified non-issue** (no `raises` clause on the agent nodes) — recorded up top; guard note in Task 14.

**2. Placeholder scan** — no TBD/TODO/"handle edge cases"; every code step is complete. The one deferral (discarded-work *preview*) is an explicit spec open question; the shipping behavior (explicit warning message) is fully specified in Task 11.

**3. Type consistency** — `_gitRun(cwd, args): Promise<string>` everywhere; tools are `parseX(_gitRun(dir, xArgs(...)))`. Builders no longer take `allowedPaths` (containment moved to `assertPathsContained`), consistent across Tasks 4/10/11. Builder + parser + type names match across the phase boundary. `ChangeCode` includes `?`/`!` so `parseStatus` needs no casts.

## Execution Handoff

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.

**2. Inline Execution** — execute in this session with checkpoints.

Which approach?
