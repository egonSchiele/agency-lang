# Path-traversal audit of stdlib filesystem & process helpers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Prerequisite:** `2026-05-28-agency-file-dirname.md` should land first so we have a known-good ALS `moduleDir` to anchor any new containment checks against.

**Goal:** Make every stdlib filesystem and process helper safe against partial-application escapes. Today, `read`/`write`/`readImage`/`edit`/`multiedit` are safe because they flow through [`resolvePath()`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/stdlib/resolvePath.ts), which lexically rejects `..` escapes and even handles symlink-escapes. The rest of the surface — `mkdir`, `copy`, `move`, `remove`, `applyPatch`, anything in `shell`, `memory`, etc. — accept whole paths with no containment check. That means `mkdir.partial(...)` cannot meaningfully constrain an LLM, because partial application doesn't pin a *prefix* of the path argument.

**Why "just reject `/` in filename" is not sufficient (and not the right model here):** the functions in question don't have a `dir` + `filename` split. They take a single path. The threat model for partial-application capability-narrowing has to look like: "the caller pre-binds an `allowedPaths` prefix; the helper rejects anything outside it." `_copy`, `_move`, `_remove` already accept an `allowedPaths` array — but it's *optional* and defaults to "no restrictions." This audit's job is to (a) inventory every fs/process helper, (b) decide the containment model for each, and (c) tighten defaults where reasonable.

**Architecture:** No new infrastructure expected — most of the work is enforcement (already-present `allowedPaths` becomes mandatory under certain modes) and lexical/symlink containment ports of the `resolvePath` pattern. The optional `moduleDir` from the prior PR may serve as a sensible default `allowedPaths` root for some helpers.

**Tech stack:** Same as the prior PR. Tests live in `lib/stdlib/*.test.ts` and `tests/agency/stdlib/`.

**Workflow conventions:** Worktree per PR. `make` after stdlib changes. Commit messages via file. Never force-push.

---

## Task 1: Inventory

**Why:** before changing anything, write down what we have and what each helper accepts.

### Steps

- [ ] **Step 1.1: Enumerate all path-accepting helpers**

For each file under `lib/stdlib/`, list every exported `_*` function whose signature includes a path-shaped argument (`path`, `dir`, `filename`, `src`, `dest`, `target`, etc.). At minimum cover:

- `lib/stdlib/fs.ts`: `_edit`, `_multiedit`, `_applyPatch`, `_mkdir`, `_copy`, `_move`, `_remove`
- `lib/stdlib/builtins.ts`: `_read`, `_write`, `_readImage` (already safe — confirm)
- `lib/stdlib/shell.ts`: anything that takes a `cwd`, a script path, or a binary path
- `lib/stdlib/memory.ts`: file writes
- `lib/stdlib/policy.ts`: policy file paths
- `lib/stdlib/oauth.ts`, `keyring.ts`, `clipboard.ts`, `imessage.ts`, `email.ts`, `calendar.ts`, `speech.ts`, `browserUse.ts`: anything that touches the filesystem or spawns a subprocess
- `lib/runtime/`: any user-callable path-accepting primitive

Produce a markdown table in this plan file (replace this checkbox with the table) of: `helper | path args | uses resolvePath? | uses allowedPaths? | spawn/exec? | gap`.

- [ ] **Step 1.2: Classify each helper into a containment category**

For each helper, decide which category it falls into. Categories:

- **A. `dir` + `filename` shape** → already / should use `resolvePath`. Trivially safe to partial-apply by binding `dir`.
- **B. Single full-path argument** → needs an `allowedPaths` containment check. Partial-application capability story: bind `allowedPaths`.
- **C. Subprocess / shell** → containment of executables and `cwd`. Partial-application capability story: bind allowed binaries and/or allowed cwd prefixes.
- **D. No useful containment available** → document explicitly that this helper cannot be safely narrowed by partial application, and flag for a docs warning.

Edit this plan file to attach a category letter to each row of the table from Step 1.1.

---

## Task 2: Tighten category-B helpers (`mkdir`, `copy`, `move`, `remove`, `applyPatch`)

**Why:** these are the most obvious gap — they take whole paths and accept (or could accept) `allowedPaths` but don't require it by default.

### Steps

- [ ] **Step 2.1: Design the `allowedPaths` enforcement model**

Decisions to make and record in this plan file:

1. **Default when `allowedPaths` is empty.** Three options:
   a. *Status quo.* Empty means unrestricted. (Worst for safety; best for ergonomics.)
   b. *Empty means deny-all.* Caller must explicitly opt into a path prefix. (Breaking, but safest.)
   c. *Empty means "moduleDir only".* Defaults to the directory of the calling module. (Smart default; consistent with the new `read` behavior.)

   Recommendation: **(c)** for consistency with the prior PR. Document the breaking change.

2. **Containment check semantics.** Should it be lexical only (fast) or include symlink resolution (matches `resolvePath`)? Recommendation: symlink-aware, factored into a shared helper `assertContained(targetPath, allowedRoots[])`.

3. **Error message.** Match the existing `resolvePath` phrasing (`escapes allowed paths ...`).

- [ ] **Step 2.2: Implement `assertContained()`**

Create `lib/stdlib/assertContained.ts`. Behavior:
- Accepts `(target: string, allowedRoots: string[])`.
- If `allowedRoots` is empty, reads `getModuleDir()` as the single allowed root (per Step 2.1.1).
- Resolves both `target` and each root via `path.resolve` and `fs.realpath`.
- Throws if `target` does not equal or sit beneath any allowed root.

Add unit tests in `lib/stdlib/assertContained.test.ts` covering: empty roots → moduleDir fallback; explicit root; symlink escape; non-existent target.

- [ ] **Step 2.3: Apply `assertContained` to fs.ts helpers**

For each of `_mkdir`, `_copy` (both `src` and `dest`), `_move` (both), `_remove`, `_applyPatch` (each touched file in the diff), call `assertContained(thePath, allowedPaths)` early. Update tests in `lib/stdlib/fs.test.ts` (create if missing) for each helper to cover allowed and rejected cases.

- [ ] **Step 2.4: Update `stdlib/fs.agency` docstrings**

Reflect the new "defaults to moduleDir-only when `allowedPaths` is empty" behavior. Encourage users to set `allowedPaths` explicitly via partial application before exposing a helper to an LLM.

---

## Task 3: Tighten category-C helpers (shell / process)

**Why:** an LLM with access to `shell::exec` can do anything. The capability story has to look like an allow-list of binaries + a cwd containment check.

### Steps

- [ ] **Step 3.1: Inventory shell entry points**

Look at `lib/stdlib/shell.ts`. Functions that take a command string or argv plus possibly a `cwd`. Note which already use `allowedPaths`-like patterns (see `lib/stdlib/allowBlockList.ts`).

- [ ] **Step 3.2: Decide and document the containment story**

Proposal for review (record decision in this plan file before implementing):
- Add an `allowedExecutables: string[]` parameter to `shell::exec` (or whichever entry point), backed by `allowBlockList.ts`.
- Reuse `assertContained` for any `cwd` argument when paired with `allowedPaths`.
- For raw shell strings (`sh -c "..."`), document that they cannot be safely narrowed and recommend the argv form for partial-application use.

- [ ] **Step 3.3: Implement and test**

Implementation pass after the design is approved.

---

## Task 4: Audit remaining stdlib modules

**Why:** the long tail (`memory`, `policy`, `oauth`, `keyring`, `clipboard`, `imessage`, `email`, `calendar`, `speech`, `browserUse`) needs at least a triage.

### Steps

- [ ] **Step 4.1: Per-module triage**

For each module, identify any fs/process surface. If trivially safe (e.g. writes to a fixed library-managed path with no user-controlled component), document why. If exposed, file a sub-task under Task 4 with the fix.

- [ ] **Step 4.2: Fix everything triaged as exposed**

Implement and test per sub-task.

---

## Task 5: Documentation

- [ ] **Step 5.1: Add a "Capability narrowing via partial application" guide page**

Under `docs/site/guide/`, add a page that explains:
- The intent: bind a `dir` or `allowedPaths` before handing a tool to an LLM.
- Which helpers are safe to narrow this way (table from Task 1).
- Which helpers cannot be narrowed (category D) and why.

Link from the existing partial-application page (`https://agency-lang.com/guide/partial-application.html` source file).

- [ ] **Step 5.2: CHANGELOG entry**

> **BREAKING (safety):** `mkdir`, `copy`, `move`, `remove`, and `applyPatch` now reject paths outside the calling module's directory unless `allowedPaths` is set explicitly. Pass `allowedPaths: [...]` to restore the previous behavior with an explicit allow-list, or `allowedPaths: ["/"]` to permit any absolute path (not recommended).

---

## Validation checklist (run before opening the PR)

- [ ] All new unit tests green (`assertContained`, per-helper fs tests).
- [ ] `make fixtures` produces no unexpected drift.
- [ ] `pnpm run lint:structure` clean.
- [ ] Manual smoke test: a representative agency program that uses `mkdir`/`copy`/`move` from a non-module path still works once `allowedPaths` is set explicitly.
- [ ] Manual escape test: confirm a partial-applied `copy.partial(allowedPaths: ["/tmp"])` rejects `copy(src: "/tmp/x", dest: "/etc/passwd_copy")`.
- [ ] Docs site builds.
