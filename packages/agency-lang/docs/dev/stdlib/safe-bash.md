# safeBash

`safeBash` (`stdlib/safeBash.agency`) is the shell tool the coding agents
carry. The plain `bash` tool raises `std::bash`, and no policy can safely
pre-approve that effect, because its payload is a string that could do
anything. safeBash reads the command, works out what it does, and asks a
narrower question when it can. A narrower question is one a policy can
answer in advance.

## Decide, then act

`planFor(source, cwd)` is a pure function. It parses the string,
classifies every command, and returns a `Plan`: the effects to raise and
an `Execution` saying what to run if every one is approved. Nothing runs
inside it, which is what makes the decision testable: hand in a string,
read the plan. `safeBash` then raises every effect with `raiseAll`, and
only when all are approved does it run the execution.

`safeBash` may call `planFor` a second time. A `gh` read that names no
repository gets one from an `origin` remote, which takes running git, so
the first plan leaves the repository empty, `safeBash` looks it up, and
plans the line again with the answer (see "gh" below). The second plan is
the one raised and run.

The parser is tarsec's bash parser (`lib/parsers/bash/` in the tarsec
repository, re-exported by `lib/stdlib/safeBash.ts`). An unparseable
string is "we understood nothing": the whole string asks `std::bash` and
bash runs the original text.

The parser reads `$?`, the exit status of the last command, as a variable
named `?`. It is a number, so `echo` and `printf` may print it
(`knownOrExitStatus`): `pnpm test; echo "exit=$?"` asks only what `pnpm
test` asks. Everywhere else it is a variable like any other. In `cat $?`,
`echo hi > $?`, or `git log $?` the word names a file or a ref that
safeBash cannot know, so the line asks `std::bash`. `exitStatusInEcho`
pins both halves.

## The rules

- **The payload tells the truth.** A narrow effect's payload describes
  what bash is about to do. If the classifier cannot fill a payload that
  describes it, the command is unrecognized. safeBash never expands a
  variable or a glob itself; bash does that, which is why a variable in a
  recognized position makes the command unrecognized.
- **All or nothing.** If any command in the string is unrecognized, one
  `std::bash` is raised for the whole string and the original text runs.
  Asking narrow questions and then the broad one would add prompts
  without adding information.
- **Rebuilt text when narrow.** When every command was recognized, the
  text that runs is rendered from the tree that was classified
  (`astToBash`), so a parser bug degrades to running what was read. Some
  commands in that tree are written by the classifier: a `cd` names the
  folder it resolved, the `exit 1` of a `cd` guard is added after it, a
  git command is the one `gitCommand` built, a `gh` command is the one
  `ghCommand` built, a grep of paths is the one `grepCommand` built, and
  a `timeout` goes back in front of the command it runs.
- **Every shell spawn raises at least one effect.** A line whose
  commands raise nothing, such as `pwd` or `echo hi | grep h`, asks
  `std::bash::readonly` when every word in it is known now, and
  `std::bash` when one is not (see "A line that asks nothing"), so the
  effect log is a complete audit of shell invocations.
- **A relabeled effect approves the question, not the bytes.** Approving
  `std::write` for a redirect approves "a write to this file"; the
  content does not exist until bash runs.

## Outcomes

A plan ends one of three ways: refused, shell-free, or handed to bash.
`outcomeOf` names five, because it splits the bash way into `narrow` and
`broad` and gives the in-process agency path its own name.

`refuse`: the refuse wall (`isRefused`) matches `dd`, `shred`, `mkfs`,
`truncate`, and the destructive git spellings, by command word including
the last part of a path. An `rm` or `rmdir` is refused only for some
targets (see "rm and rmdir" below). The git spellings are:

- `clean`.
- `reset --hard`.
- `restore`, unless its only flag is `--staged`, which takes files out of
  the index and leaves the working tree alone. A `--` before the paths
  does not count as a flag.
- `checkout` with a `.` argument, with a `--` (`git checkout --
  utils.py`), or with a second word beside the ref (`git checkout main
  utils.py`). Each discards or overwrites files. `-b` and `-B` take a
  second word as a start point and are not refused. The count is of every
  argument that is not a flag (`plainWordCount`), because the parser tags
  a word with a slash as a path and a quoted word as quoted.

Nothing is raised. The wall is
friction against the obvious spelling; `find -delete` gets past it and is
approvable under `std::bash`, which is where the control lives.

`shellFree`: a single literal `echo`, with `-n` or without, and with or
without one output redirect, never spawns a shell. The output is computed in Agency and
returned, or written with `_write` under a `std::write` whose payload
carries the bytes. A `grep` that translates exactly runs the grep
tool's own search (see "grep" below). A `cat`, `head`, or `tail` of
one file runs the read tool's own read (see "The read family" below). A
line is `shellFree` when every step of it is one of these (see "Each
step decides for itself" below). An `agency <sub> <file>` line
runs in-process through `std::agency`.

`bash`: everything else. Narrow when every command was recognized: a git
command with a rule, see "git" below; a `gh` read with a rule, see "gh"
below; a grep of named files and folders, a read of named files, a listing of named folders, a find, a
program safeBash has no rule for (`std::exec`), a redirect contributing
`std::write` or `std::read`), broad otherwise.

`outcomeOf(plan)` names which of these a plan is (`refuse`, `shellFree`,
`agency`, `narrow`, `broad`) with an exhaustive match over the
`Execution` union, so a new execution kind is a type error there.

## In process when it translates

The shell-free grep and the shell-free read follow one rule. A command
whose flags and arguments translate exactly runs the matching stdlib
tool in process, under that tool's effect, wherever it sits in the line.
A pipeline runs in process when every stage can, and otherwise bash runs
the whole pipeline. Any other command runs through bash, with a narrow effect only when the
payload describes what bash will do, and `std::bash` otherwise.

| Command | Runs | Raises |
|---|---|---|
| `grep -rn hello src` | `_grep` | `std::grep`, as the grep tool does |
| `cat one.txt` | `_read` | `std::read`, as the read tool does |
| `echo "== a =="; cat a.txt` | the echo and `_read`, in order | `std::read` for `a.txt` |
| `grep -c hello one.txt` | real grep, through bash | `std::grep` for the one file |
| `wc -l one.txt` | real wc, through bash | `std::read` for the one file |
| `ls src` | real ls, through bash | `std::ls` for `src`, as the ls tool does |
| `rm -rf build` | real rm, through bash | `std::remove` for `build`, as the remove tool does |
| `pnpm test` | real pnpm, through bash | `std::exec`, as the exec tool does |

The `pnpm test` row is a deliberate exception. A lone program line with
no glob, `~`, redirect, or pipe would translate exactly to `exec`, but
the two paths differ only in the environment scrub, so it runs through
bash.

The rule has three reasons:

1. The approval describes exactly what runs. A policy that approves the
   read tool under a folder approves the same read when the model spells
   it `cat`.
2. The output is the same on every machine and under every `sh`, because
   no program prints it.
3. The in-process path works on a host with no shell.

The rule is not a defense against a trojaned program on the user's
`PATH`. The bash path still runs whatever `cat` the shell finds. The
containment floor in `docs/dev/security/goal.md` is the defense against
that.

## Which shell runs the text

Every command that reaches a shell runs under `bash -c`. The Node host
finds `bash` on the search path, skipping relative entries, which would
resolve inside the working directory an agent writes into. The `bash`
tool takes the same path.

The reason is that the parser is a bash parser and the rebuilt text is
bash. `sh` is a different program on each platform: dash on Ubuntu, bash
3.2 in POSIX mode on macOS, busybox ash on Alpine. They disagree on
`&>` (a redirect of both streams in bash, a background job and a
truncating redirect in dash), on `echo -n` and backslashes in `echo`,
on braces, and on `$'...'`. A narrow plan must never run under a shell
other than the one it was classified for.

The host removes the variables that would make bash run something the
text does not say: `BASH_ENV` (a file bash sources before the script),
every `BASH_FUNC_*` (an exported function that shadows a program, so
`git status` could run a function named `git`), `POSIXLY_CORRECT` (POSIX
mode, where macOS bash prints `echo -n hi` as `-n hi`), `SHELLOPTS` and
`BASHOPTS` (shell options at startup, such as `xpg_echo`), `CDPATH`
(sends `cd target` somewhere else), and `GLOBIGNORE` (drops names from a
glob). It also removes the variables that change what a `git` in the
script does: the ones that point git at another repository (`GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, and the rest of `GIT_RETARGET_ENV`),
and the ones that name a program git runs or config it loads
(`GIT_EXTERNAL_DIFF`, `GIT_EDITOR`, `GIT_CONFIG*`, and the rest of
`GIT_CODE_ENV`). With `GIT_DIR` set, the `cwd` in a git payload would be
false. The variables that name git's SSH program (`GIT_SSH_COMMAND`,
`GIT_SSH`, `GIT_PROXY_COMMAND`) are kept, because a person sets those on
purpose so that `git push` uses a particular key. `GIT_CONFIG_GLOBAL`
and `GIT_CONFIG_NOSYSTEM` are removed with the rest of the prefix, so a
person who keeps their git config where `GIT_CONFIG_GLOBAL` points will
see git ignore it in the shell, as the git tools already do. The git
lists live in `lib/host/gitEnvironment.ts`, and the git tools remove the
same entries plus the SSH ones. It also removes `GH_HOST` and `GH_REPO`,
which send `gh` to another server or repository than the one a
`std::github` question names, and `GH_FORCE_TTY`, which makes `gh` treat
the captured output as a terminal and start a pager under a read
approval. `GH_TOKEN` and `GITHUB_TOKEN` are kept. A
person who uses `GH_HOST` for a GitHub Enterprise server loses it in this
shell, as `std::github` has no Enterprise support either (issue #1003).
The list is `SHELL_ENV_REMOVED` in
`lib/host/node/nodeSubprocess.ts`. Without `POSIXLY_CORRECT`, GNU
programs in the child read options anywhere on the line. No plan
changes, because the flag tables that care set `optionsFirst`, and a
grep of paths runs with its flags written first.

The shell-free echo models bash's builtin echo. `-n` is the one flag it
takes. `-e` and `-E` go to bash, because the shell-free path does not
read backslash escapes, and so does a flag after the first word, since
bash prints `echo hi -n` as `hi -n`. A quoted word that starts with a
dash goes to bash too: bash strips the quotes and reads `echo "-n" hi`
as the option, so it prints `hi` with no newline. That also sends
`echo hi "-x"` to bash, which prints `hi -x`.

When there is no bash, the command fails with a message that names bash.
Nothing falls back to `sh`. The in-process paths still work on such a
host. The parser accepts what bash 3.2 accepts, because macOS ships that
version: `|&` and `&>>` are bash 4 forms, and both are unparseable
(`bashOnlyFormsStayUnparseable` pins them).

## Why a plan went broad

`Plan.broadReason` is null for a narrow, refused, shell-free, or agency
plan. For a broad plan it is `{ kind, detail }`:

| kind | detail |
|---|---|
| `unparseable` | the parser's message |
| `unrecognized` | the first failure message `effectsFor` returned, such as ``no rule for `xargs` `` |
| `noEffects` | `""`; every command was recognized and none raised an effect, and a word in the line is not known now, so the audit rule asked `std::bash` |
| `unrenderable` | why the tree could not be rendered back to text |

The four broad branches of `planFor` go through `broadPlan`, which is
`bashPlan` with the `std::bash` effect and the reason.

`Plan.verbs` is the command word of every simple command `planFor`
decided over, in order: `""` for an assignment-only command, `[]` when
the string was unparseable.

## The command judge

`safeBash`, `startJob`, and `startShellJob` take `commandJudge`, a
decision model (`{ model, provider }`) or `null`. With `null`, nothing
below happens. With a model, a broad plan is checked in `approvedPlan`
after `asJobPlan` and before `raiseAll`:

1. **Is the plan broad?** The test is `toRaise.broadReason != null`. It
   is the same test `outcomeOf` uses to call a plan broad, so the gate and
   the `safeBash plan` event always agree. It looks at `toRaise`, so a job
   line that `asJobPlan` made broad is judged too. The read-only shell line
   has no reason and is never judged.
2. **Does a policy rule already decide the question?** `judgeGate` builds
   the `std::bash` question with `bashQuestion`, the builder `raiseOne`
   raises from, so the message (with a job's "in the background"), the
   data (with a job's limit), and the origin (`std::safeBash`) are the ones
   the raise carries. It checks them against both policies that can answer
   a run: `runPolicy()`, the run's root policy, and `currentPolicy()`, the
   policy of a `cliPolicyHandler`. A rule in either that approves or rejects
   means nobody will be asked, so the judge is skipped and `raiseAll` lets
   the rule answer.
3. **Otherwise, ask the judge.** `askJudge` makes one `type: "decision"`
   call on a fresh thread that holds only the command, with no retries and
   a 3-second limit, in the shape of the router's call. The answer is one
   of `fine`, `useSimplerCommands`, or `tooLongToReview`. Only a refusal
   with confidence of at least `JUDGE_MIN_CONFIDENCE` (0.9) refuses; an
   answer with no confidence refuses nothing. A refusal returns a plain
   failure built from `VERDICT_SENTENCES`, before anything is raised, as
   the refuse wall does. A doubtful answer, a `fine`, and a failed call all
   go on to `raiseAll`.

The rules this keeps:

- **The judge never approves.** No path turns its answer into an
  approval. Editing a saved verdict in a checkpoint can only turn a
  refusal into a pass, which leads to the ordinary question.
- **A refusal is a failure, not a rejected interrupt.** A rejected
  interrupt reaches the model with a do-not-retry line. A refusal asks
  the model to write the command again, so it must not carry that line.
- **The judge runs once per call.** The gate's result is a local in
  `approvedPlan`, saved with the checkpoint. When a passed line's question
  pauses the run, resuming continues after the judge call and does not
  call the judge again.

The two policies, and where each comes from:

- **The run's root policy** (`runPolicy()`). `installRunPolicyHandler`
  keeps the policy it installs on the run (`RuntimeContext.runPolicy`), on
  a fresh run and again on every resume. It is the policy `agency run
  --policy`, `--approve`, and `--reject` give a run, and the `policy`
  option a host passes. The agent's session driver passes the session's
  policy that way, so in an interactive `agency agent` session this is the
  policy that holds the user's "always" answers. `runPolicy()` returns a
  copy, because a caller that changed the live policy would change what
  the handler approves.
- **A `cliPolicyHandler`'s policy** (`currentPolicy()`). A program that
  installs `cliPolicyHandler` itself, such as `agency agent -p`, keeps its
  rules there. The first call may load the policy file, and any call may
  save "always" answers waiting to be written. Those reads and writes are
  the handler's own, which it does not ask about.

What the check cannot see: an answer that comes from neither policy, such
as a TypeScript host that answers interrupts itself, a `handle` block or
`with approve` around the agent, or a parent process answering for a
subprocess (an IPC child installs no root handler, so its `runPolicy()` is
empty). For those, the judge runs on a line that would not have prompted.

The judge's call shares its parts with the router's: `modelOptions` in
`std::llm` picks the model, and `lastChoiceConfidence()` in `std::thread`
reads how sure the model was. The typed `llm()` call itself stays in
`askJudge`, because its type annotation is what makes the three labels the
possible answers.

In `agency agent`, the model comes from the `judge` slot
(`--model judge=<provider>/<model>`, `slots.judge` in a preset). It has
no default, because the judge sends command lines to its provider. It
reaches the tools through `AgentSettings.judgeModel` and
`judgeProvider`: the coder's and the minimal brain's `bash`, and the job
tools. The toolkits bind `commandJudge` even when it is `null`, so the
model never sees the argument. A local session (`--local`) has no judge:
the local setup sets only the main, reasoning, embedding, and router
slots.

## The debug event

Every call posts one statelog `debug` event with the message
`safeBash plan`, after `planFor` and before the refusal check, so a
refused plan is on the record too. The bridge is `_debug` in
`lib/stdlib/statelog.ts`, a no-op outside a run. The data:

```
{ command, cwd, outcome, reason, detail, verbs, effects, accesses }
```

`reason` and `detail` are the broad reason's fields or `""`; `effects` is
the list of effect names; `accesses` is `accessesOf(effects)` (see "File
accesses"). A session's calls are tallied with a filter over its JSONL
for `debug` events whose message is `safeBash plan`. There is no
dedicated event type.

When the command judge runs, a second event follows, with the message
`safeBash judge` and the data `{ command, outcome, verdict }`. `outcome`
is `skipped` (a policy rule decides the question), `rejected`, `passed`,
or `unavailable` (the judge call failed, and an event with the message
`safeBash judge call failed` before it carries the error). A replay of
logged lines through
`planFor` cannot predict the judge, so this event is the only record of
why a broad line did or did not prompt.

## File accesses

`accessesOf(effects)` in `stdlib/safeBash/actions.agency` answers "which
files does this line touch". It reads one `FileAccess` (`mode` and
`path`) out of each file effect, in order:

| Effect | Mode | Path |
|---|---|---|
| `std::read` | `read` | `dir` joined with `filename` |
| `std::grep` | `search` | `dir` joined with `file`, or `dir` when `file` is null |
| `std::ls` | `list` | `dir` |
| `std::glob` | `find` | `dir`, the folder searched, not the files found |
| `std::write` | `write` | `dir` joined with `filename` |
| `std::remove` | `remove` | `target` |

An access is read from the effects every time and never stored on the
plan, so the two cannot drift apart. Every other effect is skipped by a
default arm.

The list covers file effects only. `cat a.txt && git add a.txt` has one
access, a read, and it also stages a file. So the list is not everything
a line does: a caller that asks "does this line only read?" must also
check that every effect is a file effect, as `onlyReads` in
`stdlib/safeBash.agency` does.

## What the model reads on a rejection

When the broad question is rejected and the plan has a `broadReason`, the
failure the model reads is the rejection text, then on its own line one
sentence from `BROAD_SENTENCES`, keyed by kind, with the detail appended
when there is one:

```
interrupt rejected
safeBash could not ask a narrower question because it has no rule for one of the commands: no rule for `xargs`.
```

When every verb in the rejected command has an entry in
`READ_TOOL_FOR_VERB`, one more sentence names the tool that does the same
job:

```
interrupt rejected
safeBash could not ask a narrower question because it has no rule for one of the commands: grep does not take `-z`. Call the grep tool instead, if you have one: a policy can approve its question in advance.
```

The sentence does not say the tool needs no approval. safeBash cannot see
the policy, and with no policy, or a stricter one, that would be false. It
says "if you have one" because safeBash cannot see the caller's tool list
either: the coding agent offers `read` and no `grep`, `ls`, or `glob`.
Adding a verb is one line in the table.

A rejected narrow question carries no reason and reads as the rejection
text alone.

Both cases hand back the rejection failure itself, with the sentence added
by `_addLine` (`lib/stdlib/builtins.ts`). Rebuilding it with
`failure(why)` would drop the failure's `rejected` flag. The tool loop
reads that flag to show the reason as a rejection. Without it, the user's
reason reaches the model as `Error: <reason>. The call failed. You may
call this tool again.`, and the model takes the user's words for a tool
error. The lint rule AL0004 reports that rebuild shape anywhere in the
stdlib (see `docs/dev/agents/tool-loop-guards.md`).

## What a failed command returns

When a command exits non-zero, the failure's text is what a terminal
would show: stdout, then stderr, then a status line, with a note when
there is one (gh not being logged in, or what to do about a time limit).
An `agency` command, which runs in process, fails with the same text.

```
fatal: invalid reference: *.py
Command exited with code 128
```

The exit line is always the last line. A note, such as the one for gh not
being logged in, goes on the line before it. The two streams are joined
before the long-output cut (`failedOutput`), so a long failure is saved
once and its last lines come back (`spill.md`).

The failure carries `data: { type: "commandExit", exitCode }`, which tells
a command's own exit from a refusal, a rejection, or a time limit. With
`exitIsFailure: false`, `safeBash` returns such a failure as a success
holding the same text. Every agent's model gets `safeBash` with that bound
(`modelSafeBash` in `stdlib/agents/lib/toolkits.agency`), so the model
never sees the argument. A failing test run or a grep with no match is
then a result to read: it gets no "The call failed" wording from the tool
loop and does not count toward the loop's limit on failures in a row. The
choice lives in the tool; the tool loop has no case for any tool's result.

A command stopped at its time limit was killed and has no exit code of
its own, so its status line is `[stopped at the time limit of 120
seconds]`.

Two rules about the text:

1. **The command is not repeated.** The model wrote it one message
   earlier, and an inline script can be 2 KB.
2. **The text that ran is never shown.** It differs from the model's text
   for a `cd`, which runs with the folder the classifier resolved, for a
   git command, which runs as the one `gitCommand` built, and for a `gh`
   command, which runs as the one `ghCommand` built. A model that read
   the built text could write it next time, and `git -c ...` has no rule,
   so the copy would ask `std::bash`. The "was not run" message names the
   model's text (`label` in `runBash`) for the same reason.

## rm and rmdir

```
rm -rf build
```

This asks `std::remove` with `target` set to the real whole path of
`build`, which is the question the `remove` tool asks for the same
folder. Then real `rm` runs through bash. One line asks once per path. A
policy that approves `std::remove` under a folder, as `withWrites` does
for the launch directory, approves the delete however the model spells
it.

`REMOVE_VERBS` lists the flags the rule knows: `-r`, `-R`, `-f`, `-d`, and
`-v` for `rm`, and `-v` for `rmdir`. A flag off the list, a glob, or a
variable makes the line unrecognized, so it asks `std::bash`: `rm -i`
waits for an answer on a terminal nobody is at, `rmdir -p` deletes the
folders above its operand, and the paths a glob or a variable names are
not known until bash runs.

Some targets are refused whoever approves. `removeRefusal` runs beside
the refuse wall, on every `rm` and `rmdir` in the line, and its rule is
the `remove` tool's own (`rejectDangerousPath` in `lib/stdlib/fs.ts`):

| Target | Example |
|---|---|
| the filesystem root | `rm -rf /`, `rm -rf /*` |
| the home folder, or a folder that holds it | `rm -rf ~`, `rm -rf "$HOME"/*` |
| a top-level folder | `rm -rf /usr` |
| the working directory, or a folder that holds it | `rm -rf .`, `rm -rf *`, `rm -rf ..` |
| a lone variable followed by `/` or `/*` | `rm -rf $BUILD/*`, which is `/*` when `BUILD` is unset |

`_removeRefusal` (`lib/stdlib/safeBashRemove.ts`) reads the argument's
text, with each variable written as `$NAME`, so it sees a glob or a
variable that the narrow rule cannot describe. A folder's contents count
as the folder. A line the bash parser cannot read has no tree to walk, so
`_unparsedRemoveRefusal` reads the words after each `rm` in the text.
That check can refuse a line that was safe, and it is meant to err that
way.

The check runs twice, because a `cd` earlier in the line changes which
folder an `rm` names:

```
cd .. && rm -rf proj
```

1. `planFor` runs it on every `rm` in the line against safeBash's own
   folder, before anything is classified. A refused target here refuses
   the whole line. From `/Users/a/proj` this line passes, because it
   reads `proj` as `/Users/a/proj/proj`.
2. `removeEffects` runs it again against the folder the classifier
   resolved for that command, which follows the `cd`. Here `proj` is
   `/Users/a/proj`, the launch folder. A refused target gets no
   `std::remove`, so the line asks `std::bash`.

The second check must not be dropped. `withWrites` approves `std::remove`
for the launch folder and everything under it, so a `std::remove` naming
the launch folder would be approved by rule and the project deleted with
nobody asked. The `remove` tool is safe from this because `_remove`
calls `rejectDangerousPath` again when it deletes; `rm` runs through
bash and gets only the checks at plan time.

## Pipelines, dup redirects, and glob words

The parser produces three shapes the classifier mirrors in its own
types. A `pipeline` is a flat list of stages, each a simple command or a
parenthesized group; `flattenOne` flattens it through `flattenCommands`,
so the refuse wall sees every stage and classification needs no new
branch: a pipeline is recognized when every stage is, its effects are
the union, and it runs through bash as the rebuilt text (`git status |
head` is narrow; `git status | xargs echo` is broad).

A pipeline is one step, so the runner checks it once, before any stage
starts, and cannot check between stages that run at the same time. So
**at most one stage may ask anything other than `std::exec`**, whose
approval already lets a program read and change any file. `git checkout
x | cat README.md` could read a file the checkout swapped a moment
before, so it asks `std::bash`, and so do `git status | git log` and
`git log | head > out.txt`. `cat package.json | grep version` and `pnpm
test 2>&1 | tee out.log | tail -30` stay narrow. The rule names no
effect but `std::exec`, so an effect added later counts against the
limit (`aPipelineHasOneStageThatAsks`).

A group of several commands is part of one stage, so the check cannot see
between its commands either. When the pipeline asks anything other than
`std::exec`, a stage that is a group of more than one command asks
`std::bash`: `(git checkout x && cat README.md) | cat`, and `(git checkout
x && cd sub && pnpm test) | cat`, where `pnpm` would run in a folder the
checkout may have swapped. A `cd` is not counted as one of the group's
commands, so `(cd lib && ls) | head` stays narrow: the check resolves the
`cd` again and writes the real folder into the text it runs. A group of
programs, `(pnpm build && pnpm test) | tail`, stays narrow.

A dup redirect
(`2>&1`, op `>&`) moves a stream and writes no file, so `redirectEffect`
skips it; `prepareRedirectWrite` stays strict, because the shell-free
write path computes the bytes it writes and a dup changes which stream
`echo`'s output goes to.

`redirectEffect` has three more rules:

1. A redirect of standard output, standard error, or both (`&>`) to
   `/dev/null` writes no file, so it contributes no effect. `pnpm test
   2>/dev/null` and `pnpm test &>/dev/null` ask one `std::exec`.
2. `< /dev/null` gives the command an empty stdin, which safeBash gives
   every line anyway, so it contributes no effect either, and
   `pipedProgram` does not count it as input. `node --version < /dev/null`
   asks one `std::exec`. `cat < /dev/null` still has no rule, because a
   cat with no file reads an empty stdin.
3. A redirect of standard error to a file contributes the same
   `std::write` as `>` to that file, with the same mode. `make
   2>build.log` asks `std::exec` and `std::write`.

Descriptor 1 means the same as no descriptor, so `make 1>out.log` is
`make >out.log`. Any other explicit descriptor is unrecognized, so
`make 3>x` is broad. `&>` to a file has no rule.
Both rules live in `redirectEffect` only. `prepareRedirectWrite` still
refuses every explicit descriptor, so `echo hi 2>err.txt` is never a
shell-free write. It runs through bash and asks `std::write` for
`err.txt`.

A `glob` word is never a literal:
`literalWordText` refuses it, so every rule that needs a literal (a
redirect target, an `echo` argument, a git argument) treats a command
with one as unrecognized until a later slice gives globs a meaning.

The parser returns a bare `--` as a flag word whose name is `--`. No
flag table lists it, so `ls -- src` and `cat -- a.txt` are unrecognized,
as any unknown flag is. Two readers of a command's words do not go
through a flag table. The refuse wall looks for `--` after `git
checkout`. And a program with no rule takes it as one more argument, so
`pnpm test -- --watch` asks `std::exec` with `--` and `--watch` in its
arguments.

A `~` or a `^` after the first character of a word is plain text, as it
is to bash: `HEAD~1` and `HEAD^` are literal words, and `echo hi > a~b`
writes a file named `a~b`. A `~` right after `=` or `:` is still
unparseable (`make DIR=~/x`), because bash expands it there.

An unquoted `~` now parses, so `echo hi > ~/x` is a recognized write to
the real home directory (`tildeModeFor` expands an unquoted word); a
quoted `'~/x'` stays a directory literally named `~` under the cwd.

## Stages that read a pipe

A command in a later stage of a pipe reads the previous stage's output
on its stdin. `grep fix` with no file named searches that output and
reads no file, so `git log | grep fix` needs only the git question. The
same command as the first stage, or outside a pipe, reads the shell's
stdin, which safeBash closes (`_bash` is called with `stdin: ""`), so it
does nothing useful and stays unrecognized.

Two pieces carry this, each with one job:

- **Where a command sits.** `flattenCommands` returns a `FlatCommand`
  per simple command: the command and `readsStdin`. `pipelineCommands`
  sets the flag in one place: the first stage keeps it false, and every
  command in a later stage is true, including both halves of a
  parenthesized group (`a | (b && c)`). `planFor` hands the flag to
  `effectsFor`.
- **What a command reads.** A verb's rule says what the command reads
  and nothing about where it sits. `readGrep` answers with a `GrepRead`:
  `{ kind: "search", calls }` for its paths, or `{ kind: "stdin" }` when
  it names none. The verb rule never sees the pipe flag.

`stdinStage(verb, readsStdin, redirects)` joins them for a verb whose
rule can read stdin, and `pipedProgram` is its counterpart for a program
`std::exec` describes (see "Programs with no rule"). They are the only
two places that read the flag. A stdin reader fed by a pipe contributes only
its redirects; anywhere else it is unrecognized, with the message `grep
with no path reads stdin`. Its callers are grep, the read verbs (see "The
read family"), `tr`, and `tee`. A new verb that can read its stdin writes
its "reads stdin" answer and calls the same helper.

`tee` in a pipe writes the pipe into each file it names, as `>` does, so
`teeEffects` asks `std::write` for each, resolved by the resolver `>`
uses, in append mode under `-a`. `pnpm test 2>&1 | tee out.log | tail
-30` asks `std::exec` and `std::write`.

A grep in a pipe still goes through the flag table, so `-R` or
`--filter` is still refused, and so is a flag after the pattern (`git
log | grep fix -i` makes BSD grep read a file named `-i`). The stdin
claim holds for GNU grep, BSD grep, and ugrep: ugrep searches the
working directory only when stdin is a terminal, which a pipe never is.

## grep

There are two greps, and safeBash uses both.

- **The grep tool** (`grep` in `stdlib/shell.agency`) runs no program.
  `_grep` walks the directory and tests each line against a JavaScript
  regex. The walk skips `SKIP_DIRS` (`node_modules`, `.git`, `dist`,
  `build`, `.next`, `.cache`) and, by default, anything `.gitignore`
  ignores, and it never follows a symlink below the path.
- **The grep program** is whatever `grep` the shell finds: GNU grep on
  Linux and CI, BSD grep on macOS, or another grep a user put on their
  `PATH`, such as ugrep. `grep -r` reads every file under the path,
  `.git/config` included, and ugrep has flags that run programs
  (`--filter`) and write files (`--save-config`).

Both raise `std::grep` with the same `dir`, so a policy cannot tell them
apart, and a policy that approves `std::grep` under the launch directory
is approving what the tool does. So real grep may run under that approval
only when it reads no file the tool would not read. safeBash makes sure
of that by writing the grep command itself (see "Any other grep runs real
grep, written by safeBash"):

| Command | What happens |
|---|---|
| `grep -rn hello src` | lone, translates: the tool's search, `std::grep` with `dir: <cwd>/src` |
| `grep -n hello one.txt` | lone, translates: the tool's search, `std::grep` with `file: "one.txt"` |
| `grep -rn "a+b" src` | `+` means different things to grep and JavaScript: real grep, `std::grep` for the folder |
| `grep -c hello one.txt` | the tool has no `-c`: real grep, `std::grep` for the file |
| `grep -rn hello src \| head -20` | not lone: real grep, `std::grep` for the folder |
| `grep -rn hello src lib --include="*.ts"` | real grep, one `std::grep` per path |
| `grep -rn hello node_modules \| head` | the folder's own name is one the tool skips: `std::bash` |
| `git status \| grep hello` | fed by a pipe, no path: a filter, only the git question |
| `git status \| grep -rn hello` | `-r` reads the working directory, pipe or not: `std::grep` for it |
| `git status \| grep hello -v` | a filter runs as written, so a flag after the pattern: `std::bash` |
| `grep hello` | no path and no pipe: reads a closed stdin, `std::bash` |
| `grep -R hello .`, `grep --filter=x hello .` | not in the flag table: `std::bash` |

### The flag table

`GREP_FLAGS` is a `FlagSpec`: plain flags, valued flags, and
`optionsFirst`. `splitFlags` checks a command against it. Combined letters
(`-rni`) are checked one by one. A valued letter takes the rest of its
word (`-A3`) or the next word (`-A 3`), which must be literal. A long flag
is looked up as written (`--color=never`) among the plain flags, then by
name among the valued ones. Anything the table does not list is refused,
because a payload that ignored it would describe a different command.

Left out on purpose: `-R` (GNU grep follows every symlink below the
path; BSD grep does not by default); `-f`,
`--exclude-from`, `--include-from` (read another file); `-m` (counted per
file); `-P` (BSD grep lacks it); `-z`, `-d`, `-D` (different meanings in
different greps); ugrep's `--filter` and `--save-config`; the long
spellings of short flags. Each letter in the table means the same thing in
GNU grep's manual, ugrep 7.8.4's `--help`, and FreeBSD's grep manual.
`--include`, `--exclude`, and `--exclude-dir` are in the table: each only
narrows what grep reads, and each may be given more than once (the
table's `repeatable`). The shell-free table does not have them, because
the tool's search cannot carry them out.

The parser reads `--include="*.ts"` as one word of two parts, the text
`--include=` and a quoted part. A table that sets `quotedValues` reads
such a word as the flag with the quoted text as its value
(`joinedFlag`). Only `GREP_FLAGS` and the git `log` and `show` rows set
it. A quoted value can hold a space, a comma, or a glob character, and the
other tables' checks were written for bare values: `gh`'s list flags are
read as CSV, and `find -name="x"` is refused on purpose.

Four more refusals:

- **A quoted word that starts with `-`.** Bash strips the quotes, so
  `grep "-R" src` runs `grep -R src`. This applies to a flag's value too,
  so `grep -e "-x" f` is refused even though grep would search for `-x`.
- **A repeated valued flag**, except the three file filters. For `grep -e
  a -e b`, a payload with one pattern would misdescribe the search.
- **A flag after the pattern of a grep that reads a pipe.** BSD grep, and
  GNU grep with `POSIXLY_CORRECT` set, read `-v` in `cmd | grep x -v` as a
  file. Such a grep runs as written, so `readGrep` refuses it.
  `GREP_FLAGS` itself allows a late flag (`optionsFirst: false`) and
  records it in `SplitArgs.lateFlag`, because a grep of paths runs the
  command safeBash writes, flags first.
- **No path, outside a pipe.** grep reads the shell's closed stdin.
  Fed by a pipe it is a filter (see "Stages that read a pipe"). The `-r`
  check comes first either way: with `-r` the path is `.`, and a pipe
  does not stop grep reading files, so `git status | grep -rn hello` asks
  `std::grep` for the working directory.

### A lone grep runs the tool's search

`tryShellFreeGrep` applies to a grep that is the whole command line, with
no pipe, chain, or redirect, whose flags are all in
`SHELL_FREE_GREP_FLAGS` (the tool has no `-c`, `-o`, or context lines),
whose directory target has `-r`, and whose pattern translates. It raises
`std::grep` and runs `printGrep`, which calls `_grep`. The payload and the
search are built from one `GrepPayload`, and the payload's `pattern` is
the JavaScript regex the search uses, with the regex flag `u`, so `.`
matches a whole character, an emoji included, as grep does in a UTF-8
locale.

The tool's search skips what `.gitignore` ignores, so it can find fewer
matches than grep would. The note at the end of the output says what it
skipped. A folder the command names is searched even when git ignores it, so
`grep -rn x node_modules` runs the tool's search and asks `std::grep`, like a
grep of any other folder. See "`.gitignore`" in
`docs/dev/stdlib/grep-flags.md`.

The `SKIP_DIRS` names still apply below the folder, and most published
packages keep their code in `dist`. So `grep -rn x node_modules/some-package`
skips that package's `dist` folder. Naming the folder searches it:
`grep -rn x node_modules/some-package/dist`.

`_grepPatternToRegex` (`lib/stdlib/grepDialect.ts`) accepts a character
only when grep and JavaScript give it the same meaning, from one role
table per syntax:

- basic: ASCII letters and digits, plain punctuation, `.`, `*` after a
  character, `^` first, `$` last. `+ ? | ( ) { }` are plain text to basic
  grep and operators to JavaScript, so they are refused.
- extended (`-E`): adds `+ ?` after a character, `|`, and balanced `( )`.
- fixed (`-F`): any text, escaped with `escapeRegex`.
- every syntax refuses control characters: grep reads a newline as the
  start of a second pattern.
- with `-w`, only word characters (and `|` with `-E`). grep's `-w` checks
  the characters around the matched text, while the tool's
  `\b(?:pattern)\b` checks the pattern's own edges, so `grep -w " world"`
  finds nothing in `hello world` while `\b(?: world)\b` matches.

`_renderGrepOutput` prints the matches the way GNU grep does: `name:` for
a directory search (or with `-H`, never with `-h`), then `line:` with
`-n`, then the text. A name is the match's path joined to the path as
bash hands it to grep (`GrepTarget.argument`, with `~` expanded), so
`grep -rn x .` prints `./a.txt` and `grep -rn x` prints `a.txt`. BSD
grep, macOS's grep, prints `./a.txt` for the second, and safeBash follows
GNU.
After a directory search the output gains `_skippedDirsNote()`, built from
`SKIP_DIRS`, so the model knows a miss may be in a skipped file; with no
match, the note goes in the failure's `stderr`. The search stops at
`SHELL_FREE_GREP_CAP` matches and says so.

`shellFreeMatchesRealGrep` runs the shell-free path and real grep on the
same commands over `tests/agency/stdlib/grep-fixtures/` and compares the
lines. Each row first checks that its command really runs shell-free.
The fixtures are short ASCII text, and what grep does with other text
depends on the locale, so the test cannot see these differences. They
change the output, not what is read:

- A binary file: GNU prints `Binary file ./x matches`, and the tool prints
  the decoded text.
- `-w` next to a non-ASCII letter: `\b` treats only ASCII letters as word
  characters, even with `u`, so `grep -rnw foo .` matches `éfoo` in the
  tool's search, and grep in a UTF-8 locale does not.
- `-i` on non-ASCII text, where the case-folding rules differ.
- In the C locale grep works on bytes, so its `.` matches one byte of a
  multi-byte character, and the tool's matches a whole character.

### Any other grep runs real grep, written by safeBash

`grepRule` is the `simpleCommandRule` branch for grep. A grep that reads
a pipe runs as written and asks nothing beyond its redirects. A grep of
paths asks one `std::grep` per path (`grepSearchRule`) and runs the
command `grepCommand` writes:

```
# The model writes:
grep -rn "planFor" lib --include="*.ts" | head -20

# bash runs:
grep -r -n '--include=*.ts' --exclude-dir=node_modules --exclude=node_modules ... -e 'planFor' -- lib | head -20
```

The command has, in order: the checked flags; `--exclude-dir=<name>` and
`--exclude=<name>` for each name in `SKIP_DIRS`, read through
`_skipDirNames`; `-e` and the pattern, so a pattern that starts with `-`
is never a flag; `--`; and the paths as the model wrote them, or `.` for
a `grep -r` that named none (GNU grep then searches the working folder,
and BSD grep reads stdin).

The excludes are the safety argument. Real `grep -r` reads every file
under the folder, `.git/config` included, while the tool's walk skips
every entry with one of the six names, a file as well as a folder. In a
git worktree `.git` is a file, so `--exclude-dir` alone would let grep
read it. With both flags, real grep reads no file the tool skips, and
`grepThroughBashReadsWhatTheToolReads` checks that on a tree with a match
in each skipped place, on BSD grep and on GNU grep. `grepRunsWhatItAsked`
pins the exact text, so a name added to `SKIP_DIRS` fails it until the
expected text agrees. Real `grep -r` follows no symlink below the folder
on either grep, as the tool does not.

Real grep still reads what `.gitignore` ignores, and the tool does not.
That is within the approval: the tool's `respectGitignore: false` reads
those files too, and `std::grep` has no field for it, so an approval of a
folder already covers its ignored files.

A folder needs `-r`. A folder whose own name is one of the six has no
rule, checked on the path as written and on its real path: with
`--exclude-dir=dist`, `grep -r x dist` searches nothing (GNU grep skips
"any command-line directory with a name suffix that matches"), while the
tool searches a folder it is given. So `grep -rn x .` run inside a folder
called `build` asks `std::bash` too.

`readGrep` resolves each path with `_searchTargetIn`, the same split the
tool uses: a file gives its real parent as `dir` and its name as `file`,
so a symlink to `~/.ssh/id_rsa` names `~/.ssh`.

### What the payload fields mean

`recommended` matches only on `dir`. Anyone writing a rule on another
field needs two facts:

- `pattern` is a JavaScript regex on the shell-free path and grep syntax
  as written on the bash path, so `a+b` means one or more `a` then `b` in
  one and the literal text `a+b` in the other.
- `maxResults` is `SHELL_FREE_GREP_CAP` on the shell-free path. On the
  bash path it is `0`, meaning no cap, which is true of grep without
  `-m`. In the grep tool, `0` means no results at all.
- The same holds for `std::ls` and `std::glob` from a listing or a
  `find`: `maxResults` is `0`, meaning no cap, because real `ls`, `tree`,
  `du`, and `find` list everything. The `ls` and `glob` tools cap their
  results with it, and `_glob` returns nothing for `0`, so a policy
  author must not read `0` as "nothing".

### Resolving the path when the plan is made

`readGrep`, `readFileVerb`, and the listings resolve a path before
anything runs, and bash runs the line later. So the classifier carries
what it knows about the line as it walks it, command by command, in a
`LineState`:

- `cwd`, the working directory after each `cd`;
- `written`, the `std::write` payloads the line has asked for so far;
- `made`, the folders the line has asked `std::mkdir` for, by real path;
- `disk`, what the commands so far may have done to the disk (below);
- `strict`, set for a lookup that needs a real path (below).

### What an earlier command did to the disk

Every payload is resolved against the disk when the plan is made, before
any command in the line runs, and an earlier command can change the
disk. With a branch that holds `README.md` as a link to a key, `git
checkout evil; cat README.md` would print the key under a question that
names the file in the project. The plan does not try to predict this.
The runner plans each step again just before it runs and stops the line
when a path now leads somewhere else (see "Each step is checked just
before it runs"). `aCheckoutThatSwapsAPathStops` in
`tests/agency/safeBashSteps.agency` runs that attack.

### A `..` after a symlink

A gap between the plan and bash also exists inside one word, and checking
later does not close it. Every
resolver makes the word absolute with `path.resolve`, which removes a
`..` from the text. The kernel applies a `..` after following a link.
With `link` pointing at `/elsewhere/inner`, `link/../creds` is
`<cwd>/creds` to the plan and `/elsewhere/creds` to `cat`.

`resolveBashPath` (`lib/stdlib/prepareContainedPath.ts`) is the first
step of `_searchTargetIn`, `_resolveRedirectTarget`, and `_realPathIn`.
It walks the word as written, and when a `..` follows a step that is a
symlink, it throws, so the line asks `std::bash`. A working folder that
is itself a symlink counts as such a step. A word with no `..` costs
nothing, and a `..` after a real folder resolves as before.
`dotDotAfterALinkHasNoRule` pins the rule for a read, a listing, a
search, a redirect, `tee`, `cd`, `mkdir`, and `git -C`.

An `rm` or `rmdir` with such a word is refused, as the other `rm` walls
are. `_removeRefusal` resolves its target with `resolveBashPath` too, and
the throw is its reason: the checks that refuse the home folder or a
folder that holds the working directory would otherwise judge a path
bash does not delete.

`resolveBashPath` can only test a step that names a real path. In
`rm -rf */../x` or `rm -rf $D/../x`, the step before the `..` is
expanded by bash, and it may expand to a symlink. So `_removeRefusal`
refuses a `..` that comes after a step with a glob character, a brace,
or a `$`, without looking at the disk.

Like every `rm` wall, this one is checked from the folder the line
starts in. After a `cd` in the same line, as in `cd sub && rm
link/../creds` where only `sub/link` is a symlink, the wall does not see
the link. `removeEffects` then resolves the target from `sub`, gets the
refusal there, and the line asks `std::bash`.

### Files the line wrote and folders it made

`afterCommand` updates the line after each command. A `std::write` goes
in `written`, and the folder of a `std::mkdir` goes in `made`. What they
let the plan ask is a prediction. When the step runs, the runner plans it
again in a fresh line, and the fresh plan finds the file or folder on the
disk; when the two disagree, the line stops.

Three lookups accept a made folder that is not on the disk yet:

- a listing of it (`listTargetOf`): `mkdir -p out && ls out` asks
  `std::mkdir` and `std::ls` for `out`;
- a file directly inside it (`missingWhere`): in `mkdir -p out && pnpm
  build > out/log.txt; tail out/log.txt` the read names `out/log.txt`;
- a `cd` into it (`cdTarget`): `mkdir -p build && cd build && cmake ..`
  classifies `cmake` in `build`.

`mkdir -p a/b` makes `a` as well, so `madeFolder` accepts a missing path
that lies above a made folder: `mkdir -p a/b && ls -R a` asks a recursive
`std::ls` for `a`. A strict lookup accepts a made folder too. `tree` is
strict because it refuses a file, and a made folder is a folder.

A path that does not exist when the plan is made has a rule
(`missingPath`) when its parent folder exists or the line made it:

1. When the line wrote that very file earlier, it resolves to it: `pnpm
   test > out.txt 2>&1; tail -50 out.txt` asks `std::exec`, `std::write`,
   and `std::read` for the same file.
2. Otherwise it resolves by its parent: `cat nope.txt` asks `std::read`
   for that name in the folder, and `ls nope` asks `std::ls` for the
   folder, as `ls file` does. After a program too: `pnpm build && cat
   dist/out.txt` asks `std::read` for `dist/out.txt`.

`_missingTarget` finds the place with `_resolveRedirectTarget`, the
resolver `>` uses, so a read and a write of one new file name one
`dir` and `filename`. It adds two checks: nothing is at the path, and the
parent is a folder that exists. The walk keeps every step after the first
missing one as written, so without the second check `cat nodir/nope.txt`
would resolve too.

Both rules are safe because the read is planned again just before it
runs. If `pnpm build` made `dist/out.txt` a link to a key, the fresh plan
resolves the link, the payload differs from the approved one, and the
line stops before the `cat`. `ln`, `cp`, and `mv` still ask `std::bash`
(see "Programs with no rule"), so `ln -s ~/.ssh/id_rsa x; cat x` has no
narrow question at all.

The stages of a pipeline run at the same time, and the runner checks a
pipeline as one step, before any stage starts. So each stage is
classified in the line as it was before the pipeline, and at most one
stage may ask anything other than `std::exec` (see "Pipelines, dup
redirects, and glob words"). In `pnpm test | cat nope.txt` only the
`cat` asks, so a read of a missing file beside a program stays narrow.
Parentheses end a `cd`, but not what the line wrote or ran.

Some lookups set `strict` and never use the three rules above, because
each needs a real path: `find`, `tree`, `grep -r`, `diff`, `cmp`, an input
redirect, and the shell-free paths. A lone `cat nope.txt` therefore goes
to bash, which runs real cat, and the model reads cat's own error.

The shell-free read does not have the swap gap at all: `_read` opens the
file without following a final link and checks it is the regular file it
resolved.

## The read family

`READ_VERBS` is a table of the verbs that read the files they name, or
their stdin when they name none. Each row is a `ReadVerb`: a `FlagSpec`,
how many paths the verb takes as a `CountRange`, and which valued flags
hold a count.

| Verbs | Flags | Paths |
|---|---|---|
| `cat` | `-n -b -s` | any number |
| `head`, `tail` | `-n N`, `-c N`, and `-N` for `-n N` | one |
| `wc` | `-l -w -c -m` | any number |
| `diff` | `-u -q -N -w -b -B --color=never`, `-U N` | two |
| `cmp` | none | two |
| `sort` | `-n -r -u -f -b`, `-k K`, `-t C` | any number |
| `uniq` | `-c -d -u -i` | one |
| `cut` | `-d C`, `-f F`, `-c C` | any number |
| `nl` | `-b B` | any number |
| `tac`, `rev` | none | any number |
| `md5sum`, `sha256sum` | none | any number |
| `shasum` | `-a N` | any number |
| `file` | none | any number |

`file` opens the file and prints what its first bytes say, such as
`OpenSSH private key`, so it is a read. The checksums take no flag but
`shasum -a` with a number, which picks the algorithm: `shasum -c` reads
every file a list names.

`sed -n Np` and `sed -n N,Mp` of one file is how models read a range of
lines, so `sedEffects` asks `std::read` for that one shape: the flag
`-n`, a script of digits, an optional comma and digits, then `p`, and one
path. With no path and a pipe feeding it, as in `git log | sed -n 1,5p`,
it is a stage like `head` and adds no question. Every other sed has no
rule: `w` in a script writes a file, and GNU sed's `e` runs a command.

Every letter means the same thing in GNU coreutils, BSD coreutils, and
busybox. These are left out on purpose:

- `cat -A -e -t -v`: GNU and BSD spell the escapes differently.
- `tail -f`: it never returns.
- `tail -r`: BSD only.
- `wc -L`: GNU only.
- `diff -r`: it reads a whole tree under a question that names one folder.
- `diff -y`: its column width depends on the terminal.
- `sort -o`: it writes a file. `sort -m` and `-c` change what sort does.
- `uniq`'s second positional: it is the output file.

`tac` is not on macOS. A line with it is recognized, and the shell
reports it missing. `sort` may spill a large input to files under
`$TMPDIR`, and no payload names those files.

### What a read verb reads

`readFileVerb` checks a command against its row and answers a
`FileRead`: `{ kind: "files", paths, split }`, or `{ kind: "stdin" }`
when it names no path. It never sees the pipe flag. A `stdin` answer goes
to `stdinStage`, so `git log | head -20` asks only the git question.

`head -20` parses as one flag named `-20`. The head and tail rows set
`digitFlag: "n"` on their `FlagSpec`, so `readFlagWord` reads a bare digit
flag as the value of `-n`. A digit flag after `-n` is read as `-n`'s
value, the way any next word is, so `head -n -5` is refused as a value
that starts with a dash. GNU reads that as "all but the last five". The
same rule refuses `find . -size -1M`, because the parser makes `-1M` a
flag word. A row's
`countFlags` must have digit values, so `tail -n +5` and `diff -U x` are
refused too.

Every path must be literal, and it must name a regular file.
`resolveReadPath` resolves each one with `_searchTargetIn`, the resolver
grep uses, which realpaths the path and stats it. An input redirect's
target goes through the same function:

- A folder is refused. With folders, `diff a b` reads every file under
  both, following links, under two questions that name only `a` and `b`.
- A FIFO or a device is refused. `wc -l pipe` would not return until
  `runBash`'s time limit stopped it.
- A missing path has a rule only through `missingPath` (see "Resolving
  the path when the plan is made").

The payload names the file's real parent as `dir` and its name as
`filename`, so a link to `~/.ssh/id_rsa` names `~/.ssh`.

### On the bash path

`otherVerbEffects` is the `effectsFor` arm for every verb with no arm of
its own. For a read verb it raises one `std::read { dir, filename }` per
path, the effect the read tool raises. `recommended` approves `std::read`
under the launch directory, so `wc -l one.txt` there needs no prompt.

`<` follows the same rules. `redirectEffect` raises `std::read` for an
input redirect, the mirror of `>` raising `std::write`, and one input and
one output redirect may both appear. A stdin reader whose only input is a
redirect (`cat < one.txt`) names no path and is not in a pipe, so it
stays unrecognized.

`tr` is the one filter whose positionals are not paths. They are
character sets, so `tr` has its own arm in `effectsFor`. `trEffects`
checks the sets are literal and that there are as many as its flags take
(`TR_SET_COUNTS`, a `CountRange` per flag set), then calls
`stdinStage`.

The bash parser reads a comma joined to a flag as part of the flag, so
`cut -d, -f1 a.txt` and `sort -k2,2n a.txt` parse. The read tables judge
them like any other spelling: each asks `std::read` for `a.txt`.

### A lone cat, head, or tail runs the read tool's read

`tryShellFreeRead` applies to a lone `cat` of any number of files, and
to a lone `cat -n`, `head -n N`, or `tail -n N` of one file, with no
redirect, where N is at least 1. `head` and `tail` take one file because
each prints a `==> name <==` header per file when given several;
`READ_VERBS` says so, and `readFileVerb` applies it. The plan raises one
`std::read` per file and runs `printRead`, which reads the files in order
with `_read`, joins the texts, and prints the joined text once with
`_renderReadView` (`lib/stdlib/readDialect.ts`). A first file with no
final newline runs into the second, as real `cat` prints it. The views:

- `whole`: the text as it is.
- `numbered`: each line after its number, right-aligned in six columns,
  and a tab. A last line with no newline is numbered and keeps no
  newline. An empty file prints nothing.
- `head`: the first N lines, each with its newline if it had one.
- `tail`: the last N lines. A last line with no newline counts as one.

Only `\n` ends a line, so a `\r` stays inside its line. A count of 0 is
refused, because BSD `head -n 0` prints an error and exits 1 while GNU
prints nothing. `cat -n` of more than one file is refused too: GNU
numbers the files as one stream and BSD starts again at 1 for each.
`cat -b`, `cat -s`, and `-c` go through bash.

A count given twice never reaches the renderer. `splitFlags` takes a
valued flag once, so `head -n 1 -n 2` and `head -2 -n 1` are refused on
every path and ask `std::bash`. GNU head and tail take the last count,
BSD head takes the last, and BSD tail refuses the line, so no one
answer would be right.

`printRead` returns `_read`'s own failure. The plan already refused a
missing file or a folder, so a failure there is a race or a permission
error, and `_read`'s message says which. The text of the files read
before the one that failed is dropped.

`shellFreeReadMatchesRealTools` runs each shell-free row and the real
program over `tests/agency/stdlib/read-fixtures/`, and compares the
output exactly. The fixtures include a file with no final newline, an
empty file, and a file with Windows line endings.

These are left out:

- `wc` in process. GNU and BSD pad the count column differently.
- `head` and `tail` of more than one file: each prints a header per file.
- `cat -n` of more than one file.
- The text of the files before one that failed to read: real `cat`
  prints them, and the shell-free read returns the failure alone.
- `file`, `stat`, `md5sum`, `shasum`, `column`, `xxd`, and `hexdump`.

## Listings

A listing asks the question the `ls` tool asks, and a `find` asks the
question the `glob` tool asks. So `recommended` approves both under the
launch directory with no prompt, and `ls /etc` or `find ~ -name '*.pem'`
still reaches a person. Both run real programs through bash. Nothing
here is shell-free.

### `ls`, `tree`, and `du`

`LIST_VERBS` gives each listing verb its flags, the valued flags that
hold a count, whether it walks the tree, and what a file given to it
asks:

| Verb | Flags | Count flags | Walks the tree | Given a file |
|---|---|---|---|---|
| `ls` | `l a A h 1 t r S R d p F --color=never` | none | with `-R` | its folder |
| `tree` | `a d --noreport`, valued `L I` | `L` | always | refused |
| `du` | `s h a c`, valued `d` | `d` | always | its folder |
| `stat` | none | none | never | its folder |

`stat` prints a file's or folder's size, owner, and times, which `ls -l`
prints too, so it asks what `ls -l` asks.

`listEffects` raises one `std::ls { dir, recursive, maxResults: 0 }` per
folder named, and `.` when none is named. Every path goes through
`resolveTargets`: it must be literal, and the payload names the real
folder. A glob word makes the command unrecognized, and a missing path
follows `missingPath`, except under `tree`, which needs a real folder. A
listing ignores its stdin, so `git log | ls` is a listing of `.`.

A file given to `ls` or `du` asks for the folder that holds it, with
`recursive: false`. `ls -la one.txt` prints one entry of that folder,
and `du one.txt` prints that one file's size, so the question names
more than runs, which fails safe: a policy that approves listing the
folder has approved seeing every entry in it. `tree` of a file prints
the name and an error, so it's refused, and so is `find` of a file,
because `std::glob` searches a folder. `requireFolder` is the one place
that refusal is written.

A path that is missing when the plan is made is asked about as the folder
it would be: `pnpm build && ls dist` with no `dist` asks `std::ls` for
`<cwd>/dist`. Once the build has made `dist`, the plan made just before
the step asks the same thing, so the line runs. If it asked for the
folder that would hold it, the two plans would differ and the line would
stop. The one exception is a file the line itself wrote, as in `pnpm test
> out.txt; ls -la out.txt`, which is known to be a file and asks for its
folder.

`mergeListings` asks once per folder. `ls one.txt two.txt` in one folder
is one question, and a folder named twice is recursive if either path
walks it, so `ls -R . one.txt` and `ls -R . .` are one recursive
question each.

### Paths whose last step is a link

The resolver follows every link, so a payload names the target. Some
programs print the link's own entry instead, from the link's folder,
and the two can be different folders. Say `/tmp/x.txt` links into the
project: the payload would name the project folder, `recommended` would
approve it, and `ls -l x.txt` would read an entry in `/tmp`.

What each program does with a link operand:

| Operand is a link to | Command | Prints | Rule |
|---|---|---|---|
| a file | `ls link.txt`, `ls -l link.txt` | the link's own entry | refused |
| a folder | `ls dirlink`, `ls -R dirlink`, `ls -a dirlink` | the target's contents | allowed: the payload is true |
| a folder | `ls -l dirlink`, `ls -d dirlink`, `ls -F dirlink` | the link's own entry | refused |
| a folder | `du dirlink`, `tree dirlink`, `find dirlink -name x` | the link's size, its name, nothing | refused |

POSIX says `ls` follows a link to a directory given as an operand
unless `-F`, `-d`, or `-l` is given, and GNU and BSD both do.
`followsFolderLink` holds that rule, and `LS_LINK_FLAGS` the three
flags. du, tree, and find follow a link operand only under `-H`, `-L`,
or `-l`, which their rows refuse.

So a file whose last step is a link is always refused, and a folder
whose last step is a link is refused unless plain `ls` follows it. The
rule keeps pnpm's `node_modules`, where each package is a folder link,
approved: `ls node_modules/react` asks `std::ls` for the real folder
under `.pnpm`. A link to a file in the same folder is refused too,
which is the safe direction. A trailing slash (`ls -l dirlink/`) makes
every program follow the link, but it does not change the rule: plain
`ls dirlink/` is allowed and the rest are refused, which is the safe
direction for the ones that would have followed it. On macOS, `/etc` and `/tmp` are
links, so `ls -l /etc` and `find /tmp -name x` ask `std::bash`, while
plain `ls /etc` still asks `std::ls`.

`lastStepIsLink` finds a link with the resolver alone. The written
path's last step is a link exactly when its last segment differs from
the real one, or its parent's real folder differs from the real parent.
It skips `.`, `..`, and `/`, which can't be links. A link earlier in the
path is fine, because both sides are realpathed through it.

Left out: `-L` on every verb, because it follows symlinks out of the
folder. `ls -G` is left out because it turns on color on macOS and hides
the group column on GNU. `tree` is not on macOS by default. The line is
recognized, and the shell reports it missing, as with `tac`.

### `find`

`findEffects` raises one `std::glob { pattern, dir, maxResults: 0 }` per
path. `FIND_FLAGS` is an allowlist of whole words: `-not -o -a -prune
-print -print0`, and valued `-name -path -type -maxdepth -mindepth
-size`. An unlisted word makes the command unrecognized, which keeps
`-exec`, `-delete`, `-fprint`, `-L`, and the ones the list forgot on the
`std::bash` path. `-exec rm {} \;` does not parse at all. `-newer` reads
another file's time. `-iname` matches without case, and the glob tool's
pattern does not. `-H` and `-P` are taken only before the paths, where
the ordering rule refuses them.

The table sets `wholeWords` (see `FlagSpec`), so `readFlagWord` reads
`-name` as one word and not as the letters `n a m e`. An unknown word
is refused by its whole name (`find does not take -delete`). No verb
mixes the two kinds, so a table holds letters or words.

find's paths come first and its expression after. A `find` with no path
is refused, because BSD `find -name x` is a usage error while GNU reads
`.`. A path after the first expression word is refused, because it is a
usage error in find's grammar. Every path must be a folder. `-name` may
appear once, the rule `splitFlags` applies to every valued flag, so
`find . -name a -o -name b` asks `std::bash`. `-maxdepth 0` is refused,
because it lists only the path itself and no pattern says that.

The pattern describes find's search or a wider one. It never describes
a narrower one. The glob tool matches a pattern against the whole
relative path, with `*` stopping at `/`, while `-name` matches the last
part of the path at any depth. So `findPattern` gives:

| `-name` given, with no `-not`, `-o`, or `-prune` | `-maxdepth 1` | Pattern |
|---|---|---|
| yes | no | `**/` and the value |
| yes | yes | the value |
| no | no | `**` |
| no | yes | `*` |

The three words widen or invert what `-name` selects. `-not -name x`
lists everything except `x`. `-name x -o -type d` lists `x` and every
folder. `-path ./node_modules -prune -o -name x` lists `./node_modules`
too. `**` says the search may list anything under `dir`, which is true
of every expression the allowlist accepts, and it keeps the common
`-not -path '*/node_modules/*'` narrow. So `find . -name a -o -path b`
is narrow, with pattern `**`.

### What a recursive listing shows

The `ls` tool's recursive walk and the `glob` tool's walk skip `SKIP_DIRS`
(`node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`) and what
`.gitignore` ignores. Real `ls -R`, `du`, `tree`, and `find` skip nothing. A
recursive listing through bash is still narrow under the same payload. It
shows the names the tools leave out, and no file's contents. The names are
not what decided grep, where a directory search through bash asks
`std::bash` because real grep reads the contents the tool skips.

## Programs with no rule

A program that no arm of `effectsFor` and no table owns raises
`std::exec`, the question the `exec` tool asks for the same program and
arguments. `pnpm test`, `make`, `pytest tests`, and `tsc --noEmit` all
take this path. The step sits at the end of `otherVerbEffects`, where
the line used to fail with "no rule for", and `execEffects` builds it.

The payload has the exec tool's fields: `command` is the program,
`args` its arguments, `cwd` safeBash's resolved folder, `timeout` the
line's time limit in
milliseconds (see "The time limit"), and `stdin` empty. The full
line goes in an extra field, `line`, because `std::exec` already uses
`command` for the program and `@always` pins it. The line then runs
through bash, as every narrow plan does.

It differs from the exec tool's payload in three ways:

1. A glob argument (`pytest tests/*.py`) is carried unexpanded, and
   bash expands it. The exec tool passes its arguments through as they
   are.
2. An unquoted `~` in an argument (`node ~/x.js`) is carried as written,
   and bash expands it.
3. bash runs with the environment scrubbed (see "Which shell runs the
   text"), while the exec tool spawns with the process's environment. So
   a program approved through safeBash runs with slightly less, which is
   the safe direction.

Ownership needs no list of its own. A verb with an arm or a row fails
inside it when the spelling isn't one it describes, so `git push`,
`find . -delete`, and `tail -f` never reach this step. They keep asking
`std::bash`. Otherwise a saved rule for an innocent git subcommand, or
for `find .`, would start covering them.

These stay broad, each for a reason:

- **Bash builtins** (`BUILTIN_VERBS`, the `compgen -b` list). The exec
  tool can't run a builtin, so no payload of its shape describes one.
  Some builtins also change what later commands do: `hash -p /tmp/x
  git` makes `git` run `/tmp/x`, `enable -f` loads a shared object as a
  builtin, and `export NODE_OPTIONS=...; pnpm test` is the
  leading-assignment case spread over two commands. The message is
  "`hash` is a bash builtin, not a program". A `cd` has its own rule
  (see "`cd`"). It reaches this refusal only on the right of `&&` or
  `||`, or in a pipeline.
- **Programs that run other programs** (`NO_EXEC_PROGRAMS`). The
  wrappers (`sh`, `xargs`, `env`, `sudo`, ...) would put the wrapper in
  the payload while what runs is in its arguments. The package runners
  (`npx`, `bunx`, `uvx`, `pipx`) take a flag first, so the widest
  "always approve when" choice for `npx -y foo`, `npx -y …`, would cover
  every package. `agency` is
  here because a lone `agency` line runs in process, and `recommended`
  approves `std::exec` for agency's safe subcommands, which were chosen
  for the exec tool. `which` and `whereis` are here because a lone
  `which agency` is refused by `tryAgencyPlan`, and a chain must not turn
  the same lookup into a question a saved rule answers; the quiet table
  takes a `which` before this list is read (see "Commands that only
  print"). `cp`, `mv`, `ln`, and `sed` do one narrow thing to files, and
  the widest `std::exec` rule pins only the first argument: "always
  approve when" for `mv -f a b` could cover every forced move, one for
  `sed -n` covered `sed -n '1e
  cmd'` and `sed -n 'w file'`, and one for `ln -sf` would let a later
  command read a file swapped for a link (see "Resolving the path when the
  plan is made"). A new program that can replace a file joins this list
  before it gets any rule. `timeout` and `gtimeout` are here for every
  spelling `unwrapTimeout` does not read through. These keep the message
  "no rule for `xargs`", because that's still true and the rejection
  fixtures pin it.
- **A program fed by a pipe or `<`** (`pipedProgram`). The payload's
  `stdin` is empty, so it can't describe what the program reads.
  `< /dev/null` is not input.
- From earlier checks: a leading assignment outside the quiet list (see
  "Assignments in front of a command"), and a command word that isn't
  literal (`./gradlew`).

What a saved rule covers: "always approve when" pins the program, as much
of its arguments as the person picks, and the folder, the same as for the
exec tool (see "The command step" in
`docs/dev/agents/approval-policies.md`). The widest choice for `pnpm test`
covers `pnpm test` with any later arguments, in the folder picked.
`node -e '...'` is as broad as `sh -c`, so for an interpreter the person
should pick "this exact command", which pins the program text. The same
goes for every program that takes its program as text: `python3`, `perl`,
`ruby`, `awk`, and `jq`. A rule for `awk '{print}'` followed by anything
still covers every file named after the program text. `rg --pre=<program>` runs
another program for each file, so a saved rule for `rg` covers that
too.

## Commands that only print

`QUIET_VERBS` lists commands that reveal nothing and change nothing.
Inside a line each adds no question, as `echo` does, so `pwd; ls src`
asks one `std::ls`. Some are bash builtins and some are programs; the
table is checked first, in `otherVerbEffects`, so a spelling it accepts
never reaches the builtin refusal or `NO_EXEC_PROGRAMS`.

| Verb | Flags | Words |
|---|---|---|
| `pwd` | `-P -L` | none |
| `true`, `false`, `:` | none | any |
| `printf` | none | a literal format that does not start with `-` and holds no `%n`, then words that are literal or `$?` |
| `basename`, `dirname` | none | literal |
| `sleep` | none | one number |
| `date` | `-u` | at most one `+FORMAT` word |
| `uname` | `-a -s -r -m` | none |
| `whoami`, `hostname` | none | none |
| `which` | `-a` | literal names, none with the last path segment `agency` |
| `type` | none | the same |
| `command` | `-v`, required | the same |

A spelling the table does not accept has no rule, and the line asks
`std::bash`: `date -s` and `date 0101` set the clock, `hostname x`
renames the machine, and `command ls` runs a program. `printf -v NAME`
sets a shell variable, `PATH` included, so the next command in the line
would run a program from another folder under an approval for the real
one. The parser reads `"-v"` as a quoted word, and bash still takes it as
the option, so the check reads the format's text. `%n` in a format sets
a variable too: `printf 'aaa%n' PATH` leaves `PATH` as `3`, so a format
with a `%n` conversion, modifiers or not, has no rule. A variable argument to
`printf` would print what no `std::env` question named. `env` and
`printenv` are not in the table, because they print the environment.

## A line that asks nothing

When every command in a line is recognized and none raises an effect,
`planLine` asks one question for the line, unless the line starts no
shell (see "Each step decides for itself"). `pwd`, `echo "---"`, `which
node; date`, and `echo hi | grep h` all end here. When
every word in the line is known now (`everyWordKnown`: `isLiteralWord`,
or a word made only of such text and `$?`), it asks
`std::bash::readonly { command, cwd, timeout }` and runs the rebuilt
text, so the plan is narrow. `timeout` is the limit the line runs under,
as in `std::bash`, so a job started with `startJob("sleep 600")` shows
its limit. Otherwise, as in `echo $RANDOM`, it asks `std::bash` for the
original text, with the reason `noEffects`. A line with an environment
variable in it never gets here, because it asks `std::env` (next
section).

## A variable in a word asks `std::env`

Bash expands a variable and the model reads what it printed, so a narrow
line asks the question the `env` tool asks, `std::env { name }`, once for
each environment variable a word of it holds:

```
git status && echo $GITHUB_TOKEN     # std::git::status, std::env GITHUB_TOKEN
echo $HOME                           # std::env HOME
```

`envEffects` adds the questions in `classifySimple`, for every command
and not only `echo`, so a command that later accepts a variable is
covered with no further change. `variablesOf` finds a name alone (`$X`),
inside double quotes (`"t: $X"`), and joined to text (`pre$X`,
`--token=$X`), in a command's words and in its assignments' values.

- **Computed names ask nothing.** `$?`, `$0` to `$9`, `$RANDOM`, and
  `$SECONDS` hold nothing from the environment (`COMPUTED_VARIABLES`).
- **The question sits on the command's step.** The plan made just before
  the step asks it again, so the two plans match and the line runs.
  `planLine` drops a repeated name (`askedOnce`), so `echo $A; echo $A`
  asks once.
- **The payload has no field for the command**, because the effect is
  the `env` tool's. The message carries the command.

`printf` still refuses a variable argument, and a variable in any other
command's words has no rule, so those lines ask `std::bash`. The test
nodes are `variablesAskStdEnv` in `tests/agency/safeBash.agency`, and
`aLineWithAVariableRuns`, `aVariableIsAskedOnce`, and
`aRejectedVariableRunsNothing` in `tests/agency/safeBashSteps.agency`.

`std::bash::readonly` is declared in `stdlib/shell.agency`, with
`@always(command, cwd)`. `recommended` approves it, so a lone `pwd` asks
no person. It is in the `Shell` effect set, so `--reject Shell` rejects
it, and the approval prompt colors it as a shell question. A saved policy
does not follow `recommended`: someone whose `~/.agency-agent/policy.json`
was written before it existed gets the rule only after `/policy` updates
the file. Until then a lone `pwd` asks them the new question.

## `timeout`

`timeout 60 pnpm test` runs `pnpm test` and stops it after a minute, so
it asks what `pnpm test` asks. `unwrapTimeout` reads through `timeout` or
`gtimeout` (the name coreutils gives it on macOS) when its first word is
a number with an optional `s`, `m`, or `h` unit and a command follows.
The wrapper is read in one place for each reader: `flattenOne` hands the
refuse wall the command inside every layer of it, so `timeout 5 rm -rf /`
and `timeout 5 timeout 5 shred x` are refused, and `classifySimple`
classifies the command inside one layer. No verb rule knows the word.

`withTimeout` puts the wrapper back in front of the command the rule
returned. The assignments go in front of `timeout`, the model's and any
the rule added, such as the `GH_HOST=github.com` that `ghCommand` puts on
a search: after it, `timeout` would look for a program called
`GH_HOST=github.com`. A rule that returns more than one command, as a
`git diff` does, has no rule under `timeout`. So does a flag on `timeout`
(`-s KILL`) and a second `timeout`.

## Assignments in front of a command

A leading assignment can make an approved program run other code:
`PATH=/tmp/evil:$PATH pnpm test`, `NODE_OPTIONS='--require ./x.js' pnpm
test`, `GIT_SSH_COMMAND=... git fetch`. No payload has a field for the
environment, so a saved rule for `pnpm test` would approve all of these.

`QUIET_ASSIGNMENTS` is the exception: `TERM`, `NO_COLOR`, `FORCE_COLOR`,
`CLICOLOR`, `CLICOLOR_FORCE`, `COLUMNS`, `LINES`, `LC_ALL`, `LANG`, and
`TZ` change how output looks. `quietAssignments` accepts one only with a
literal value of letters, digits, and `. _ - :`. A value with a `/` has
no rule, because the C library reads `TZ=/some/path` and a locale name
with a slash as a file to open. `NODE_ENV` changes which config a program
loads, and `CI` changes what programs do (`pnpm install` uses the frozen
lockfile), so neither is on the list.

A command safeBash writes for git, gh, or grep starts with no assignments
of the model's, so `withAssignments` puts them back in front of each
simple command the rule wrote, before any safeBash adds:
`NO_COLOR=1 gh search issues crash --repo o/r` runs as `NO_COLOR=1
GH_HOST=github.com gh search issues ...`, and `TERM=dumb git diff` puts
`TERM=dumb` in front of both commands of the guarded diff.

## `mkdir`, `touch`, and the files they make

`mkdir` asks `std::mkdir { dir }` for each folder, with the real path the
`mkdir` tool puts in its own payload. `_realPathIn` (`lib/stdlib/
safeBashRemove.ts`) is that resolver, shared with `rm`: steps that exist
are resolved through links, every step after the first missing one is
kept as written, and a dangling link fails. `touch` asks `std::write {
dir, filename, content: "", mode: "append" }` for each file, resolved by
the resolver `>` uses, since touching a file appends nothing to it. The
`with-writes` policy approves both under its folder. `mkdir -m` and
`touch -t` are not in the table.

`cp` and `mv` ask `std::bash` for now. A rule for them must name the file
that lands, which depends on whether the destination is a folder, handle
several sources, a link as a source (which `cp` follows and `mv` moves),
and the refusals `rm` has, since `mv` deletes its source.

## git

```
git log --oneline -n 5 src
```

This asks `std::git::log` with `ref: ""` and `path: "src"`, the effect the
`gitLog` tool raises, and runs:

```
git -c core.pager=cat -c core.fsmonitor=false --no-optional-locks log --oneline -n '5' -- src
```

### The rule

A git command is recognized only when an existing `std::git::*` effect
describes it completely. The rule fills that effect's payload from the
command's own words. So a policy that approves the `gitCommit` tool in a
project approves `git commit -m "..."` there, with no change to the
policy. A read with no effect of its own asks an existing effect when
it prints a part of what that effect already shows (see "Reads that map
onto another effect"). A command with no such effect (`git push`, `git
revert`, `git fetch`) has no rule and asks `std::bash`.

A flag is allowed only when it leaves the payload true. A flag that
changes how the result is shown (`--oneline`, `--stat`) or shows less of
it (`-n 5`, `--author=dana`) is allowed. A flag that shows more or does
something else is not: `--all` on log shows every branch, `--no-index`
on diff compares files outside the repository, and `--output` on diff
writes a file. The tables are allowlists, and the comment above
`GIT_VERBS` names what was left out and why.

### What is recognized

Reads:

| Subcommand | Words | Effect |
|---|---|---|
| `status` | none | `status { cwd }` |
| `log` | at most one ref and one path | `log { cwd, ref, path }` |
| `diff` | at most two refs and one path | `diff { cwd, ref, ref2, staged, path }` |
| `show` | at most one ref | `show { cwd, ref }`, `HEAD` when none is given |
| `blame` | exactly one path | `blame { cwd, path }` |
| `branch`, with a listing flag or alone | none, or one after `--merged` or `--no-merged` | `branchList { cwd }` |
| `remote`, `remote -v` | none | `remoteList { cwd }` |
| `stash list` | | `stashList { cwd }` |

Writes:

| Command | Effect |
|---|---|
| `add <paths>`, `add -A` | `add { cwd, paths, all }`; a bare `git add` stages nothing and has no rule |
| `commit -m <msg>` | `commit { cwd, message }` |
| `commit -am <msg>` | `add { cwd, paths: [], all: true }`, then `commit` |
| `checkout <ref>` | `checkout { cwd, target, force: false }` |
| `checkout -b <name>`, `switch -c <name>` | `switch { cwd, branch, create: true }` |
| `switch <name>` | `switch { cwd, branch, create: false }` |
| `branch <name>` | `branchCreate { cwd, branch }` |
| `branch -d <names>` | one `branchDelete { cwd, branch, force: false }` per name |
| `stash`, `stash push`, with one `-m` | `stashPush { cwd, message }` |
| `stash pop` | `stashPop { cwd }` |
| `restore --staged <paths>` | `restore { cwd, paths, staged: true }` |

`commit -a` asks for the staging as well as the commit. The add's `all:
true` describes staging everything, which is slightly more than `-a`
does, so the approval covers what happens.

Not recognized, on purpose: a forced form (`branch -D`, `checkout -f`),
`commit --amend` and `--no-verify`, a start point (`branch name start`,
`checkout -b name start`), `add -u`, `stash -u` and `stash drop`, a path
on `show` or `status`, and a ref on `blame`. For the last three the
effect has no field to hold the word.

`log` and `show` take `--format` and `--pretty`, which change how the
result is shown. Their rows set `quotedValues`, so `--format="%h %s"`
is read as the flag (see "The flag table" under grep), and the value runs
as one quoted word.

### Reads that map onto another effect

These subcommands have no effect of their own. Each prints a part of what
an existing effect already shows, so it asks that effect:

| Command | Asks | Why the payload is true |
|---|---|---|
| `rev-parse <ref>`, alone or with `--short`, `--abbrev-ref`, `--verify` | `log { cwd, ref, path: "" }` | It prints the hash or name of a commit that `git log <ref>` prints. |
| `rev-parse --show-toplevel`, `--git-dir`, `--is-inside-work-tree` | `status { cwd }` | It prints where the repository is. |
| `merge-base A B` | `log` for `A` and for `B` | It prints one commit from the history of both. |
| `ls-files [folder]` | `std::ls { dir, recursive: true, maxResults: 0 }` | It prints names under the folder, which `ls -R` prints too. |
| `grep <pattern> [paths]` | `std::grep` per path | It searches tracked files under each path, minus the six names the grep tool skips. |
| `grep <pattern> <ref> [-- paths]` | `show { cwd, ref }` | It reads files of that commit, which `git show <ref>:<path>` already reads under the same question. |
| `worktree list` | `branchList { cwd }` | It prints the branches checked out and where. |

`rev-parse` with flags of both kinds, or any other flag (`--git-path`),
has no rule. `ls-files --others` lists every ignored file without
`--exclude-standard`, `node_modules` included, so the two are allowed
only together. `git grep` takes `-n -i -l -w -E -F -c`. `--no-index`
reads outside the repository, and `-O` and `--open-files-in-pager` run a
program, so none of them has a rule.

A repository can track files under a folder the grep tool skips, such as
`dist`. For a `git grep` with no ref, `gitGrepRule` writes two exclude
pathspecs per name in `SKIP_DIRS` after the paths, `':(top,exclude,glob)**/<name>/**'`
and `':(top,exclude,glob)**/<name>'`, so git grep reads no file the tool
would skip. `top` reads each from the top of the repository, so `git grep
x ..` from a subfolder does not reach a `dist` beside it. With no path from the model it writes `.` first, because git
needs one pathspec that is not an exclude. `gitRunsSafely` commits a
match under `dist` and checks git grep does not print it. The pattern is
always written after `-e`, so a pattern that starts with `-` is never a
flag. The form with a ref writes no excludes: an approval of `show` in a
repository already covers reading any file of any commit there.

### Flags before the subcommand

`gitLeadingFlags` reads two flags before the subcommand. `--no-pager`
changes nothing, because the fixed flags already set `core.pager=cat`,
so it is dropped. `-C <dir>` runs git in that folder, which is `cd <dir>
&& git ...`, so the folder is resolved by `cdTarget`'s rules, and each
`-C` is read from the folder the one before it named, as git does. Every
payload names that folder, and `inGitFolder` writes `-C '<folder>'`
after the fixed flags in each git command the rule built, the repository
check in front of a diff included. Any other leading flag, such as `-c`
or `--git-dir`, has no rule. The refuse wall reads past the same two
flags (`afterGitLead`), so `git --no-pager checkout .` and `git -C x
reset --hard` are refused.

### safeBash writes the git command it runs

Every other narrow command runs as the text that was classified, printed
back from the tree. A git command does not. Git reads a command line
with rules of its own, and they can disagree with the classifier in ways
that matter:

- `git diff /dev/null /Users/me/.ssh/id_rsa` prints the file. Given two
  words, one of them a path outside the repository, git compares the two
  files, as `git diff --no-index` does. No flag is needed.
- `git checkout '*.py'` discards the changes to every Python file. When
  the word is not a ref, git reads it as a pathspec, a pattern it matches
  itself. The quotes make it literal text to bash and to safeBash.

A `--` settles both. Git reads the words before it as refs and the words
after it as paths, and fails when a word is not what its side says: `git
diff /dev/null -- <file>` is "bad revision", and `git checkout '*.py' --`
is "invalid reference". So `gitCommand` assembles the command:

```
git <fixed flags> <subcommand> <flags> <refs> <names> -- <paths>
```

1. The fixed flags are `GIT_HARDENING_FLAGS`, the list the git tools put
   on every git command (`lib/stdlib/gitCore.ts`), read through
   `_gitHardeningFlags` so the two paths cannot drift. They turn off
   `core.fsmonitor`, a setting in the repository's config that names a
   program git runs on `git status`.
2. The flags are built from what `splitFlags` returned, and are not
   copied from the model's text. `splitFlags` returns checked data, a
   list of plain flags and a list of flags with values, and does not keep
   the words. So `-n5`, `-n 5`, and `-5` all run as `-n '5'`. A letter's
   value is written as a quoted word of its own, because a bare `~/x` in
   a commit message would be expanded by bash. A long flag's value is
   part of the flag word, and the printer quotes the whole word when the
   value needs it.
3. The refs, names, and paths are the parser's own words, kept as
   `GitWord` beside their text. The text goes in the payload. The word
   goes in the command, so the model's quoting is kept and a quoted
   `'~/x'` stays quoted. An unquoted word that starts with `~` has no
   rule (`gitWordsOf`): bash would expand it, so the payload's `~/x`
   would not be the path git gets, and the git tools read the same text
   as a folder named `~`. `git add ~/x` asks `std::bash`.
4. The `--` is written whenever the subcommand's words are refs or paths,
   including when there are no paths. `git checkout main` runs as `git
   ... checkout main --`. A subcommand whose words are names (`switch`,
   `branch`) gets none.
5. The model's redirects stay on the command, and `redirectEffect` asks
   about them as for any other verb.

The result is a `SimpleCommand`, the parser's type, so `astToBash` prints
it and quotes what needs quoting.

`stash` writes its action right after the subcommand, before the flags
(`git stash push -m 'wip'`): after them, git would read `push` as a path
to stash. `branch` writes `--merged` last, right before the branch it
compares with.

### A diff runs behind a repository check

Outside a repository `git diff` ignores the `--` and compares files. The
model chooses the working directory with `cd`, so the `--` alone is not
enough for `diff`. A recognized `git diff` runs as:

```
(git <fixed flags> rev-parse --show-toplevel > /dev/null && git <fixed flags> diff <flags> <refs> -- <paths>)
```

When git sees no work tree, `rev-parse` fails and the diff never runs:
"not a git repository" outside one, and "this operation must be run in
a work tree" in a bare repository or inside a `.git` folder.
`--is-inside-work-tree` would not do, because in those two it prints
`false` and exits 0. The parentheses make the pair one
unit, which the parser allows as a stage of a pipe, so `git diff main |
head` works.

The check runs when the command runs, and git answers it. Looking for a
`.git` folder while planning would be a second guess about what git will
do: an empty folder named `.git` passes that check, and git still sees no
repository. No other subcommand needs the check, because each fails by
itself outside a repository. `gitRunsSafely` runs the guarded diff in a
folder with no repository above it, in a bare repository, and inside a
`.git` folder.

`diff` takes at most one path, and that limit is a safety rule. Two
paths after `--` is the one spelling that still compares files outside
the repository, so `git diff -- a.py b.py` has no rule.

### Refs and paths

`log`, `diff`, `show`, `blame`, and `checkout <ref>` read their words as
refs and paths (`GitWords` is `refsAndPaths`).

- With a `--`, the words before it are refs and the words after it are
  paths, whether or not they exist. The parser returns `--` as a flag
  word, so `gitArgsFor` splits the words at it before `splitFlags` sees
  them.
- With no `--`, a word that names a file or folder on disk is a path, and
  any other word is a ref (`refsAndPathsByDisk`). The check is
  `resolveTarget` on the parser's word, the function that decides whether
  `cat <word>` reads a file.

Because the command that runs has a `--`, a wrong sort cannot make git do
something other than what was asked. It can make git fail, or answer a
different question than the model meant, in three cases:

- A word that is both a branch and a folder, such as `docs`. safeBash
  asks about the path and runs `git log -- docs`. Plain git would have
  refused the command as ambiguous. The model writes `git log docs --`
  for the branch.
- A path that no longer exists. `git log removed.py` is sorted as a ref,
  and git fails with "bad revision". The model writes `git log --
  removed.py`.
- A path made earlier in the same line, since the plan is made before
  anything runs (see "Resolving the path when the plan is made").

`checkout <ref>` allows exactly one ref and no path. A word that names a
file is a path, so `git checkout utils.py`, which discards the changes
to that file, has no rule. A word that is not on disk and is not a real
ref makes git fail, because of the `--`. So a discard never runs under a
`std::git::checkout` approval. `checkout -b <name>` is read first, as a
name, so `git checkout -b src` works beside a `src` folder.

### One path into the rules

`simpleCommandRule` is the one function every simple command is
classified by. It makes four checks before it looks at the verb: there is
a command word, the word is literal (`/bin/git` is not `git`), every
leading assignment is a quiet one (`GIT_DIR=/x git status` is not), and
the redirects have effects. It returns the effects and the command to
run. For every verb but git, gh, and a grep of paths, the command is the
one it was given.

`effectsFor` is a call to `simpleCommandRule` that returns the effects.
`classifySimple` calls it and passes on both. `gitEffects` has no other
caller, so no path reaches a git rule without the four checks. A second
caller would have to repeat them, and one that forgot the redirects would
let `git log > ~/.zshrc` ask only `std::git::log`.

### The table and the functions

Ten subcommands have one shape, and each is a row of `GIT_VERBS`: its
flags, how its words are read, and how many refs, paths, and names it
takes. `gitRowRule` checks any row, and `gitPayloads` fills the payload
with one `match` arm per subcommand. Adding one is a row and an arm.

For `branch`, `stash`, `commit`, `checkout`, `rev-parse`, `ls-files`,
`worktree`, and `grep` the allowed words or the effect depend on the
flags or on the disk, so each has a function of its own, using the same
helpers.
`branch` is the one to be careful with: `git branch -v newname` creates a
branch, so a listing flag beside a name has no rule, and only `--merged`
and `--no-merged` take a word.

### What git itself can run

Approving a git effect approves running the `git` program, and git can
run other programs. The shell path and the git tools compare like this:

| | Git tool | Git through safeBash |
|---|---|---|
| `core.fsmonitor`, the pager, optional locks | fixed flags | the same fixed flags |
| Refs and paths | separated with `--` | separated with `--` |
| `git diff` outside a repository | compares files | does not run |
| `GIT_DIR` and the other variables | removed | removed (see "Which shell runs the text") |
| Time limit | 30 seconds | none |
| Output size | capped at 2 MB | saved by the spill tools past a preview |
| `destructive` mark on a write | yes | no (see "Why a bash call is never destructive") |

On both paths the repository's own config still decides what runs for
hooks on commit and checkout, `diff.external`, textconv filters, and
`gpg.program`. A policy that approves a git effect in a repository
approves whatever that repository's config names for those. That makes a
write under `.git` the thing to guard, and `**` in a policy rule never
matches a dot-led folder (`docs/dev/agents/approval-policies.md`).

Any agent that carries `safeBash` can now write to git when the policy
approves the effect, including the agents whose own git tools are
read-only.

## gh

```
gh pr view 1451
```

In a checkout whose `origin` is `github.com/egonSchiele/agency-lang`, this
asks `std::github::prGet`, `issueCommentList`, `prReviewList`, and
`prChecks`, each with `owner: "egonSchiele"`, `repo: "agency-lang"`, and
`number: 1451`. These are the effects the typed tools in `std::github`
raise for the same data, and `recommended` approves them. It runs:

```
gh pr view 1451 --repo github.com/egonSchiele/agency-lang
```

### Which subcommands the rule owns

Seven reads have a rule: `gh pr view`, `pr diff`, `pr checks`, `pr list`,
`issue view`, `issue list`, and `search issues`. So does a GET of six
paths through `gh api` (see "gh api" below). A spelling of one of these
that fails its rule asks `std::bash`, with the reason, such as ``gh does
not take `--web` ``.

Every other `gh` subcommand asks `std::exec`. That includes every write (`gh pr comment`, `gh pr review`, `gh
issue create`, `gh pr create`, `gh pr merge`), and `gh run view`. The
agents write through the typed tools in `std::github`, because a write
effect names its repository and a person can approve writes to one
repository once. A line with a flag before the group, such as `gh -R o/r
pr view 1`, is not owned either and asks `std::exec`: the rule only reads
a line whose first two words are a row.

### The number and the URL

A subcommand that acts on one pull request or issue takes a number
(`1451`) or a URL (`https://github.com/OWNER/REPO/pull/1451`, or
`/issues/` for an issue). A URL also gives the repository. The command
that runs has the number, also when the model gave a URL. With no number,
`gh` uses the pull request for the current branch, and the payload has no
number to show, so that spelling has no rule. `gh pr view #1451` is the
same case, because bash reads `#1451` as a comment.

### The repository

Every `std::github` payload names `owner` and `repo`, and an "always
approve when" answer pins to that pair. `gh` finds its repository in ways
safeBash cannot see (`gh repo set-default`, the upstream of a fork,
`GH_REPO`), so safeBash always writes the repository into the command. It
comes from one of three places, in this order:

1. The URL, when the target is one. A `--repo` that names another pair
   has no rule.
2. `--repo` or `-R`, checked with the same name check the typed tools
   use (`checkRepoCoord`). `OWNER/REPO` and `github.com/OWNER/REPO` are
   accepted; another host has no rule.
3. The `origin` remote of the folder the command runs in, as the typed
   tools do. In a fork, `origin` is the fork.

Looking up `origin` runs git, and `planFor` runs nothing. So `planFor`
takes an optional `origin`. On the first plan it is null, and a `gh`
command that names no repository gets effects with `owner: ""` and `repo:
""`, each with a `lookup` folder (`pendingLookups` lists them).
`resolvedPlan` in `safeBash` then looks up the folder's origin with
`_ghResolveRepo` and plans the line again with the answer. The second
plan is the one raised and run, so its payloads and its command come from
one pass. Nothing edits a command's text after it is rendered. `safeBash`
refuses to run a plan that still has a pending lookup.

When the folder has no origin on GitHub, `safeBash` raises nothing and
returns the lookup's message, followed by "With gh, pass --repo
OWNER/REPO."

The lookup is the one thing safeBash runs before an approval, and after
`cd other &&` it runs in a folder the model picked. It goes through
`_gitRun`, which puts the hardening flags on the command and removes the
`GIT_*` variables, and `git remote get-url` runs no hook or pager.

A line gets one lookup. When its `gh` commands need lookups in two
folders, as in `(cd a && gh pr view 1); gh pr view 2`, it has no rule.

### safeBash writes the gh command it runs

`ghCommand` builds the command from checked data, as `gitCommand` does:

```
gh <group> <subcommand> <number> <search words> <flags> --repo <repository>
```

The flags are rebuilt from what `splitFlags` returned, with every short
name replaced by its long one, so `-L 5` runs as `--limit=5`. The model's
`--repo` is dropped and safeBash writes its own last. The repository
names the host, `--repo github.com/OWNER/REPO`, because `gh` can take its
default host from its own config. With the host written, the payload is
true whatever that config says. `gh` has no per-repository config file,
so once the repository is written nothing in the working folder changes
what `gh` does.

`gh search issues` is different. Its `--repo` is a search filter that
takes no host, so it is written as `--repo OWNER/REPO`, and `gh search`
searches its default host. safeBash pins that host by writing
`GH_HOST=github.com` before the command:

```
GH_HOST=github.com gh search issues crash --repo o/r
```

### One name per flag

`splitFlags` compares spellings, so `-L 5 --limit 500` passes it, and so
does `--repo o/r -R other/private`. `gh` uses both values: the second
fetches five pages, and `gh search issues` takes `--repo` more than once
and searches every repository it names. `ghLongFlags` replaces each short
name with its long name (`GH_LONG_NAMES`), and a long name that then
appears twice has no rule: ``gh takes `--limit` only once``.

### `--jq` and `--template` have no rule

`gh`'s `--jq` runs a jq program inside `gh`, and jq reads the
environment:

```
$ FOO_TEST=secret-value gh api rate_limit --jq 'env.FOO_TEST'
secret-value
```

An approved read would then print any variable, `GITHUB_TOKEN` included,
with no `std::env` question. A check for the word `env` would be a
denylist over a small language. So a `gh` line with `--jq` or `-q` has no
rule, on an owned subcommand or not (`ghHasJq`). The check reads the text
of every argument, because `gh` reads a quoted `'--jq'` as the flag while
the parser reads it as a quoted word. It counts `--jq`, `--jq=x`, and any
group of short flags that holds a `q`, such as `-wq`. On a subcommand
where `-q` means something else that costs one broader prompt.

A `gh` line with a glob word or a glob flag value has no rule either
(`ghHasGlob`). Bash expands the glob after the plan is made, so on a line
that would ask `std::exec`, `gh run view 1 --json jobs *` in a folder
holding a file named `--jq=env.GITHUB_TOKEN` would pass that file name to
`gh` as the flag.

`--template` and `-t` are left off every owned row as well. Go templates
cannot read the environment, but they are another small language, and
`--json` covers the need.

### Flag values

Every flag value is checked with `_ghHasScopeQualifier`, the check the
typed `ghIssueSearch` uses. `gh search issues` writes its filter values
into a search query, where a `repo:`, `org:`, or `user:` adds a
repository, so `--author 'x repo:other/private'` has no rule. The search
words get the same check.

`gh` reads a list flag such as `--label` as one line of CSV. In CSV a
quote changes where the value splits, so `--label '"bug,urgent"'` is one
label to `gh` and two to a plain split at commas. A flag value with a
quote or a line break has no rule, and neither does a `--label` or
`--match` value with an empty item (`--label ''`, `--label bug,`).

### The search query

The payload's `query` is the query `gh` sends, built by `_ghSearchQuery`
the way `gh` 2.88.1 builds it (`AdvancedIssueSearchString` in
`pkg/search/query.go`). So a handler that reads `query` sees the filter
flags and the `type:issue` that `gh` adds unless `--include-prs` is given:

```
gh search issues 'crash bug' --repo o/r --state closed --label bug
```

asks `issueSearch` with this `query`:

```
( "crash bug" ) label:bug repo:o/r state:closed type:issue
```

`gh` puts the words in parentheses and the qualifiers after them. A
parenthesis in a word or a value could close that group early, so
`a) OR (b` would put the `OR` outside the repository filter. A search word
or value with a parenthesis has no rule. Neither has one with a backslash,
a control character, or a space character other than a plain space,
because `gh` quotes those differently than `_ghSearchQuery` can.

`ghCommand` writes the search words back as the model wrote them, and
bash expands a leading `~` in an unquoted word. So `gh search issues
~/notes --repo o/r` has no rule, and `'~/notes'` asks for the text
`~/notes`.

`--search` on `gh pr list` and `gh issue list` has no rule. Its value is
a search query, which can name another repository or contradict
`--state`. `gh search issues` covers the need.

### The tables

| Command | Effects | Flags besides `--repo`/`-R` |
|---|---|---|
| `pr view N` | `prGet`, `issueCommentList`, `prReviewList`, `prChecks` | `-c`/`--comments`, `--json` |
| `pr view N --json f` | by field, below | |
| `pr diff N` | `prDiff` | `--name-only`, `--patch`, `--color`, `-e`/`--exclude` |
| `pr checks N` | `prChecks` | `--required`, `--json` |
| `pr list` | `prList` with `state`, `base`, `perPage` | `--state`, `--base`, `--limit`, `--author`, `--assignee`, `--label`, `--draft`, `--head`, `--json` |
| `issue view N` | `issueGet`, `prGet`, `issueCommentList` | `-c`/`--comments`, `--json` |
| `issue view N --json f` | `comments` asks `issueCommentList`, any other field `issueGet` and `prGet` | |
| `issue list` | `issueList` with `state`, `labels`, `perPage` | `--state`, `--label`, `--limit`, `--author`, `--assignee`, `--mention`, `--milestone`, `--json` |
| `search issues <words> --repo O/R` | `issueSearch` with `query`, `perPage` | `--state`, `--label`, `--author`, `--assignee`, `--limit`, `--sort`, `--order`, `--include-prs`, `--match`, `--json` |

A plain `pr view` asks for comments, reviews, and checks because `gh`
2.88.1 fetches them with the pull request (`defaultFields` in
`pkg/cmd/pr/view/view.go`). A plain `issue view` fetches the last comment,
or all of them with `--comments`.

`issue view N` shows a pull request when `N` is one (`FindIssueOrPR` in
`gh`), and the number cannot tell which before `gh` runs. The typed
`ghIssueGet` refuses a pull request, so an approval of `issueGet` alone
must not read one: a read of the issue itself asks `prGet` as well.

`pr view --json` asks one effect per kind of data its fields read:

| Field | Effect |
|---|---|
| `files` | `prFiles` |
| `comments` | `issueCommentList` |
| `reviews`, `latestReviews` | `prReviewList` |
| `statusCheckRollup` | `prChecks` |
| any other field | `prGet` |

"Any other field" includes `commits` and `projectItems`, which the typed
`ghPrGet` does not return. No `std::github` effect covers them, and `gh
pr view N --json commits` is how a model lists a pull request's commits,
so they count as reading the pull request. On `pr list`, `commits` has no
rule, because there it reads the commits of every pull request listed.

`--limit` sets `perPage`, from 1 to 100, the most GitHub returns in one
page (`GITHUB_MAX_PER_PAGE`); with no `--limit` it is 30, `gh`'s default.
A read of one pull request or issue fetches every page `gh` asks for, and
its payload says so with `perPage: 0`. On `pr list`, the `--json` fields
`comments`, `commits`, `files`, `reviews`, `latestReviews`, and
`statusCheckRollup` have no rule, because each reads data about every
pull request listed; on `issue list`, `comments` has none. A `--state`
value must be one `gh` takes for that subcommand.

Left out of every row: `--web` (opens a browser), `--watch` on `pr checks`
(runs until the checks finish), and `--owner` on `search issues` (searches
every repository of an owner).

### gh api

`gh api` is the one `gh` command where the model writes the web request
itself. A GET of six paths has a rule, each asking the effect of the typed
tool that reads the same data:

| Path | Effect |
|---|---|
| `repos/O/R/pulls/N` | `prGet` |
| `repos/O/R/pulls/N/files` | `prFiles` |
| `repos/O/R/pulls/N/reviews` | `prReviewList` |
| `repos/O/R/pulls/N/comments` | `prReviewCommentList` |
| `repos/O/R/issues/N` | `issueGet` and `prGet` |
| `repos/O/R/issues/N/comments` | `issueCommentList` |

`pulls/N/comments` is how an agent reads the inline review comments on a
pull request; no other `gh` command shows them. An issue path also asks
`prGet`, for the reason `issue view` does: the number may be a pull
request.

The path may start with `/`. It names `O/R`, checked as `--repo` is, or
uses `gh`'s placeholders `{owner}` and `{repo}` together, which safeBash
fills from `origin` or a lookup, as for any `gh` read. One placeholder
beside a name has no rule. A list path may carry `per_page`, from 1 to
100, and `page`; any other query key, or a key given twice, has no rule. A
single pull request or issue takes no query string. The path table and
its checks are `_ghParseApiPath` in `lib/stdlib/safeBashGh.ts`, and
`_ghApiPath` writes a path back from the same table.

A path with a query string must be quoted. Bash reads an unquoted `?` as a
glob, and a `gh` line with a glob has no rule.

`gh api` sends a GET unless it is told otherwise, and switches to POST as
soon as it is given a field. So the one flag allowed is `-X`/`--method`
with `GET`, under one of its names. No rule for the field flags (`-f`,
`-F`, `--field`, `--raw-field`, `--input`), `--paginate` and `--slurp` (no
bound on the requests), `-H`, `--hostname`, `-i`, `--verbose`, `-p`,
`--cache`, `--silent`, `--jq`, and `--template`.

The rule owns every `gh api` line, a quoted `'api'` included, so one it
cannot describe, such as `gh api repos/o/r/pulls/5/commits`, `gh api
graphql`, or a POST, asks `std::bash`. It does not fall back to
`std::exec` the way an unowned subcommand like `gh run view` does,
because `std::exec` names only `gh` and `api`, and a saved rule for that
pair would approve any request.

safeBash runs:

```
gh api --hostname github.com --method GET 'repos/O/R/pulls/N/comments?per_page=30&page=1'
```

The path is written from the parsed read, with the names and, for a list,
both paging values, so `{owner}` and `{repo}` never reach `gh`, which
would fill them from its own idea of the repository. `--hostname` pins
the server, as `--repo github.com/...` does for the other rows.

### Aliases and extensions

Neither a `gh` alias nor an extension can replace a built-in command, so
`gh pr view` always runs `gh`'s own code. `gh alias set` and `gh
extension install` refuse a built-in name, and `gh` ignores an alias
written into `config.yml` by hand under one.

### Not logged in

With no login, `gh` exits with code 4 and prints a message that names
`gh auth login`. A model that sees it may run `gh auth login`, which
waits for a person until the time limit. So when a line that ran `gh`
(`Plan.verbs` holds it) exits 4 and stderr holds `gh auth login`, the
failure's JSON gets a `note`: tell the user to run `gh auth login` or to
set `GH_TOKEN`, and do not retry or log in yourself. The stderr check is
there because the exit code belongs to the whole line. In `gh pr view 1 |
head` the exit code is `head`'s, so the note does not appear.

### Which agents this reaches

Every agent that carries `safeBash` reads GitHub with `gh` and no prompt
under `recommended`: the coder (`std::agents/coding`), the verifier
(`std::agents/verifier`), and the Agency verifier
(`std::agents/agency/verifier`), all through `shellTools`.

## `cd`

```
cd packages/agency-lang && pnpm test
```

This asks one `std::exec` whose `cwd` is the real `packages/agency-lang`.
The `cd` raises nothing. Every path and every payload to its right is
resolved against the new directory.

Every command after the `cd` is classified in the new directory, whether
it follows `&&`, `;`, or a newline:

```
cd lib && ls; cat README.md
```

This asks `std::ls` for `lib` and `std::read` for `lib/README.md`.

### A step runs only in the folder it was planned in

A question names a folder, so it is true only if its command runs
there. The runner runs each `cd` itself (`runCd`), and a `cd` whose
folder is gone, or now leads somewhere else, stops the line. That leaves
a `cd` that bash skips without it failing:

```
pnpm build && cd dist && ls; cat out.txt
```

When the build fails, bash skips the `cd` and the `ls`, and runs `cat
out.txt` in the starting folder. Its question named `dist/out.txt`. So
before each run step and each `cd` step, `skippedCd` compares the folder
the step was planned in (its `cwd`) with the folder the line is in. When
they differ, the line stops before the step:

```
Stopped before `cat out.txt`: it was planned to run in /repo/dist, and
the line is still in /repo, because the `cd` before it did not run.
`pnpm build` already ran. Run the rest as a new command if you still
want it.
[stopped: the plan changed]
```

Both folders are strings the planner wrote, so they are compared as
text.

This is the one place a line runs differently from bash, which would
run `cat out.txt` in `/repo`. The stop applies to a command that ignores
its folder too, such as `echo finished`. When every `cd` in the line
happens, the line runs as bash runs it.

A `cd` that exists and cannot be entered is not caught by `runCd`. The
line moves there, and each later command fails to start in it, so no
question is false in that case either.

`cd x && a || b` is broad.

A line where no command raises an effect is still broad. `cd x` alone
and `cd x; echo hi` both ask `std::bash` and run the original text.

`classifyAll` walks the command tree and carries the working directory
with it. The refuse wall still reads the flat list from
`flattenCommands`. Each tree node has a rule:

- **`and`**: each side is classified in turn (`andSide`), the right one
  in the line the left one ended with. A side that is a `cd` asks nothing
  and moves the line to the directory `cdTarget` resolves. `&&` groups to
  the left, so `cd x && a && b` is `(cd x && a) && b`, and that hand-over
  is how `b` is classified in `x`. `a && cd x && b` is
  `(a && cd x) && b`, so `b` is classified in `x` too, and it runs only
  when the `cd` worked.
- **`or`**: a left side that ends in another directory is unrecognized,
  so `cd x && a || b` is broad.
- **parentheses and pipeline stages**: each is a subshell, so the
  directory after one is the directory before it. `(cd x && a) && b`
  classifies `b` in the original directory.
- **the top-level list**: each command is classified in the line the one
  before it ended with. A `cd` that is a whole command moves every
  command after it, and so does a `cd` inside an `&&` chain.

`cdTarget` accepts one literal argument that resolves to a directory that
exists, or to a folder the line made (see `made` above). `cd` alone, `cd -`, a variable, a second argument, a redirect, or
an assignment is unrecognized. A `cd` in any other position is a simple
command like any other, and `execEffects` refuses it as a builtin. That
covers a `cd` on the right of `||` and a `cd` in a pipeline.

The rebuilt text does not keep the word the model wrote. Each recognized
`cd` is rebuilt with the directory `cdTarget` resolved, as an absolute
real path in single quotes (`cdTo`):

```
cd '/Users/me/proj/packages/agency-lang' && pnpm test
```

Bash would otherwise decide for itself where the word leads, and it can
disagree with the classifier in two ways:

1. Bash reads a word that starts with `-` as a flag, even in quotes. With
   a folder named `-P`, `cd '-P'` goes to the home folder.
2. Bash keeps its own record of the path it came by, symlinks included,
   and applies `..` to that text. After `cd link`, a `cd ..` returns to
   the folder that holds the link. The classifier resolves `..` from the
   link's target. The same happens when `PWD` names a symlinked path for
   the directory bash starts in.

An absolute path starts with `/` and holds no `..`, so bash goes where
the payloads say in both cases. A resolved path that holds a single
quote cannot be written this way, so that `cd` is unrecognized. The
`classify` functions return the rewritten command beside the effects,
and `rebuild` renders that tree.

## Each step decides for itself

A command safeBash can run itself is run by safeBash wherever it sits in
a line, and bash runs the steps beside it:

```
pnpm build && cat dist/out.txt     # bash runs pnpm, the read tool runs cat
echo "=== a.txt ==="; cat a.txt    # no shell starts
```

`classifySimple` asks `tryShellFreeStep` about every simple command
before it tries the bash rules. `tryShellFreeStep` is the table of
commands safeBash runs itself: an echo with or without one redirect, a
grep that translates, and a cat, head, or tail that translates. When it
accepts, the command's step holds a `StepExec` in `inProcess`, and its
effects are the ones the stdlib tool raises. When it refuses, the bash
rule decides, and the step's `inProcess` is null. An `agency` line is
not in the table.

`2>/dev/null` on a command is dropped before the table reads it
(`withoutQuietStderr`), in any position, a later stage of a pipeline
included. A command safeBash runs itself writes nothing to standard
error when it succeeds, so `grep -rn x lib 2>/dev/null` is the search
`grep -rn x lib` is. When such a step fails, its message is still
reported, where bash would have hidden the program's complaint. Every
other redirect keeps the command with bash, apart from the one `>` or
`>>` an `echo` takes.

Three commands are never taken, whatever the table says:

- **A command inside a pipeline bash runs.** A pipeline is all or
  nothing (see "A pipeline in process" below). When bash runs it,
  `classifyPipeline` marks the line (`LineState.byBash`) for every
  stage, a group inside a stage included.
- **A command behind `timeout`.** The limit is the program's.
- **A read of a file that does not exist when the line is planned.** The
  read tool needs a real file, so in `pnpm build > out.txt; cat out.txt`
  with no `out.txt`, bash runs the `cat`.

### A pipeline in process

A pipeline runs in process when every stage can (`inProcessPipeline`):

```
cat notes.txt | grep TODO | head -3     # no shell starts
git log --oneline | head -5             # bash runs the whole pipeline
```

It is all or nothing because bash runs the stages at the same time. In
`git log | head -5`, bash stops `git` once `head` has five lines.
Handing over finished text cannot do that, so `yes | head` would never
end.

- **The first stage** is a command the table takes, as it would alone:
  an echo, a grep, or a cat, head, or tail of files. It asks the
  pipeline's only questions.
- **Each later stage** is a `cat`, `head`, `tail`, or `grep` that names
  no file (`stdinFilter`). It takes the text of the stage before it and
  asks nothing. `head` and `tail` take the counts their lone forms take.
  `grep` takes `-n`, `-v`, `-i`, `-w`, `-E`, `-F`, and `-e`, and three
  flags that do nothing to piped text: `-h`, `-s`, and `--color=never`.
  A flag may follow the pattern (`grep hello -v`), as it may for a lone
  grep safeBash runs itself, because no real grep reads the arguments. A
  flag that changes the shape of the output (`-c`, `-o`, `-l`, a context
  flag) has no in-process form, so bash runs that pipeline.
- **A stage that names a file, has a redirect or an assignment, or is a
  group** sends the pipeline to bash, where the pipeline rules above
  decide what it asks.

The step holds a `PipeExec`: the first stage's execution and a
`TextFilter` per later stage. `printPipe` runs the first stage, then
each filter in order, each to its end. A `grep` stage is the search the
grep tool runs on one file, given the text (`_grepPipedText` in
`lib/stdlib/spill.ts`, beside the search of a saved output), with no
limit on matches.

Three things differ from a lone command or from bash:

- **The status is the last stage's**, as in bash without `pipefail`. A
  first-stage grep that matches nothing is not a failure, where a lone
  one is. A last-stage grep that keeps no line is.
- **A folder search's note is printed after the last stage**, so `|
  head` cannot cut it off.
- **A first stage that fails to read** fails the step with the read
  tool's message. In bash the later stages would still run on empty
  input. A file that is missing when the line is planned is not taken by
  the table, so bash runs that pipeline and nothing changes for it.

A search of a folder the grep tool skips by name is refused by the bash
rule, because the grep it writes excludes that name. In process the tool
searches the folder it is given, so `grep -rn x node_modules | head`
asks `std::grep`, as the lone search does.

A step safeBash runs itself is not planned again before it runs
(`runOneStep`). Its stdlib tool opens the approved folder with
`fixedRoot`, which refuses a link anywhere in the path (see
`docs/dev/stdlib/contained-files.md`). So after `git checkout evil; cat
README.md` swaps the file for a link, the `cat` fails with the read
tool's message and reads nothing. A step bash runs is planned again, and
a changed plan stops the line (see the next section). That second plan
uses the bash rules only (`checkedStep` marks its line `byBash`). In
`pnpm build > out.txt; grep -n x out.txt` the file exists by the time
the `grep` is checked, and the table would otherwise take it and ask
with the stdlib search's payload, which differs from the approved one.

The payload describes what runs. A grep safeBash runs itself asks with
`maxResults: 1000`, the stdlib search's limit, where the same grep
through bash asks with 0. An `echo hi > out.txt` asks `std::write` with
the bytes, in any position.

A line whose every step is in process starts no shell, and its outcome
is `shellFree`. A plan of one such step is how a lone `cat a.txt` runs.
A `cd` counts as in process (`allInProcess`): `runCd` resolves the
folder and moves the runner there with no shell. So `cd sub && cat
a.txt` starts no shell, and a lone `cd lib` asks nothing. The refuse
wall runs on every command of every line first, so `cat a.txt && shred
a.txt` is still refused.

A job is a shell, so a line that starts none is not one: `startJob("cd
sub && cat a.txt")` runs in the foreground with the read's own question,
as `startJob("cat a.txt")` does (`startsShell`).

A line fails when the last step that ran failed, with the joined text as
stdout. A failed in-process step adds its message to stderr and no text
to stdout, the way a failing program's complaint goes to stderr. `grep`
with no match is a failure, as its exit code 1 is.

`runWrite` enters a `destructive { }` region, but that marks only
`runWrite`'s activation. A failure the runner builds later (`echo started
>> log.txt; grep zzz one.txt`) would otherwise say nothing destructive
ran, so the tool loop could retry and append twice. So the runner records
in its state that an in-process write started (`wrote`), and `runSteps`
returns a failure from inside a region of its own when it did. The flag
is set before `_write` runs, so a write that fails before writing
anything still reports `destructiveRan: true`, which is the safe
direction. A step that runs through bash is never marked; see "Why a bash
call is never destructive".

A line's effects may be empty. A line of echoes raises nothing, as a
lone echo raises nothing: the audit rule is about shell spawns, and such
a line spawns none. `planLine` checks `allInProcess` before it asks the
quiet question for a line with no effects.

Two outputs differ from bash. A shell-free directory grep's
skipped-folders note lands in the line's output where that step's text
goes, so `grep -rn TODO src; echo finished` prints the note before
`finished`. And every read is resolved when the plan is made, so in
`echo x > f; cat f` with `f` present, the read prints whatever the write
left, under a `std::read` that named `f` (see "Resolving the path when
the plan is made"). With `f` missing, bash runs the `cat`.

## A narrow line runs one step at a time

A narrow line is a plan of kind `steps`. Beside each command's effects
and rewritten tree, the classifier returns the same command as steps
(`LineStep` in `stdlib/safeBash/actions.agency`):

- A `run` step is one simple command or one pipeline. The stages of a
  pipeline run at the same time, so a pipeline is one step. The step
  holds the command as the model wrote it, its effects, the folder the
  plan used (`cwd`, which the payloads name), that folder with every link
  followed (`realCwd`), and `text`, the text the plan rebuilt for it.
- A `cd` step holds the folder `cdTarget` resolved. `guarded` is true for
  a `cd` that is a whole command of the top-level list.
- A `group` step holds the steps inside a pair of parentheses.

Each step carries the join before it. The parser is left-associative, so
`a && b || c` is `Or(And(a, b), c)`, and a flat list with one join per
step runs in bash's order.

`runSteps` runs the list. `runStepList` carries a state from one step to
the next: the folder, the exit status of the last step that ran, the
stdout and stderr so far, and the time left. For example, `pnpm build &&
cd lib && ls` runs as three steps: `pnpm build` in the starting folder,
then the `cd`, which only moves the state's folder, then `ls` in `lib`.

- **The joins.** `skipsStep` decides whether a step runs: `;` always,
  `&&` only after a status of 0, `||` only after any other status. A
  skipped step changes nothing.
- **A run step** is checked (see the next section), then runs under a
  `bash -c` of its own, in the state's folder. Its stdout is added to the
  stdout so far and its stderr to the stderr so far, which is what one
  `bash -c` of the whole line gives. A step whose words read `$?` runs as
  `(exit 3); echo "exit=$?"`, where 3 is the status of the step before.
- **A `cd` step** is checked, then moves the state's folder. It starts no
  shell. If the folder disappears after the check, the next step's shell
  cannot start. After a guarded `cd` the line ends with "`<line>` was not
  run", as `cd '/abs' || exit 1` ended one shell. After any other `cd`
  the status is 1, the host's reason goes to stderr, and the line goes
  on, as bash goes on after a `cd` that failed inside `&&` or a group.
- **A group** runs on a copy of the state. Its folder ends at the closing
  parenthesis, and its status and output carry on, so `(cd sub && ls);
  ls` lists `sub` and then the starting folder.
- **The time limit** covers the whole line. Each step's shell gets the
  time that is left, and once none is left no step starts, because the
  host sets no limit at all for a limit of zero. A `timeout` of 0 or less
  means no limit, as it did for one `bash -c`.
- **A pause** from outside lands at a statement boundary
  (`docs/dev/runtime/pause.md`), so it lands between steps and never
  inside one. A step's shell is never cut short by a pause and never runs
  twice.

Splitting a line is safe because a narrow line shares almost no shell
state between its commands. No narrow rule changes the shell apart from
`cd`: every other builtin has no rule, and neither does a line of
assignments (`noNarrowRuleChangesTheShell` pins the list). The runner
carries the folder and `$?`. A word that reads another variable bash
sets from the commands before (`$_`, `$OLDPWD`, `$PIPESTATUS`,
`$BASH_COMMAND`, `$LINENO`, `$!`, the list `SHELL_STATE_VARIABLES`) has
no rule, so `ls src; echo $_` asks `std::bash` and runs whole under one
shell.

The runner raises nothing. Every question was raised in `approvedPlan`
before the first step runs. The plan also keeps the whole rebuilt line in
`command`, which the debug log records.

### Each step is checked just before it runs

Every payload was resolved against the disk before the line ran, and an
earlier step can change the disk. After `git checkout evil`, `README.md`
may be a link to a key, and `cat README.md` would print it under a
question that named the file in the project. So before a step that runs
through bash, the runner checks two things, and stops the line when
either fails:

1. **The folder.** `folderChange` resolves the runner's folder with
   `_realFolder`, which follows every link, and compares it with the
   step's `realCwd`. A git or exec payload names its folder as a string,
   so a folder swapped for a link to another repository leaves the
   payload the same, and only this check sees it. The comparison is real
   path against real path, because `cwd` can be `"."`, a relative path,
   or a path through a link. `_realPathIn` would not do: it keeps the last
   step of a path as written, and a folder that became a link is a link
   in its last step.
2. **The plan.** The step is classified again, from its command as the
   model wrote it, in a fresh line in the runner's folder, with the
   repository the up-front plan looked up (so a `gh` step is not looked up
   twice). `sameEffects` compares the new effects with the approved ones:
   the same names and payloads in the same order, with `timeout` left
   out. When they match, the step runs the text the new plan rebuilt,
   which describes the disk as it is now.

A `cd` step is checked too. `runCd` resolves its target again from the
runner's folder, and stops the line when the target no longer resolves
or resolves somewhere else. That holds for every `cd`, guarded or not:
a folder that vanished after approval is not the folder that was
approved.

The fresh plan knows nothing of what earlier steps wrote or made, while
the up-front plan used `written` and `made`. That matters only when the
two give different payloads; for a folder the line made, a file it wrote,
and a second write to that file they give the same ones
(`harmlessLinesDoNotStop`).

A step that runs in process is not planned again. The stdlib tool checks
the path when it opens it. Like every run step and `cd` step, it is
still stopped when the line is not in the folder it was planned in (see
"A step runs only in the folder it was planned in"). The refuse wall is not run again either. It reads
the disk only for `rm`, and a changed `rm` target changes the
`std::remove` payload, so the plan check stops the line. The payload keeps
a link in the last step as written, which is right for `rm link`, so for
`rm -rf build/` after `build` became a link to another folder it would
not change, and `rm` would delete the link's target. `removeEffects`
gives a `/` after a link no rule (`aSlashAfterALinkHasNoRule`), so the
fresh plan of that step fails and the line stops.

A stop runs nothing more. The failure has `data.type` `"planChanged"`,
and its text is the output so far, a sentence that names the step, what
was approved, what the new plan found, and which steps already ran, then
`[stopped: the plan changed]` as the last line, which the agent's trace
shows as "stopped":

```
Stopped before `cat README.md`: it was approved to read
/repo/README.md, and it now asks to read /outside/secret.
`git checkout evil` already ran. Run the rest as a new command if you
still want it.
[stopped: the plan changed]
```

If the model runs `cat README.md` again as a new command, it is planned
fresh and asks about `/outside/secret`, so the person sees the true
question. Each check and each stop is logged with `_debug` ("safeBash
step check", "safeBash step stopped").

What the check does not close: there is still a gap of a few milliseconds
between the fresh plan of a step and the moment its program opens the
file. A process already running beside the line can use it, and so can a
child process an earlier step left running. Only a `std::exec` step can
leave one, and its approval already lets it read any file.

When every step has an in-process execution, the line is the chain of
the section above, and its outcome is `shellFree`.

## Why a bash call is never destructive

This is a decision, made after the alternatives below were weighed. Do
not add a `destructive { }` region around `runBash` without reading it.

The rule: safeBash marks destructive work only where Agency code does
the work. `runWrite` wraps `_write` in a `destructive { }` region, as
the `write` tool does, and `runSteps` enters one when an in-process write
started. `runBash` and the runner's bash steps enter none, so a failure
from a line that ran through bash always carries `destructiveRan: false`. safeBash is treated like any
other tool: the Agency functions it runs mark their own work, and
nothing in the `destructive` logic or the tool loop has a case for it.

The reasons:

1. **safeBash cannot see what bash did.** `make` may have written half
   its outputs before it failed. `echo hi > /missing/dir/f` failed
   before writing anything. Any region around `runBash` is a guess about
   the whole line.
2. **A bash failure is any non-zero exit, and those are routine.**
   `runBash` fails on every non-zero exit: a failing test run, a `grep`
   that finds nothing, a `diff` of two files that differ, a compile
   error. Most of them changed nothing.
3. **The flag removes the tool.** `failureTier`
   (`lib/runtime/toolInvocation.ts`) puts a failure with
   `destructiveRan: true` in the destructive tier, and the model is told
   "This tool can no longer be called in this conversation." The tool
   loop also marks the function that called `llm()`
   (`lib/runtime/prompt.ts`, the `destructiveSink`), so an agent that is
   itself a tool can be removed from its parent. Marking every bash
   failure, or every broad one, would take the shell away after the
   first failed test run.

The cost of the rule: after `echo started >> log.txt && false`, the model
is told it may call safeBash again. If a policy approves the write with
no prompt, as `recommended` does inside the launch directory, a retry
appends the line twice. That is accepted. The `destructive` flag is
something Agency offers on top of what most agents have, and a shell is
a black box it cannot see into.

The alternatives that were set aside:

- **A region around `runBash` for every plan, or every broad plan or
  plan with a write.** This removes the shell after any failed command.
- **A region only for narrow plans that raise `std::write`.** It is
  still a guess (a write that failed before writing reports `true`), and
  it is a safeBash-only case in how the flag is set.
- **A softer tier for "may have changed files"** that keeps the tool and
  tells the model to check before running again. That changes the tool
  loop's tiers for every tool, to serve one.
- **Comparing the named write targets before and after the run.** It
  only covers narrow writes, adds reads around each one, and misses a
  write that leaves the size and time unchanged.

## The time limit

`safeBash` takes a `timeout` in seconds, 120 unless the model passes
another. A line still running at the limit is stopped, with every process
it started. How the stop works is in "Stopping a command" in
`docs/dev/runtime/host.md`.

The number is in seconds because that is the unit a model guesses, and
the one the `bash` tools of other agents use. The `bash` and `exec` tools
take milliseconds, with the same two-minute default.
`safeBash` multiplies by 1000 in two places: the `timeout` field of the
`std::bash` and `std::exec` questions it raises, so the payload states
the limit the line runs under, and the call to `_bash`. A plan is made
before the limit is known, so the `timeout` in a planned `ExecPayload` is
0, and `raiseOne` writes the real one.

Only the bash path has the limit. A plan that runs in process (a lone
`grep`, `cat`, or `echo`, or a chain of them) starts no program, and the
git tools have their own 30-second limit. A narrow line that runs a step
at a time shares one limit across its steps (see "A narrow line runs one
step at a time").

A stopped line is a failure in the shape `exitFailure` gives, so the tool
trace reads it the same way, with two more fields: `timedOut: true`, which
the trace shows as "timed out", and a `note` that names the limit and
tells the model to run a narrower command or pass a larger `timeout`.
`stdout` and `stderr` hold what the line printed before the stop, which
for a test run shows which tests ran and which one hung.

The limit is not capped at the time left in a subagent's budget, because
it does not need to be. The budget is a time guard, a guard trip aborts
the run's signal, and the host stops the running line on that signal the
same way. That stop is a cancel. The call is unwound and its output is
dropped, as for any other aborted tool.

## Why the executors call `_bash`, `_write`, `_grep`, and `_read`

The `bash`, `write`, `grep`, and `read` tools raise their own interrupts. Calling them
after `raiseAll` would ask the broad question a second time. The bypass
is correct for one reason: the only path to an executor runs through a
`raiseAll` that raised every effect in the plan and returned success, and
every plan raises at least one effect, except a line that only reads
saved output (see "Saved output"). The runner reaches the same
internals through each step's executor, and calls `_bash` for each step
that runs through bash.

That reason holds only if nothing else can call an executor. So the
executors are private functions in `stdlib/safeBash.agency`, not exports.
An exported executor would let any program import it and run a command,
write a file, or read a file with no approval at all.

## `startJob` shares the approval

`startJob` starts a command as a background job. It sits beside `safeBash`
because the two share `approvedPlan`, which plans the command, returns a
refusal, and calls `raiseAll`. Both raise the effect set
`SafeBashEffects`, so an effect added for `safeBash` is added for both. `safeBash` then runs the plan with
`runPlanned`. `startJob` starts a plan that starts a shell with
`_launchJob`, and runs any other plan with `runPlanned`, in the
foreground. `_launchJob` is the second place a command runs with no
interrupt of its own, and it is safe for the same reason as the
executors: the only path to it runs through `approvedPlan`.

A job runs its line whole, where the runner is not present, so as a job a
narrow line may be only one step, or a `cd` and one step. Any other line
of several steps asks `std::bash` as a job. The rule and the launch check
are in `docs/dev/stdlib/jobs.md`, "Approvals".

`approvedPlan` decides from the plan, not from the caller, whether the
command runs as a job. When it does, `raiseOne` puts "in the background"
in the `std::bash` and `std::exec` questions, and the payload's `timeout`
is the job's limit. See `docs/dev/stdlib/jobs.md`.

## Saved output

A long output is saved in the run, and its path, such as
`/tmp/agency-spill-1000/<name>.log`, can be read like a file
(`docs/dev/stdlib/spill.md`, "Reading saved output by path"). Five
places handle it, and no verb's rule has a branch for it:

- **The resolvers.** `resolveReadPath`, used by the read verbs and input
  redirects, and the grep rule, which resolves through `resolveTarget`
  because its target may be a folder, both ask `savedPathOf` before they
  stat anything. A saved-output path becomes a `saved` `ReadSource`, or
  a grep call with `saved` set. It keeps the folder as written, so the
  rule's `std::read` or `std::grep` names the copy's path.
- **`textOf` and the saved grep.** The in-process executors read a
  `saved` source from the store by name (`_readSpill`, `_grepSaved`),
  never from disk.
- **`savedOutputLine`.** `planFor` lists the saved outputs a line names,
  from its parsed words, and notes whether every word is literal. Each
  word's text is searched with `savedPathsInText`, so a path inside a
  longer argument is found too: `sh -c 'cat <path>'`, or
  `--input=<path>`. A word is not literal when it holds a variable or a
  glob, when it is a flag whose value is a glob, or when it starts with
  an unquoted `~`. A line that does not parse is searched as text
  instead; it asks the broad question, so the search only decides which
  copies to write. The list becomes the plan's `savedPaths`.
- **`savedOutputRules`.** It runs last in `planFor`, on the finished
  plan, after `bashPlan`. A write, delete, listing or find for which
  `inSpillFolder` is true refuses the plan. A read or search whose
  payload names a path in `savedPaths` is dropped, and only when every
  effect is `std::read`, `std::grep`, `std::ls` or `std::glob` and every
  word is literal. It never adds an effect.
- **Before a shell starts.** `runBash` and `startJob` call
  `_prepareSpillFiles(plan.savedPaths)` right before `_bash` and
  `_startJob`, and a failure stops the line.

The two conditions on a dropped read:

- **The line only reads.** The copies are written once, before the whole
  line runs. In `ln -sf ~/.ssh/id_rsa <saved path>; cat <saved path>`
  the `ln` asks `std::exec`, and the `cat` keeps its `std::read`.
- **The line expands nothing.** `echo` raises no effect, so in
  `echo "$GH_TOKEN" && wc -l <saved path>` a dropped read would leave no
  question at all while the shell prints the variable. A variable, a
  glob, or an assignment anywhere in the line keeps every question.

A read is dropped only for a path in `savedPaths`, the list that is
written, so the two cannot disagree. `bashPlan` still turns an empty
effect list into `std::bash`, and `savedOutputRules` runs after it, so a
shell plan ends with no effects only when a read of saved output was
dropped. A program with no rule, such as `sed -n`, asks `std::exec` and
nothing more, as it does for a file on disk.

## Files and tests

- `stdlib/safeBash.agency`: the classifier, `planFor`, `safeBash`, and
  the private executors.
- `stdlib/safeBash/actions.agency`: `Plan`, `BroadReason`, `Effect`, and
  `Execution`, with a named payload type and a constructor per git
  effect, and `pendingLookups`.
- `lib/stdlib/safeBashGh.ts`: `_ghParseTarget`, `_ghParseRepoFlag`, and
  `_ghSearchQuery`, the text handling for the `gh` rule, tested in
  `safeBashGh.test.ts`.
- `lib/host/gitEnvironment.ts`: the git environment variables, in three
  lists the shell and the git tools share.
- `lib/stdlib/safeBash.ts`: the tarsec re-export.
- `lib/stdlib/safeBashRemove.ts`: the delete refusal and `_realPathIn`,
  the real path of an `rm` or `mkdir` operand, tested in
  `safeBashRemove.test.ts`. The plan tests are `removePlans`,
  `removeRefusals`, `removeAfterCd`, and `removeAsksLikeTheRemoveTool`.
  No test runs an `rm`.
- `lib/stdlib/prepareContainedPath.ts`: `resolveRedirectTarget`, where a
  write lands, and `missingTarget`, the same place for a read of a path
  that does not exist yet.
- `lib/stdlib/grepDialect.ts`: the pattern translation, grep's output
  format, and the skipped-folders note.
- `lib/stdlib/readDialect.ts`: what `cat`, `cat -n`, `head`, and `tail`
  print for a file's text.
- `lib/stdlib/shell.ts`: `_searchTargetIn`, which resolves a grep path
  or a read path against safeBash's cwd.
- `lib/stdlib/statelog.ts`: `_debug`.
- `tests/agency/safeBash.agency`: plan tests (`planReasons`,
  `planVerbs`, `planOutcomes`, `wholeStringPlans`, ...), the end-to-end
  runs with interrupt expectations, and the rejection messages. The
  chain nodes are `chainsOfInProcessCommands`, `chainMatchesBash`,
  `chainFailureAfterAWriteIsDestructive`, `chainFailsLikeBash`, and
  `chainOfReadsAsksOnlyTheReads`. The listing nodes are
  `wholeShortFlags`, `listingsAskStdLs`, `lsPayloadFields`,
  `listingPayloadNamesTheRealFolder`, `findAsksStdGlob`, `findPatterns`,
  and the end-to-end runs under `recommended`.
  The git nodes are `gitReads`, `gitRefsAndPaths`, `gitWrites`,
  `gitStaysBroad` (every spelling with no rule), `gitInChains`,
  `gitRestoreStaged`, `gitCheckoutRefusals`, `gitRunsWhatItAsked` (the
  text each plan runs), `gitBranchShapes`, and `gitRunsSafely`, which
  runs real git in a repository and in a folder with none, both made by
  the test. No test approves a git write in the checkout it runs in.
  The gh nodes are `ghReads`, `ghLookupFollowsCd`, `ghStaysBroad` (every
  refused spelling, with its reason), `ghJqHasNoRule`,
  `ghUnownedStaysExec`, `ghLookupFillsThePair` and
  `ghLookupFailureRaisesNothing` (a repository the test makes, with and
  without an origin), `ghRunsWhatItAsked` and `ghLoginNote` (a fake `gh`
  on the search path, through `runWithFakeGh`). `punctuationInWords`
  covers words with `,`, `@`, `%`, and braces. The grep-through-bash
  nodes are `grepThroughBashAsksStdGrep`, `grepRunsWhatItAsked`, and
  `grepThroughBashReadsWhatTheToolReads`, which runs real grep on a tree
  that holds a match in every place the tool skips. The quiet nodes are
  `quietCommandsAskNothing`, `timeoutReadsThrough`,
  `quietAssignmentsAndNull`, `quietLinesAskTheQuietQuestion`, and
  `quietLineRunsUnderRecommended`. The file-command nodes are
  `makeAsksLikeTheTools`, `fileProgramsAskBash`,
  `teeWritesLikeARedirect`, and `readsByOtherNames`. The missing-path
  nodes are `missingPathsResolveByParent`,
  `missingPathAfterAProgram`, and `readsOfFilesTheLineWrote`. The runner's
  nodes, and the attacks that stop, are in `tests/agency/safeBashSteps.agency`.
- `tests/agency/safeBash-corpus.agency` and `safeBash-corpus.json`: the
  measurement. Each row is a common coding line with the outcome and
  effect names it plans to, so a rule change shows as rows that moved.
  It is not the place for a rule's edge cases.
- `lib/stdlib/safeBash.test.ts`: `astToBash` round-trips every command
  family the classifier sees.
- `lib/stdlib/statelog.test.ts`: `_debug`.
- `lib/stdlib/grepDialect.test.ts`: the translation table, the rendering
  rules, and the docstring check for `SKIP_DIRS`.
- `lib/stdlib/readDialect.test.ts`: the four read views.
- `tests/agency/stdlib/grep-fixtures/` and `read-fixtures/`: the files the
  parity tests read.

Design: `docs/superpowers/specs/2026-07-26-safebash-classifier-design.md`
(the plan-then-act model) and
`docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`
(the measurement, pipes, read family, and project scripts).
