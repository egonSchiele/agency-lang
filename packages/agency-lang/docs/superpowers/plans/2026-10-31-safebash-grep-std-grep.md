# safeBash: `grep` and `rg` raise `std::grep` (ADI-242) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bash `grep` or `rg` that safeBash can describe raises the same `std::grep` the grep tool raises, with the payload filled from its flags and path, so the `recommended` policy's read rules approve it under the launch directory and the model's commonest shell habit stops prompting.

**Architecture:** One flag table per verb says which flags stand alone and which consume the next word; one helper, `splitFlags`, turns a command's arguments into recognized flags, their values, and positionals, or a failure for any flag not in the table. `grepEffects` reads that split into the `std::grep` payload: the pattern, the one path resolved the way the grep tool resolves it (a directory gives `dir`, a file gives its parent as `dir` and its name as `file`), and the booleans the grep letters mean. A path is resolved against safeBash's cwd by a new bridge beside `_searchTarget`. `grep` with no path is unrecognized alone and a filter in a later pipeline stage, so the walk that flattens commands now says which stages read stdin. The rule is owned: a `grep` spelling the table rejects asks `std::bash`, never anything else. The rest of safeBash is unchanged: real `grep` still runs through bash, and the narrow question replaces the broad one.

**Tech Stack:** Agency (`stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`), one TypeScript bridge in `lib/stdlib/shell.ts`, vitest, Agency execution tests.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 5 (the `grep`/`rg` row, paths, valued flags, the no-path rule) and the ownership rule in Part 6. Linear: ADI-242. Depends on ADI-238 (merged) and, for the pipeline cases, ADI-241.

## Global Constraints

- Nothing new runs. The grep rule adds an effect to the plan; execution is still one bash call of the rebuilt text, and the executors are reachable only after `raiseAll` succeeds.
- The payload tells the truth: every field of `std::grep` is filled from the command, and a flag the table does not know makes the command unrecognized. The table is an allowlist.
- safeBash never expands anything: a pattern or path that is not a literal word (a variable, an interpolated word) makes the command unrecognized. A glob word as the path is unrecognized in this slice; ADI-247 gives it a meaning.
- The effect declaration travels with an import: `stdlib/safeBash.agency` imports `grep` from `std::shell` so the `raise std::grep(...)` payload contract is enforced, with the same comment the git imports carry.
- `make` after `.agency` changes; `pnpm run build` after `.ts` changes; `pnpm run typecheck`, `pnpm run lint:structure`, prettier on named `.ts` files; absolute paths inside any script; never force-push.
- Test fixtures: `tests/agency/stdlib/grep-fixtures/` already exists (from PR #1309) with `one.txt` containing `hello`; use `__dirname + "/stdlib/grep-fixtures"` from `tests/agency/safeBash.agency`, since the Agency test runner's cwd is not the test file's directory.

## Review Focus

- `grep -rni "foo bar" src`: combined short flags split into letters, and a double-quoted pattern with no variable is a literal. Pinned in Task 3.
- `grep -A 3 foo src`: a valued flag consumes `3`, which must not become the path. Pinned in Task 3.
- `grep -rn foo /etc`: resolves and raises `std::grep` with `dir: "/etc"`; the policy, not safeBash, decides it. Pinned in Task 3 (payload) and Task 4 (policy says propagate).
- `grep -rn foo missing-dir`: the path does not exist; the command is unrecognized (broad), it does not throw out of `planFor`. Pinned in Task 3.
- `grep foo` alone and `grep -rn foo` alone: the first is unrecognized (reads stdin); the second searches `.`. Pinned in Task 3.
- `git status | grep foo`: `grep` with no path as a later stage contributes nothing, and the plan is narrow with the git effect alone. Pinned in Task 3.
- `grep -z foo src` and `grep -rn foo src --exclude-dir=x -o`: the unknown `-z` is unrecognized; the listed long flag and `-o` are fine. Pinned in Task 3.

---

### Task 1: Stages know whether they read stdin

**Files:**
- Modify: `stdlib/safeBash.agency` (`flattenOne`, `flattenCommands`, their callers in `planFor` and `verbNames`)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Produces: `export type Stage = { command: SimpleCommand; readsStdin: boolean }`; `flattenCommands(commands: Command[]): Stage[]` and `flattenOne(command: Command): Stage[]`, where every stage of a pipeline but the first has `readsStdin: true` and every other simple command has `false`; `export def stagesOf(source: string): Result<Stage[]>` (parse, then flatten), for tests and for `safeBash`'s verb list.
- `verbNames` takes `Stage[]`; `isRefused` and `effectsFor` keep taking a `SimpleCommand` (callers pass `stage.command`). `effectsFor` gains a third parameter `readsStdin: boolean`, unused until Task 3.

- [ ] **Step 1: Write the failing test**

```
def stdinFlags(source: string): any {
  const stages = stagesOf(source)
  if (stages is failure(why)) {
    return "UNPARSEABLE"
  }
  return [s.readsStdin for s in stages.value]
}

node stagesReadStdin() {
  return [
    stdinFlags("git status"),
    stdinFlags("a | b | c"),
    stdinFlags("a | b && c"),
    stdinFlags("(a | b) | c"),
    stdinFlags("a; b | c"),
  ]
}
```

`expectedOutput`: `[[false],[false,true,true],[false,true,false],[false,true,true],[false,false,true]]`. For `(a | b) | c`, the group is the first stage of the outer pipeline, so `a` does not read stdin and `b` does; `c` does.

- [ ] **Step 2: Run it to see it fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t1-red.txt 2>&1; grep -n "stagesOf" /tmp/242-t1-red.txt | head -3`
Expected: FAIL, `stagesOf` is not defined in `std::safeBash`.

- [ ] **Step 3: Implement**

`flattenOne` returns `Stage[]`: a simple command is `[{ command, readsStdin: false }]`; `and`, `or`, and `parens` concatenate as today; the `pipeline` arm flattens each stage with `flattenCommands` and marks every stage of the list after the first by setting `readsStdin: true` on each `Stage` the later stages produced (a comprehension over the stage index). `planFor` loops over `Stage`, passing `stage.command` to `isRefused` and `stage.command, cwd, stage.readsStdin` to `effectsFor`. `verbNames` maps `stage.command`. `stagesOf` is `bashParser` then `flattenCommands`.

- [ ] **Step 4: `make`; run the tests to see all pass**

Run: `make > /tmp/242-make1.txt 2>&1; tail -2 /tmp/242-make1.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t1.txt 2>&1; tail -3 /tmp/242-t1.txt`
Expected: every existing case still passes; the new one passes.

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: the flattened command list says which stages read stdin"
```

---

### Task 2: A search target resolved against safeBash's cwd

**Files:**
- Modify: `lib/stdlib/shell.ts` (new `_safeBashSearchTarget` beside `_searchTarget`)
- Test: `lib/stdlib/shell.test.ts`

**Interfaces:**
- Consumes: `_searchTarget(given, tool)` (`lib/stdlib/shell.ts`), `resolveCwdPath` and `expandPath` as `resolveRedirectTarget` uses them (`lib/stdlib/prepareContainedPath.ts`), `TildeMode`.
- Produces: `export async function _safeBashSearchTarget(given: string, cwd: string, tildeMode: TildeMode): Promise<SearchTarget>`: resolves `given` against `cwd` (expanding a leading `~` only when `tildeMode` is `"expand"`), then returns what `_searchTarget(absolute, "grep")` returns. Throws for an empty cwd, a missing path, or a path that is neither file nor directory, with `_searchTarget`'s messages.

- [ ] **Step 1: Write the failing tests**

In `lib/stdlib/shell.test.ts`, a `describe("_safeBashSearchTarget resolves a grep path against a cwd")` using the temp-directory pattern the `_searchTarget` tests in that file already use:

- a relative directory under `cwd` → `{ dir: <real cwd>/sub, file: null }`
- a relative file under `cwd` → `{ dir: <real cwd>/sub, file: "one.txt" }`
- `"."` → `{ dir: <real cwd>, file: null }`
- a missing path → rejects with `/No file or directory at/`
- `"~"`-prefixed path with `"literal"` mode resolves to a directory named `~` under `cwd` (create it) and with `"expand"` mode to the home directory.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run lib/stdlib/shell.test.ts -t safeBashSearchTarget > /tmp/242-t2-red.txt 2>&1; tail -5 /tmp/242-t2-red.txt`

- [ ] **Step 3: Implement, then run to see them pass and `pnpm run build`**

Compose the two existing pieces; no new walking. Run: `pnpm vitest run lib/stdlib/shell.test.ts > /tmp/242-t2.txt 2>&1; tail -3 /tmp/242-t2.txt; pnpm run build > /tmp/242-build.txt 2>&1; tail -1 /tmp/242-build.txt`

- [ ] **Step 4: Commit**

```bash
git add lib/stdlib/shell.ts lib/stdlib/shell.test.ts
git commit -F /tmp/msg.txt   # "shell: a search target resolved against a given cwd"
```

---

### Task 3: The `grep` and `rg` rule

**Files:**
- Modify: `stdlib/safeBash/actions.agency` (`Effect` union, `GrepPayload`)
- Modify: `stdlib/safeBash.agency` (imports, `FlagSpec`, `splitFlags`, `GREP_FLAGS`, `RG_FLAGS`, `grepEffects`, the `effectsFor` arms, `raiseOne`, `safeBash`'s `raises` clause)
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `Stage.readsStdin` through `effectsFor`'s third parameter (Task 1); `_safeBashSearchTarget` (Task 2), imported from `agency-lang/stdlib-lib/shell.js`; `tildeModeFor`, `literalWordText`, `flagNames`, `renderFlag` already in the file.
- Produces, in `actions.agency`:

```
export type GrepPayload = {
  pattern: string;
  dir: string;
  file: string | null;
  flags: string;
  maxResults: number;
  ignoreCase: boolean;
  wholeWord: boolean;
  filesOnly: boolean;
  invert: boolean
}
```

  and `| { name: "std::grep"; payload: GrepPayload }` on `Effect`.

- Produces, in `safeBash.agency`:

```
/** Which flags a verb takes. A plain flag stands alone; a valued flag
 *  consumes the next word. Short letters are listed one per entry, so a
 *  combined `-rn` is checked letter by letter. */
export type FlagSpec = {
  plain: string[];
  valued: string[]
}

export type SplitArgs = {
  plain: string[];
  values: Record<string, string>;
  positionals: Word[]
}

export def splitFlags(command: SimpleCommand, spec: FlagSpec): Result<SplitArgs>
```

  `splitFlags` walks `command.args` in order. A `flag` word is split: `--name` or `--name=value` is one entry; `-abc` is the letters `a`, `b`, `c`. Each entry is looked up in `spec.plain` (added to `plain`) or `spec.valued` (the next word is taken as its value: for a `--name=value` form the value after `=`; for a short letter, the rest of the same word when non-empty (`-m5`), else the following word, which must be a literal, else the result is a failure). An entry in neither list is a failure naming the flag, in the shape ``grep does not take `-z` ``. Every other word is a positional.

  `static const GREP_FLAGS: FlagSpec = { plain: ["n", "r", "R", "i", "w", "l", "v", "E", "F", "P", "c", "h", "H", "o", "s", "--color=never", "--color=auto", "--no-color"], valued: ["e", "m", "A", "B", "C", "--include", "--exclude", "--exclude-dir"] }` and `static const RG_FLAGS: FlagSpec` = the same plus plain `"S"`, `"--no-heading"`, `"--line-number"`, `"--with-filename"`, `"--no-filename"` and valued `"t"`, `"g"`.

  `def grepEffects(command: SimpleCommand, cwd: string, readsStdin: boolean, spec: FlagSpec): Result<Effect[]>`:
  1. `splitFlags`; a failure is returned as is.
  2. The pattern: the `e` value when present, else the first positional, which must be a literal word (`literalWordText`), else failure `"the grep pattern is not literal"`. Positionals after it are paths.
  3. Paths: zero or one. Two or more is failure `"grep with more than one path"` (a later slice may lift this). Zero: if `readsStdin`, return `success([])` (a filter stage); else if `r` or `R` is present, the path is `"."`; else failure `"grep with no path reads stdin"`. A path that is not a literal word (a glob, a variable) is failure `"the grep path is not literal"`.
  4. Resolve: `const target = try _safeBashSearchTarget(pathText, cwd, tildeModeFor(pathWord))`; a failure (missing path) is returned as `failure("${why}")`.
  5. The payload: `pattern`, `dir: target.value.dir`, `file: target.value.file`, `flags: ""` (grep letters are not regex flags; the booleans carry them), `maxResults`: the `m` value as a number or `0`, `ignoreCase: plain includes "i"`, `wholeWord: "w"`, `filesOnly: "l"`, `invert: "v"`. Return `success([{ name: "std::grep", payload }])`.

  In `effectsFor`, the match gains `"grep" => grepEffects(command, cwd, readsStdin, GREP_FLAGS)` and `"rg" => grepEffects(command, cwd, readsStdin, RG_FLAGS)`, with a redirect contribution appended the way the git arm does it.

  In `raiseOne`, a `"std::grep"` arm raises `std::grep("Are you sure you want to search files with grep?", { ...the nine payload fields..., command: fullCommand })`, the message the grep tool uses. `safeBash`'s `raises` clause gains `std::grep`. The import line: `import { grep } from "std::shell"` with the deliberately-unused comment.

- [ ] **Step 1: Write the failing plan tests**

Add to `tests/agency/safeBash.agency` (the file already has `effectNamesFor`, `planSummary`, `planReason`; `planFor` takes the cwd):

```
static const FIXTURES = __dirname + "/stdlib/grep-fixtures"

def grepPayloadOf(source: string): any {
  const plan = planFor(source, FIXTURES)
  for (effect in plan.effects) {
    if (effect.name == "std::grep") {
      return effect.payload
    }
  }
  return "NO GREP EFFECT"
}

def grepNames(source: string): any {
  const plan = planFor(source, FIXTURES)
  return [[e.name for e in plan.effects], plan.broadReason]
}

node grepRecognized() {
  return [
    grepNames("grep -rn hello ."),
    grepNames("grep -n hello one.txt"),
    grepNames("grep -rni \"hello there\" ."),
    grepNames("grep -A 3 hello one.txt"),
    grepNames("grep -rn hello"),
    grepNames("rg -t txt hello ."),
    grepNames("grep -rn hello . --exclude-dir=x -o"),
    grepNames("git status | grep hello"),
  ]
}

node grepUnrecognized() {
  return [
    grepNames("grep hello"),
    grepNames("grep -z hello ."),
    grepNames("grep -rn hello missing-dir"),
    grepNames("grep -rn $PAT ."),
    grepNames("grep -rn hello *.txt"),
    grepNames("grep -rn hello one.txt two.txt"),
    grepNames("grep -rn hello . > out.txt"),
  ]
}

node grepPayloads() {
  const dirSearch = grepPayloadOf("grep -rn hello .")
  const fileSearch = grepPayloadOf("grep -n hello one.txt")
  const flagged = grepPayloadOf("grep -rlwiv -m 5 -e needle .")
  return [
    [dirSearch.file, dirSearch.pattern, dirSearch.ignoreCase, dirSearch.maxResults],
    [fileSearch.file, fileSearch.dir == dirSearch.dir],
    [flagged.pattern, flagged.filesOnly, flagged.wholeWord, flagged.ignoreCase, flagged.invert, flagged.maxResults],
  ]
}
```

`expectedOutput`:

- `grepRecognized`: `[[["std::grep"],null],[["std::grep"],null],[["std::grep"],null],[["std::grep"],null],[["std::grep"],null],[["std::grep"],null],[["std::grep"],null],[["std::git::status"],null]]`
- `grepUnrecognized`: every row `[["std::bash"],{"kind":"unrecognized","detail":...}]` with details, in order: `grep with no path reads stdin`, ``grep does not take `-z` ``, the `_safeBashSearchTarget` message starting `No file or directory at` (use `"type": "contains"` on this node, or assert `kind` only by mapping to `broadReason.kind`; choose the kind-only form and make this node return `[names, broadReason.kind]`), `the grep pattern is not literal`, `the grep path is not literal`, `grep with more than one path`; the last row is `[["std::grep","std::write"],null]` since a redirect on a recognized grep is a write (move it to `grepRecognized`).
- `grepPayloads`: `[[null,"hello",false,0],["one.txt",true],["needle",true,true,true,true,5]]`

- [ ] **Step 2: Run to see them fail**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t3-red.txt 2>&1; grep -n "grepRecognized\|grepUnrecognized\|grepPayloads" -A4 /tmp/242-t3-red.txt | head -30`
Expected: the three nodes fail; every `grep` row is `["std::bash"]` with ``no rule for `grep` ``.

- [ ] **Step 3: Implement** as the Interfaces block says: the two types and `splitFlags`, the two specs, `grepEffects`, the `effectsFor` arms, the `Effect` variant, the `raiseOne` arm, the `raises` clause, the import.

- [ ] **Step 4: `make`; run to see all pass**

Run: `make > /tmp/242-make3.txt 2>&1; tail -2 /tmp/242-make3.txt; AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t3.txt 2>&1; tail -3 /tmp/242-t3.txt`

- [ ] **Step 5: Commit**

```bash
git add stdlib/safeBash/actions.agency stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: grep and rg raise std::grep"
```

---

### Task 4: End to end, and the policy

**Files:**
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `checkPolicy` and `recommendedAutoApprovePolicy` from `std::policy` (the pattern in `lib/agents/agency-agent/tests/readPolicy.agency`), `cwd` from `std::system`.

- [ ] **Step 1: Write the tests**

```
node grepRunsUnderTheNarrowQuestion() {
  // One std::grep approval, then real grep runs through bash and finds
  // the fixture line. A second std::bash prompt would fail the run.
  const result = safeBash("grep -n hello one.txt", cwd: FIXTURES)
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return result.value.includes("hello")
}

node grepUnderRecommendedNeedsNoPrompt() {
  // The launch directory is the package directory, so a grep of the
  // fixtures is inside it and recommended approves std::grep there.
  // No interruptHandlers in the test file: an unanswered interrupt
  // would fail this run.
  const result = handle {
    safeBash("grep -rn hello " + FIXTURES)
  } with (intr) {
    if (checkPolicy(recommendedAutoApprovePolicy, intr).type == "approve") {
      return approve()
    }
    return reject()
  }
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return result.value.includes("hello")
}

node grepOutsideTheLaunchDirPropagates() {
  const plan = planFor("grep -rn root /etc", FIXTURES)
  const effect = plan.effects[0]
  return checkPolicy(recommendedAutoApprovePolicy, { effect: effect.name, data: effect.payload }).type
}
```

`.test.json`: the first with `interruptHandlers: [{ "action": "approve", "expectedMessage": "Are you sure you want to search files with grep?" }]` and `expectedOutput: "true"`; the second with no handlers and `"true"`; the third `"\"propagate\""`. Check `handle` as an expression is the form `docs/dev/language/on-clause-handlers.md` describes; if it is statement-only here, assign inside the block to a `let` declared above it.

- [ ] **Step 2: Run, fix anything the real run turns up, commit**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/safeBash.agency > /tmp/242-t4.txt 2>&1; tail -3 /tmp/242-t4.txt`

```bash
git add tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -F /tmp/msg.txt   # "safeBash: grep runs under the narrow question and under recommended"
```

---

### Task 5: The rejection hint, the docs, the checks

**Files:**
- Modify: `stdlib/safeBash.agency` (`broadExplanation`, a `READ_TOOL_VERBS` constant)
- Modify: `docs/dev/stdlib/safe-bash.md`, `docs/dev/agents/approval-policies.md`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

- [ ] **Step 1: The hint the spec deferred from ADI-238**

`static const READ_TOOL_VERBS = ["grep", "rg"]` (later slices add theirs). When a broad plan is rejected and every entry of `plan.verbs` is in that list, `broadExplanation`'s sentence gains ` The grep, read, and ls tools do not need an approval under the current policy.` Test: `rejectedGrepNamesTheTools` runs `safeBash("grep -z hello .")` with a reject handler for `std::bash` and expects the failure to end with that sentence; `rejectedBroadSaysWhy` (an `xargs` line) must not gain it. Write the test first, watch it fail, then implement.

- [ ] **Step 2: Docs**

`docs/dev/stdlib/safe-bash.md`: a section "The read family: grep and rg" with the flag table shape (`FlagSpec`, plain versus valued, combined letters), the path rule (one literal path, `.` with `-r`, stdin as a later stage), how the path is resolved (`_safeBashSearchTarget`, the same split the tool uses), the payload fields and what fills them, the ownership rule, and the hint. `docs/dev/agents/approval-policies.md`: in "What `recommended` lets the agent read", one paragraph: a `std::grep` rule now also covers a bash `grep` or `rg` safeBash recognized, which spawns a shell to run it, the same way a `std::write` rule covers a redirect.

- [ ] **Step 3: Checks, anti-pattern pass, PR**

Run: `pnpm run typecheck > /tmp/tc.txt 2>&1; tail -2 /tmp/tc.txt; pnpm run lint:structure > /tmp/lint.txt 2>&1; tail -2 /tmp/lint.txt; npx prettier --check lib/stdlib/shell.ts lib/stdlib/shell.test.ts`. Then `/anti-pattern-check` on the diff. Commit the docs with the generated `docs/site/stdlib/safeBash.md` and `actions.md` `make` rewrote. Push and open the PR against `main`, title `safeBash: grep and rg raise std::grep (ADI-242)`, body in a file. The owner merges.
