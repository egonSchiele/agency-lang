# safeBash: fewer approvals for a coding agent

## What this is

The owner plans to use `agency agent` for a lot more coding work. A coding
agent runs shell commands constantly, and today nearly every one of them
stops the run for a human approval. This design cuts that number without
weakening any guarantee safeBash gives today.

It has four parts, in the order they should be built:

1. **Measurement.** Every `safeBash` call records which decision it made
   and why, so the later parts can be judged by what they removed.
2. **Pipes, `2>&1`, globs, and `~`.** The parser learns `a | b`, `2>&1`,
   an unquoted glob word, and a leading `~`. This is a change to tarsec,
   the parser library, followed by a version bump here.
3. **The read family, plus `cd`.** `grep`, `cat`, `head`, `ls`, `find`,
   and a few others raise the same read effects the file tools raise, so
   the policy that already approves the tools approves the bash spelling.
4. **Project scripts.** A simple command made of plain words, such as
   `pnpm test` or `make`, raises `std::exec` with the payload the `exec`
   tool would raise, so a policy can approve "run `pnpm test` here" once.

The owner's decisions so far:

- All-or-nothing stays. A string with any unrecognized command asks the
  broad question and nothing else.
- A policy may pre-approve a project's own scripts, such as `pnpm test`,
  in a directory.
- Measurement comes first. The read family and pipes come before the
  long tail of individual commands.

The calls I made are listed at the end for the owner to check. The
biggest two: bash reads raise the file tools' own effects rather than a
new read effect, and project scripts raise `std::exec` rather than a new
effect.

## Part 1: Background

### What safeBash is

`safeBash` (`stdlib/safeBash.agency`) is the shell tool the coding agents
carry. `shellTools()` in `stdlib/agents/lib/toolkits.agency` hands it to
the coding agent, the verifier, and the Agency verifier, and the
coordinator's code prompt
(`lib/agents/agency-agent/brains/coordinator/prompts/code.md`) tells the
model to use it for "tests, formatters, package managers" and anything
the dedicated tools do not cover.

The plain `bash` tool raises `std::bash`. No policy can safely
pre-approve that effect, because its payload is a string and the string
could do anything. So every `bash` call costs a human an approval.
safeBash exists to ask a narrower question when it can tell what the
string does. A narrower question is one a policy can answer in advance.

### How it decides

`planFor(source, cwd)` is a pure function. It parses the string,
classifies every command, and returns a `Plan`: the effects to raise and
an `Execution` saying what to run if every one is approved. Nothing runs
inside it, which is what makes it testable: hand in a string, look at
the plan. `safeBash` then raises every effect with `raiseAll`, and only
when all are approved does it run the execution.

The parser is tarsec's bash parser (`lib/parsers/bash/` in the tarsec
repository; this package pins tarsec 0.5.4 and re-exports the parser from
`lib/stdlib/safeBash.ts`). It understands simple commands, `;`, `&&`,
`||`, parentheses, flags, quoted words, variables, and the redirects `>`,
`>>`, `<`, and `&>`. It rejects pipes, `$(...)`, heredocs, `2>&1`, an
unquoted glob such as `*.ts`, and an unquoted `~`.
An unparseable string is "we understood nothing": the whole string asks
`std::bash` and bash runs the original text.

Classification is `effectsFor`, which today knows two verbs. `echo`
contributes nothing. `git status`, `git log`, `git diff`, and
`git diff --staged`, with no other flags, raise the matching
`std::git::*` effect. A redirect `>` or `>>` to a literal target raises
`std::write` whatever the verb. Anything else is unrecognized: a leading
`FOO=bar`, a path word like `/bin/git`, an unknown flag, or any other
verb.

Before classification, a refuse wall rejects `rm`, `rmdir`, `dd`,
`shred`, `mkfs`, `truncate`, and the destructive git spellings outright.
Nothing is raised for a refused string.

### The rules the current design rests on

These come from the v3 spec
(`2026-07-26-safebash-classifier-design.md`) and every change below has
to keep them:

- **Decide everything, then act.** No effect is raised and nothing runs
  until the whole plan exists.
- **The payload tells the truth.** A narrow effect's payload describes
  what bash is about to do. If the classifier cannot fill a payload that
  describes it, the command is unrecognized. safeBash does not expand
  variables or globs itself. Bash does that, which is why a variable
  anywhere in a recognized position makes the command unrecognized.
- **All or nothing.** If any command in the string is unrecognized, one
  `std::bash` is raised for the whole string and the original text runs.
  Narrow questions are asked only when every command was recognized, and
  then the text that runs is rebuilt from the tree that was classified.
- **Every shell spawn raises at least one effect.** A string of nothing
  but echoes still raises `std::bash`, so the effect log is a complete
  audit of shell invocations.
- **A relabeled effect approves the question, not the bytes.** Approving
  `std::write` for a redirect approves "a write to this file", and the
  content does not exist until bash runs.

Partial resolution was considered and dropped. If `grep foo src && pnpm
test` raised `std::grep` for the first half and `std::bash` for the
second, the human would still be asked about `std::bash`. No prompt is
saved and the narrow question is noise. The all-or-nothing rule exists
to avoid prompts that change nothing. Safety does not depend on it.

### How a policy answers

A policy (`lib/runtime/policy.ts`) is a map from effect name to rules.
Each rule has an optional `match` of field globs and an action. The
first matching rule wins; a field the payload lacks, or holds as null,
never matches.

Two facts about the built-in `recommended` policy
(`lib/runtime/builtinPolicies.ts`) matter here:

- `std::read`, `std::readBinary`, `std::ls`, `std::glob`, and `std::grep`
  are approved under the launch directory (`{.,./**}`), the agency
  install's `stdlib/` and `dist/`, three directories of the agent home,
  and the Claude skill folders. Nowhere else. `**` does not enter a
  directory whose name starts with a dot, so a read of `.github/x`
  under the launch directory still prompts. That is true for the tools
  today and stays true for the bash spellings.
- `std::exec` is approved for `agency` with a read-only subcommand
  (`parse`, `typecheck`, `doc`, ...), matched on `command` plus
  `subcommand`. Nothing else.

There is no `std::bash` rule in any built-in. Every bash string prompts.

Every effect declaration says which payload fields "approve always here"
pins (`docs/dev/language/effect-always-tag.md`). `std::read` and the
other reads carry `@alwaysUnder(dir)`: the saved rule covers that
directory and everything under it. `std::exec` carries
`@always(command, subcommand)`: the saved rule covers that program with
that first argument, anywhere. `std::bash` carries
`@always(command, cwd)`: the saved rule covers one exact command string
in one directory.

### What the agent actually runs

Two pieces of evidence set the priorities.

The owner's agent log for 2026-10-26 (`log.oct26.jsonl` in the main
checkout) held roughly forty recursive greps (`grep -rn ...`) and a dozen
single-file greps, each one a `std::bash` approval. These were a model
looking at code, and the `grep` tool would have answered every one with
no prompt.

The owner's saved policy (`~/.agency-agent/policy.json`) holds exactly
one `std::bash` rule, written by "approve always here":

```
make 2>&1 | tee /tmp/make_output.log | tail -100    in cwd .
```

Approving bash "always" saves one exact spelling. A `make` with any
other suffix prompts again. This one string does not even parse, because
of the pipe and the `2>&1`, so it never reached the classifier.

The coding agent's prompt (`stdlib/agents/coding.agency`) already tells
the model to avoid safeBash. The model reaches for the shell anyway.
That is the premise of the module, and this design accepts it rather
than fighting it with more prompt text.

## Part 2: Goals, non-goals, anti-goals

**Goals.**

- A coding session under the `recommended` policy, or a user's saved
  policy derived from it, stops for far fewer approvals. The target is
  that a bash read of the project, with or without a trailing filter,
  never prompts, and that a project script the user has approved once
  never prompts again in that project.
- Every narrow effect raised keeps the five rules above. A policy author
  who reads `docs/dev/agents/approval-policies.md` can predict exactly
  what each rule now approves.
- We can tell, from a session's log, how many approvals each part
  removed and what is left.

The work is tracked in Linear under the milestone "M6: Safe Bash
improvements" in the "Agency agent cleanup" project, one issue per slice
in the order of Part 10.

**Non-goals.**

- safeBash does not become a capability layer. Bash still runs
  everything; safeBash still only picks the question. The v3 spec's
  section "What this design forecloses" stands.
- No reimplementing commands. v2 tried to substitute Agency functions for
  commands and broke on output fidelity. The read family raises the
  tools' effects but runs real `grep`, `cat`, and `ls` through bash.
- No partial resolution, for the reason above.
- No `$(...)`, heredocs, here-strings, `|&`, background `&`, or
  functions. Each stays unparseable and asks `std::bash`.
- No `sed` or `awk` in this round. Both carry a script language with
  write and execute commands inside it (`sed 'w file'`, `awk
  'system(...)'`), so a flag allowlist is not enough to call them reads.
  The measurement will say whether they are worth a script checker.

**Anti-goals.** Each of these would make the work a failure even if every
test passed:

- A read effect raised for a command that writes or executes. `sed -i`,
  `tee`, `find -exec`, `find -delete`, `xargs` must never be classified
  as reads.
- A payload that names one path while bash reads another. `cd x; grep
  foo .` where the `cd` fails is the shape to fear: the grep runs in the
  original directory while a payload would claim `x`.
- A `std::exec` payload whose `command` names a wrapper (`sh -c`,
  `xargs`, `sudo`, `env`) while something else runs.
- A policy rule that used to cover one thing now silently covering
  another, without a line in the policies doc saying so.

## Part 3: Measurement

### The event

Every `safeBash` call records one statelog `debug` event, the generic
event the client already has (`debug(message, data)` in
`lib/statelogClient.ts`, reached from runtime code as `run.log.debug`),
after `planFor` returns and before `raiseAll` runs. The message is the
fixed string `safeBash plan`, so a session's log can be filtered for it.
Recording before raising means a plan whose question was later rejected
still counts, which is the case we most want to see. There is no new
event type: very few tools have one, and this one has nothing a reader
of the log needs that `debug` cannot carry.

The data:

| field | meaning |
|---|---|
| `command` | the string the model sent, as given |
| `cwd` | the resolved working directory |
| `outcome` | `refuse`, `shellFree`, `agency`, `narrow`, or `broad` |
| `reason` | why it was broad: `unparseable`, `unrecognized`, `noEffects`, `unrenderable`; empty otherwise |
| `verbs` | the command word of every simple command, in order; `""` for an assignment-only command; empty when unparseable |
| `effects` | the effect names the plan raises |
| `detail` | the parser message for `unparseable`, the classifier's message for the first unrecognized command (such as ``no rule for `xargs` ``) for `unrecognized`, the render failure for `unrenderable`, and empty for `noEffects` |

`reason`, `detail`, and `verbs` are new information. Today `planFor`
computes a failure message for every unrecognized command and then
throws it away (`allRecognized = false`), and holds the flattened
command list it could name the verbs from. The `Plan` type gains
`broadReason`, a record `{ kind, detail }` or null, and `verbs`, a list
of command words; the event reads both from the plan, and `outcomeOf`,
an exhaustive match in Agency over the `Execution` union, names the
outcome. Part 6 uses `broadReason` for the message the model sees on a
rejection.

### Where it lives

- `lib/stdlib/statelog.ts` gains `_debug(message, data)`, a generic
  bridge beside `_turnStart` that calls `debug` on the current run's log
  and is a no-op outside a run. Nothing in it knows about safeBash;
  `lib/stdlib/safeBash.ts` stays a one-line re-export of the parser.
- `stdlib/safeBash.agency` builds the data record and calls `_debug`
  from `safeBash` between `planFor` and the refusal check.

Reading the numbers back is a filter over the session's statelog JSONL
for `debug` events whose message is `safeBash plan`. No viewer change.

### What it is not

safeBash keeps doing what it does. The event only records the decision.
The command string it carries is already in the `toolCallStart` event
for the same call, and it goes through the same redaction every statelog
event gets (`lib/runtime/redactForStatelog.ts`).

## Part 4: Pipes, `2>&1`, globs, and `~`

### Why first

Models append `| head -20`, `| wc -l`, `| sort | uniq -c`, and
`2>&1 | tail` by reflex. Today one pipe makes the whole string
unparseable. Without this part, the read family would catch a lone
`grep` and miss the same grep with a filter on the end, which is most of
them. The saved `make` rule above is the project-script case of the same
thing.

Globs and `~` are in the same part for the same reason. `grep foo
*.ts`, `cat ~/.zshrc`, `--include=*.ts`, and `pytest tests/*.py` are
all unparseable today, so every rule in Parts 5 and 6 that mentions a
glob depends on this change.

### The tarsec change

In the tarsec repository, `lib/parsers/bash/`:

- A new node, `Pipeline { tag: "pipeline"; stages: PipelineStage[] }`,
  with at least two stages, where `PipelineStage = SimpleCommand |
  Parens`, so `(a && b) | c` parses. `Command` becomes
  `SimpleCommand | Pipeline | And | Or | Parens`.
- A pipeline binds tighter than `&&` and `||`, as in bash: `a | b && c`
  is `(a | b) && c`. In `commandParser` the atom becomes "a stage,
  followed by zero or more committed `| stage` pairs", and the
  `&&`/`||` level is unchanged. Parentheses are a pipeline stage, and
  the expression parser gets `fail()` for its paren slot: it tries that
  slot before the atom, so a real paren parser there would consume
  `(a && b)` whole and the `| c` could never attach.
- `|` commits: `ls |` is a parse error, not `ls`. `|&` is not recognized
  and stays a parse error.
- A new redirect form, `2>&1` and `>&2`, parsed as
  `{ tag: "redirect", fd: 2, op: ">&", target: literal "1" }`: an
  optional fd of any length (`12>&1` parses, as bash allows), then `>&`,
  then one digit with no space. `>&2` with no leading fd has no `fd`.
  Any other `>&` spelling stays a parse error, as today.
- A new word, `GlobWord { tag: "glob"; text: string }`: an unquoted word
  containing `*`, `?`, or `[`, otherwise made of the characters a path
  word allows. It is its own node because bash expands it and the
  classifier must be able to tell it from a quoted `'*.ts'`, which bash
  passes through as text. A glob may appear as an argument and as the
  value of a `--flag=value` flag (`--include=*.ts`); `flagValue` stays
  a string and the flag gains a `valueIsGlob` boolean. A glob is never
  a command word and never a redirect target.
- `~` is allowed as the first character of a literal or path word
  (`~/x`, `~`), and nowhere else. The word stays a `LiteralWord` or
  `PathWord`; the quote-aware tilde rule in `resolveRedirectTarget`
  already handles it.
- `astToBash` renders a pipeline with ` | ` between stages, a dup
  redirect as `2>&1`, and a glob word as its text. The round-trip tests
  in `tests/parsers/bash/astToBash.test.ts` gain all of them.

The owner releases tarsec and bumps the pin in `package.json` here
(`docs/dev/contributing/supply-chain.md` covers the pinning). Nothing in
this package can land before the bump, so this is the first PR of the
work after measurement, and the two can go in parallel.

### What changes here

- `stdlib/safeBash.agency` mirrors the new nodes in its `Command` and
  `Word` types. `flattenOne` is an exhaustive match with no catch-all,
  so the build fails until the pipeline arm is added. That failure is
  the designed property: the refuse wall must see every stage. The arm
  returns the stages. `literalWordText` refuses a glob word, so every
  existing rule that needs a literal (a redirect target, an `echo`
  argument, a git argument) treats a glob as unrecognized without
  further change.
- A dup redirect contributes no effect. It writes no file; it only
  changes which stream carries what. `redirectEffect` skips it. It is
  still the only form of `>&` that parses, so nothing else rides in on
  this rule.
- A pipeline is recognized when every stage is recognized by the rules
  in Part 5 or Part 6, with one addition: a read verb with no path
  argument is allowed as any stage but the first, because there it reads
  its stdin. The pipeline's effects are the union of its stages'
  effects. The whole pipeline runs through bash as the rebuilt text,
  with bash doing the plumbing.
- A pipeline where any stage is unrecognized is unrecognized, and the
  whole string asks `std::bash`, by the all-or-nothing rule.

`cat a.txt | grep x` is in today's plan tests as unparseable. After this
part it parses, and under Part 5 it raises `std::read` for `a.txt`,
because `grep x` with no path is a filter stage.

## Part 5: The read family, plus `cd`

### The idea

The question a policy wants to answer for `grep -rn foo src` is "may the
agent read files under `src`?" It already answers that question for the
`grep` tool: `recommended` approves `std::grep` with `dir` under the
launch directory. So the bash spelling should raise `std::grep` with the
same payload, and the existing rule approves it. No new effect, no new
policy line, and one line in a user's policy covers both spellings.

The precedent is already in the module. `git status` raises
`std::git::status`, the effect `gitStatus` raises, with the payload
fields the tool would fill and defaults for the rest. A redirect raises
`std::write`, the effect `write` raises. The read family does the same
for the file tools.

**The alternative considered: one new effect** such as `std::bash::read
{ paths }`. It would be simpler to raise and would never collide with the
tools' payload shapes. It loses because every policy, built-in or saved,
would need a new rule before any bash read went quiet, and because the
tools' effects already carry `@alwaysUnder(dir)`, so "approve always
here" on a bash grep saves the same directory rule the grep tool would.

### The table

One table, in `stdlib/safeBash.agency`, drives the family. Each row is a
verb, the effect it raises, which arguments are paths, the flags it
tolerates, and how the payload is filled. As in `gitEffects`, an unknown
flag makes the command unrecognized, because `grep -r` and `grep -l`
mean different things and the payload must say which.

A row's flag list has two kinds of entry. A plain flag stands alone
(`-n` on `cat`). A valued flag consumes the next word (`-n 20` on
`head`, `-A 3` and `-e pat` on `grep`, `-L 2` on `tree`, `-t ts` on
`rg`). The parser hands `head -n 20 f` over as the flag `-n` followed
by the literals `20` and `f`, so without the distinction `20` would be
taken for a path and raise a read of a file named `20`. The row type
has one list of each. A valued flag's value must be a literal word, or
the command is unrecognized. The joined spelling `-n20` parses as one
flag named `-n20` and is unrecognized unless a row lists it.

| verb | effect | paths | flags tolerated | payload |
|---|---|---|---|---|
| `cat`, `head`, `tail`, `wc`, `file`, `stat`, `md5sum`, `shasum` | `std::read`, one per path | every positional | `cat`: `-n -b -s -A`; `head`/`tail`: `-n N`, `-c N`, `-N`; `tail`: also `-f` refused; `wc`: `-l -w -c -m`; `file`, `stat`, `md5sum`, `shasum`: no flags except `shasum -a N` | `dir`, `filename` of the resolved path |
| `diff`, `cmp` | `std::read`, one per path | both positionals | `diff`: `-u -r -q -N -w -b -B --color=never`, `-U N`; `cmp`: none | as above |
| `ls` | `std::ls` | every positional, or `.` when none | `-l -a -A -h -1 -t -r -S -R -d -p -F -G --color=never` | `dir` = resolved path, `recursive` = `-R` given, `maxResults` = 0 |
| `tree`, `du` | `std::ls` | every positional, or `.` when none | `tree`: `-L N -a -d -I pat --noreport`; `du`: `-s -h -a -c -d N` | `dir`, `recursive` = true |
| `grep`, `rg` | `std::grep` | every positional after the pattern; `.` when `-r` and none | the letters in `lib/stdlib/grepQuery.ts` (`i m s u n r R g E P w l v`), plus `-c -h -H -o -F -A N -B N -C N`, `-e pat` as the pattern, `--include=`, `--exclude=`, `--exclude-dir=`, `--color=never`, `-m N`; `rg` additionally `-t`, `-g`, `--no-heading`, `-S` | `pattern`, `dir`, `file`, `flags` (the regex letters), `ignoreCase`, `wholeWord`, `filesOnly`, `invert`, `maxResults`; the same split `grep` the tool uses: a directory path gives `dir` and `file: null`, a file path gives its parent as `dir` and its name as `file` |
| `find` | `std::glob` | the first positional, or `.` when none | `-name -iname -path -type -maxdepth -mindepth -newer -size -not -o -a -prune -print -print0 -L` refused, `-H -P` | `dir`, `pattern` = the `-name` or `-iname` value or `*`, `maxResults` = 0 |

Rows are easy to add later, and each is one line plus one test. What the
table refuses is as important as what it accepts:

- `tail -f` never returns, so it is refused.
- `find -exec`, `-execdir`, `-ok`, `-delete`, `-fprint`, `-fls` write or
  run things; any of them makes the command unrecognized. The flag list
  is an allowlist, so an unlisted `find` flag is unrecognized too, and
  that is what protects against the ones this list forgot.
- `grep` writes nothing and runs nothing. Its allowlist exists so the
  payload says what the flags mean, such as `-l` setting `filesOnly`.
- A verb missing from the table is unrecognized, whatever it is called.

### Paths

Every path argument must be fully literal: a plain word, a path word, a
single-quoted word, or a double-quoted word with no variable inside
(`literalWordText`). Anything else makes the command unrecognized, by
the no-expansion rule.

A literal path is resolved the way a redirect target is
(`resolveRedirectTarget` in `lib/stdlib/prepareContainedPath.ts`):
against the resolved cwd, with `~` expanded only when the word was
unquoted, through the strict symlink walk, to a real path. The payload
carries the real path, split into `dir` and `filename` where the effect
wants both. A path that cannot be resolved (a dangling link, a loop) is
unrecognized. A path that does not exist resolves the way a redirect to
a new file does, by its parent, and is reported where it would be.

**Globs.** A glob word (Part 4) is one bash will expand. A quoted
`'*.ts'` is not a glob; it is text, and for a read verb it is a path
spelled with an asterisk, which resolves like any other literal. The
classifier cannot know which files an unquoted glob matches, but it can
know where they are: the literal prefix up to the first glob character
names a directory, and every match lives under it. So `grep foo src/*.ts` raises `std::grep`
with `dir` = the real `src` and `file: null`, and `cat *.md` raises
`std::read` with `dir` = cwd and `filename` = `*.md`. A glob word with a
`..` segment anywhere is unrecognized, because the expansion could climb
back out of the prefix. A policy author should know that approving reads
under a directory approves glob reads under it; Part 8 writes that down.

**No path.** A read verb with no path reads stdin. Alone, or as the first
stage of a pipeline, that is pointless (safeBash gives it an empty
stdin), so it is unrecognized. As a later pipeline stage it is a filter
and contributes no effect.

**Filters.** `sort`, `uniq`, `cut`, `tr`, `tac`, `rev`, `nl`, `column`,
`xxd`, and `hexdump` read only stdin and write only stdout. They are
recognized with no effect as any stage but the first, with a small flag
allowlist each (`sort -n -r -u -k -t`, `uniq -c -d -u`, `cut -d -f -c`,
`tr -d -s`, `nl -b`, `column -t -s`). `tee` writes a file, so it is not
a filter. `xargs` runs a command, so it is not one either.

### Input redirects

`< file` today makes the command unrecognized. It is a read of a literal
target, so it now raises `std::read` for the resolved target, the mirror
of `>` raising `std::write`. A variable target is still unrecognized.

### `cd`

`cd packages/agency-lang && pnpm test` is the shape of half of what a
coding agent runs in a monorepo. The classifier resolves every path
against the working directory, so to classify the right-hand side it
has to know the `cd` happened.

The rule: `cd <literal>` is recognized only as the left side of `&&`.
Everything to the right of that `&&` is classified with cwd = the
resolved directory, which must exist. The `cd` itself raises nothing. In
any other position (alone, last, before `;`, before `||`, inside a
pipeline) `cd` is unrecognized.

Why only `&&`: with `;` or `||`, a `cd` that fails leaves the next
command running in the original directory, so a payload that assumed the
move would lie. With `&&`, a failed `cd` means nothing after it runs.
`cd` with no argument, `cd -`, and `cd` with a variable are unrecognized.

Because `&&` is left-associative, `cd x && a && b` parses as
`((cd x && a) && b)`. The walk that classifies has to thread the cwd
through the tree rather than flattening first: when it meets an `and`
node whose left side is a recognized `cd`, it classifies the right side
with the new cwd and carries that cwd up to the enclosing `and`. The
flattened list the refuse wall uses is unchanged.

The rebuilt text keeps the `cd`, so bash performs the same move the
classifier assumed.

### What is still unrecognized after this part

- Leading assignments (`FOO=1 grep ...`). The v3 reasoning holds: an
  assignment can change what a command does (`GREP_OPTIONS`, `PATH`),
  and the payload would lie. Part 6 says more.
- `sed`, `awk`, `less`, `more`, `vim`, and every other verb not in the
  table.
- Any path or flag value that is not literal.

## Part 6: Project scripts raise `std::exec`

### The idea

`pnpm test`, `pnpm run build`, `make`, `pytest tests`, `tsc --noEmit`,
`cargo test`: a coding agent runs these more than anything else, and
none of them is a read. They run whatever the project's scripts say. So
no narrow effect can make them safe in general. But they are the same
decision every time: "may the agent run this project's own programs in
this checkout?" The owner wants to make that decision once, per program,
in a policy.

The `exec` tool already asks exactly this question. It raises `std::exec
{ command, args, subcommand, cwd, timeout, stdin }`, where `subcommand`
is the first argument, and `@always(command, subcommand)` means "approve
always here" saves a rule for that program with that first argument,
such as `{ command: "pnpm", subcommand: "test" }`. The `recommended`
policy already uses this shape for `agency typecheck` and friends.

So: **a simple command whose every word is literal, which no other rule
recognized, raises `std::exec` with the payload the `exec` tool would
raise for the same program and arguments.** Then runs through bash like
every other narrow plan.

**The alternative considered: a new effect** such as
`std::safeBash::script { cwd, program, script }`. It would keep bash
scripts out of every existing `std::exec` rule. It loses because it
would need its own `@always` tag, its own rows in the built-in policies,
its own entry in the `Shell` effect set, and a second place for users to
write "pnpm test is fine", when `std::exec` already has all four. The
cost of reusing `std::exec` is one sentence in the policies doc, in
Part 8.

### The payload matches what bash runs

When every word of the command is literal and there is no redirect, `sh
-c "pnpm test"` hands `pnpm` the argv `["test"]`, the same argv the
`exec` tool would spawn. The payload says `command: "pnpm", args:
["test"], subcommand: "test", cwd`, with `timeout` 0 and `stdin` empty,
which is what safeBash runs with. The git effects add the full command
string as an extra `command` field so the human sees the whole line.
`std::exec` already uses `command` for the program and `@always` pins
it, so here the full line goes in an extra field named `line`. A rule
written against `command` keeps meaning the program.

A glob word in the arguments (`pytest tests/*.py`) is allowed and
carried unexpanded in `args`. The human reads the same text bash will expand, and the
policy keys on `command` and `subcommand`, which are never globs. This
is the one place a `std::exec` payload from safeBash differs from the
tool's. The tool passes its arguments through unexpanded. Bash expands
them. The policies doc says so.

A variable anywhere in the command keeps it unrecognized. A redirect on
the command is classified as today: `pnpm test > out.log` raises
`std::exec` and `std::write`.

### Wrapper verbs stay broad

A few programs exist to run another program. For them the payload's
`command` would name the wrapper while the thing that matters is in the
arguments, and a policy rule `{ command: "sh" }` would be meaningless.
They are listed in one static array and are never classified as
`std::exec`; they ask `std::bash`:

`sh`, `bash`, `zsh`, `dash`, `fish`, `eval`, `exec`, `source`, `.`,
`xargs`, `env`, `sudo`, `doas`, `nohup`, `time`, `timeout`, `watch`,
`command`, `builtin`, `nice`, `script`.

Interpreters (`node`, `python3`, `ruby`, `perl`) are not on this list.
`node -e 'anything'` is as broad as `sh -c`, but `node script.js` is the
common case, and the `exec` tool has the same shape today: a policy rule
`{ command: "node" }` approves both. Nothing here widens what that rule
already approves, because the model can call `exec` directly. The
policies doc tells authors to key interpreter rules on `subcommand`.

### Leading assignments stay unrecognized

`AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test` is this
repository's own test convention, so this gap will show up in the
measurement immediately. It stays a gap in this round because an
assignment can change what a program does (`PATH`, `NODE_OPTIONS`,
`LD_PRELOAD`), so a rule `{ command: "pnpm", subcommand: "test" }` must
not cover `NODE_OPTIONS=--require=x pnpm test`. Covering assignments
needs `env` in the payload and the policy keyed on it, which means an
`env` field on `std::exec` or a separate effect. That is a decision to
make with the numbers in hand.

### Ordering of rules

For one simple command, in this order, the first that applies wins:

1. The refuse wall (`isRefused`), as today.
2. The agency rule (`tryAgencyPlan`), as today.
3. The shell-free `echo` paths, as today, for a single bare command.
4. The git rules, as today.
5. `cd` on the left of `&&`, Part 5.
6. The read family, Part 5.
7. `std::exec`, this part: every word literal or glob, not a wrapper
   verb, no assignment, and a verb that no earlier rule owns.
8. Otherwise unrecognized.

**A verb with a rule is owned by that rule.** `git`, `cd`, and every
verb in the read-family table belong to their rows. When the spelling
fails the row, the command is unrecognized and asks `std::bash`. It
never falls through to `std::exec`. Otherwise `git push --force` would
raise `std::exec { command: "git", subcommand: "push" }` and bypass the
`std::git::*` write effects the stdlib declares, and `find . -delete`
would raise `std::exec { command: "find", subcommand: "." }`, which an
"approve always here" on an innocent `find .` would then cover. So `git
push`, `git commit`, `tail -f`, and `find -delete` keep asking the
broad question, as they do today.

`echo` stays where it is: `echo hi; git status` still raises
`std::git::status` alone and runs under the audit rule, and nothing
about `echo` becomes a `std::exec`.

### The rejection message names the reason

Today a `std::bash` rejection reaches the model as the policy's
`rejectMessage` or a generic line. With `reason` on the plan (Part 3),
the failure the model reads can say why the command could not be
narrowed:

```
The shell command was rejected. safeBash could not ask a narrower
question because: no rule for `xargs`. The grep, read, and ls tools do
not need approval under the current policy.
```

The first sentence is the existing rejection. The second is `reason`
and `detail` from the plan. The third appears only when the plan's
verbs are all in the read-family table or are filters, so it is only
said when it is true. The whole change is one string, and it steers the
model's next call.

## Part 7: What is unchanged, and the safety argument

### Interrupts

Every new effect is raised at a named site in `raiseOne`, which is an
exhaustive match on `effect.name` with no catch-all, so a new `Effect`
variant without a raise site is a build error. The `Effect` union in
`stdlib/safeBash/actions.agency` gains variants for `std::read`,
`std::ls`, `std::grep`, `std::glob`, and `std::exec`, each with a typed
payload, and `safeBash`'s `raises` clause lists them. The effect
declarations travel with imports, so `stdlib/safeBash.agency` imports
from `std::shell` and `std::index` what it needs for the payload
contracts to be enforced, with the same comment the git imports carry.

`raiseAll` still raises every effect before anything runs, and the
executors still call `_bash`, never `bash`, for the reason the comment
on `runBash` gives: the narrow question replaces the broad one, and the
only path to the executor runs through a `raiseAll` that succeeded.

### Checkpoints and resume

The plan is a local of `safeBash`, computed before the first raise, so
it is in the checkpoint when a question goes to a human. On approval,
execution resumes after the raise with the same plan. Nothing new is
stored anywhere else. The known attack, editing the checkpoint to change
a local before resuming, is the same as today and is covered by
checkpoint integrity (`docs/dev/runtime/checkpoint-integrity.md`). This
design does not change it.

### Isolation

Nothing here touches globals or statics. The measurement event goes to
the run's statelog sink. The tables are `static const` data.

### Where the trust rule bends

The policies doc already says safeBash is "the exception that proves the
trust rule": its whole command is untrusted, so there is no trusted
`dir` to contain within. Part 5's payloads report real, resolved paths
for the same reason redirect writes do, so a policy judges the
destination that will be read.

### What this round makes weaker, so it is said here

- The analytical gate gets wider. v3 classified two verbs; this round
  classifies about twenty, each with a flag allowlist. A mistake in a
  row (a `find` flag that executes, missed) is a read effect raised for
  an execution. The allowlist discipline, one test per row, and the
  refuse wall underneath are the three things narrowing it.
- Approving `std::read` under a directory now also approves a shell
  spawn that reads there, the way approving `std::write` already does
  for a redirect. The audit rule still holds.
- Approving `std::exec` for a program now approves that program's bash
  spelling too. This adds no capability, since the `exec` tool was
  already there, but a policy author who had only ever seen the tool
  raise it should hear it from the doc.
- A `std::exec` from safeBash may carry an unexpanded glob in `args`.

## Part 8: Documentation

- A new dev doc, `docs/dev/stdlib/safe-bash.md`. There is none today;
  the module is described only by its spec and by sentences in five
  other docs. It records the mechanism: plan then act, the five rules,
  the rule order in Part 6, the read-family table and what each column
  means, the `cd` rule, the wrapper list, the `std::exec` payload and
  its one departure, the `safeBash plan` debug event, and the test files. Add
  it to the index in `CLAUDE.md` and in
  `.claude/skills/agency-stdlib-docs/SKILL.md`.
- `docs/dev/agents/approval-policies.md` gains a section, "What a read
  or exec rule now covers": a read rule under a directory approves bash
  reads and glob reads there; an exec rule for a program approves its
  bash spelling, with the glob note; a rule for an interpreter should
  key on `subcommand`.
- The v3 spec gets a status line pointing here.
- `safeBash`'s docstring (it is the tool description the model reads)
  says which commands run without a prompt under the recommended
  policy: reads of the project, pipes of them through filters, and
  programs the user has approved.

## Part 9: Tests

Every part keeps the existing split: pure classification in Agency
tests, parser round-trips in vitest, and a small number of end-to-end
runs with real interrupts.

- **tarsec:** `tests/parsers/bash/parsers.test.ts` and
  `astToBash.test.ts` gain pipelines (two stages, three stages, a
  pipeline inside `&&`, `|&` rejected), dup redirects (`2>&1`, `>&2`,
  `2>&3` rejected), glob words (`*.ts`, `src/**/*.md`, `--include=*.ts`,
  a quoted `'*.ts'` staying single-quoted, a glob as a command word
  rejected), and `~` (`~/x`, `~`, `a~b` rejected).
- **`tests/agency/safeBash.agency`** (the plan tests, run with the test
  LLM provider) gains nodes for: every read-family row, accepted and
  refused flags per row; glob paths, including the `..` refusal; a read
  with no path alone and in a pipeline; filters in each position;
  `tee` and `xargs` as pipeline stages; `cd` on the left of `&&`,
  before `;`, before `||`, and alone; `cd` into a missing directory;
  `std::exec` for `pnpm test`, `make`, `pytest tests/*.py`; each wrapper
  verb; an assignment before a script; the full saved-policy string
  `make 2>&1 | tee /tmp/make_output.log | tail -100` (tee makes it
  broad, which the test pins); valued flags (`head -n 20 f` reads only
  `f`); the rule order where two rules could apply (`git status` is
  git; `echo` is never exec); and the ownership rule (`git push`, `git
  commit -m x`, `find . -delete`, and `tail -f log` are all broad, never
  `std::exec`).
- **`lib/stdlib/safeBash.test.ts`** extends the round-trip list with
  every new command family so `astToBash` is proven on each.
- **Interrupt tests** in the same Agency file, with `interruptHandlers`
  in the `.test.json`: `grep -rn foo <dir>` raises exactly one
  `std::grep` and no `std::bash`; the single-file form raises it with
  `file` set; `cat a.txt | wc -l` raises one `std::read`; `cd <dir> &&
  ls` raises `std::ls` with the moved `dir`; `pnpm --version` raises one
  `std::exec` with `subcommand: "--version"`.
- **Policy tests** in `lib/agents/agency-agent/tests/`: under
  `recommended`, `safeBash("grep -rn foo .")` runs with no prompt;
  `safeBash("cat ~/.ssh/config")` prompts (dir outside scope);
  `safeBash("pnpm test")` prompts under `recommended` and runs under a
  policy with `{ command: "pnpm", subcommand: "test" }`. These run with
  a scratch `HOME`.
- **Measurement:** `lib/stdlib/statelog.test.ts` pattern for the event:
  one `debug` event with message `safeBash plan` per call, carrying the
  right `outcome` and `reason`, and none outside a run.

## Part 10: Order of work

One Linear issue and one PR each, in this order:

1. **Record what every call decided.** `Plan.reason`, the `debug`
   event, the rejection message of Part 6, and the start of the dev doc.
   No parser dependency.
2. **tarsec: pipelines and `2>&1`.** In the tarsec repo.
3. **tarsec: glob words and a leading `~`.** In the tarsec repo. Two and
   three can ship in one release.
4. **Parser parity here.** The pin bump, the mirrored nodes, the
   `flattenOne` arm, the no-effect dup redirect, `literalWordText`
   refusing a glob, and a pipeline classified as "every stage
   recognized".
5. **`grep` and `rg` raise `std::grep`.**
6. **Project scripts raise `std::exec`,** with the wrapper list, the
   `line` field, the ownership rule, and the policies-doc paragraph.
7. **File reads raise `std::read`:** `cat` and friends, `< file`, and
   the filters as later pipeline stages.
8. **`cd` on the left of `&&`.**
9. **Listings raise `std::ls` and `std::glob`.**
10. **Globs as read paths.**

Five, six, and seven need four only for their pipeline cases. If the
tarsec release lags, they land first with the pipeline tests deferred to
four. After five through seven have run for a few days, read the debug
events on a few sessions before starting nine and ten. The two
candidates already visible for a later round are leading assignments and
`sed -n`.

## Part 11: Left to the builder

- The exact flag allowlists. The rows above are a starting point. A
  builder who finds a flag that writes or executes removes it, and a
  builder who finds a common harmless one adds it with a test.
- How the cwd-threading walk is written: a recursive function over
  `Command` returning the effects and the cwd to carry up, replacing the
  flatten-then-loop in `planFor` for classification only.
- Whether the read-family table lives in one `static const` array of
  records with the verb as key, or one `match` arm per verb like
  `gitEffects`. The array is likelier to stay readable at twenty rows.
- Whether `rg` needs its own row or aliases `grep`'s with a few extra
  flags.

## My calls, for the owner to check

- Bash reads raise the file tools' own effects, not a new read effect.
- Project scripts raise `std::exec`, not a new effect. The full line
  rides in an extra `line` field, because `command` is the program.
- The tarsec change includes glob words and a leading `~`, not only
  pipes and `2>&1`. Without them none of the glob rules can fire.
- A verb that has a rule is owned by it. A spelling the rule rejects is
  broad, never `std::exec`.
- Read-family rows list valued flags separately from plain ones.
- Glob paths resolve to their literal prefix directory, and a glob with
  `..` is unrecognized.
- A read verb with no path is unrecognized alone and a filter in a
  later pipeline stage.
- `cd` is recognized only on the left of `&&`.
- Leading assignments stay unrecognized this round.
- The wrapper verb list in Part 6, and interpreters left off it.
- `sed` and `awk` are out of this round.
- The event is recorded before the questions are asked.
