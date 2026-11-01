# safeBash runs bash, and a lone `echo -n` runs in process (ADI-248, ADI-263)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `{ kind: "shell" }` command the host runs goes to `bash -c`, never `sh -c`, so the text safeBash classified as bash runs as bash; and a lone `echo -n` prints in process, which the shell mismatch was the only reason to refuse.

**Architecture:** `spawnCommand` in the Node host looks `bash` up on the search path and spawns it, or rejects with a message that names bash when it is missing. It also hands bash an environment with the variables removed that would make bash run code the script did not name (`BASH_ENV`, exported functions). Nothing in safeBash's classifier changes for that. The shell-free echo then gains a one-flag table, `ECHO_FLAGS`, read through the existing `splitFlags`, so `-n` drops the trailing newline on both the echo path and the write path.

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

0. `BASH_ENV=/tmp/x.sh` in the environment, or an exported function named `git`. Expected: a narrow `git status` runs git and nothing else. A non-interactive `bash -c` sources the file `BASH_ENV` names before the script, and imports a function from any variable named `BASH_FUNC_<name>%%` (bash 4.3 and later) or `BASH_FUNC_<name>()` (older), which `sh` ignores. Checked on this Mac: `BASH_ENV=benv.sh /bin/bash -c 'echo hi'` prints the script's line first, and `env 'BASH_FUNC_git%%=() { echo FAKE-GIT; }' /bin/bash -c 'git --version'` prints `FAKE-GIT`. A program can put these in the environment through `setEnv`, whose approval says nothing about shells, and a user's own shell can export them. Test in Task 1.
1. A machine with no `bash` on the search path. Expected: `safeBash` returns a failure whose message names bash, and nothing runs under `sh`. Test in Task 1.
2. `echo hi &> out.txt` approved as a broad question. Expected: `out.txt` holds `hi` and stdout is empty, which is what the person who read the text as bash approved. Test in Task 2.
3. `echo 'a\tb'` alone and `echo 'a\tb'; echo x` in a chain. Expected: the same `a\tb` bytes in both, since bash's echo does not read escapes. Test in Task 2.
4. `echo hi -n`. Expected: bash's echo prints `hi -n`; the shell-free path must not treat a trailing `-n` as a flag. The table's `optionsFirst` refuses it to bash, which prints the right thing. Test in Task 3.
5. `echo -n hi > out.txt` written shell-free. Expected: the file holds `hi` with no newline, the same bytes bash would write. Test in Task 3.

---

### Task 1: The Node host spawns bash

**Files:**
- Modify: `lib/host/node/nodeSubprocess.ts` (`spawnCommand`, the `locate` body)
- Modify: `lib/stdlib/abortable.ts` (`abortableShell`: the two `"sh"` labels and its comment)
- Modify: `lib/host/host.ts` (the `Command` type's comment), `lib/stdlib/shell.ts` (the comment above `bashImpl`), `lib/host/node/nodeHost.ts` if the clean-copy loop moves into a shared helper
- Create: `lib/host/node/nodeSubprocess.test.ts`

**Interfaces:**
- Produces: `locateProgramSync(program: string, searchPath: string): string | null` in `nodeSubprocess.ts`: the body of today's `locate` with the search path as an argument and `fs.statSync`/`fs.accessSync` in place of the promises. `nodeSubprocess.locate(program)` becomes a call to it with `process.env.PATH ?? ""`. Synchronous on purpose: `startChild` returns `child` and `kill` at once, and `nodeSubprocess.start` hands `kill` to its caller before `ended` settles, so the spawn cannot wait on a promise. Skip a search-path entry that is not absolute: `path.resolve(".", "bash")` would point into the parent's working directory, which an agent writes into.
- Produces: `shellEnvironment(env: Record<string, string>): Record<string, string>`, a copy with these removed: `BASH_ENV`, `POSIXLY_CORRECT`, `SHELLOPTS`, `BASHOPTS`, `CDPATH`, `GLOBIGNORE`, and every name that starts with `BASH_FUNC_`. The list is one constant, `SHELL_ENV_REMOVED: string[]` for the exact names and `SHELL_ENV_REMOVED_PREFIX = "BASH_FUNC_"`, with a comment per entry: `BASH_ENV` names a file bash sources before the script; `POSIXLY_CORRECT` starts bash in POSIX mode, where macOS bash 3.2 prints `echo -n hi` as `-n hi` and reads backslash escapes (checked: `POSIXLY_CORRECT=1 /bin/bash -c 'echo -n hi'` prints `-n hi`, and `+o posix` on the command line does not undo it); `BASH_FUNC_*` carries an exported function that shadows a program; `BASHOPTS` (bash 4.1 and later read it) could turn on `xpg_echo` and change what `echo` prints; `SHELLOPTS` likewise; `CDPATH` sends `cd target` to `$CDPATH/target` and prints the folder, which ADI-245 will depend on; `GLOBIGNORE` drops names from a glob, which ADI-247 will depend on. `ENV` is not on the list: a non-interactive `bash -c` never reads it (checked, in and out of POSIX mode). Removing `POSIXLY_CORRECT` also means GNU programs in the child stop reading options in POSIX order; that changes nothing in safeBash's plans, because every flag table that cares already sets `optionsFirst`. Say so in the dev doc beside the list.
- The copy is built from `options.env ?? process.env`. `process.env` is not a `Record<string, string>` (its values may be `undefined`), and `nodeHost.ts` already builds a clean copy for `env.all()` by skipping undefined values (`lib/host/node/nodeHost.ts:79-86`). Move that loop into a helper both call, or call the same one; do not write a second copy.
- Produces: for `{ kind: "shell" }`, `spawnCommand` resolves `bash` through `locateProgramSync("bash", env.PATH ?? "")` over that clean copy, and spawns the absolute path with `["-c", script]` and `shellEnvironment(env)` as the child's environment. When bash is not found it throws `new Error("bash was not found on the PATH. safeBash and the bash tool run their commands with bash.")`. `start` is already `async`, so the throw becomes a rejection there; make `run` `async` too (`nodeSubprocess.ts:187` is a plain arrow today), and both reject with no `try`. The `{ kind: "program" }` branch is unchanged, so `exec` and `locate` behave as before.

- [ ] **Step 1: Write the failing tests**

`lib/host/node/nodeSubprocess.test.ts`. Each test makes a temp folder with `fs.mkdtempSync` under `os.tmpdir()` and removes it in a `finally` with `safeDeleteDirectoryWithin(os.tmpdir(), dir)` from `lib/utils.ts` (the repo's anti-patterns doc forbids a bare `rmSync`). Write a small `withTempDir(async (dir) => ...)` helper at the top of the file so each test states only what it checks.

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeSubprocess } from "./nodeSubprocess.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";

const shell = (script: string, options = {}) => nodeSubprocess.run({ kind: "shell", script }, options);

describe("the shell a script runs under", () => {
  it("runs scripts with bash: &> redirects both streams into the file", () =>
    withTempDir(async (dir) => {
      const result = await shell("echo hi &> out.txt", { cwd: dir });
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("hi\n");
    }));

  it("runs scripts with bash: echo -n drops the newline and echo keeps a backslash", async () => {
    expect((await shell("echo -n hi")).stdout).toBe("hi");
    expect((await shell("echo 'a\\tb'")).stdout).toBe("a\\tb\n");
  });

  it("rejects with a message naming bash when the search path has none", () =>
    withTempDir(async (empty) => {
      await expect(shell("echo hi", { env: { PATH: empty } })).rejects.toThrow("bash was not found on the PATH");
    }));

  it("does not source BASH_ENV before the script", () =>
    withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, "env.sh"), "touch sourced\n");
      await shell("echo hi", { cwd: dir, env: { ...process.env, BASH_ENV: path.join(dir, "env.sh") } });
      expect(fs.existsSync(path.join(dir, "sourced"))).toBe(false);
    }));

  it("does not import an exported function that shadows a program", async () => {
    const fake = "() { echo FAKE-GIT; }";
    const env = { ...process.env, "BASH_FUNC_git%%": fake, "BASH_FUNC_git()": fake };
    const result = await shell("git --version", { env });
    expect(result.stdout).toMatch(/^git version/);
  });

  it("ignores POSIXLY_CORRECT: echo -n still drops the newline", async () => {
    const env = { ...process.env, POSIXLY_CORRECT: "1" };
    expect((await shell("echo -n hi", { env })).stdout).toBe("hi");
  });
});
```

Under dash the first test prints `hi` to stdout and leaves `out.txt` empty; under macOS `sh` the second prints `-n hi`. On the owner's machine today `/bin/sh` is bash in POSIX mode, so the first test may pass before the change there; the third, fourth, and fifth fail everywhere before the change (the fourth and fifth because bash does read those variables); the sixth fails on macOS and passes on Linux before the change, because a GNU build of bash keeps `echo -n` in POSIX mode.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run lib/host/node/nodeSubprocess.test.ts > $SCRATCH/t1.txt 2>&1; tail -30 $SCRATCH/t1.txt`
Expected: the third, fourth, and fifth tests fail everywhere; on macOS the sixth fails too; on Linux the first two fail too.

- [ ] **Step 3: Implement**

In `nodeSubprocess.ts`: `locateProgramSync`, `shellEnvironment` with its constants, and the `{ kind: "shell" }` branch of `spawnCommand` as the Interfaces block says. Keep the existing `ENOENT` behavior for `{ kind: "program" }` untouched.

In `abortable.ts`, `abortableShell` passes the string `"sh"` twice (to `spawnResultOf` and to `runCancellable`). Read what each uses it for (a label in failure text) and change both to `"bash"`.

`resolveSpawnCwd` in `lib/stdlib/shell.ts` checks that the working directory exists before anything is spawned, so a missing cwd never reaches `spawnCommand`, and a missing bash rejects with its own message before spawn. The two failures cannot be confused; nothing there changes.

Text that still describes the old shell, to change in this task: the header comment of `lib/host/node/nodeSubprocess.ts` (lines 5-7 say a program that cannot start rejects with Node's own error, now true of a `program` command only); the `Command` type's comment in `lib/host/host.ts` ("a script for the platform's shell" becomes "a script bash runs"); `abortableShell`'s comment in `lib/stdlib/abortable.ts` ("the platform's shell"); and the comment above `bashImpl` in `lib/stdlib/shell.ts` ("routes the command through `sh -c`").

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command. Expected: 6 passed. Then `pnpm vitest run lib/stdlib/abortable.test.ts lib/stdlib/shell.test.ts > $SCRATCH/t1b.txt 2>&1` (if `shell.test.ts` does not exist, run only `abortable.test.ts`). Expected: all pass. Then `pnpm run typecheck && pnpm run lint:structure` and prettier on the three files.

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
- Modify: `tests/integration/stdlib-sandbox/fs.agency` (the comment at lines 18-20 explains `printf` by saying `_bash` uses `sh -c`; say bash, and keep `printf`, which is still the portable spelling)
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
  // lone echo asks nothing; the chain asks std::bash, which is the one
  // question the test file approves. The trailing `true` has no rule, so
  // the chain stays on the bash path even after chains of echoes run in
  // process (the cat-and-chains plan); without it this node would compare
  // the in-process echo with itself.
  const alone = safeBash("echo 'a\\tb'")
  const chain = safeBash("echo 'a\\tb'; echo x; true")
  return [alone, chain]
}

node bashOnlyFormsStayUnparseable() {
  // The parser accepts what bash 3.2 accepts, because macOS ships that
  // version. `|&` and `&>>` are bash 4 forms; 3.2 rejects both with a
  // syntax error, so a parser that accepted them would make a narrow plan
  // fail there. Pinned so a tarsec release cannot widen this unnoticed.
  return [grepNames("make |& tail"), grepNames("echo hi &>> log")]
}
```

Expected for the last node: both `[["std::bash"],{"kind":"unparseable","detail":...}]`, with the parser's exact text pinned from a first run.

`.test.json` rows: `ampersandRedirectWritesTheFile` expects `["", {"value":"hi\n", ...}]`: read what the `read` tool returns (a `Result`), and pin the exact JSON after the first run that fails for the right reason. `interruptHandlers`: one approve for "Are you sure you want to run this shell command?". `echoIsTheSameAloneAndInAChain` expects `[{"success":true,"value":"a\\tb\n"},{"success":true,"value":"a\\tb\nx\n"}]` (check how a `Result` serializes in an existing row and match it), with one approve for the shell question.

The parser accepts `echo hi &> out.txt` as a redirect with op `&>` (checked with tarsec 0.5.6), and `redirectEffect` refuses that op ("`&>` is not an output redirect"), so the line is broad and the one `std::bash` approval is the right handler.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run agency test tests/agency/safeBash.agency > $SCRATCH/t2.txt 2>&1; grep -n "FAIL\|✗\|passed\|failed" $SCRATCH/t2.txt | head`
Expected: on macOS with `/bin/sh` as bash, `ampersandRedirectWritesTheFile` may already pass; `echoIsTheSameAloneAndInAChain` fails because macOS sh in POSIX mode turns `\t` into a tab in the chain. Both must fail or pass for the reason you can name; write the reason in the ledger.

- [ ] **Step 3: Docstrings and dev docs**

`stdlib/shell.agency`: the `bash` tool's docstring sentence becomes "Run a shell command string via bash -c and return its stdout, stderr, and exit code." `stdlib/safeBash/actions.agency`, `runBash`: add "The script runs under bash, found on the search path. When there is no bash the result is a failure that says so; nothing falls back to another shell."

`docs/dev/stdlib/safe-bash.md`: a new section after "In process when it translates" titled "Which shell runs the text", four short paragraphs: the text runs under `bash -c`, found on the search path; why (the parser is a bash parser and the rebuilt text is bash; `sh` is a different program per platform, with `&>`, `echo -n`, braces, and `$'...'` as the forms that differ; a narrow plan must never run under a shell it was not classified for); what happens with no bash (a failure naming it, and the in-process paths still work); and that the parser's accepted subset is what bash 3.2 accepts, since macOS ships that version. No history.

`docs/dev/runtime/host.md`, "The subprocess part": say a `shell` command runs under bash looked up on the search path, with the environment variables that would make bash run unnamed code removed (name them), and that a missing bash rejects with a message naming it. The paragraph's sentence "A program that cannot be started rejects with the platform's error (`ENOENT` on Node)" is now true of a `program` command only; say so in that sentence.

`docs/dev/stdlib/safe-bash.md`, the new section, also names the removed variables and why (`BASH_ENV` sources a file before the script; an exported function shadows a program the payload named).

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
- Modify: `stdlib/safeBash.agency` (`echoPlan`, `writePlan`, `echoWords`, `echoOutput`, `agencyCommandPlan`, new `ECHO_FLAGS`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`
- Modify: `docs/dev/stdlib/safe-bash.md` ("Outcomes", and the `echo -n` bullet under "The read family")

**Interfaces:**
- Produces: `static const ECHO_FLAGS: FlagSpec = { plain: ["n"], valued: [], optionsFirst: true }`.
- Produces: `echoText(command: SimpleCommand): Result<string>`, the one place that says what an echo prints: `splitFlags("echo", command, ECHO_FLAGS)`, then `echoWords` over the split's positionals, then the words joined by single spaces, with a trailing `"\n"` unless the split's `plain` includes `"n"`. Today `echoPlan` and `writePlan` each call `flagNames`, `echoWords`, and `echoOutput` themselves; both now call `echoText` and nothing else about the text, so a change to what echo prints is one edit. `echoWords` takes `words: Word[]`; fold `echoOutput` into `echoText`. `echoWords` has a third caller, `agencyCommandPlan`, which turns an `agency` line's arguments into text; change that call to `echoWords(command.args)`, which keeps today's behavior there (a flag word makes it fail).

A quoted dash is refused, and that is a fix: `echo "-n" hi` plans shell-free today and prints `-n hi` with a newline, but bash strips the quotes, sees the option, and prints `hi` with no newline (checked with `/bin/bash -c 'echo "-n" hi'`). `splitFlags` refuses a quoted word that starts with `-` through `refuseQuotedOption`, so the line goes to bash, which prints the right thing. The cost is `echo hi "-x"`, which is shell-free today and prints `hi -x` in bash; it goes to bash now too. Say both in the dev doc's echo sentence.

Why `optionsFirst: true`: bash's echo takes flags only at the front, so `echo hi -n` prints `hi -n`. The table refuses the late flag, the line goes to bash as it does today, and bash prints the right thing. Why no `-e` or `-E`: `-e` turns on escape reading, which the shell-free path does not model.

- [ ] **Step 1: Write the failing tests**

Add rows to `shellFreeEcho`:

```agency
    planDetail("echo -n"),
    planDetail("echo -e x"),
    planDetail("echo hi -n"),
    planDetail("echo -n -n hi"),
    planDetail("echo \"-n\" hi"),
    planDetail("echo hi \"-x\""),
```

and change the expectation for the existing `echo -n hi` row from `["bash","",["std::bash"]]` to `["echo","hi",[]]`. New rows expect `["echo","",[]]`, `["bash","",["std::bash"]]`, `["bash","",["std::bash"]]`, `["echo","hi",[]]`, `["bash","",["std::bash"]]`, `["bash","",["std::bash"]]`. Update the description: "A flag other than -n, a flag after the first word, or a quoted word that starts with a dash sends it to bash, because bash reads the quoted dash as the option too."

Find the node that checks a shell-free write's payload (grep the test file for `"write"` and `content`) and add a row for `echo -n hi > out.txt` expecting content `"hi"` with the same `dir` and `filename` shape its neighbors use.

Generalize the existing exact parity helper instead of copying it. The test file has two: `parityOf(source)` for grep, which compares sorted lines in `FIXTURES`, and `readParityOf(source)`, which plans in `READ_FIXTURES`, requires `execution.kind == "read"`, and compares exactly. Leave the grep one alone. Rename the second `exactParityOf(source: string, kind: string, cwd: string): any` with the kind and folder as arguments, and fix one hole while renaming: today it sets `ours` only when `safeBash` succeeds, so a row where safeBash fails and the real command prints nothing compares `""` with `""` and passes. Return `"FAILED: ${why}"` when `safeBash` fails. Change the `shellFreeReadMatchesRealTools` rows to `exactParityOf("cat one.txt", "read", READ_FIXTURES)` and so on, and add:

```agency
node shellFreeEchoMatchesBash() {
  return [
    exactParityOf("echo hi", "echo", FIXTURES),
    exactParityOf("echo -n hi", "echo", FIXTURES),
    exactParityOf("echo -n", "echo", FIXTURES),
    exactParityOf("echo -nn a b", "echo", FIXTURES),
    exactParityOf("echo 'a\\tb'", "echo", FIXTURES),
  ]
}
```

The chain plan that follows this one adds `exactParityOf(..., "chain", FIXTURES)` rows through the same helper.

Expected `[true,true,true,true,true]`.

- [ ] **Step 2: Run to verify they fail**

Run the agency test command into `$SCRATCH/t3.txt`. Expected: `shellFreeEcho` fails on the `echo -n hi` row; `shellFreeEchoMatchesBash` returns `NOT SHELL-FREE` for the `-n` rows.

- [ ] **Step 3: Implement**

`ECHO_FLAGS` and `echoText`; `echoPlan` and `writePlan` each become a call to `echoText` plus what they already do with the text; `agencyCommandPlan`'s call becomes `echoWords(command.args)`. `flagNames` stays: `effectsFor` calls it for the git arm.

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

Commit the index lines. Push the branch. Open a PR with the body in a file: what changes (a table: `echo hi &> f.txt`, `echo -n hi`, `echo 'a\tb'; echo x`, `BASH_ENV` set, a host with no bash, each before and after), where to look (`spawnCommand`, `shellEnvironment`, `ECHO_FLAGS`), and what is left out (`echo -e`; `echo hi "-x"` now goes to bash; the `exec` tool is unaffected because it spawns a program, not a shell; the eval grader in `lib/eval/gradersJson/build.ts` spawns `sh -c` on its own, outside the host, and keeps doing so). End with the attribution line the session gave you. Link ADI-248 and ADI-263 in the body. Stop there; the owner merges.
