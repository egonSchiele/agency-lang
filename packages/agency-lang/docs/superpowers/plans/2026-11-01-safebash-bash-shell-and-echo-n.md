# safeBash runs bash, and a lone `echo -n` runs in process (ADI-248, ADI-263)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every shell script a host runs goes to `bash -c`, never `sh -c`, so the text safeBash classified as bash runs as bash; and a lone `echo -n` prints in process, which the shell mismatch was the only reason to refuse.

**Architecture:** `spawnCommand` in the Node host looks `bash` up on the search path and spawns it, or rejects with a message that names bash when it is missing. Nothing in safeBash's classifier changes for that. The shell-free echo then gains a one-flag table, `ECHO_FLAGS`, read through the existing `splitFlags`, so `-n` drops the trailing newline on both the echo path and the write path.

**Tech Stack:** TypeScript (`lib/host/node/nodeSubprocess.ts`, vitest), Agency (`stdlib/safeBash.agency`, the Agency test runner).

**Spec:** `docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`. The decision this plan carries out is recorded on Linear ADI-248 (closed): option A, `bash -c`, refuse when no bash. The reasons, in short: the parser is a bash parser and the rebuilt text is bash; `sh` is dash on Ubuntu, bash 3.2 in POSIX mode on macOS, and busybox ash in Alpine, and they disagree on `&>`, `echo -n`, `echo -e`, braces, and `$'...'`; a narrow plan must never run under a shell other than the one it was classified for.

## Background for the implementer

safeBash (`stdlib/safeBash.agency`) parses a command string with tarsec's bash parser, decides which interrupts describe it, raises them, and then either computes the result in process (a lone literal `echo`, a lone `grep` that translates, a lone `cat`, `head`, or `tail` of one file) or hands the text to a shell through `runBash` in `stdlib/safeBash/actions.agency`, which calls `_bash` in `lib/stdlib/shell.ts`, which reaches `abortableShell` in `lib/stdlib/abortable.ts`, which asks the host's subprocess part to run `{ kind: "shell", script }`. The Node host runs that with `spawn("sh", ["-c", script])` at `lib/host/node/nodeSubprocess.ts:51`. The `bash` tool in `stdlib/shell.agency` takes the same path and its docstring says "via sh -c".

Read `docs/dev/stdlib/safe-bash.md` first ("Decide, then act", "The rules", "Outcomes", "In process when it translates") and `docs/dev/runtime/host.md` ("The subprocess part"). Then read `echoPlan`, `writePlan`, `echoWords`, `echoOutput`, `splitFlags`, and `readFlagWord` in `stdlib/safeBash.agency`.

Today `echoPlan` and `writePlan` refuse any flag (`flagNames(command).length > 0`), so `echo -n hi` goes to bash as a broad `std::bash` question. It waited because macOS `/bin/sh -c 'echo -n hi'` prints `-n hi`, while a shell-free `echo -n` would print `hi`, and the same echo inside a chain would then disagree with the lone one. Once the shell is bash everywhere, bash's builtin echo prints `hi` with no newline, in a chain and alone, so the shell-free path can match it.

## Global Constraints

- Never force-push or amend. Commit messages and PR bodies go in a file and are passed with `-F`.
- Run `make` after any `.agency` edit (it regenerates `docs/site/stdlib/safeBash.md` and `docs/site/stdlib/safeBash/actions.md`; commit those). Do not hand-edit `docs/site`.
- After every TypeScript edit: `pnpm run typecheck`, `pnpm run lint:structure`, and prettier on the files you touched (`pnpm exec prettier --write <file>`), never `pnpm run fmt:ts` from the main checkout.
- Save test output to a file in the scratchpad and read it; do not rerun a slow test to see what failed. Do not run the whole Agency suite; run `pnpm run agency test tests/agency/safeBash.agency`.
- Dev docs state the mechanism and the rule, with no history, dates, or "previously".
- Agency has no lambdas. An `isFailure` guard does not narrow a `Result` over a union; match on the Result through a helper def. A `!=` tag check does not narrow; use `if (word is { tag: "flag" })`.
- `.claude/skills/agency-stdlib-docs/SKILL.md` is tracked but gitignored: `git add -f` it in a command of its own, or the whole `git add` aborts.
- The owner opens no PR for you; you open it, and the owner merges.

## Review Focus

1. A machine with no `bash` on the search path. Expected: `safeBash` returns a failure whose message names bash, and nothing runs under `sh`. Test in Task 1.
2. `echo hi &> out.txt` approved as a broad question. Expected: `out.txt` holds `hi` and stdout is empty, which is what the person who read the text as bash approved. Test in Task 2.
3. `echo 'a\tb'` alone and `echo 'a\tb'; echo x` in a chain. Expected: the same `a\tb` bytes in both, since bash's echo does not read escapes. Test in Task 2.
4. `echo hi -n`. Expected: bash's echo prints `hi -n`; the shell-free path must not treat a trailing `-n` as a flag. The table's `optionsFirst` refuses it to bash, which prints the right thing. Test in Task 3.
5. `echo -n hi > out.txt` written shell-free. Expected: the file holds `hi` with no newline, the same bytes bash would write. Test in Task 3.

---

### Task 1: The Node host spawns bash

**Files:**
- Modify: `lib/host/node/nodeSubprocess.ts` (`spawnCommand`, the `locate` body)
- Modify: `lib/stdlib/abortable.ts` (`abortableShell`: the two `"sh"` labels)
- Create: `lib/host/node/nodeSubprocess.test.ts`

**Interfaces:**
- Produces: `locateProgram(program: string, searchPath: string): Promise<string | null>` in `nodeSubprocess.ts`, the body of today's `locate` with the search path as an argument. `nodeSubprocess.locate(program)` calls it with `process.env.PATH ?? ""`.
- Produces: for `{ kind: "shell" }`, `spawnCommand` resolves `bash` through `locateProgram(program, options.env?.PATH ?? process.env.PATH ?? "")` and spawns the absolute path with `["-c", script]`. When it is `null`, the returned child's `ended` promise rejects with `new Error("bash was not found on the PATH. safeBash and the bash tool run their commands with bash.")`. `spawnCommand` is synchronous today and returns a `ChildProcess`; make `startChild` do the lookup before spawning, since it already returns a promise for `ended`. Read `startChild` to see where the `error` listener attaches and reject through the same path.

- [ ] **Step 1: Write the failing tests**

`lib/host/node/nodeSubprocess.test.ts`. Each test makes a temp folder with `fs.mkdtempSync` under `os.tmpdir()` and removes it after.

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeSubprocess } from "./nodeSubprocess.js";

describe("the shell a script runs under", () => {
  it("runs scripts with bash: &> redirects both streams into the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-bash-"));
    const result = await nodeSubprocess.run({ kind: "shell", script: "echo hi &> out.txt" }, { cwd: dir });
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("hi\n");
    fs.rmSync(dir, { recursive: true });
  });

  it("runs scripts with bash: echo -n drops the newline and echo keeps a backslash", async () => {
    const noNewline = await nodeSubprocess.run({ kind: "shell", script: "echo -n hi" });
    expect(noNewline.stdout).toBe("hi");
    const escaped = await nodeSubprocess.run({ kind: "shell", script: "echo 'a\\tb'" });
    expect(escaped.stdout).toBe("a\\tb\n");
  });

  it("rejects with a message naming bash when the search path has none", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agency-nopath-"));
    await expect(
      nodeSubprocess.run({ kind: "shell", script: "echo hi" }, { env: { PATH: empty } }),
    ).rejects.toThrow("bash was not found on the PATH");
    fs.rmSync(empty, { recursive: true });
  });
});
```

Under dash the first test prints `hi` to stdout and leaves `out.txt` empty; under macOS `sh` the second prints `-n hi`. On the owner's machine today `/bin/sh` is bash in POSIX mode, so the first test may pass before the change there; the third fails everywhere.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run lib/host/node/nodeSubprocess.test.ts > $SCRATCH/t1.txt 2>&1; tail -30 $SCRATCH/t1.txt`
Expected: the third test fails (no rejection); on Linux the first two fail too.

- [ ] **Step 3: Implement**

In `nodeSubprocess.ts`: extract `locateProgram(program, searchPath)`; make the `{ kind: "shell" }` branch look up `bash` and spawn the located path; reject through `ended` with the message above when it is `null`. Keep the existing `ENOENT` behavior for `{ kind: "program" }` untouched.

In `abortable.ts`, `abortableShell` passes the string `"sh"` twice (to `spawnResultOf` and to `runCancellable`). Read what each uses it for (a label in failure text) and change both to `"bash"`.

Check `lib/stdlib/shell.ts` near line 41: it maps `spawn <command> ENOENT` to a missing-cwd message. A missing bash now rejects before spawn with its own message, so that mapping is not reached for it; confirm by reading the code path, and leave the mapping as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command. Expected: 3 passed. Then `pnpm vitest run lib/stdlib/abortable.test.ts lib/stdlib/shell.test.ts > $SCRATCH/t1b.txt 2>&1` (if `shell.test.ts` does not exist, run only `abortable.test.ts`). Expected: all pass. Then `pnpm run typecheck && pnpm run lint:structure` and prettier on the three files.

- [ ] **Step 5: Commit**

```bash
git add lib/host/node/nodeSubprocess.ts lib/host/node/nodeSubprocess.test.ts lib/stdlib/abortable.ts
git commit -F $SCRATCH/c1.txt
```

Message: `host: a shell script runs under bash, and a missing bash is a failure that says so`.

---

### Task 2: safeBash and the bash tool say bash, and two tests pin what bash does

**Files:**
- Modify: `stdlib/shell.agency` (the `bash` tool's docstring, "via sh -c")
- Modify: `stdlib/safeBash/actions.agency` (`runBash` docstring: add the missing-bash sentence)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md`, `docs/dev/runtime/host.md`

**Interfaces:**
- Consumes: the bash spawn from Task 1.

- [ ] **Step 1: Write the failing tests**

In `tests/agency/safeBash.agency`, a scratch folder beside the symlink test's folder (see `LINK_FIXTURE` for the pattern: `remove` with approve, `mkdir` with approve, work, `remove` with approve):

```agency
static const SHELL_FIXTURE = __dirname + "/stdlib/__safebash_shell__"

node ampersandRedirectWritesTheFile() {
  // `&>` is a redirect of both streams in bash. Under dash it would be
  // `echo hi &` and then `> out.txt`, which empties the file and prints to
  // stdout. The test file approves the std::bash question.
  remove(SHELL_FIXTURE) with approve
  mkdir(SHELL_FIXTURE) with approve
  const ran = safeBash("echo hi &> out.txt", cwd: SHELL_FIXTURE)
  const written = read("out.txt", SHELL_FIXTURE) with approve
  remove(SHELL_FIXTURE) with approve
  return match(ran) {
    success(out) => [out, written]
    failure(why) => "FAILED: ${why}"
  }
}

node echoIsTheSameAloneAndInAChain() {
  // bash's echo does not read backslash escapes, alone or in a chain. The
  // chain asks std::bash, which the test file approves.
  const alone = safeBash("echo 'a\\tb'")
  const chain = safeBash("echo 'a\\tb'; echo x")
  return [alone, chain]
}
```

`.test.json` rows: `ampersandRedirectWritesTheFile` expects `["", {"value":"hi\n", ...}]`: read what the `read` tool returns (a `Result`), and pin the exact JSON after the first run that fails for the right reason. `interruptHandlers`: one approve for "Are you sure you want to run this shell command?". `echoIsTheSameAloneAndInAChain` expects `[{"success":true,"value":"a\\tb\n"},{"success":true,"value":"a\\tb\nx\n"}]` (check how a `Result` serializes in an existing row and match it), with one approve for the shell question.

Check first that the parser accepts `&>` as a redirect op: `node --input-type=module -e "import {bashParser} from 'tarsec/parsers/bash'; console.log(JSON.stringify(bashParser('echo hi &> out.txt')))"` from the package directory. If it does not parse, the plan is still broad (unparseable) and the test proves the same thing.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run agency test tests/agency/safeBash.agency > $SCRATCH/t2.txt 2>&1; grep -n "FAIL\|✗\|passed\|failed" $SCRATCH/t2.txt | head`
Expected: on macOS with `/bin/sh` as bash, `ampersandRedirectWritesTheFile` may already pass; `echoIsTheSameAloneAndInAChain` fails because macOS sh in POSIX mode turns `\t` into a tab in the chain. Both must fail or pass for the reason you can name; write the reason in the ledger.

- [ ] **Step 3: Docstrings and dev docs**

`stdlib/shell.agency`: the `bash` tool's docstring sentence becomes "Run a shell command string via bash -c and return its stdout, stderr, and exit code." `stdlib/safeBash/actions.agency`, `runBash`: add "The script runs under bash, found on the search path. When there is no bash the result is a failure that says so; nothing falls back to another shell."

`docs/dev/stdlib/safe-bash.md`: a new section after "In process when it translates" titled "Which shell runs the text", four short paragraphs: the text runs under `bash -c`, found on the search path; why (the parser is a bash parser and the rebuilt text is bash; `sh` is a different program per platform, with `&>`, `echo -n`, braces, and `$'...'` as the forms that differ; a narrow plan must never run under a shell it was not classified for); what happens with no bash (a failure naming it, and the in-process paths still work); and that the parser's accepted subset is what bash 3.2 accepts, since macOS ships that version. No history.

`docs/dev/runtime/host.md`, "The subprocess part": say a `shell` command runs under bash looked up on the search path, and is refused with a message when there is none.

- [ ] **Step 4: `make`, run the test, verify pass**

Run `make > $SCRATCH/make2.txt 2>&1; tail -3 $SCRATCH/make2.txt`, then the agency test command again. Expected: every node passes. Check `git status docs/site` shows the regenerated pages.

- [ ] **Step 5: Commit**

```bash
git add stdlib/shell.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/dev/stdlib/safe-bash.md docs/dev/runtime/host.md docs/site/stdlib
git commit -F $SCRATCH/c2.txt
```

Message: `safeBash: the text runs under bash, and two tests pin what bash does`.

---

### Task 3: A lone `echo -n` runs in process

**Files:**
- Modify: `stdlib/safeBash.agency` (`echoPlan`, `writePlan`, `echoWords`, `echoOutput`, new `ECHO_FLAGS`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md` ("Outcomes", and the `echo -n` bullet under "The read family")

**Interfaces:**
- Produces: `static const ECHO_FLAGS: FlagSpec = { plain: ["n"], valued: [], optionsFirst: true }`.
- Produces: `echoWords(positionals: Word[]): Result<string[]>`, the same literal check over the positionals `splitFlags` returned instead of over `command.args`.
- Produces: `echoOutput(words: string[], newline: boolean): string`, `words.join(" ")` plus `"\n"` when `newline` is true.
- Both `echoPlan` and `writePlan` call `splitFlags("echo", command, ECHO_FLAGS)`; a failure is their failure. `newline` is `!split.value.plain.includes("n")`.

Why `optionsFirst: true`: bash's echo takes flags only at the front, so `echo hi -n` prints `hi -n`. The table refuses the late flag, the line goes to bash as it does today, and bash prints the right thing. Why no `-e` or `-E`: `-e` turns on escape reading, which the shell-free path does not model.

- [ ] **Step 1: Write the failing tests**

Add rows to `shellFreeEcho`:

```agency
    planDetail("echo -n"),
    planDetail("echo -e x"),
    planDetail("echo hi -n"),
    planDetail("echo -n -n hi"),
```

and change the expectation for the existing `echo -n hi` row from `["bash","",["std::bash"]]` to `["echo","hi",[]]`. New rows expect `["echo","",[]]`, `["bash","",["std::bash"]]`, `["bash","",["std::bash"]]`, `["echo","hi",[]]`. Update the row's description: "A flag other than -n, or a flag after the first word, sends it to bash."

Find the node that checks a shell-free write's payload (grep the test file for `"write"` and `content`) and add a row for `echo -n hi > out.txt` expecting content `"hi"` with the same `dir` and `filename` shape its neighbors use.

Add a parity node beside `shellFreeReadMatchesRealTools`, using its `readParityOf` pattern (plan must be shell-free first, then compare `safeBash` with `bash`):

```agency
def echoParityOf(source: string): any {
  if (planFor(source, FIXTURES).execution.kind != "echo") {
    return "NOT SHELL-FREE: ${source}"
  }
  let ours = ""
  let theirs = ""
  handle {
    const shellFree = safeBash(source, cwd: FIXTURES)
    if (shellFree is success(out)) {
      ours = out
    }
    theirs = bash(source, cwd: FIXTURES).stdout
  } with approve
  if (ours == theirs) {
    return true
  }
  return [source, ours, theirs]
}

node shellFreeEchoMatchesBash() {
  return [
    echoParityOf("echo hi"),
    echoParityOf("echo -n hi"),
    echoParityOf("echo -n"),
    echoParityOf("echo -nn a b"),
    echoParityOf("echo 'a\\tb'"),
  ]
}
```

Expected `[true,true,true,true,true]`.

- [ ] **Step 2: Run to verify they fail**

Run the agency test command into `$SCRATCH/t3.txt`. Expected: `shellFreeEcho` fails on the `echo -n hi` row; `shellFreeEchoMatchesBash` returns `NOT SHELL-FREE` for the `-n` rows.

- [ ] **Step 3: Implement**

`ECHO_FLAGS`, the two signature changes above, and `echoPlan`/`writePlan` reading the split. `flagNames(command)` stays for its other callers; check with grep whether echo was its only caller and delete it if so.

- [ ] **Step 4: `make`, run, verify pass**

`make` then the agency test command. Expected: all nodes pass. Then `pnpm vitest run lib/stdlibCapabilities.test.ts > $SCRATCH/t3b.txt 2>&1` (the allow list of helpers that touch nothing; a new def that reaches `_bashParser` or the host needs a tag or an entry). Expected: pass.

- [ ] **Step 5: Dev doc**

"Outcomes", the `shellFree` paragraph: "a single literal `echo`, with `-n` or without". Under "The read family", the "These are left out" list has an `echo -n` bullet: delete it. In the new "Which shell runs the text" section, one sentence: the shell-free echo models bash's builtin echo, so `-n` is the one flag it takes and `-e` is refused to bash.

- [ ] **Step 6: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json docs/dev/stdlib/safe-bash.md docs/site/stdlib
git commit -F $SCRATCH/c3.txt
```

Message: `safeBash: a lone echo -n runs in process`.

---

### Task 4: Index lines, checks, PR

- [ ] **Step 1: Index lines**

`CLAUDE.md` (this package) and `.claude/skills/agency-stdlib-docs/SKILL.md`: the `safe-bash.md` line gains "which shell runs the text (bash, and a failure with no bash)". `.claude/skills/agency-runtime-docs/SKILL.md` and `CLAUDE.md`: the `host.md` line gains "a shell command runs under bash". Add the two skill files with `git add -f`, each in its own command.

- [ ] **Step 2: Checks**

`pnpm run typecheck`, `pnpm run lint:structure`, prettier on touched `.ts` files, `pnpm vitest run lib/host/node/nodeSubprocess.test.ts lib/stdlib/abortable.test.ts lib/stdlibCapabilities.test.ts`, and the safeBash agency test once more. Save each to a file; every one green before push.

- [ ] **Step 3: Commit and PR**

Commit the index lines. Push the branch. Open a PR with the body in a file: what changes (a table: `echo hi &> f.txt`, `echo -n hi`, `echo 'a\tb'; echo x`, a host with no bash, each before and after), where to look (`spawnCommand`, `ECHO_FLAGS`), and what is left out (`echo -e`; the `exec` tool is unaffected because it spawns a program, not a shell). End with the attribution line the session gave you. Link ADI-248 and ADI-263 in the body. Stop there; the owner merges.
