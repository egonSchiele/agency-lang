# Contained Filenames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** A model-chosen filename cannot escape the directory the interrupt
reported, through absolute paths, `~`, `..`, or stable symlinks.

**Architecture:** One declarative TS preparation function
(`prepareContainedPath`) canonicalizes `dir`, normalizes `filename`, and
rejects escapes before any interrupt is raised. The nine scoped Agency
wrappers call it once and use the prepared values in both the interrupt payload
and the execution. safeBash, which has no trusted `dir`, resolves each supported
literal redirect through one Agency-level `prepareRedirectWrite` operation. It
follows the complete stable target and reports that target's resolved parent.
Imperative filesystem walking and quote/tilde interpretation stay behind those
two interfaces. Policy-side `.` expansion realpaths the launch directory so
both sides share one path identity.

**Tech Stack:** TypeScript (lib/stdlib), Agency (stdlib wrappers), vitest,
the agency test runner.

**Spec:** `packages/agency-lang/2026-08-20-contained-filename-spec.md` — read
it first; it defines the ten preparation steps, the trust-level rule, the
caller inventory, and the error wording.

## Global constraints

- Repo rules: `make` only after `.agency`/agent changes (name the stale
  artifact); `pnpm run fmt:ts` and `pnpm run lint:structure` before push;
  save test output to files; never run the full agency suite locally.
- Commit messages use a file because apostrophes break the CLI.
- The teaching sentence must appear verbatim in escape errors:
  `To write somewhere else, pass that directory in dir` (adapted per verb:
  "read from" for reads).
- Behavior of the non-raising TS primitives (`_read`, `_write`,
  `resolvePath`, ...) does not change. `resolvePath`'s existing doc comment
  remains accurate and must not be rewritten to claim containment; only the
  scoped Agency wrapper docstrings gain the new contract.

---

### Task 1: `prepareContainedPath` and its unit tests

**Files:**
- Create: `lib/stdlib/prepareContainedPath.ts`
- Create: `lib/stdlib/prepareContainedPath.test.ts`
- Modify: `lib/stdlib/assertContained.ts` (export the private `isContained`)

**Interfaces:**
- Produces: `type ContainedPath = { dir: string; filename: string }` and
  `type FileOperation = "read" | "write"` and
  `async function prepareContainedPath(dir: string, filename: string,
  operation: FileOperation): Promise<ContainedPath>`.
  Throws `Error` on every rejection; Agency callers convert with `try`.
  `operation` is required and only shapes the error message.
- Consumes: `resolveDir`, `expandPath`, `isContained` (newly exported).

- [ ] **Step 1: export `isContained` from `assertContained.ts`**

Change `function isContained(` to `export function isContained(` and leave
everything else alone. Its Windows case-folding and `path.relative` logic is
the containment primitive the spec requires reusing.

- [ ] **Step 2: write the failing unit tests**

`lib/stdlib/prepareContainedPath.test.ts`, following the sandbox pattern in
`lib/stdlib/writeContained.test.ts` from git history (mkdtemp a base with
`root/` and `outside/`):

```ts
import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { realpath } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { prepareContainedPath } from "./prepareContainedPath.js";

const sandboxes: string[] = [];

function sandbox(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "pcp-"));
  sandboxes.push(base);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

afterEach(() => {
  for (const base of sandboxes.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

describe("prepareContainedPath", () => {
  it("accepts nested relative filenames and normalizes . and ..", async () => {
    const { root } = sandbox();
    expect(await prepareContainedPath(root, "src/lib/file.ts", "write")).toEqual({
      dir: await realDir(root),
      filename: path.join("src", "lib", "file.ts"),
    });
    expect((await prepareContainedPath(root, "a/./b/../c.txt", "write")).filename).toBe(
      path.join("a", "c.txt"),
    );
  });

  it("rejects absolute, ~, and escaping filenames with the teaching message", async () => {
    const { root, outside } = sandbox();
    const absolute = path.join(path.parse(root).root, "pcp-absolute-outside");
    await expect(prepareContainedPath(root, absolute, "write")).rejects.toThrow(
      /pass that directory in dir/,
    );
    await expect(prepareContainedPath(root, "~/payload.agency", "write")).rejects.toThrow(
      /pass that directory in dir/,
    );
    await expect(
      prepareContainedPath(root, path.join("..", path.basename(outside), "x"), "write"),
    ).rejects.toThrow(/pass that directory in dir/);
  });

  it("realpaths a symlinked dir", async () => {
    const { root } = sandbox();
    const link = path.join(path.dirname(root), "rootlink");
    symlinkSync(root, link);
    expect((await prepareContainedPath(link, "f.txt", "write")).dir).toBe(await realDir(root));
  });

  it("follows in-root symlinks and rejects escaping ones", async () => {
    const { root, outside } = sandbox();
    mkdirSync(path.join(root, "realsub"));
    symlinkSync(path.join(root, "realsub"), path.join(root, "insub"));
    symlinkSync(outside, path.join(root, "outsub"));
    // In-root parent link: allowed, filename keeps the link spelling.
    expect((await prepareContainedPath(root, "insub/f.txt", "write")).filename).toBe(
      path.join("insub", "f.txt"),
    );
    // Escaping parent link and escaping final link: rejected.
    await expect(prepareContainedPath(root, "outsub/f.txt", "write")).rejects.toThrow(/outside dir/);
    writeFileSync(path.join(outside, "real.txt"), "x");
    symlinkSync(path.join(outside, "real.txt"), path.join(root, "leaflink"));
    await expect(prepareContainedPath(root, "leaflink", "write")).rejects.toThrow(/outside dir/);
    // In-root final link: allowed.
    writeFileSync(path.join(root, "inner.txt"), "x");
    symlinkSync(path.join(root, "inner.txt"), path.join(root, "innerlink"));
    expect((await prepareContainedPath(root, "innerlink", "write")).filename).toBe("innerlink");
  });

  it("rejects dangling symlinks on the target path", async () => {
    const { root, outside } = sandbox();
    symlinkSync(path.join(outside, "missing"), path.join(root, "dangle"));
    await expect(prepareContainedPath(root, "dangle", "write")).rejects.toThrow(/dangling/);
    await expect(prepareContainedPath(root, "dangle/deeper.txt", "write")).rejects.toThrow(/dangling/);
  });

  it("treats missing intermediate directories as contained, not dangling", async () => {
    const { root } = sandbox();
    expect((await prepareContainedPath(root, "sub/new/file.txt", "write")).filename).toBe(
      path.join("sub", "new", "file.txt"),
    );
  });

  it("requires dir to exist", async () => {
    const { root } = sandbox();
    await expect(
      prepareContainedPath(path.join(root, "nope"), "f.txt", "write"),
    ).rejects.toThrow();
  });

  it("rejects an empty dir instead of silently using cwd", async () => {
    await expect(prepareContainedPath("", "f.txt", "write")).rejects.toThrow(/dir/);
  });
});

async function realDir(p: string): Promise<string> {
  return realpath(p);
}
```

All calls in this test pass an explicit `"read"` or `"write"` operation.
Extend the cases above with: a two-link in-root chain that succeeds; a symlink
loop that rejects with `ELOOP`; `file/child` where `file` is regular and the
walk rejects with `ENOTDIR`; a mocked `lstat` `EACCES` that rejects rather than
becoming a lexical tail; exact read and write teaching sentences; and a
Windows-only case-folding assertion guarded by `it.runIf(process.platform ===
"win32")`. These cases pin every fail-closed branch advertised by the helper.

- [ ] **Step 3: run to verify they fail**

Run: `npx vitest run lib/stdlib/prepareContainedPath.test.ts > /tmp-scratch/pcp1.log 2>&1`
(use the session scratchpad; path shortened here). Expected: FAIL, module
not found.

- [ ] **Step 4: implement `prepareContainedPath`**

`lib/stdlib/prepareContainedPath.ts` — the spec's ten steps, numbered in
comments:

```ts
import fs from "fs/promises";
import path from "path";
import { resolveDir } from "./resolveDir.js";
import { expandPath } from "./expandPath.js";
import { isContained } from "./assertContained.js";

export type ContainedPath = {
  dir: string;
  filename: string;
};

export type FileOperation = "read" | "write";

/**
 * Prepare a (dir, filename) pair for a scoped single-file wrapper: the
 * returned values go into BOTH the interrupt payload and the execution.
 * Guarantees the spec's containment contract: the resolved file operand
 * stays inside the resolved dir operand, or this throws before any
 * interrupt exists. See 2026-08-20-contained-filename-spec.md.
 */
export async function prepareContainedPath(
  dir: string,
  filename: string,
  operation: FileOperation,
): Promise<ContainedPath> {
  if (dir.trim() === "") {
    throw new Error(`${operation} refused: dir must not be empty.`);
  }
  // Steps 1-2: expand, absolutize, and realpath dir. It must exist.
  const baseDir = await resolveDir(dir);
  const realRoot = await fs.realpath(baseDir);

  // Steps 3-4: expand filename; absolute (including ~-led) is an escape.
  const expanded = expandPath(filename);
  if (path.isAbsolute(expanded)) {
    throw escapeError(operation, filename, realRoot, expanded);
  }

  // Steps 5-6: lexical resolution and lexical containment.
  const lexical = path.resolve(realRoot, expanded);
  if (!isContained(lexical, realRoot)) {
    throw escapeError(operation, filename, realRoot, lexical);
  }

  // Steps 7-9: resolve through existing symlinks (dangling ones fail
  // closed) and check the resolved target too.
  const resolved = await resolveExistingStrict(lexical);
  if (!isContained(resolved, realRoot)) {
    throw escapeError(operation, filename, realRoot, resolved);
  }

  // Step 10: the real dir plus the normalized relative filename. The
  // relative form deliberately keeps in-root symlink names (spec: the
  // payload guarantees containment, not leaf-target naming).
  return { dir: realRoot, filename: path.relative(realRoot, lexical) };
}

/** Walk the target path component by component. Existing components are
 *  realpathed (following healthy symlinks); a component whose lstat says
 *  "symlink" but whose realpath fails is dangling and fails closed; a
 *  component that simply does not exist ends the walk, and the remaining
 *  tail is appended lexically (missing intermediates are contained, not
 *  dangling). */
async function resolveExistingStrict(target: string): Promise<string> {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep);
  let current = parsed.root;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error: any) {
      // Only ENOENT means the rest is a lexical tail. Permission, I/O,
      // ELOOP, and ENOTDIR failures fail closed.
      if (error?.code !== "ENOENT") {
        throw error;
      }
      return path.join(next, ...segments.slice(i + 1));
    }
    if (stat.isSymbolicLink()) {
      try {
        current = await fs.realpath(next);
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        throw new Error(`refused: "${next}" is a dangling symlink.`);
      }
    } else {
      current = next;
    }
  }
  return current;
}

function escapeError(
  operation: FileOperation,
  filename: string,
  root: string,
  landed: string,
): Error {
  const preposition = operation === "write" ? "somewhere else" : "from somewhere else";
  return new Error(
    `${operation} refused: filename "${filename}" is outside dir "${root}" ` +
      `(it resolves to "${landed}"). To ${operation} ${preposition}, pass that ` +
      `directory in dir.`,
  );
}
```

Keep `resolveExistingStrict` private to this module and reuse it for redirect
resolution in Task 7. Add a comment explaining why it cannot call
`assertContained.ts`'s `realpathOrLexicalAncestor`: that older helper treats
all `realpath` errors as missing paths, while this safety boundary may treat
only `ENOENT` as a lexical tail. Do not add a second strict walk elsewhere.

- [ ] **Step 5: run the tests to verify they pass**

Same vitest command. Expected: PASS. Fix until green; the symlink cases are
the ones most likely to need iteration.

- [ ] **Step 6: commit**

`git add` the three files; message: "Add prepareContainedPath: containment
preparation for scoped file wrappers".

---

### Task 2: bridge the helper to Agency code

**Files:**
- Modify: `lib/stdlib/fs.ts` (add
  `export { prepareContainedPath as _prepareContainedPath } from "./prepareContainedPath.js";`)

**Interfaces:**
- Produces: `_prepareContainedPath` importable in `.agency` files from
  `"agency-lang/stdlib-lib/fs.js"`, returning `{ dir, filename }`, throwing
  on rejection (so Agency `try` yields a failure Result).

- [ ] **Step 1:** add the export line beside the existing re-exports.
- [ ] **Step 2:** `npx tsc --noEmit -p .` → clean. Commit with Task 3.

---

### Task 3: convert the four `stdlib/index.agency` wrappers

**Files:**
- Modify: `stdlib/index.agency` (`read`, `write`, `readBinary`,
  `writeBinary`)
- Test: `tests/agency/contained-filenames.agency` (+ `.test.json`) — new
- Test: create `tests/agency-js/contained-filename-wrappers/agent.agency`,
  `test.js`, and `fixture.json` for symlinked-dir payload recording

**Interfaces:**
- Consumes: `_prepareContainedPath` from Task 2.
- Produces: wrapper behavior every later task follows. The pattern, shown for
  `write` (reads are identical minus `destructive`):

```agency
  if (useAgentCwd) {
    dir = applyAgentCwd(dir)
  }
  const prepared = try _prepareContainedPath(dir, filename, "write")
  if (isFailure(prepared)) {
    return prepared
  }
  return interrupt std::write("Are you sure you want to write to this file?", {
    dir: prepared.value.dir,
    filename: prepared.value.filename,
    content: content,
    mode: mode
  })
  destructive {
    return try _write(prepared.value.dir, prepared.value.filename, content, mode)
  }
```

- [ ] **Step 1:** add `_prepareContainedPath` to the
  `"agency-lang/stdlib-lib/builtins.js"`-adjacent import block (it comes
  from `fs.js`, so add a new import line).
- [ ] **Step 2:** apply the pattern to all four wrappers. Pass operation
  `"read"` for the two read wrappers.
- [ ] **Step 3:** update the four docstrings. Each `@param filename` gains:
  "Must stay inside dir: no absolute paths, `~`, upward traversal, or
  symlinks that leave it. To touch another directory, pass it in `dir`."
  Delete nothing else.
- [ ] **Step 4:** write the Agency execution test (no LLM calls). Give each of
  `read`, `write`, `readBinary`, and `writeBinary` one contained success case
  and one `../escape` rejection case, so deleting preparation from any one
  wrapper fails the suite. Also pin `/abs/x` and `~/x` through `write`, and the
  exact read-versus-write teaching sentence. Run every escape with a handler
  that would return `reject("HANDLER_REACHED")`; assert the preparation error
  instead, proving no interrupt existed.
- [ ] **Step 5:** add Agency-JS recording-handler cases for all four wrappers.
  `test.js` creates a unique real fixture directory plus `dir-link`, passes
  both paths into `agent.agency`, and removes the base in `finally`.
  `agent.agency` uses `nested/../probe` and an inline handler that records the
  interrupt, rejecting unless `interrupt.data.dir` equals the supplied real
  directory and `interrupt.data.filename` equals the normalized filename.
  It then approves, reads back writes, and returns the four payload checks plus
  execution outcomes for exact comparison in `fixture.json`. Keep binary
  content tiny (`"aGk="`).
- [ ] **Step 6:** `make` (stale: compiled stdlib dist), then
  `pnpm run agency test tests/agency/contained-filenames.test.json`,
  output to a scratch file. Expected: PASS.
- [ ] **Step 7:** also run the existing focused binary regressions,
  `tests/agency/read-binary.test.json` and
  `tests/agency/write-binary.test.json`, and the new Agency-JS wrapper test,
  with output saved to scratch files.
- [ ] **Step 8:** commit: "Contain read/write filenames inside dir".

---

### Task 4: convert `edit` in `stdlib/fs.agency`

**Files:**
- Modify: `stdlib/fs.agency` (`edit`, around line 63)
- Test: extend `tests/agency/contained-filenames.agency`
- Test: extend `tests/agency-js/contained-filename-wrappers/` from Task 3

- [ ] **Step 1:** prepare BEFORE `_previewEdit`; preview, interrupt payload,
  and `_multiedit` all consume `prepared.value` (spec: preview and eventual
  write must not refer to different spellings).
- [ ] **Step 2:** add this sentence to the `filename` documentation: "Must
  stay inside dir: no absolute paths, `~`, upward traversal, or symlinks that
  leave it. To edit another directory, pass it in `dir`."
- [ ] **Step 3:** test `edit("../escape.txt", ...)` with a handler whose unique
  rejection text proves preparation fails before the interrupt. Then edit a
  file through a symlinked `dir` with a normalized `sub/../file.txt` filename.
  Its recording handler approves only when the payload has the real `dir`, the
  normalized filename, and the expected `before`/`after`; assert the final
  file content. This detects raw values in preview or payload, not only a
  successful ordinary edit.
- [ ] **Step 4:** put the symlinked-dir recording case in the Agency-JS fixture
  from Task 3, where `test.js` can create and reliably clean the symlink. Return
  the payload check and final content for exact comparison in `fixture.json`.
- [ ] **Step 5:** `make` (stale: fs stdlib dist), run the new tests and the
  existing `tests/agency/agent-cwd.test.json` regression, with output saved,
  commit: "Contain edit filenames inside dir".

---

### Task 5: convert the four `stdlib/agency.agency` wrappers

**Files:**
- Modify: `stdlib/agency.agency` (`typecheckFile` ~483, `writeAST` ~527,
  `loadTemplate` ~570, `formatFile` ~645)
- Test: extend `tests/agency/contained-filenames.agency`
- Test: extend `tests/agency-js/contained-filename-wrappers/` from Task 3

- [ ] **Step 1:** import `_prepareContainedPath` from
  `"agency-lang/stdlib-lib/fs.js"`. In `typecheckFile` and `loadTemplate`, call
  it with operation `"read"`; in `writeAST` and `formatFile`, call it with
  operation `"write"`. Convert a preparation failure to the wrapper's failure
  Result.
  Put `prepared.value.dir` and `.filename` in each interrupt and pass those
  same values to `_typecheckFile`, `_loadTemplate`, `_writeAST`, or
  `_formatFile` after approval.
- [ ] **Step 2:** add one test per wrapper rejecting a `~` filename with a
  uniquely rejecting handler, proving preparation happens before the
  interrupt. Add a contained success smoke test for `typecheckFile`,
  `writeAST`, and `formatFile`; run an existing focused template test for the
  `loadTemplate` success half. The write smoke tests read their resulting file
  so a helper wired only into the payload cannot pass.
- [ ] **Step 3:** extend the Agency-JS recording fixture with all four
  wrappers. For each, approve only a payload carrying the real symlink target
  directory and normalized filename. Assert successful results for the reads
  and inspect resulting files for the writes. Raw interrupt values in any
  alternate wrapper must make the fixture fail.
- [ ] **Step 4:** `make`, run the new tests plus
  `tests/agency/templates/generatedProgram.test.json`, save both outputs, and
  commit: "Contain the
  agency.agency file wrappers".

---

### Task 6: migrate the broken callers and preserve lifecycle coverage

**Files:**
- Modify: `lib/agents/agency-agent/brains/coordinator/subagents/code.agency:71-79`
- Modify: `tests/agency/dirname-paths.agency` and
  `tests/agency/dirname-paths.test.json`
- Modify: `tests/agency/dirname-paths/helper.agency` (+ its test json if
  expectations are listed there)
- Modify: `tests/agency/stdlib-destructive.agency:9` (keep its existing JSON
  expectation)

- [ ] **Step 1: promptFile.** Change to the dir-based spelling:

```agency
def promptFile(filename: string): string {
  const contents = read(filename, __dirname + "/../prompts") with approve
  if (isFailure(contents)) {
    return ""
  }
  return contents.value
}
```

and its two call sites drop the `../prompts/` prefix:
`promptFile("code.md")`, `promptFile("oneShot.md")`. Add a comment: the
empty-string fallback makes THIS the silent failure the spec's inventory
warns about, so the test in Step 2 is the guard.

- [ ] **Step 2: prompt-loading guard test.** Create
  `tests/agency/agency-agent-code-prompt.agency` and its `.test.json`. Use
  `import test { promptFile }` from the coordinator's
  `subagents/code.agency`, call `promptFile("code.md")` and
  `promptFile("oneShot.md")` independently, and return two booleans asserting
  each value is nonempty. Expect `[true,true]`. This directly guards both
  silent-empty failure sites; one successfully loaded prompt cannot hide the
  other one's failure.
- [ ] **Step 3: dirname-paths flips.** `readUpward` now asserts the upward
  read FAILS (pin the new contract), and add `readUpwardViaDir` asserting
  `read("dirname-paths-shared.txt", __dirname + "/..")` succeeds. Update
  the `.test.json` expectations. Replace `absoluteFilenameAllowed` with a
  migration test that passes `tmp-abs.txt` as `filename` and its absolute
  parent as `dir`; keep the success assertion under the new spelling.
- [ ] **Step 4: stdlib-destructive.** Preserve this test's lifecycle purpose.
  Change the write to a contained filename below a nonexistent parent, for
  example `write("missing-parent/f.txt", "hi", __dirname)`. Preparation then
  succeeds and `_write` fails after entering `destructive`, so the existing
  `[true,false]` expectation remains valid.
- [ ] **Step 5:** `make` (stale: agent brain dist), run the three affected
  agency tests only, commit: "Migrate upward-path callers to dir-based
  spellings".

---

### Task 7: safeBash reports the actual literal redirect target

**Files:**
- Modify: `stdlib/safeBash.agency` (the plan construction that fills the
  `std::write` payload, near line 207, and the `WriteExec` fill)
- Test: `lib/stdlib/safeBash.test.ts`
- Test: `tests/agency/safeBash.agency`
- Test: create `tests/agency-js/safe-bash-redirect-paths/agent.agency`,
  `test.js`, and `fixture.json` for real symlink fixtures

`stdlib/safeBash/actions.agency` does not change. `WriteExec` already carries
the resolved `dir` and `filename` consumed by `runWrite`.

**Interfaces:**
- Consumes: a new bridge export
  `_resolveRedirectTarget(target, cwd, tildeMode)` beside
  `prepareContainedPath`. It resolves the **complete** target, including a
  healthy final symlink, with the same strict dangling-link rule. It then
  returns `{ dir, filename }` by splitting the resolved target. There is no
  containment rejection because safeBash has no trusted `dir`. `tildeMode` is
  the closed union `"expand" | "literal"`, not a boolean whose meaning callers
  must remember.
- Produces in TypeScript:
  `type TildeMode = "expand" | "literal"` and
  `async function resolveRedirectTarget(target: string, cwd: string,
  tildeMode: TildeMode): Promise<ContainedPath>`.
- Produces: one Agency-level declarative helper
  `prepareRedirectWrite(redirect: Redirect, cwd: string, content: string): Result<WritePayload>`.
  It alone validates the redirect, extracts a fully literal word, decides
  quote-aware tilde behavior, invokes the bridge, chooses `WriteMode`, and
  converts bridge errors to `Result`. `redirectEffect` and `writePlan` do not
  repeat that choreography.
- Produces: `writeEffect(write: WritePayload): Effect` and
  `writeExecution(write: WritePayload): WriteExec`. The shell-free plan creates
  one `WritePayload` and derives both sides from it, so approval/execution
  parity holds by construction. Keep `WriteExec`'s existing flat shape:
  `writeExecution` is the only place that adds `kind: "write"` and copies the
  fields from the shared payload.

- [ ] **Step 1:** implement `resolveRedirectTarget` in
  `lib/stdlib/prepareContainedPath.ts`, reusing `resolveExistingStrict` on the
  full target. Export it via `fs.ts` as `_resolveRedirectTarget`. Unit-test an
  absolute target, a relative target, `"expand"` and `"literal"` tilde modes,
  a symlinked parent, an existing final symlink, a two-link chain, a loop, and
  dangling parent/final rejection. The existing-final-symlink case must return
  the target's real parent and basename. All fixtures use unique temporary
  roots and cleanup.
- [ ] **Step 2:** replace `literalTarget` with
  `prepareRedirectWrite`. Its exhaustive `Word` match selects `"expand"` only
  for unquoted `literal`/`path` words and `"literal"` for single-quoted or
  fully literal double-quoted words. Variable-bearing words fail and therefore
  fall back to the broad `std::bash` plan. Keep all interpretation inside this
  helper; neither caller receives literal text plus a mode to orchestrate.
  Import `WritePayload` and `WriteExec` from `./safeBash/actions.agency` beside
  the existing `Effect` and `Plan` imports.
- [ ] **Step 3:** add `writeEffect` and `writeExecution`. In `writePlan`, bind
  one `WritePayload`, pass it to both constructors, and remove the duplicate
  four-field object literals. In `redirectEffect`, use
  `prepareRedirectWrite(..., content: "")` and `writeEffect`. A bridge failure
  becomes the surrounding `Result` failure; pin that `planFor` then deliberately
  chooses the broad `std::bash` plan rather than throwing or executing a narrow
  write.
- [ ] **Step 4:** extend `tests/agency/safeBash.agency` with exact structural
  assertions: an isolated absolute target reports its real parent; a relative
  target resolves against plan cwd; `WritePayload` and `WriteExec` match in
  `dir`, `filename`, `content`, and `mode`; a final symlink reports its real
  target; unquoted `~/f` expands home while both `'~/f'` and `"~/f"` remain
  beneath cwd; dangling and looping targets produce a broad `std::bash` plan.
  Cover both shell-free `echo > target` and recognized Bash-backed
  `git status > target` paths so breaking either caller fails.
- [ ] **Step 5:** put the real-symlink cases in the new Agency-JS fixture.
  `test.js` creates a unique base, target file, final symlink, dangling link,
  and loop, passes their paths to `agent.agency`, and removes the base in
  `finally`. The Agency node approves the narrow final-symlink write and
  returns its plan fields and result. `test.js` asserts the real target received
  the content. Do not write fixed `/tmp/f`.
- [ ] **Step 6:** `make` (stale: safeBash stdlib dist), run
  `npx vitest run lib/stdlib/safeBash.test.ts`, the safeBash Agency test, and
  the new Agency-JS fixture with output saved. Commit: "Report actual safeBash
  redirect targets".

---

### Task 8: canonicalize the policy-side `.` expansion

**Files:**
- Modify: `lib/runtime/policy.ts` (`resolveDotDirPattern`)
- Test: `lib/runtime/policy.test.ts`

- [ ] **Step 1:** failing direct test: with an injected cwd that is a symlink
  to a real directory, `resolveDotDirPattern("{.,./**}", link)` produces a
  pattern that matches the real directory and a real descendant, but not an
  outside sibling or the stale link spelling. (The function already takes cwd
  as a parameter for tests.)
- [ ] **Step 2:** realpath the cwd (fall back to the lexical cwd if
  realpath fails) with `realpathSync` before `escapeForGlob`; this policy path
  is synchronous. Keep the replacement-callback and glob-escaping behavior;
  those tests must stay green.
- [ ] **Step 3:** add an integration assertion through `checkPolicy`: mock
  `process.cwd()` to return the symlink, configure `{.,./**}` for
  `std::write`, and verify an interrupt carrying the real directory is
  approved while an outside sibling propagates. Restore the mock in `finally`.
  This catches a correct resolver that is not actually wired into policy
  matching.
- [ ] **Step 4:** pin the documented fallback with a nonexistent injected cwd:
  expansion uses that lexical cwd and preserves the existing glob escaping.
- [ ] **Step 5:** `npx vitest run lib/runtime/policy.test.ts` → all pass.
  Commit: "Policy dot expansion uses the real launch directory".

---

### Task 9: end-to-end security tests

**Files:**
- Test: create `tests/agency-js/contained-filenames-policy/agent.agency`,
  `test.js`, and `fixture.json`, following the policy injection and temporary
  directory cleanup pattern in `tests/agency-js/cli-policy-handler-headless/`

- [ ] **Step 1:** in `test.js`, create one unique temporary base containing
  `work/` and `outside/`, plus all symlinks used below. Write a policy that
  approves `std::write` only for the real workdir and descendants. Pass every
  fixture path into the Agency node; do not use a fixed `/tmp/report.txt`.
  Remove the entire base in `finally`, even when an assertion fails.
- [ ] **Step 2:** prove the migrated destination rule: writing
  `report.txt` with `dir: outside` is rejected, the same filename with
  `dir: work` is approved and created, and no outside file exists. Capture the
  interrupt with an inner recording handler that saves `interrupt.data` then
  returns `propagate()` to the outer noninteractive `cliPolicyHandler`. Return
  the recorded `dir` alongside the operation result and assert it is the real
  outside directory, so rejection for an unrelated reason cannot produce a
  false positive.
- [ ] **Step 3:** test filename escapes independently: a unique
  `~/.agency-contained-test-<random>` name, an absolute filename under
  `outside`, and `../outside/escape.txt` each fail with the preparation
  teaching message before the policy handler and create no file. Reset a
  `handlerReached` flag before each call; the inner recording handler sets it
  before propagating. Assert it remains false for every escape. Compute the
  unique home candidate in `test.js`, assert it did not exist beforehand, and
  remove it in `finally` if broken code creates it.
- [ ] **Step 4:** create `work/out-link -> outside`. A write through
  `out-link/f.txt` must fail before the handler and create no outside file.
  Create `work/in-link -> work/real-sub`; a write through `in-link/f.txt` must
  be approved and update the in-work target. These two rows catch a wrapper
  that implements lexical containment but omits stable-symlink resolution.
- [ ] **Step 5:** create `work/dir-link -> outside`, call
  `write("f.txt", dir: dir-link)`, assert the interrupt reports the real
  outside path, the workdir policy rejects it, and no file is created.
- [ ] **Step 6:** run just this Agency-JS test and save output. The direct
  `checkPolicy` integration for a symlinked launch directory lives in Task 8,
  where `process.cwd()` can be injected reliably.
- [ ] **Step 7:** commit: "End-to-end containment
  tests under a scoped policy".

---

### Task 10: docs and guards

**Files:**
- Modify: `docs/dev/agents/approval-policies.md` (containment section + the
  threat-model boundary: stable escapes are rejected before the interrupt;
  post-approval races are out of scope and why)

- [ ] **Step 1:** write the doc section: the contract, the migration rule,
  the safeBash parent-as-dir exception, what is NOT defended.
- [ ] **Step 2:** full guard pass: `pnpm run fmt:ts`,
  `pnpm run lint:structure`, `npx vitest run lib/sourceIsText.test.ts`,
  `npx tsc --noEmit -p .`. All green.
- [ ] **Step 3:** commit: "Document filename containment in
  approval-policies". Report the verified branch and ask for separate
  approval before pushing or opening a PR.

---

## Self-review notes

- Spec coverage: contract → T1; wrappers table → T3/T4/T5; safeBash → T7;
  canonical `.` → T8; caller inventory → T6; errors/docstrings → T1/T3;
  migration + e2e tests → T6/T9; docs → T10.
- Known judgment call: `resolveExistingStrict` follows healthy symlinks
  during the walk (so a link-to-link chain inside root works) and fails
  on dangling links, loops, non-directory components, permission errors, and
  other non-`ENOENT` filesystem failures; the tests pin each branch.
- Two plan clarifications override ambiguous spec wording: `resolvePath` keeps
  its accurate unrestricted-helper documentation, and safeBash resolves the
  complete redirect target with quote-aware tilde semantics before splitting
  it into `dir` and `filename`.
- Mutation-sensitivity check: removing preparation from any one scoped wrapper,
  using raw values in a payload, omitting symlink resolution, breaking either
  safeBash planning path, loading either coordinator prompt from the old path,
  or canonicalizing policy patterns without wiring that result through
  `checkPolicy` makes at least one named test fail.
- Not in this plan, tracked in the spec's superseded-work section:
  applyPatch, copy/move/remove, ls/grep/glob, the wider effect audit.
