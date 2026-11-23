# safeBash Globs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only command with a glob in the file-name part of a path asks a narrow question about the folder, so the policy rules users already have answer it with no prompt.

**Architecture:** One helper, `globTargetOf`, splits a glob word into a fixed folder and a name pattern and resolves the folder. The grep rule, the listing rule, and the read rule each call it and ask their usual effect for that folder. Bash still expands the glob. safeBash expands nothing.

The read family puts a glob pattern in a question's `filename`, so one change to the policy matcher (`lib/runtime/policy.ts`) lands before it: a reject rule that names a file must match a pattern that can name that file.

**Tech Stack:** Agency (`stdlib/safeBash.agency`), TypeScript (`lib/runtime/policy.ts`), Agency tests in `tests/agency/`, vitest.

**Spec:** There is no separate spec. The "Background" and "Decisions" sections below record what the owner agreed to on 2026-11-22. The trace that motivated the work is analysed in `docs/superpowers/specs/2026-11-22-safebash-prompts-trace-analysis.md`. An architecture review of this plan is in `docs/superpowers/plans/2026-11-22-safebash-globs-review.md`.

## Background

Read `docs/dev/stdlib/safe-bash.md` before you start. This section repeats only what this plan depends on.

`safeBash` reads a shell line and works out what it will do. When it can describe every command, it asks one narrow question per command, such as `std::grep` for a folder. A policy can answer a narrow question in advance. When it cannot describe a command, it asks `std::bash` about the whole line, and no policy can safely answer that in advance.

Today a glob in a path makes a command impossible to describe:

```bash
grep -rn "origin" lib/runtime/*.ts | head -8
```

The parser returns `lib/runtime/*.ts` as a word with the tag `glob`. `literalWordText` refuses that tag, so `grepCallFor` fails with "the grep path is not literal", and the line asks `std::bash`. In one 97-minute agent session this caused 6 of the 15 broad questions.

After this plan, the same line asks one `std::grep` whose `dir` is the real path of `lib/runtime` and whose `file` is null. That is the question `grep -rn "origin" lib/runtime` asks today. The built-in `recommended` policy approves `std::grep`, `std::ls`, and `std::read` by `dir` for the launch folder, so the user sees no prompt.

## Decisions

The owner made these on 2026-11-22. Do not reopen them.

1. **The question is about the folder.** A glob does not ask about each file it matches, and it does not ask about an extension.
2. **Bash expands the glob.** safeBash does not list the folder or match names. The rule "safeBash never expands a variable or a glob itself" in the dev doc stays true.
3. **The rule covers every command that only reads:** grep, the listing verbs (`ls`, `tree`, `du`, `stat`), and the read family (`cat`, `head`, `wc`, and the rest of `READ_VERBS`).
4. **A glob in the folder part stays broad.** `lib/*/index.ts` asks `std::bash`.
5. **Anything that writes or deletes stays broad.** `rm *.log` asks `std::bash`, as it does today.
6. **No new symlink checks.** A question names the path as written. Do not add a check for a matched name that is a link. Leave the existing link checks alone.
7. **A rule must see a pattern in a question.** A reject or propagate rule matches when the question's pattern can name the rule's file: a reject rule for `secrets.json` matches a read of `*.json`. An approve rule matches only when it covers everything the pattern can name: an approve rule for `settings.json` does not match a read of `*.json`.
8. **The interrupt's shape does not change.** A question does not say whether a field holds a glob or a file with that literal name. A file literally named `*.json` is too unlikely to design for.
9. **A folder search waits.** `grep -rn KEY config` asks with `file: null`, and a reject rule for one file under `config` does not match it. That stays as it is today. It is ticket ADI-364.

### What is not yet confirmed

How the matcher carries out decision 7 without a mark on the question. Task 4 holds the assistant's proposal for it and says so at its top.

## What each command asks

| Command, run in `/proj` | Question |
|---|---|
| `grep -rn hello lib/*.ts` | `std::grep { dir: "/proj/lib", file: null, ... }` |
| `grep -n hello one.txt lib/*.ts` | `std::grep` for `one.txt`, and `std::grep { dir: "/proj/lib", file: null }` |
| `grep -n hello *.ts` | `std::grep { dir: "/proj", file: null }` |
| `ls lib/*.ts` | `std::ls { dir: "/proj/lib", recursive: true, maxResults: 0 }` |
| `cat lib/*.ts` | `std::read { dir: "/proj/lib", filename: "*.ts" }` |
| `grep -n hello lib/*/a.ts` | `std::bash` (decision 4) |
| `grep -n hello lib/.*` | `std::bash` (see "Global Constraints") |
| `grep -n hello ~/*.md` | `std::bash` (see "Global Constraints") |
| `find lib/* -name a.ts` | `std::bash` (find is out of scope) |
| `rm lib/*.ts` | `std::bash` (decision 5) |

### The command that runs

Bash can expand a glob to a name that starts with `-`, and the command would read that name as a flag. In a folder holding `-o`, `a.txt`, and `b.txt`, `sort *` runs as `sort -o a.txt b.txt` and overwrites `a.txt`. So when a path is a glob, safeBash writes `--` before the first path in the command it hands to bash. grep's rule already does this for every grep of paths.

| The model writes | bash runs |
|---|---|
| `ls *.json` | `ls -- *.json` |
| `ls -la lib/*.ts` | `ls -la -- lib/*.ts` |
| `wc -l one.txt lib/*.ts` | `wc -l -- one.txt lib/*.ts` |
| `sort *.txt \| uniq -c` | `sort -- *.txt \| uniq -c` |
| `grep -n TODO *.ts` | `grep -n -e 'TODO' -- *.ts` (as today) |
| `ls src` | `ls src` (no glob, so unchanged) |

A command with no glob runs with exactly the text it runs with today.

A glob listing asks `recursive: true` because `ls lib/*` lists the contents of every subfolder of `lib`, one level below what a plain listing of `lib` shows. The question names more than runs, which is the safe direction.

## Global Constraints

- A glob whose file-name part starts with `.` has no rule. In bash 3.2, which macOS ships, `lib/.*` expands to `lib/.` and `lib/..`, so the command would read the parent folder under a question that names `lib`.
- A glob that starts with `~` has no rule. `tildeModeFor` treats a glob word as literal text, so the folder would resolve to a folder named `~`.
- The folder part must exist and be a folder. A folder that an earlier command in the line will create (`pnpm build && ls dist/*.js` with no `dist` yet) stays broad in this version.
- A read command with a limit on how many files it takes refuses a glob. A glob is one word and bash can expand it to any number of files. `uniq` takes one file because a second is its output file, so `uniq u*.txt` overwrites the second match. The rule is about the limit and names no command. It covers `uniq`, `diff`, `cmp`, `head`, and `tail`.
- A listing or read command with a glob path runs with `--` before its first path (see "The command that runs").
- `find`, `sed -n`, `rm`, `rmdir`, git, `gh`, and redirect targets are not changed. Each still refuses a glob.
- A command with a glob never runs in process. `shellFreeGrepPlan` and `shellFreeReadPlan` must refuse it, so that bash runs it and expands the glob.
- Add no type. `globTargetOf` returns the existing `PathTarget`. The one idea "bash expands this path" has one spelling, a field named `expands`.
- Write new tests in a new file. Do not run `agency fmt` on any existing `.agency` file.
- Run `make` once and the new test file once, at the end (Task 6). Save the test output to a file. Do not run any other Agency test file locally. CI runs them.
- Write every commit message in a file and pass it with `git commit -F <file>`.
- Change files with the Edit and Write tools only.

## Review Focus

Each line is an input the decisions imply and that is easy to get wrong. The task named in brackets owns the test.

1. `grep -n hello lib/.*` must ask `std::bash`, because `.*` matches `..`. [Task 1]
2. `grep -rn hello lib/*` matches `lib/node_modules`. The command that runs must carry the `--exclude-dir` and `--exclude` flags, so grep reads no file the grep tool's search of `lib` would skip. [Task 2, checked end to end in Task 6]
3. A lone `cat lib/*.ts` must run through bash. If it ran in process it would try to read a file named `*.ts`. [Task 5, checked end to end in Task 6]
4. `grep -n hello one.txt lib/*.ts` mixes a fixed path and a glob. It must ask two questions and keep both paths in the command that runs. [Task 2]
5. A glob that matches nothing (`grep -n hello lib/*.zzz`) must still plan narrow. Bash passes the text through and grep prints its own error. [Task 2]
6. `sort *` in a folder that holds a file named `-o` must read that file and write nothing. [Task 3 writes the `--`, checked end to end in Task 6]
7. `uniq lib/*.ts` must ask `std::bash`, because `uniq` writes to its second file. [Task 5]
8. A `std::bash` command that starts with `!`, such as `! grep -q TODO notes.md`, must not be rejected by a reject rule it has nothing to do with. [Task 4]

---

## File Structure

| File | Change |
|---|---|
| `stdlib/safeBash.agency` | Add `globTargetOf`. Call it from `grepCallFor`, `listEffects`, and `readFileVerb`. Add `expands` to `GrepCall` and `ReadPath`. Add `endFlagsBeforeGlob`, which writes `--` before the paths of a listing or read command with a glob. Refuse a glob in `shellFreeGrepPlan` and `shellFreeReadPlan`. |
| `lib/runtime/policy.ts`, `lib/runtime/policy.test.ts` | Task 4: a reject or propagate rule also matches a value that, read as a glob, names the rule's file. |
| `docs/dev/agents/approval-policies.md` | Task 4: the rule, in "Rule matching". |
| `tests/agency/safeBashGlobs.agency` | New. Two test nodes. |
| `tests/agency/safeBashGlobs.test.json` | New. One entry per node, `"type": "exact"`. Copy the entry shape from `tests/agency/safeBashSteps.test.json`. |
| `tests/agency/safeBash.test.json`, `tests/agency/safeBash-corpus.json` | Update the five rows named in Task 6. |
| `docs/dev/stdlib/safe-bash.md` | Document the rule. |

### The test tree

Both test nodes build one tree with a helper in the new test file and remove it before they return. Model the helper on `makeGrepTree` in `tests/agency/safeBash.agency:1720`, and delete the tree with `remove(...) with approve`, as that file does.

```
GLOB_TREE = __dirname + "/stdlib/__safebash_glob_tree__"
GLOB_ROOT = GLOB_TREE + "/tree"

tree/one.txt                      hello
tree/lib/a.ts                     hello
tree/lib/b.ts                     hello
tree/lib/c.js                     hello
tree/lib/.hidden.ts               hello
tree/lib/sub/d.ts                 hello
tree/lib/node_modules/p/x.ts      hello
tree/dash/-o                      dash
tree/dash/a.txt                   keep
tree/dash/b.txt                   z, then y on a second line
```

Create `tree/dash/-o` with a path that starts with `./`, such as `echo dash > ./-o`, so the shell that builds the tree does not read the name as a flag.

Plan-level rows report paths relative to `GLOB_ROOT`, so the expected output holds no absolute path. Write one helper for that:

```
def planRow(source: string): any
```

It returns `[source, outcomeOf(plan), questions]` for `planFor(source, GLOB_ROOT)`. `questions` is one string per effect: the effect name, then the payload's `dir` with the `GLOB_ROOT` prefix removed (`""` for the root itself), then `file` for `std::grep`, `filename` for `std::read`, or `recursive` for `std::ls`, joined with a space. A null `file` prints as `null`. For example `"std::grep /lib null"`, `"std::read /lib *.ts"`, `"std::ls /lib true"`. Any other effect prints as its name alone.

Every plan-level row goes in one node, `globPlans`. Tasks 1, 2, 3, and 5 each add rows to it. The tables in those tasks give each row's command and the two values expected after it.

---

### Task 1: `globTargetOf`

**Files:**
- Modify: `stdlib/safeBash.agency`, next to `resolveTarget` (line 2007)
- Test: `tests/agency/safeBashGlobs.agency`, `tests/agency/safeBashGlobs.test.json`

**Interfaces:**
- Consumes: `resolveTarget(text, word, cwd)`, `literalWordOf(text)`, the existing type `PathTarget { dir, file, argument }`.
- Produces:

```
/* A glob word as the folder bash expands it in: `dir` is that folder's
 real path, `file` the name pattern, and `argument` the word as written.
 Null for a word that is not a glob. */
@capabilities(fileRead)
def globTargetOf(word: Word, cwd: string): Result<PathTarget | null>
```

It takes the working folder and not the whole `LineState`, as `resolveTarget` does, because it never looks at what the line wrote or made.

`globTargetOf` returns `success(null)` for any word whose tag is not `glob`, so a caller falls through to its existing path. For a glob word it returns the target or one of these failures:

| Condition | Failure message |
|---|---|
| The text starts with `~` | ``a glob after `~` has no rule`` |
| The folder part holds `*`, `?`, or `[` | `a glob in the folder part of a path has no rule` |
| The name part starts with `.` | ``a glob that starts with `.` can match `..` `` |
| The folder part does not resolve | the failure `resolveTarget` returned |
| The folder part resolves to a file | `the folder of a glob is a file` |

The folder part is the text before the last `/`. It is `.` when the text has no `/`, and `/` when the only `/` is the first character. The name part is the text after the last `/`. Resolve the folder part with `resolveTarget(folderText, literalWordOf(folderText), cwd)`.

- [ ] **Step 1: Create the test file with `makeGlobTree`, `planRow`, and the node `globPlans`, holding these rows**

`globTargetOf` is private, so each row goes through grep. Task 2 makes the first three rows pass.

| Command | Outcome | Questions |
|---|---|---|
| `grep -n hello lib/*.ts \| wc -l` | `narrow` | `["std::grep /lib null"]` |
| `grep -n hello *.txt \| wc -l` | `narrow` | `["std::grep  null"]` |
| `grep -n hello lib/[ab].ts \| wc -l` | `narrow` | `["std::grep /lib null"]` |
| `grep -n hello lib/*/d.ts \| wc -l` | `broad` | `["std::bash"]` |
| `grep -n hello lib/.* \| wc -l` | `broad` | `["std::bash"]` |
| `grep -n hello ~/*.md \| wc -l` | `broad` | `["std::bash"]` |
| `grep -n hello nope/*.ts \| wc -l` | `broad` | `["std::bash"]` |
| `grep -n hello one.txt/*.ts \| wc -l` | `broad` | `["std::bash"]` |

- [ ] **Step 2: Add `globTargetOf` to `stdlib/safeBash.agency`**

- [ ] **Step 3: Commit**

Message: `safeBash: split a glob word into a folder and a name pattern`

---

### Task 2: grep

**Files:**
- Modify: `stdlib/safeBash.agency`: `GrepCall` (line 1227), `grepCallFor` (1326), `searchHere` (1370), `grepSearchRule` (1473), `shellFreeGrepPlan` (1605)
- Test: `tests/agency/safeBashGlobs.agency`, `tests/agency/safeBashGlobs.test.json`

**Interfaces:**
- Consumes: `globTargetOf` from Task 1.
- Produces: `GrepCall` gains one field.

```
  /** True when the path word is a glob that bash expands. The target is
   then the folder the glob is in, with `file` null. */
  expands: boolean
```

- [ ] **Step 1: Add these rows to `globPlans`**

| Command | Outcome | Questions |
|---|---|---|
| `grep -rn hello lib/*.ts \| wc -l` | `narrow` | `["std::grep /lib null"]` |
| `grep -n hello one.txt lib/*.ts \| wc -l` | `narrow` | `["std::grep  one.txt","std::grep /lib null"]` |
| `grep -n hello lib/*.zzz \| wc -l` | `narrow` | `["std::grep /lib null"]` |
| `grep -n hello lib/*.ts` | `narrow` | `["std::grep /lib null"]` |

The last row is a lone grep with flags the in-process search supports. It must be `narrow` and not `shellFree`.

Add two rows that return the text bash runs. Copy `executionCommandIn` from `tests/agency/safeBash.agency:2636` into the new file.

| Command | Text that runs |
|---|---|
| `grep -n hello one.txt lib/*.ts \| wc -l` | `grep -n -e 'hello' -- one.txt lib/*.ts \| wc -l` |
| `grep -rn hello lib/* \| wc -l` | `grep -r -n --exclude-dir=node_modules --exclude=node_modules --exclude-dir=.git --exclude=.git --exclude-dir=dist --exclude=dist --exclude-dir=build --exclude=build --exclude-dir=.next --exclude=.next --exclude-dir=.cache --exclude=.cache -e 'hello' -- lib/* \| wc -l` |

- [ ] **Step 2: Set `expands: false` in every place that builds a `GrepCall`**

`grepCallFor` has three and `searchHere` has one.

- [ ] **Step 3: Call `globTargetOf` at the top of `grepCallFor`**

Before the `literalWordText` call, ask `globTargetOf(pathWord, line.cwd)`. Return its failure. When it returns a target, return this call:

```
{
  split: args,
  pattern: pattern,
  target: { dir: glob.dir, file: null, argument: glob.argument },
  saved: null,
  word: pathWord,
  expands: true
}
```

- [ ] **Step 4: Change the folder branch of `grepSearchRule`**

Inside `if (call.target.file == null)`, a call with `expands` true skips both existing checks: the "grep without -r does not search a folder" failure and the skip-name refusal. It sets `searchesFolder` to true only when the flags include `r`. A call with `expands` false behaves as it does today.

The skip-name refusal does not apply because the question names the folder the glob is in, and the grep tool searches a folder it is given. The excludes still apply to what the glob matches: GNU grep, BSD grep, and ugrep all skip a folder named `node_modules` that a glob put on the command line under `-r`. That was checked by hand on macOS for BSD grep 2.6.0 and ugrep 7.8.4.

- [ ] **Step 5: Refuse a glob in `shellFreeGrepPlan`**

First statement: when `call.expands` is true, return `failure("bash expands the grep path")`.

- [ ] **Step 6: Commit**

Message: `safeBash: a grep of a glob asks std::grep for the folder`

---

### Task 3: listings

**Files:**
- Modify: `stdlib/safeBash.agency`: `listEffects` (line 2394)
- Test: `tests/agency/safeBashGlobs.agency`, `tests/agency/safeBashGlobs.test.json`

**Interfaces:**
- Consumes: `globTargetOf` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add these rows to `globPlans`**

| Command | Outcome | Questions |
|---|---|---|
| `ls lib/*.ts` | `narrow` | `["std::ls /lib true"]` |
| `ls -la lib/*.ts \| head -3` | `narrow` | `["std::ls /lib true"]` |
| `ls lib lib/*.ts` | `narrow` | `["std::ls /lib true"]` |
| `du -sh lib/*` | `narrow` | `["std::ls /lib true"]` |
| `tree lib/*` | `narrow` | `["std::ls /lib true"]` |
| `ls lib/*/d.ts` | `broad` | `["std::bash"]` |
| `find lib/* -name d.ts` | `broad` | `["std::bash"]` |

The third row has a fixed path and a glob for the same folder. `mergeListings` joins them into one question and keeps `recursive: true`.

- [ ] **Step 2: Handle glob words in `listEffects`**

Replace the `resolveTargets` call and the loop after it with one loop over `words`. For each word, ask `globTargetOf(word, line.cwd)` and return a failure. A glob contributes the payload `{ dir: glob.dir, recursive: true, maxResults: 0 }`. Any other word goes through what `resolveTargets` does for one word: `literalWordText`, with the failure "the ${verb} path is not literal", then `listTargetOf(text, word, lookup)`, then `listingOf`. The payloads go through `mergeListings` in the order the loop produced them.

Do not change `resolveTargets`. `find` calls it too, and `find` keeps refusing a glob.

- [ ] **Step 3: Write `--` before the paths of a command with a glob**

Add this function next to `withAssignments` (line 499):

```
/* A listing or read command with a glob path, with `--` before its first
 path, so a name bash expands the glob to is never read as a flag. Any
 other command is returned as it is. */
def endFlagsBeforeGlob(verb: string, command: SimpleCommand): SimpleCommand
```

It returns `command` unchanged when no word in `command.args` has the tag `glob`, or when `verb` has no row in `LIST_VERBS` or `READ_VERBS`. Otherwise it calls `splitFlags(verb, command, <the row's flags>)`, which has already succeeded once for this command, and returns the command with `END_OF_FLAGS_WORD` inserted before the last `positionals.length` words of `args`. Those tables all set `optionsFirst`, so the paths are always the last words.

Call it in the last statement of `simpleCommandRule` (line 451): `command: endFlagsBeforeGlob(name.text, command)`.

Add these rows to `globPlans`, using `executionCommandIn`:

| Command | Text that runs |
|---|---|
| `ls -la lib/*.ts` | `ls -la -- lib/*.ts` |
| `ls *.txt` | `ls -- *.txt` |
| `ls lib` | `ls lib` |
| `pytest lib/*.ts` | `pytest lib/*.ts` |

The last row is a program with no rule. It asks `std::exec`, whose approval already covers whatever the program does, and its text is unchanged.

- [ ] **Step 4: Commit**

Message: `safeBash: a listing of a glob asks std::ls for the folder`

---

### Task 4: a reject rule sees a pattern

> **Status: proposed, not yet confirmed by the owner.** The owner agreed to the two tests in "Decisions" 7. How the matcher carries them out, written below, is the assistant's proposal. Confirm it with the owner before building this task. Tasks 1 to 3 do not depend on it.

**Files:**
- Modify: `lib/runtime/policy.ts`: `matchesRule` (line 225), `matchesField` (242), `matchesScalar` (259)
- Test: `lib/runtime/policy.test.ts`
- Modify: `docs/dev/agents/approval-policies.md`, section "Rule matching"

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new export. `checkPolicy` keeps its signature.

Background: a question's field can hold a glob. After Task 5, `cat config/*.json` asks `std::read { dir: ".../config", filename: "*.json" }`. Today the matcher asks one thing of a scalar field: does the rule's pattern match the value, read as plain text? A reject rule for `secrets.json` does not match the text `*.json`, so a later approve rule answers, and `cat` prints `secrets.json`.

The rule after this task: **a reject or propagate rule matches a scalar field when today's test passes, or when the rule's pattern, read as plain text, matches the value read as a glob.** An approve rule is matched as it is today.

| Rule | Value | Today | After | Why |
|---|---|---|---|---|
| reject `secrets.json` | `*.json` | no match | match | the value, as a glob, names the rule's file |
| reject `secrets.json` | `*.ts` | no match | no match | it cannot name it |
| reject `secrets.json` | `notes.json` | no match | no match | a plain value is a glob that names only itself |
| reject `.env` | `*` | no match | no match | a `*` skips a name that starts with a dot, in bash and in picomatch |
| approve `settings.json` | `*.json` | no match | no match | unchanged |
| approve `*.json` | `*.json` | match | match | unchanged |

Each "Today" and "After" value was checked against picomatch with `dot: false`.

The rule names no effect and no field. It applies to every scalar field of every question. It can only make a reject or propagate rule match more often.

Known limits, each accepted:

- A file that is literally named `*.json` is treated as the glob. The owner called that case too unlikely to design for.
- A file literally named `[id].tsx` is read as a glob that names `i.tsx` and `d.tsx`, so a reject rule for `d.tsx` would match a read of it.
- When the rule and the value are both globs, the rule may fail to match. A rule for `secret*` does not match the value `*.json`, though both can name `secret.json`. A rule for `*.pem` does match the value `*`, because the text `*.pem` is a name that `*` matches.
- An approve rule for `?.json` matches the value `*.json` today, because the text `*.json` is five characters after one. This task does not change approve rules.

- [ ] **Step 1: Write the failing tests in `lib/runtime/policy.test.ts`**

Add `describe("a reject rule and a value that is a glob", ...)` with one test per row of the table above, using `checkPolicy` on a policy of the form:

```ts
{ "std::read": [
  { match: { dir: "/proj/config", filename: "secrets.json" }, action: "reject" },
  { match: { dir: "/proj/config" }, action: "approve" },
] }
```

Assert `{ type: "reject" }` for the first row and `{ type: "approve" }` for rows two to four. Add one test with `action: "propagate"` in place of `"reject"` and the value `*.json`, expecting `{ type: "propagate" }`. Add one test for a list field: a reject rule with `paths: "secrets.json"` and the value `["*.json"]` still does not match, because this task changes scalar fields only.

The value is read as a bash glob, and picomatch's own syntax is wider than that. Add a test for each difference, all against the reject rule for `secrets.json` and all expecting `{ type: "approve" }`:

- the value `!notes.md`. picomatch reads a leading `!` as "anything except".
- the value `{a,secrets}.json`. picomatch reads braces as a choice, and a bash glob has no such form.
- a value of 70,000 characters. picomatch throws on input longer than 65,536, and `checkPolicy` must not throw.

Add one test for Review Focus 8: with the policy `{ "std::bash": [{ match: { command: "*rm -rf*" }, action: "reject" }] }`, the command `! grep -q TODO notes.md && echo none` gets `{ type: "propagate" }` from `checkPolicy`, as it does today.

Add one test that the rule's `matchDotFolders: true` does not change the second test: a reject rule for `.env` with that flag does not match the value `*`.

- [ ] **Step 2: Run them and see the first and the propagate test fail**

Run: `pnpm exec vitest run lib/runtime/policy.test.ts > $LOGS/policy-test.log 2>&1; echo "exit=$?"`
Expected: `exit=1`, with those two tests failing.

- [ ] **Step 3: Add the second test to the matcher**

`matchesRule` passes the rule's action down to `matchesScalar`. For an action other than `approve`, `matchesScalar` returns true when its existing result is true, or when the second test passes. Write the second test as its own function:

```ts
/** Whether `value`, read as a bash 3.2 glob, names the text `name`. */
function globNames(value: string, name: string): boolean
```

It returns false when `value` is longer than `MAX_PATTERN_LENGTH`. Otherwise it returns `picomatch.isMatch(name, value, BASH_GLOB)`, where:

```ts
const BASH_GLOB = { dot: false, nonegate: true, nobrace: true, noextglob: true, noglobstar: true };
```

Call it with `stripDotSlash` on both sides and with the rule's raw pattern as `name`. Do not apply the `.` or placeholder substitutions, and do not pass the rule's `matchDotFolders`: that flag says what the rule's own globs match, and bash's `*` never matches a leading dot.

- [ ] **Step 4: Run the tests again**

Run the command from Step 2. Expected: `exit=0`.

- [ ] **Step 5: Typecheck and format**

Run: `pnpm run typecheck > $LOGS/typecheck.log 2>&1; echo "exit=$?"` and `pnpm exec prettier --write lib/runtime/policy.ts lib/runtime/policy.test.ts`
Expected: `exit=0`.

- [ ] **Step 6: Update "Rule matching" in `docs/dev/agents/approval-policies.md`**

Add the rule in one paragraph, the table above, and the four limits. The section's opening says which comparison applies "depends on the shape of the value and the shape of the pattern, and on nothing else" (line 983). Change that sentence to say it also depends on the rule's action for a scalar value, and add a row for it to the table under it.

- [ ] **Step 7: Commit**

Message: `policy: a reject rule matches a value that is a glob naming its file`

---

### Task 5: the read family

**Depends on Task 4.** Without it, a reject rule that names a file does not see a read of a glob.

**Files:**
- Modify: `stdlib/safeBash.agency`: `ReadPath` (line 1809), `resolveReadPath` (1967), `readFileVerb` (2513), `shellFreeReadPlan` (4369)
- Test: `tests/agency/safeBashGlobs.agency`, `tests/agency/safeBashGlobs.test.json`

**Interfaces:**
- Consumes: `globTargetOf` from Task 1.
- Produces: `ReadPath` gains one field, with the same name and meaning as `GrepCall`'s.

```
  /** True when the path word is a glob that bash expands. The source's
   `filename` is then the name pattern, and no file has that name. */
  expands: boolean
```

- [ ] **Step 1: Add these rows to `globPlans`**

| Command | Outcome | Questions |
|---|---|---|
| `cat lib/*.ts` | `narrow` | `["std::read /lib *.ts"]` |
| `wc -l lib/*.ts one.txt` | `narrow` | `["std::read /lib *.ts","std::read  one.txt"]` |
| `sort lib/*.ts \| uniq -c` | `narrow` | `["std::read /lib *.ts"]` |
| `cat *.txt` | `narrow` | `["std::read  *.txt"]` |
| `head -5 lib/*.ts` | `broad` | `["std::bash"]` |
| `uniq lib/*.ts` | `broad` | `["std::bash"]` |
| `diff one.txt lib/*.ts` | `broad` | `["std::bash"]` |
| `cat lib/*/d.ts` | `broad` | `["std::bash"]` |
| `sed -n 1,5p lib/*.ts` | `broad` | `["std::bash"]` |
| `rm lib/*.ts` | `broad` | `["std::bash"]` |

The first row is a lone `cat`. It must be `narrow` and not `shellFree`.

Add one row with `executionCommandIn`: `wc -l one.txt lib/*.ts` runs as `wc -l -- one.txt lib/*.ts`. Task 3 wrote the function that adds the `--`.

- [ ] **Step 2: Set `expands: false` in the three places `resolveReadPath` builds a `ReadPath`**

- [ ] **Step 3: Call `globTargetOf` in `readFileVerb`**

In the loop over `positionals`, before `literalWordText`, ask `globTargetOf(word, lookup.cwd)`. Return its failure.

When the word is a glob and `spec.paths.most` is not null, return this failure:

```
a glob can name any number of files, and `${verb}` takes ${describeCount(spec.paths, "path")}
```

The check reads the range and names no verb. Today it covers `uniq`, `diff`, `cmp`, `head`, and `tail`.

Otherwise the target becomes this `ReadPath`:

```
{ source: { kind: "disk", dir: glob.dir, filename: glob.file }, argument: glob.argument, expands: true }
```

- [ ] **Step 4: Refuse a glob in `shellFreeReadPlan`**

First statement: when any path has `expands` true, return `failure("bash expands the read path")`. This is the only reader that opens the files a `ReadPath` names. The others build payloads from it.

- [ ] **Step 5: Commit**

Message: `safeBash: a read of a glob asks std::read for the folder`

---

### Task 6: run it end to end, update the old rows, and document it

**Files:**
- Test: `tests/agency/safeBashGlobs.agency`, `tests/agency/safeBashGlobs.test.json`
- Modify: `tests/agency/safeBash.test.json`, `tests/agency/safeBash-corpus.json`
- Modify: `docs/dev/stdlib/safe-bash.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the test node `globsRunUnderTheFolderQuestion`**

Write a helper `runApproving(source: string, effect: string): string`. It calls `safeBash(source, cwd: GLOB_ROOT)` inside a handler that approves only `effect` and rejects everything else, and returns the output with its lines sorted and joined with `\n`, or `"FAILED"`. The sort is there because ugrep, which some machines have as `grep`, does not promise an order across files. Model it on `grepOnly` in `tests/agency/safeBash.agency:1782`.

| Call | Returns |
|---|---|
| `runApproving("grep -n hello lib/*.ts", "std::grep")` | `lib/a.ts:1:hello\nlib/b.ts:1:hello` |
| `runApproving("grep -rn hello lib/*", "std::grep")` | `lib/a.ts:1:hello\nlib/b.ts:1:hello\nlib/c.js:1:hello\nlib/sub/d.ts:1:hello` |
| `runApproving("ls lib/*.ts", "std::ls")` | `lib/a.ts\nlib/b.ts` |
| `runApproving("cat lib/*.ts", "std::read")` | `hello\nhello` |
| `runApproving("uniq lib/*.ts", "std::read")` | `FAILED` |

Add one row for Review Focus 6. It runs in `tree/dash`, so write a second helper that takes the folder, or give `runApproving` a `cwd` argument. The row returns two values: what `sort *` printed, and what `a.txt` holds afterward, read with the `read` tool.

| Call, in `tree/dash` | Returns |
|---|---|
| `sort *` approving `std::read`, then the contents of `a.txt` | `["dash\nkeep\ny\nz", "keep"]` |

Without the `--` from Task 3, bash runs `sort -o a.txt b.txt`, prints nothing, and `a.txt` holds `y` and `z`.

The second row proves Review Focus 2: `lib/node_modules/p/x.ts` holds `hello` and is not in the output. `lib/.hidden.ts` is in none of the rows, because bash's `*` skips a name that starts with a dot. The fourth row proves Review Focus 3.

- [ ] **Step 2: Update the five existing rows that hold a glob**

Each plans in a real folder, so its result changes. Work out each new value by reading the row's helper, and change only that row's part of the expected output.

| Row | Today | After |
|---|---|---|
| `tests/agency/safeBash.agency:1490`, `grepNames("grep -rn hello *.txt")` | `std::bash`, "the grep path is not literal" | `[["std::grep"], null]` |
| `tests/agency/safeBash.agency:2723`, `grepNames("ls *.txt")` | `std::bash`, "the ls path is not literal" | `[["std::ls"], null]` |
| `tests/agency/safeBash.agency:1870`, `readOf("cat *.txt")` | "the cat path is not literal" | what `readOf` returns for a read of the one name `*.txt` |
| `tests/agency/safeBash-corpus.json:33`, `ls *.json` | `broad`, `["std::bash"]` | `narrow`, `["std::ls"]` |
| `tests/agency/safeBash-corpus.json:38`, `wc -l stdlib/*.agency` | `broad`, `["std::bash"]` | `narrow`, `["std::read"]` |

The corpus test plans in the package folder (`tests/agency/safeBash-corpus.agency:9`), which holds `stdlib` and `.json` files, so both corpus rows change. Update the descriptions in `safeBash.test.json` that say a path that is not literal asks `std::bash`, where a glob was the example.

- [ ] **Step 3: Build**

The two commands below write their logs to `$LOGS`. Set it to a scratch folder outside the repository first.

Run: `make > $LOGS/make.log 2>&1; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 4: Run the new test file**

Run: `pnpm run agency test tests/agency/safeBashGlobs.agency --check-capabilities > $LOGS/globs-test.log 2>&1; echo "exit=$?"`
Expected: `exit=0`, and the log shows both nodes passing. On a failure, read the log. Do not run the test again to see the output.

- [ ] **Step 5: Update `docs/dev/stdlib/safe-bash.md`**

1. In "Pipelines, dup redirects, and glob words", replace the paragraph that starts "A `glob` word is never a literal" with one that says a glob is still never a literal, and that the grep, listing, and read rules give it a meaning. Point to the new section.
2. Add a section "A glob in a path" after "Resolving the path when the plan is made". It holds the example line and the question it asks, the table from "What each command asks" above, the refusals of `globTargetOf` with the reason for each, the `--` that `endFlagsBeforeGlob` writes with the `sort *` example, and the rule that a read command with a limit on its file count refuses a glob with the `uniq` example.
3. In the same section, say what a policy author needs to know: a glob read asks `std::read` with the pattern in `filename`, and a reject rule that names a file matches it when the pattern can name that file. Point to "Rule matching" in `docs/dev/agents/approval-policies.md`. Say that a folder search has no such match yet.
4. In "Files and tests", add `tests/agency/safeBashGlobs.agency`.

Write only the mechanism and the rule. Leave out how the change came about.

- [ ] **Step 6: Commit**

Message: `safeBash globs: end-to-end test, updated rows, and dev doc`

---

## Not in this plan

- A glob in the folder part of a path.
- A glob after `~`.
- A glob in a folder that an earlier command in the line creates.
- `find` with a glob path.
- A glob for a read command that takes a limited number of files, such as `head -5 lib/*.ts`.
- Holes in a folder approval for secret files such as `.env`, including a reject rule for a file matching a folder search above it. That is ticket ADI-364 and gets its own brainstorm.
