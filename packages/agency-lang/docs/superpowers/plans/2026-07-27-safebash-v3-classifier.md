# safeBash v3 Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `std::safeBash` so it classifies a bash command, raises the narrowest interrupt that describes it, and then hands the whole command string to bash — instead of substituting Agency functions for commands.

**Architecture:** Parse the string into commands. Classify each one to work out which interrupts it needs. Raise all of them up front. If everything is approved, run the *whole original string* in **one** bash call, so bash does the control flow and produces the output. Two single-command cases never touch a shell: a fully-literal `echo`, and a fully-literal `echo` with a `>`/`>>` redirect.

**Tech Stack:** Agency (`stdlib/*.agency`), TypeScript for the parser shim and property test (`lib/stdlib/*.ts`), tarsec 0.5.3 bash parser, vitest for TS tests, the Agency test runner for `.agency` tests.

**Spec:** `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md`

## Global Constraints

- **No new commands.** The classification table covers exactly what v2 covers: `git status`, `git diff`, `git diff --staged`, `git log`, and `echo`. Do not add `cat`, `ls`, `grep`, `curl`, or anything else.
- **We resolve a variable nowhere.** Not for classification, not for an interrupt payload, not for content. If a value depends on expansion, the string goes to bash.
- **The command word must be a literal.** A `PathWord` command name (`./script.sh`, `/bin/git`) is never classified as a recognized command.
- **Spawning a shell always raises at least one effect.** If classification produced none and we are going to bash, raise `std::bash`.
- **Run `make` before running any `.agency` test.** Changing a stdlib file requires a full build; `pnpm run build` is not enough.
- **Agency test command:** `pnpm run a test <path>` — not `pnpm test:run`, which is the vitest suite.
- **Format before committing:** `pnpm run a fmt -i <file>` on every `.agency` file touched.
- **Never edit `CHANGELOG.md`.**
- **Execute through the non-raising internals.** `bash()` raises `std::bash` itself and `write()` raises `std::write`; calling them after `raiseAll` would ask the question twice and make the narrow path pointless. Use `_bash` (`agency-lang/stdlib-lib/shell.js`) and `_write` (`agency-lang/stdlib-lib/builtins.js`). Bypassing a tool's interrupt is normally forbidden — the reasoning that makes it correct here is in the spec, and it depends on every plan raising at least one effect first.

## File Structure

| File | Responsibility |
|---|---|
| `stdlib/safeBash.agency` | AST types (unchanged), classification, plan assembly, effect raising, execution |
| `stdlib/safeBash/actions.agency` | The plan/action data types and the three executors (`bash`, `echo` content, `write`) |
| `lib/stdlib/safeBash.ts` | Unchanged — re-exports `bashParser` and `astToBash` from tarsec |
| `lib/stdlib/safeBash.test.ts` | **New.** The `astToBash` round-trip property test |
| `tests/agency/safeBash.agency` | Classification tests: string in, plan out |
| `tests/agency/safeBash.test.json` | Expected plans |

---

### Task 1: The refuse wall

**Files:**
- Modify: `stdlib/safeBash.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `SimpleCommand`, `ScriptName`, `FlagWord` (existing types, `stdlib/safeBash.agency:16-130`)
- Produces: `export def isRefused(command: SimpleCommand): boolean`

- [ ] **Step 1: Write the failing test**

Add to `tests/agency/safeBash.agency`:

```ts
import { bashParser, isRefused } from "std::safeBash"

def refusedFor(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const first = parsed.value[0]
  if (first.tag != "simpleCommand") {
    return "NOT-SIMPLE"
  }
  return isRefused(first)
}

node refuseWall() {
  return [
    refusedFor("rm -rf build"),
    refusedFor("/bin/rm -rf build"),
    refusedFor("./rm thing"),
    refusedFor("dd if=a of=b"),
    refusedFor("git clean -fd"),
    refusedFor("git reset --hard"),
    refusedFor("git restore src"),
    refusedFor("git reset HEAD~1"),
    refusedFor("git checkout main"),
    refusedFor("git log reset"),
    refusedFor("git status"),
    refusedFor("echo hi"),
  ]
}
```

Add to `tests/agency/safeBash.test.json` inside `"tests"`:

```json
{
  "nodeName": "refuseWall",
  "description": "Commands we decline to run even with approval, matched by command word and by the last part of a path. Only the destructive spellings of git subcommands are refused, and only in the first argument position.",
  "input": "",
  "expectedOutput": "[true,true,true,true,true,true,true,false,false,false,false,false]",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: FAIL — `isRefused` is not exported from `std::safeBash`.

- [ ] **Step 3: Write the implementation**

Add to `stdlib/safeBash.agency`:

```ts
/** Commands we decline to run even when a human approves. */
static const REFUSED_COMMANDS: string[] = [
  "rm", "rmdir", "dd", "shred", "mkfs", "truncate",
]

/** `git` subcommands that always destroy work. */
static const REFUSED_GIT_ALWAYS: string[] = ["clean", "restore"]

def baseName(text: string): string {
  """
  The last part of a path. `/bin/rm` is `rm`.
  """
  const parts = text.split("/")
  return parts[parts.length - 1]
}

export def isRefused(command: SimpleCommand): boolean {
  """
  True when this command must not run, whatever anyone approves.

  Matches the command word, including the last part of a path, so `rm`,
  `/bin/rm` and `./rm` are all refused.

  This wall is friction against the obvious spelling, not a guarantee.
  `find . -delete` and `xargs rm` get past it and are approvable under
  `std::bash`, which is where the actual control lives.
  """
  const name = command.command
  if (name == null) {
    return false
  }
  const word = baseName(name.text)
  if (REFUSED_COMMANDS.includes(word)) {
    return true
  }
  if (word != "git") {
    return false
  }
  return isDestructiveGit(command)
}

def isDestructiveGit(command: SimpleCommand): boolean {
  """
  The git subcommands that throw work away.

  Only the FIRST argument is the subcommand. `git log reset` is a log,
  not a reset, and matching a subcommand name anywhere in the arguments
  would refuse it.

  `clean` and `restore` are destructive by purpose. `reset` and
  `checkout` are only destructive in particular spellings, and refusing
  the whole subcommand would refuse `git checkout main`, which agents do
  constantly. So those two are matched on the spelling that discards
  work.
  """
  if (command.args.length == 0) {
    return false
  }
  const first = command.args[0]
  if (first.tag != "literal") {
    return false
  }
  if (REFUSED_GIT_ALWAYS.includes(first.text)) {
    return true
  }
  if (first.text == "reset") {
    return hasFlag(command, "--hard")
  }
  if (first.text == "checkout") {
    // `git checkout -- path` and `git checkout .` discard working-tree
    // changes. `git checkout branch` does not.
    if (hasFlag(command, "--")) {
      return true
    }
    return hasLiteralArg(command, ".")
  }
  return false
}

def hasFlag(command: SimpleCommand, name: string): boolean {
  for (arg in command.args) {
    if (arg.tag == "flag" && arg.flagName == name) {
      return true
    }
  }
  return false
}

def hasLiteralArg(command: SimpleCommand, text: string): boolean {
  for (arg in command.args) {
    if (arg.tag == "literal" && arg.text == text) {
      return true
    }
  }
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: add the refuse wall"
```

---

### Task 2: Classify one command into effects

**Files:**
- Modify: `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `isRefused` (Task 1)
- Produces:
  - `export type Effect` — a discriminated union over the five effect names, with a typed payload per name (defined in Step 3)
  - `export type WritePayload = { dir: string; filename: string; content: string; mode: string }`
  - `export type GitDiffPayload = { cwd: string; ref: string; ref2: string; staged: boolean; path: string }`
  - `export def effectsFor(command: SimpleCommand, cwd: string): Result<Effect[]>`
  - A `failure` return means "this command is not recognized" — the caller demotes the whole string to `std::bash`.

- [ ] **Step 1: Write the failing test**

Add to `tests/agency/safeBash.agency`:

```ts
import { effectsFor } from "std::safeBash"

def effectNamesFor(source: string): any {
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    return "UNPARSEABLE"
  }
  const first = parsed.value[0]
  if (first.tag != "simpleCommand") {
    return "NOT-SIMPLE"
  }
  const effects = effectsFor(first, "/repo")
  if (effects is failure(why)) {
    return "UNRECOGNIZED"
  }
  return [e.name for e in effects.value]
}

node classifyOneCommand() {
  return [
    effectNamesFor("git status"),
    effectNamesFor("git diff"),
    effectNamesFor("git diff --staged"),
    effectNamesFor("git log"),
    effectNamesFor("echo hi"),
    effectNamesFor("ls"),
    effectNamesFor("git log --graph"),
    effectNamesFor("$CMD status"),
    effectNamesFor("FOO=1 git status"),
    effectNamesFor("echo -n hi"),
    effectNamesFor("echo \"quoted\""),
  ]
}
```

Add to `tests/agency/safeBash.test.json`:

```json
{
  "nodeName": "classifyOneCommand",
  "description": "Each recognized command contributes its own effects. An unrecognized command, an unknown flag, a non-literal command word and a leading assignment are all unrecognized. In a sequence, echo contributes nothing whatever its arguments, because bash runs it.",
  "input": "",
  "expectedOutput": "[[\"std::git::status\"],[\"std::git::diff\"],[\"std::git::diff\"],[\"std::git::log\"],[],\"UNRECOGNIZED\",\"UNRECOGNIZED\",\"UNRECOGNIZED\",\"UNRECOGNIZED\",[],[]]",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: FAIL — `effectsFor` is not defined.

- [ ] **Step 3: Write the implementation**

Add to `stdlib/safeBash/actions.agency`:

```ts
/** One interrupt a command needs raised before it may run.
 *
 * A discriminated union rather than a bag of `any`: the effect set is
 * closed, so each payload can be typed, and typing them is what makes the
 * raise sites in Task 7 check that every payload satisfies its effect's
 * contract. */
export type Effect =
  | { name: "std::bash" }
  | { name: "std::write"; payload: WritePayload }
  | { name: "std::git::status"; payload: { cwd: string } }
  | { name: "std::git::log"; payload: { cwd: string; ref: string; path: string } }
  | { name: "std::git::diff"; payload: GitDiffPayload }

export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: string
}

export type GitDiffPayload = {
  cwd: string;
  ref: string;
  ref2: string;
  staged: boolean;
  path: string
}
```

If the typechecker fights the union when these are built dynamically —
narrowing on `effect.name` in Task 7 has to work for the payload accesses
to check — fall back to `{ name: string; payload: any }` and record the
deviation in the commit message. Do not spend more than one attempt on it;
the union is an improvement, not a requirement of the design.

Add to `stdlib/safeBash.agency` (import `Effect` from `./safeBash/actions.agency`):

```ts
def literalArgs(command: SimpleCommand): Result<string[]> {
  """
  A command's non-flag arguments as text, but only when every one is a
  plain literal.

  Flags are SKIPPED, not rejected: they are collected separately by
  `flagNames`, and rejecting them here would make `git diff --staged`
  unrecognized before any rule saw it.

  A variable, a quoted string or a path is a failure, because
  classification must never depend on a value we would have to expand or
  interpret ourselves.
  """
  let out: string[] = []
  for (arg in command.args) {
    if (arg.tag == "flag") {
      continue
    }
    if (arg.tag != "literal") {
      return failure("`${arg.tag}` is not a literal argument")
    }
    out.push(arg.text)
  }
  return success(out)
}

def flagNames(command: SimpleCommand): string[] {
  """
  Every flag on the command, in source form (`--staged`, `-n`).
  """
  let out: string[] = []
  for (arg in command.args) {
    if (arg.tag == "flag") {
      out.push(renderFlag(arg))
    }
  }
  return out
}

export def effectsFor(command: SimpleCommand, cwd: string): Result<Effect[]> {
  """
  Which interrupts this one command needs raised.

  A failure means the command is not recognized. The caller turns that
  into a `std::bash` question for the whole string rather than trying to
  ask a narrow question about part of it.

  @param command - One simple command from the parsed AST
  @param cwd - The resolved working directory, for payloads that need it
  """
  const name = command.command
  if (name == null) {
    return failure("an assignment with no command")
  }
  // A path word is never a recognized command: `$CMD` and `./git` must
  // not become git reads. The wall may look at path words, because a
  // wall match can only ever cause a refusal.
  if (name.tag != "literal") {
    return failure("the command word is not a literal")
  }
  // `GIT_DIR=/elsewhere git status` reads a DIFFERENT repository than the
  // payload would claim. Rather than model what each assignment means,
  // any command carrying one is unrecognized; bash applies it correctly
  // and the human sees the whole command.
  if (command.assignments.length > 0) {
    return failure("a leading assignment changes what the command does")
  }
  const args = literalArgs(command)
  if (args is failure(why)) {
    return failure(why)
  }
  const flags = flagNames(command)

  if (name.text == "echo") {
    // `echo` contributes nothing on its own, whatever its arguments. Bash
    // runs it and expands anything in it, so `echo $HOME` and `echo -n hi`
    // are both fine HERE — the flag and literal-argument restrictions
    // belong to the shell-free path in Task 5, which computes the output
    // itself and therefore cannot tolerate either.
    //
    // A string of nothing but echoes still raises `std::bash`, by the
    // audit rule in the caller.
    return success([])
  }

  if (name.text != "git") {
    return failure("no rule for `${name.text}`")
  }
  return gitEffects(args.value, flags, cwd)
}

def gitEffects(args: string[], flags: string[], cwd: string): Result<Effect[]> {
  """
  The four git reads we recognize.

  An unrecognized flag is a failure rather than something to ignore.
  Answering `git log --graph` with a plain `std::git::log` would tell the
  model it asked one question when it asked another.
  """
  if (args.length != 1) {
    return failure("only a bare git subcommand is recognized")
  }
  const sub = args[0]
  if (sub == "status" && flags.length == 0) {
    return success([{ name: "std::git::status", payload: { cwd: cwd } }])
  }
  if (sub == "log" && flags.length == 0) {
    return success([
      { name: "std::git::log", payload: { cwd: cwd, ref: "", path: "" } }
    ])
  }
  if (sub == "diff" && flags.length == 0) {
    return success([
      { name: "std::git::diff", payload: {
        cwd: cwd, ref: "", ref2: "", staged: false, path: ""
      } }
    ])
  }
  if (sub == "diff" && flags.length == 1 && flags[0] == "--staged") {
    return success([
      { name: "std::git::diff", payload: {
        cwd: cwd, ref: "", ref2: "", staged: true, path: ""
      } }
    ])
  }
  return failure("no rule for `git ${sub}`")
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: classify one command into effects"
```

---

### Task 3: Redirects contribute on their own

**Files:**
- Modify: `stdlib/safeBash.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `effectsFor` (Task 2)
- Produces: `effectsFor` now also accounts for redirects. Same signature.

This is the security-critical task. Without it, `echo pwned >> .bashrc; git status` classifies as a git read only, and a policy that approves git reads has approved appending to a shell startup file.

- [ ] **Step 1: Write the failing test**

Add to `tests/agency/safeBash.agency`:

```ts
node redirectsContribute() {
  return [
    effectNamesFor("git status > out.txt"),
    effectNamesFor("echo hi > out.txt"),
    effectNamesFor("echo hi >> out.txt"),
    effectNamesFor("echo hi > $F"),
    effectNamesFor("echo hi < in.txt"),
    effectNamesFor("echo hi 2> err.txt"),
  ]
}
```

Add to `tests/agency/safeBash.test.json`:

```json
{
  "nodeName": "redirectsContribute",
  "description": "A redirect writes a file whatever the verb is, so it contributes std::write independently. A variable target or any other redirect kind is unrecognized.",
  "input": "",
  "expectedOutput": "[[\"std::git::status\",\"std::write\"],[\"std::write\"],[\"std::write\"],\"UNRECOGNIZED\",\"UNRECOGNIZED\",\"UNRECOGNIZED\"]",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: FAIL — redirects are ignored, so `git status > out.txt` returns only `["std::git::status"]`.

- [ ] **Step 3: Write the implementation**

Add to `stdlib/safeBash.agency`:

```ts
def redirectEffect(redirects: Redirect[], cwd: string): Result<Effect[]> {
  """
  What a command's redirects contribute, independently of its verb.

  A redirect writes a file whatever the command is, so it has to be
  accounted for on its own. Without this, `echo pwned >> .bashrc; git
  status` would classify as a git read and ride along under whatever
  approves git reads.

  Anything other than a plain `>` or `>>` to a literal target is a
  failure, which sends the whole string to `std::bash`. An input redirect
  is a read the effect set would otherwise never mention, and a variable
  target cannot fill the payload without expanding it ourselves.
  """
  if (redirects.length == 0) {
    return success([])
  }
  if (redirects.length > 1) {
    return failure("more than one redirect")
  }
  const only = redirects[0]
  if (only.fd != null) {
    return failure("redirect with an explicit file descriptor")
  }
  if (only.op != ">" && only.op != ">>") {
    return failure("`${only.op}` is not an output redirect")
  }
  if (only.target.tag != "literal" && only.target.tag != "path") {
    return failure("the redirect target is not a literal")
  }
  const mode = writeMode(only.op)
  return success([
    { name: "std::write", payload: {
      dir: cwd, filename: only.target.text, content: "", mode: mode
    } }
  ])
}

def writeMode(op: string): string {
  """
  `>` truncates, `>>` appends. A statement rather than an `if` expression,
  because an `if ... then ... else` is only allowed as a variable value or
  a return, not as an object field or a member assignment.
  """
  if (op == ">>") {
    return "append"
  }
  return "overwrite"
}
```

Then in `effectsFor`, compute the redirect contribution first and add it to every return. Replace the body after the `flags` line with:

```ts
  const redirect = redirectEffect(command.redirects, cwd)
  if (redirect is failure(why)) {
    return failure(why)
  }

  if (name.text == "echo") {
    return success(redirect.value)
  }

  if (name.text != "git") {
    return failure("no rule for `${name.text}`")
  }
  const git = gitEffects(args.value, flags, cwd)
  if (git is failure(why)) {
    return failure(why)
  }
  return success([...git.value, ...redirect.value])
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: redirects contribute std::write on their own"
```

---

### Task 4: Assemble the whole-string plan

**Files:**
- Modify: `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `isRefused` (Task 1), `effectsFor` (Tasks 2–3), `resolveCwd` (existing, `stdlib/safeBash.agency:336`)
- Produces:
  - `export type Plan = { effects: Effect[]; execution: Execution }`
  - `export type Execution = { kind: string; command: string; content: string; filename: string; dir: string; reason: string }` — one flat record; `kind` is `"bash"`, `"echo"`, `"write"` or `"refuse"`, and the other fields are filled per kind. A flat record rather than a union because a union of object shapes is awkward to assert on in a test fixture.
  - `export def planFor(source: string, cwd: string): Plan`

- [ ] **Step 1: Write the failing test**

Add to `tests/agency/safeBash.agency`:

```ts
import { planFor } from "std::safeBash"

def planSummary(source: string): any {
  const plan = planFor(source, "/repo")
  return [plan.execution.kind, [e.name for e in plan.effects]]
}

node wholeStringPlans() {
  return [
    planSummary("git status"),
    planSummary("git status; git log"),
    planSummary("git status; ls"),
    planSummary("ls"),
    planSummary("echo hi; echo bye"),
    planSummary("rm -rf build"),
    planSummary("git status; rm -rf build"),
    planSummary("cat a.txt | grep x"),
    planSummary("git status && git log"),
    planSummary("true && rm -rf /tmp/x"),
    planSummary("(git status && git log)"),
    planSummary("git status && ls"),
  ]
}
```

Add to `tests/agency/safeBash.test.json`:

```json
{
  "nodeName": "wholeStringPlans",
  "description": "The whole string gets one plan: refused if any command anywhere is refused, one std::bash if any command is unrecognized, otherwise the union of narrow effects. Chains are walked, so `true && rm -rf /tmp/x` is refused rather than approvable, and `git status && git log` keeps its narrow questions.",
  "input": "",
  "expectedOutput": "[[\"bash\",[\"std::git::status\"]],[\"bash\",[\"std::git::status\",\"std::git::log\"]],[\"bash\",[\"std::bash\"]],[\"bash\",[\"std::bash\"]],[\"bash\",[\"std::bash\"]],[\"refuse\",[]],[\"refuse\",[]],[\"bash\",[\"std::bash\"]],[\"bash\",[\"std::git::status\",\"std::git::log\"]],[\"refuse\",[]],[\"bash\",[\"std::git::status\",\"std::git::log\"]],[\"bash\",[\"std::bash\"]]]",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

Note `git status` alone plans as `kind: "bash"` — the shell-free paths are `echo` only and arrive in Tasks 5 and 6.

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: FAIL — `planFor` is not defined.

- [ ] **Step 3: Write the implementation**

Add to `stdlib/safeBash/actions.agency`:

```ts
/** What happens if every effect in the plan is approved. */
export type Execution = {
  kind: string;
  command: string;
  content: string;
  filename: string;
  dir: string;
  reason: string
}

/** The whole decision about one call to safeBash, made before anything runs. */
export type Plan = {
  effects: Effect[];
  execution: Execution
}
```

Add to `stdlib/safeBash.agency`:

```ts
static const BASH_EFFECT: Effect = { name: "std::bash" }

def emptyExecution(): Execution {
  return { kind: "", command: "", content: "", filename: "", dir: "", reason: "" }
}

def refusePlan(reason: string): Plan {
  let exec = emptyExecution()
  exec.kind = "refuse"
  exec.reason = reason
  return { effects: [], execution: exec }
}

def bashPlan(command: string, effects: Effect[]): Plan {
  let exec = emptyExecution()
  exec.kind = "bash"
  exec.command = command
  // Spawning a shell always raises at least one effect, so a log of
  // effects is a complete audit of shell invocations. A string of nothing
  // but echoes would otherwise raise nothing and still start a shell.
  if (effects.length == 0) {
    return { effects: [BASH_EFFECT], execution: exec }
  }
  return { effects: effects, execution: exec }
}

export def planFor(source: string, cwd: string): Plan {
  """
  Decide everything about a call before any of it happens.

  Parses the string, classifies every command, and works out which
  interrupts to raise and what to run. Nothing here has an effect, which
  is what makes the decision testable: hand in a string, look at the plan.

  @param source - One or more bash commands
  @param cwd - The resolved working directory
  """
  const parsed = bashParser(source)
  if (parsed is failure(why)) {
    // Unparseable: nothing was understood, so ask the broad question and
    // hand bash the text the human will have seen.
    return bashPlan(source, [])
  }
  const commands: Command[] = parsed.value

  // Flatten first. A chain hides its halves inside `and`/`or`/`parens`
  // nodes, and `true && rm -rf /` has no top-level simple command at all —
  // without this walk the wall never sees the `rm` and the string plans as
  // an APPROVABLE std::bash.
  const simple = flatten(commands)

  let narrow: Effect[] = []
  let allRecognized = true
  for (command in simple) {
    if (isRefused(command)) {
      const name = command.command
      if (name == null) {
        return refusePlan("this command is not allowed")
      }
      return refusePlan("`${name.text}` is not allowed")
    }
    const effects = effectsFor(command, cwd)
    if (effects is failure(why)) {
      allRecognized = false
    } else {
      narrow = [...narrow, ...effects.value]
    }
  }

  if (!allRecognized) {
    // We have to ask the broad question anyway, so asking narrow ones
    // first adds prompts without adding information — and a human
    // approving std::bash should see the whole command, not a fragment.
    // The ORIGINAL text runs, because that is what they read.
    return bashPlan(source, [BASH_EFFECT])
  }
  if (narrow.length == 0) {
    // Everything was recognized but nothing contributed an effect — a
    // string of nothing but echoes. The audit rule makes this a std::bash
    // question, so by the same rule it runs the original text.
    return bashPlan(source, [BASH_EFFECT])
  }
  // Narrow questions were asked, so run the tree we classified.
  const rebuilt = rebuild(commands)
  if (rebuilt is failure(why)) {
    return bashPlan(source, [BASH_EFFECT])
  }
  return bashPlan(rebuilt.value, narrow)
}

def flatten(commands: Command[]): SimpleCommand[] {
  """
  Every simple command in the string, including the halves of a chain.

  `a && b` and `a || b` contribute both sides; `( a )` contributes its
  inner command. Used for BOTH the refuse wall and classification, because
  a wall that only looks at the top level is bypassed by two characters,
  and a classifier that only looks at the top level demotes every chained
  invocation to the broad question — and agents chain with `&&`
  constantly.
  """
  let out: SimpleCommand[] = []
  for (command in commands) {
    out = [...out, ...flattenOne(command)]
  }
  return out
}

def flattenOne(command: Command): SimpleCommand[] {
  if (command.tag == "simpleCommand") {
    return [command]
  }
  if (command.tag == "and" || command.tag == "or") {
    return [...flattenOne(command.left), ...flattenOne(command.right)]
  }
  if (command.tag == "parens") {
    return flattenOne(command.command)
  }
  return []
}

def rebuild(commands: Command[]): Result<string> {
  """
  The command string, rendered back from the tree we classified.

  Used only when every command was recognized. We claimed the string is
  `git status`, so we must run what we classified rather than text we only
  assumed matched it. A parser bug then degrades to running what we
  thought we read.

  When the plan is a broad `std::bash` question the caller passes the
  ORIGINAL text instead, because that is what the human read and approved.
  """
  let parts: string[] = []
  for (command in commands) {
    const text = try _astToBash(command)
    if (text is failure(why)) {
      return failure("could not render `${why}`")
    }
    parts.push(text.value)
  }
  return success(parts.join("; "))
}
```

Then make `planFor` handle a render failure **before anything is raised**:

```ts
  // Narrow questions were asked, so run the tree we classified.
  const rebuilt = rebuild(commands)
  if (rebuilt is failure(why)) {
    // We cannot produce the text we classified, so we must not ask narrow
    // questions about it. Demote to the broad question and the original
    // text. Doing this AFTER raising would break the design's first hard
    // rule: a narrow approval must never be followed by text we only
    // assumed matched it.
    return bashPlan(source, [BASH_EFFECT])
  }
  return bashPlan(rebuilt.value, narrow)

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: assemble one plan for the whole string"
```

---

### Task 5: The shell-free echo path

**Files:**
- Modify: `stdlib/safeBash.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `planFor` (Task 4)
- Produces: `planFor` returns `execution.kind == "echo"` with `execution.content` set, for a single fully-literal `echo` with no redirect.

- [ ] **Step 1: Write the failing test**

Add to `tests/agency/safeBash.agency`:

```ts
def planDetail(source: string): any {
  const plan = planFor(source, "/repo")
  return [plan.execution.kind, plan.execution.content, [e.name for e in plan.effects]]
}

node shellFreeEcho() {
  return [
    planDetail("echo hello world"),
    planDetail("echo"),
    planDetail("echo 'a  b'"),
    planDetail("echo $HOME"),
    planDetail("echo -n hi"),
    planDetail("echo hi; echo bye"),
  ]
}
```

Add to `tests/agency/safeBash.test.json`:

```json
{
  "nodeName": "shellFreeEcho",
  "description": "A single fully-literal echo computes its own output and never touches a shell. An expansion, a flag, or a sequence sends it to bash.",
  "input": "",
  "expectedOutput": "[[\"echo\",\"hello world\\n\",[]],[\"echo\",\"\\n\",[]],[\"echo\",\"a  b\\n\",[]],[\"bash\",\"\",[\"std::bash\"]],[\"bash\",\"\",[\"std::bash\"]],[\"bash\",\"\",[\"std::bash\"]]]",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

Note `echo 'a  b'` keeps its two spaces: a single-quoted word is fully literal, and its text is the value between the quotes.

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: FAIL — every case plans as `"bash"`.

- [ ] **Step 3: Write the implementation**

Add to `stdlib/safeBash.agency`:

```ts
def echoWords(command: SimpleCommand): Result<string[]> {
  """
  `echo`'s arguments as text, but only when every one is fully literal.

  A plain word or a single-quoted string qualifies. A variable does not,
  and neither does a double-quoted string containing one: this path never
  invokes a shell, so there is nothing here to expand a variable, and
  expanding it ourselves is where v2's divergence bugs lived.
  """
  let out: string[] = []
  for (arg in command.args) {
    if (arg.tag == "literal" || arg.tag == "path") {
      out.push(arg.text)
    } else if (arg.tag == "singleQuoted") {
      out.push(arg.text)
    } else if (arg.tag == "doubleQuoted") {
      const flat = literalDoubleQuoted(arg)
      if (flat is failure(why)) {
        return failure(why)
      }
      out.push(flat.value)
    } else {
      return failure("`${arg.tag}` is not fully literal")
    }
  }
  return success(out)
}

def literalDoubleQuoted(word: DoubleQuotedWord): Result<string> {
  """
  The text of a double-quoted word, when it contains no expansions.
  """
  let out = ""
  for (part in word.parts) {
    if (part.tag != "literal") {
      return failure("a double-quoted word contains `${part.tag}`")
    }
    out = out + part.text
  }
  return success(out)
}

def echoOutput(words: string[]): string {
  """
  What `echo` prints: its arguments joined by single spaces, then a
  newline. Bare `echo` is still a newline, not nothing.
  """
  return words.join(" ") + "\n"
}

def echoPlan(command: SimpleCommand): Result<Plan> {
  """
  A single `echo` with nothing else in the string and no redirect.

  Nothing here can write a file or reach the network no matter how wrong
  the classifier is, because all it does is build a string. That is the
  one place v2's structural safety was free, and it is worth keeping.
  """
  if (command.redirects.length > 0) {
    return failure("a redirected echo is handled elsewhere")
  }
  if (flagNames(command).length > 0) {
    return failure("`echo` with flags prints differently")
  }
  const words = echoWords(command)
  if (words is failure(why)) {
    return failure(why)
  }
  let exec = emptyExecution()
  exec.kind = "echo"
  exec.content = echoOutput(words.value)
  return success({ effects: [], execution: exec })
}
```

Then in `planFor`, immediately after `const commands: Command[] = parsed.value`, add the single-command check:

```ts
  if (commands.length == 1 && commands[0].tag == "simpleCommand") {
    const only = commands[0]
    if (!isRefused(only) && only.command != null && only.command.tag == "literal" && only.command.text == "echo") {
      const shellFree = echoPlan(only)
      if (shellFree is success(plan)) {
        return plan
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: a single literal echo never touches a shell"
```

---

### Task 6: The shell-free write path

**Files:**
- Modify: `stdlib/safeBash.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `echoWords`, `echoOutput`, `emptyExecution` (Task 5)
- Produces: `planFor` returns `execution.kind == "write"` with `content`, `filename` and `dir` set, and a `std::write` effect whose payload includes `content`.

- [ ] **Step 1: Write the failing test**

Add to `tests/agency/safeBash.agency`:

```ts
def writePlanDetail(source: string): any {
  const plan = planFor(source, "/repo")
  const exec = plan.execution
  return [exec.kind, exec.content, exec.filename, exec.dir, [e.name for e in plan.effects]]
}

node shellFreeWrite() {
  return [
    writePlanDetail("echo hi > out.txt"),
    writePlanDetail("echo hi >> out.txt"),
    writePlanDetail("echo hi > $F"),
    writePlanDetail("echo $HOME > out.txt"),
  ]
}

node writeContentIsInThePayload() {
  // The bytes are in the approval payload BEFORE anyone approves, which
  // is more than v2 managed.
  const plan = planFor("echo hi > out.txt", "/repo")
  return plan.effects[0].payload.content
}
```

Add to `tests/agency/safeBash.test.json`:

```json
{
  "nodeName": "shellFreeWrite",
  "description": "A single literal redirected echo computes its content and writes it, with no shell. A variable in the target or the arguments sends it to bash.",
  "input": "",
  "expectedOutput": "[[\"write\",\"hi\\n\",\"out.txt\",\"/repo\",[\"std::write\"]],[\"write\",\"hi\\n\",\"out.txt\",\"/repo\",[\"std::write\"]],[\"bash\",\"\",\"\",\"\",[\"std::bash\"]],[\"bash\",\"\",\"\",\"\",[\"std::bash\"]]]",
  "evaluationCriteria": [{ "type": "exact" }]
},
{
  "nodeName": "writeContentIsInThePayload",
  "description": "The std::write interrupt carries the bytes, so a policy that inspects what is being written still can.",
  "input": "",
  "expectedOutput": "\"hi\\n\"",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

Note the append case plans the same way; `mode` is carried separately in Task 7's executor via the redirect operator, which `writePlanDetail` does not surface.

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: FAIL — the redirected cases plan as `"bash"`.

- [ ] **Step 3: Write the implementation**

Add to `stdlib/safeBash.agency`. First add a `mode` field to `Execution` in `stdlib/safeBash/actions.agency`:

```ts
export type Execution = {
  kind: string;
  command: string;
  content: string;
  filename: string;
  dir: string;
  mode: string;
  reason: string
}
```

and add `mode: ""` to `emptyExecution`. Then:

```ts
def writePlan(command: SimpleCommand, cwd: string): Result<Plan> {
  """
  A single `echo` redirected to a literal file.

  The content is computed rather than produced by running anything, so no
  shell is spawned and the bytes are in the approval payload before anyone
  approves. An earlier design ran `echo` through bash with the redirect
  stripped and only then asked — a shell spawn with nothing raised before
  it, and an awkward argument about why running before approval was fine.

  If the equivalence claim is good enough to say what `echo` prints, it is
  good enough to say what `echo` writes.
  """
  if (command.redirects.length != 1) {
    return failure("not a single redirect")
  }
  if (flagNames(command).length > 0) {
    return failure("`echo` with flags prints differently")
  }
  const only = command.redirects[0]
  if (only.fd != null) {
    return failure("redirect with an explicit file descriptor")
  }
  if (only.op != ">" && only.op != ">>") {
    return failure("`${only.op}` is not an output redirect")
  }
  if (only.target.tag != "literal" && only.target.tag != "path") {
    return failure("the redirect target is not a literal")
  }
  const words = echoWords(command)
  if (words is failure(why)) {
    return failure(why)
  }
  const content = echoOutput(words.value)

  let exec = emptyExecution()
  exec.kind = "write"
  exec.content = content
  exec.filename = only.target.text
  exec.dir = cwd
  exec.mode = writeMode(only.op)

  const effect: Effect = {
    name: "std::write",
    payload: {
      dir: cwd,
      filename: only.target.text,
      content: content,
      mode: exec.mode
    }
  }
  return success({ effects: [effect], execution: exec })
}
```

Then extend the single-command branch in `planFor` to try `writePlan` when `echoPlan` declines:

```ts
      const shellFree = echoPlan(only)
      if (shellFree is success(plan)) {
        return plan
      }
      const written = writePlan(only, cwd)
      if (written is success(plan)) {
        return plan
      }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: a single redirected echo writes without a shell"
```

---

### Task 7: Raise the effects and execute

**Files:**
- Modify: `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`
- Test: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**
- Consumes: `planFor` (Tasks 4–6)
- Produces: `export def safeBash(command: string, cwd: string = ""): Result<string>` with the new behavior, and `raises <std::bash, std::write, std::git::status, std::git::diff, std::git::log>`

- [ ] **Step 1: Write the failing test**

Replace the old execution tests in `tests/agency/safeBash.agency` with:

```ts
import { safeBash } from "std::safeBash"

node echoRunsWithoutApproval() {
  // The whole point: this raises no interrupt and spawns no shell.
  return safeBash("echo hello world")
}

node unrecognizedAsksForBash() {
  // Rejecting the approval means nothing ran at all.
  const result = safeBash("ls")
  if (result is failure(why)) {
    return "REJECTED"
  }
  return "RAN"
}

node refusedNeverRuns() {
  const result = safeBash("rm -rf build")
  if (result is failure(why)) {
    return why
  }
  return "UNEXPECTEDLY RAN"
}

node exactlyOneQuestion() {
  // The test that actually pins the feature. It APPROVES the narrow
  // question and asserts the command ran. A test that only ever rejects
  // the first interrupt passes whether or not a second `std::bash` prompt
  // would have appeared — which is precisely how calling `bash()` instead
  // of `_bash()` hides itself.
  //
  // The test.json lists exactly one interrupt handler. If execution asks
  // a second question, the harness fails on the unmatched message.
  const result = safeBash("git status")
  if (result is failure(why)) {
    return "FAILED: ${why}"
  }
  return "RAN"
}
```

Add to `tests/agency/safeBash.test.json`:

```json
{
  "nodeName": "echoRunsWithoutApproval",
  "description": "A literal echo returns its text with no interrupt and no shell.",
  "input": "",
  "expectedOutput": "\"hello world\\n\"",
  "evaluationCriteria": [{ "type": "exact" }]
},
{
  "nodeName": "unrecognizedAsksForBash",
  "description": "An unrecognized command asks for std::bash; rejecting it means nothing ran.",
  "input": "",
  "expectedOutput": "\"REJECTED\"",
  "interruptHandlers": [
    { "action": "reject", "expectedMessage": "Are you sure you want to run this shell command?" }
  ],
  "evaluationCriteria": [{ "type": "exact" }]
},
{
  "nodeName": "exactlyOneQuestion",
  "description": "The narrow question REPLACES the broad one. Approving std::git::status runs the command; a second std::bash prompt would fail the run on an unmatched interrupt.",
  "input": "",
  "expectedOutput": "\"RAN\"",
  "interruptHandlers": [
    { "action": "approve", "expectedMessage": "Show git status" }
  ],
  "evaluationCriteria": [{ "type": "exact" }]
},
{
  "nodeName": "refusedNeverRuns",
  "description": "A refused command fails without raising anything, so there is nothing to approve.",
  "input": "",
  "expectedOutput": "\"`rm` is not allowed\"",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -30
```

Expected: FAIL — `safeBash` still has the v2 body.

- [ ] **Step 3: Write the implementation**

Replace `bashAction` in `stdlib/safeBash/actions.agency` with the v3 return contract, and delete `printAction`, `writeAction`'s old signature, `gitStatusAction`, `gitDiffAction`, `gitLogAction`, and the `PrintAction` / `GitAction` / `GitStatusAction` / `GitDiffAction` / `GitLogAction` types:

```ts
export def runBash(command: string, cwd: string): Result<string> {
  """
  Run a command string through bash and return what it printed.

  On success the value is bash's stdout, raw — nothing added, nothing
  stripped. stderr is discarded on success and reported on failure: two
  captured pipes cannot interleave the way a terminal does, so this is a
  policy either way, and discarding on success keeps the value exactly
  equal to bash's stdout.

  A non-zero exit is a failure, which `&&` and `||` require. The known
  cost: `grep` exits 1 when it finds nothing and `diff` exits 1 when files
  differ, and neither is an error, so an agent sees a failure where bash
  would have shown an empty result.
  """
  // `_bash`, NOT `bash`. The `bash` tool raises `std::bash` itself, so
  // calling it here would ask the broad question again — after the human
  // already answered a narrower one — and the entire feature would be a
  // no-op. On the broad path they would be asked twice.
  //
  // Bypassing a tool's interrupt is normally forbidden: handlers are
  // safety infrastructure. It is correct here for one specific reason,
  // and only while that reason holds: the narrow interrupt REPLACES the
  // broad one, and the only path into this function runs through a
  // `raiseAll` that raised every effect in the plan and returned success.
  // Every plan raises at least one effect, so no classification bug can
  // turn into an ungated shell call.
  const result: any = try _bash(command, cwd, 0, "", {})
  if (result is failure(why)) {
    return failure("`${command}` was not run: ${why}")
  }
  const out = truncate(result.stdout)
  if (result.exitCode != 0) {
    return failure(JSON.stringify({
      command: command,
      exitCode: result.exitCode,
      stderr: truncate(result.stderr),
      stdout: out
    }))
  }
  return success(out)
}

def truncate(text: string): string {
  """
  Cap output length. Raw output with no bound is a context-window hazard,
  and a visible loss of fidelity beats an invisible one.
  """
  if (text.length <= MAX_STDOUT_LEN) {
    return text
  }
  return text[:MAX_STDOUT_LEN] + "\n[truncated]"
}

export def runWrite(exec: Execution): Result<string> {
  """
  Perform the write a redirected echo asked for. Returns the empty string,
  which is what bash's stdout for `echo hi > f` is.

  `_write`, NOT `write`, for the same reason `runBash` uses `_bash`: the
  `write` tool raises its own `std::write`, and `raiseAll` already raised
  one carrying the content. Calling the tool would ask twice.
  """
  const written = try _write(exec.dir, exec.filename, exec.content, exec.mode)
  if (written is failure(why)) {
    return failure(why)
  }
  return success("")
}
```

Add these imports to `stdlib/safeBash/actions.agency`, and remove the now-unused `bash` and `write` imports:

```ts
import { _bash } from "agency-lang/stdlib-lib/shell.js"
import { _write } from "agency-lang/stdlib-lib/builtins.js"
```

Then replace `safeBash` in `stdlib/safeBash.agency`:

```ts
export def safeBash(
  command: string,
  cwd: string = "",
): Result<string> raises <std::bash, std::write, std::git::status, std::git::diff, std::git::log> {
  """
  Run a shell command, asking the narrowest question that describes it.

  `bash` cannot be pre-approved, because a command is a string and a
  string could do anything, so every call needs a human. Many of the
  commands an agent writes can be identified, and for those we ask a more
  specific question — one a policy can answer in advance.

  Nothing runs until every question is answered. If everything is
  approved, the whole string goes to bash in one call, so bash does the
  control flow and produces the output.

  @param command - One or more bash commands
  @param cwd - Working directory. Defaults to the agent working directory.
  """
  const dir = resolveCwd(cwd)
  const plan = planFor(command, dir)

  if (plan.execution.kind == "refuse") {
    return failure(plan.execution.reason)
  }

  const raised = raiseAll(plan.effects, command, dir)
  if (raised is failure(why)) {
    return failure(why)
  }

  if (plan.execution.kind == "echo") {
    return success(plan.execution.content)
  }
  if (plan.execution.kind == "write") {
    return runWrite(plan.execution)
  }
  // `planFor` already decided which text to run — rebuilt when it asked
  // narrow questions, original when it asked the broad one. There is no
  // fallback here: choosing the original AFTER raising narrow effects
  // would break the design's first hard rule.
  return runBash(plan.execution.command, dir)
}

def raiseAll(effects: Effect[], fullCommand: string, cwd: string): Result {
  """
  Ask every question the plan needs answered, before anything happens.

  An effect is raised at a named site, not by name-as-data, so this is a
  closed dispatch with one arm per effect. That is also why safeBash
  declares them all in its `raises` clause: it is how an agent author
  discovers which handlers to write.

  Every payload carries the full command string. A human approving a git
  read inside `echo hi; git status` needs to see the whole thing, not the
  fragment.
  """
  for (effect in effects) {
    const why = raiseOne(effect, fullCommand, cwd)
    if (why is failure(reason)) {
      return failure(reason)
    }
  }
  return success(null)
}

def raiseOne(effect: Effect, fullCommand: string, cwd: string): Result {
  if (effect.name == "std::bash") {
    // The contract is `effect std::bash { command, cwd, timeout, stdin }`
    // and payload contracts are enforced at the raise site, so all four
    // fields are required even though we only vary the first two.
    raise std::bash("Are you sure you want to run this shell command?", {
      command: fullCommand,
      cwd: cwd,
      timeout: 0,
      stdin: ""
    })
    return success(null)
  }
  if (effect.name == "std::write") {
    raise std::write("Are you sure you want to write to this file?", {
      dir: effect.payload.dir,
      filename: effect.payload.filename,
      content: effect.payload.content,
      mode: effect.payload.mode,
      command: fullCommand
    })
    return success(null)
  }
  if (effect.name == "std::git::status") {
    raise std::git::status("Show git status", {
      cwd: effect.payload.cwd,
      command: fullCommand
    })
    return success(null)
  }
  if (effect.name == "std::git::log") {
    raise std::git::log("Show git log", {
      cwd: effect.payload.cwd,
      ref: effect.payload.ref,
      path: effect.payload.path,
      command: fullCommand
    })
    return success(null)
  }
  if (effect.name == "std::git::diff") {
    raise std::git::diff("Show git diff", {
      cwd: effect.payload.cwd,
      ref: effect.payload.ref,
      ref2: effect.payload.ref2,
      staged: effect.payload.staged,
      path: effect.payload.path,
      command: fullCommand
    })
    return success(null)
  }
  return failure("no raise site for `${effect.name}`")
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -30
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency
git add stdlib/safeBash.agency stdlib/safeBash/actions.agency tests/agency/safeBash.agency tests/agency/safeBash.test.json
git commit -m "safeBash: raise the plan effects, then run the whole string"
```

---

### Task 8: Delete the v2 machinery

**Files:**
- Modify: `stdlib/safeBash.agency`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new. This task only removes code that is now unreachable.

- [ ] **Step 1: Confirm the current tests pass before deleting**

```bash
make && pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -5
```

Expected: PASS. This is the baseline the deletion must preserve.

- [ ] **Step 2: Delete the runner**

Remove these definitions from `stdlib/safeBash.agency`. Bash does control flow now, so none of them has a caller:

- `runAction`, `runCommand`, `runSimpleCommand`
- `andCommand`, `orCommand`, `parensCommand`
- `joinOutput`, `commandsToStr`, `runCommands`, `failureReport`
- `makeActions`, `actionsFor`, `wrapOne`, `bothSides`
- `makeAction`, `echoAction`, `gitOnly`, `bashFallback`, `echoContent`, `tokenize`

- [ ] **Step 3: Delete the expansion machinery**

Remove from `stdlib/safeBash.agency`:

- `stringifyWord`, `expandVariable`, `stringifyParts`, `hasQuotedPart`, `stringifyArg`
- `simplifyRedirects`, `joinWords` (replaced by `echoOutput`)

Keep `writeDir`'s behavior by folding it into `resolveCwd`, which must
never return `""`: `write` rejects an empty `dir`, and `getAgentCwd()` is
empty whenever nothing set one — which is the case the tests run in.

```ts
def resolveCwd(cwd: string): string {
  """
  Which directory a command runs in: the caller's, or the agent's, or
  here. Never empty — `write` rejects an empty `dir`, so an empty result
  would make every redirected echo fail at write time.
  """
  if (cwd != "") {
    return cwd
  }
  const agent = getAgentCwd()
  if (agent != "") {
    return agent
  }
  return "."
}
```
- the `OutputRedirect` type
- the `env` import from `std::system`, which now has no user

Bash expands variables in the child process, so the word-splitting and empty-value refusals these implemented are not needed and cannot diverge.

- [ ] **Step 4: Verify nothing broke**

```bash
make && pnpm run a tc stdlib/safeBash.agency 2>&1 | tail -10
pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -5
```

Expected: no type errors, all tests still pass. If `tc` reports an unused import or an undefined function, that names something the deletion missed or over-reached.

- [ ] **Step 5: Commit**

```bash
pnpm run a fmt -i stdlib/safeBash.agency
git add stdlib/safeBash.agency
git commit -m "safeBash: delete the runner and the expansion machinery"
```

---

### Task 9: The astToBash round-trip property test

**Files:**
- Create: `lib/stdlib/safeBash.test.ts`

**Interfaces:**
- Consumes: `_bashParser`, `_astToBash` from `lib/stdlib/safeBash.ts`
- Produces: nothing the Agency code uses. This pins a claim the design rests on.

`astToBash` became security-critical in this design: when every command is recognized, bash receives a string rendered from the tree rather than the agent's text. If rendering is lossy, we run something other than what we classified.

- [ ] **Step 1: Write the failing test**

Create `lib/stdlib/safeBash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { _bashParser, _astToBash } from "./safeBash.js";

/** Drop `loc` fields so two trees compare on structure, not on where the
 *  text happened to sit. Rendering re-flows whitespace, so positions
 *  legitimately differ between the original and the re-parsed form. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "loc") continue;
    out[k] = strip(v);
  }
  return out;
}

// Every command family the classifier recognizes, plus the hostile
// quoting cases that would turn one command into two if rendering lost a
// quote.
const CORPUS = [
  "echo hello",
  "echo hello world",
  "echo 'a  b'",
  'echo "a b" c',
  "echo a'b'\"c\"",
  'echo "a; rm -rf /tmp/x"',
  'echo "a\\"b"',
  "echo $HOME",
  'echo "$HOME"/bin',
  "echo hi > out.txt",
  "echo hi >> out.txt",
  'echo hi > "my file.txt"',
  "git status",
  "git log",
  "git diff",
  "git diff --staged",
  "git log --format=oneline",
  "ls -la",
  "cat src/main.ts",
  "git status; git log",
  "git status && git log",
  "git status || git log",
  "(git status && git log)",
];

describe("astToBash round-trips every command family the classifier sees", () => {
  for (const source of CORPUS) {
    it(`round-trips ${JSON.stringify(source)}`, () => {
      const first = _bashParser(source);
      expect(first.success, `corpus entry did not parse: ${source}`).toBe(true);
      if (!first.success) return;

      const rendered = first.result.map((c: unknown) => _astToBash(c)).join("; ");
      const second = _bashParser(rendered);
      expect(second.success, `rendered form did not re-parse: ${rendered}`).toBe(true);
      if (!second.success) return;

      // Compare the TREES, not the rendered strings. A string fixed point
      // passes on exactly the failure this test exists to catch: if
      // rendering lost the quotes, `echo "a; b"` renders to `echo a; b`,
      // which re-parses as TWO commands, which re-render (joined with
      // "; ") to the same string. Green test, one command became two.
      expect(strip(second.result)).toEqual(strip(first.result));

      // Kept only as a readability aid on failure.
      const again = second.result.map((c: unknown) => _astToBash(c)).join("; ");
      expect(again).toBe(rendered);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it runs and passes**

```bash
npx vitest run lib/stdlib/safeBash.test.ts 2>&1 | tail -15
```

Expected: PASS for every entry. A failure here is a real finding — it means the design's rebuilt-string rule is unsound for that command shape, and the classifier must not recognize it until the renderer is fixed.

- [ ] **Step 3: Commit**

```bash
git add lib/stdlib/safeBash.test.ts
git commit -m "safeBash: pin the astToBash round-trip property"
```

---

### Task 10: Documentation and the full sweep

**Files:**
- Modify: `docs/site/stdlib/safeBash.md`, `docs/site/stdlib/safeBash/actions.md` (both regenerated)
- Modify: `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md` (status line only)

- [ ] **Step 1: Regenerate the stdlib documentation**

```bash
make doc
git status --short -- docs/site/stdlib/
```

Expected: `docs/site/stdlib/safeBash.md` and `docs/site/stdlib/safeBash/actions.md` show as modified.

If `make doc` also modifies files unrelated to safeBash — `docs/site/guide/pattern-matching.md` has done this before — revert those with `git checkout --` and mention it. They are pre-existing generator drift, not part of this change.

- [ ] **Step 2: Run every test that touches this module**

```bash
make
pnpm run a test tests/agency/safeBash.agency 2>&1 | tail -5
npx vitest run lib/stdlib/safeBash.test.ts 2>&1 | tail -5
npx vitest run lib/utils/expressionSlots.test.ts 2>&1 | tail -5
pnpm run lint:structure 2>&1 | tail -3
```

Expected: all pass. The third is the walker-completeness tripwire, which fires when a `.agency` file in the corpus uses an AST shape the walker does not reach. This plan adds `match`-free code and array patterns are already ruled on, but run it because a new shape would fail the whole build.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md`, change the Status section's first line from:

```
Design, not yet built.
```

to:

```
Implemented. See `docs/superpowers/plans/2026-07-27-safebash-v3-classifier.md`.
```

- [ ] **Step 4: Audit the diff against the anti-patterns list**

```bash
git diff main...HEAD --stat
```

Read `docs/dev/anti-patterns.md` and check the diff against it. The ones most likely to bite here: comments that restate the code rather than explaining why, and `any` used where a real type would work. The two deliberate `any` uses in this plan — `bash()`'s return, and `Effect.payload` — each have a comment saying why.

- [ ] **Step 5: Commit**

```bash
git add docs/site/stdlib docs/superpowers/specs/2026-07-26-safebash-classifier-design.md
git commit -m "safeBash: regenerate docs and mark the spec implemented"
```

---

## Notes for the implementer

**What is deliberately not in this plan.** No new commands. If you find yourself adding a row for `cat`, `ls`, `grep` or `curl`, stop — that is a separate change with its own effect-signature consequences, because adding a row changes `safeBash`'s public `raises` clause.

**The two rules that carry the safety argument.** If a change seems to require breaking one of these, it is the wrong change:

1. Bash receives a string rendered from the validated tree when we asked narrow questions, and the agent's original text when we asked for `std::bash`. Never the other way round.
2. We resolve a variable nowhere — not for classification, not for a payload, not for content.

**The hole this design closes.** `echo pwned >> .bashrc; git status` must classify as needing `std::write`, not just `std::git::status`. Task 3 is what makes that true. If you refactor `effectsFor`, keep a test that pins it.

**Known gaps that are not bugs.** `grep` and `diff` exit non-zero for ordinary results, and the blanket "non-zero is a failure" rule reports those as failures. Echo-only sequences (`echo a; echo b`) now cost a `std::bash` approval that was free in v2. Both are recorded in the spec as accepted costs.
