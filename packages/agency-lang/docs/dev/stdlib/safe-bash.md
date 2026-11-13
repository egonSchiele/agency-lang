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
  (`astToBash`), so a parser bug degrades to running what was read. Three
  commands in that tree are written by the classifier: a `cd` names the
  folder it resolved, a git command is the one `gitCommand` built, and a
  `gh` command is the one `ghCommand` built.
- **Every shell spawn raises at least one effect.** A string of nothing
  but echoes still raises `std::bash` (`bashPlan` substitutes it for an
  empty effect list), so the effect log is a complete audit of shell
  invocations.
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
carries the bytes. A lone `grep` that translates exactly runs the grep
tool's own search (see "grep" below). A lone `cat`, `head`, or `tail` of
one file runs the read tool's own read (see "The read family" below). A
chain of such commands joined by `;`, `&&`, or `||` runs them in process
in order (see "Chains in process" below). An `agency <sub> <file>` line
runs in-process through `std::agency`.

`bash`: everything else. Narrow when every command was recognized: a git
command with a rule, see "git" below; a `gh` read with a rule, see "gh"
below; a grep of one named file, a read of named files, a listing of named folders, a find, a
program safeBash has no rule for (`std::exec`), a redirect contributing
`std::write` or `std::read`), broad otherwise.

`outcomeOf(plan)` names which of these a plan is (`refuse`, `shellFree`,
`agency`, `narrow`, `broad`) with an exhaustive match over the
`Execution` union, so a new execution kind is a type error there.

## In process when it translates

The shell-free grep and the shell-free read follow one rule. A lone
command, or a chain of them, whose flags and arguments translate exactly
runs the matching stdlib tools in process, under each tool's effect. Any other command runs
through bash, with a narrow effect only when the payload describes what
bash will do, and `std::bash` otherwise.

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
changes, because the flag tables that care set `optionsFirst`.

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
| `noEffects` | `""`; every command was recognized and none raised an effect, so the audit rule asked `std::bash` |
| `unrenderable` | why the tree could not be rendered back to text |

The four broad branches of `planFor` go through `broadPlan`, which is
`bashPlan` with the `std::bash` effect and the reason.

`Plan.verbs` is the command word of every simple command `planFor`
decided over, in order: `""` for an assignment-only command, `[]` when
the string was unparseable.

## The debug event

Every call posts one statelog `debug` event with the message
`safeBash plan`, after `planFor` and before the refusal check, so a
refused plan is on the record too. The bridge is `_debug` in
`lib/stdlib/statelog.ts`, a no-op outside a run. The data:

```
{ command, cwd, outcome, reason, detail, verbs, effects }
```

`reason` and `detail` are the broad reason's fields or `""`; `effects` is
the list of effect names. A session's calls are tallied with a filter
over its JSONL for `debug` events whose message is `safeBash plan`.
There is no dedicated event type.

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
safeBash could not ask a narrower question because it has no rule for one of the commands: grep does not take `-z`. Call the grep tool instead: a policy can approve its question in advance.
```

The sentence does not say the tool needs no approval. safeBash cannot see
the policy, and with no policy, or a stricter one, that would be false.
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
would show: stdout, then stderr, then a status line, then a note when
there is one (gh not being logged in, or what to do about a time limit).
An `agency` command, which runs in process, fails with the same text.

```
fatal: invalid reference: *.py
[exit code 128]
```

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
git log` and `git status | head` are narrow; `git status | xargs echo` is
broad). A dup redirect
(`2>&1`, op `>&`) moves a stream and writes no file, so `redirectEffect`
skips it; `prepareRedirectWrite` stays strict, because the shell-free
write path computes the bytes it writes and a dup changes which stream
`echo`'s output goes to.

`redirectEffect` has two more rules for output redirects:

1. A redirect of standard output or standard error to `/dev/null` writes
   no file, so it contributes no effect. `pnpm test 2>/dev/null` asks one
   `std::exec`.
2. A redirect of standard error to a file contributes the same
   `std::write` as `>` to that file, with the same mode. `make
   2>build.log` asks `std::exec` and `std::write`.

Descriptor 1 means the same as no descriptor, so `make 1>out.log` is
`make >out.log`. Any other explicit descriptor is unrecognized, so
`make 3>x` is broad. `&>` is not one of these redirects, so
`pnpm test &>/dev/null` is still broad.
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
  `{ kind: "search", call }` for a path, or `{ kind: "stdin" }` when it
  names none. The verb rule never sees the pipe flag.

`stdinStage(verb, readsStdin, redirects)` joins them for a verb whose
rule can read stdin, and `pipedProgram` is its counterpart for a program
`std::exec` describes (see "Programs with no rule"). They are the only
two places that read the flag. A stdin reader fed by a pipe contributes only
its redirects; anywhere else it is unrecognized, with the message `grep
with no path reads stdin`. Its callers are grep, the read verbs (see "The
read family"), and `tr`. A new verb that can read its stdin writes its
"reads stdin" answer and calls the same helper.

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
is approving what the tool does. So a grep is handled one of two ways:

| Command | What happens |
|---|---|
| `grep -rn hello src` | lone, translates: the tool's search, `std::grep` with `dir: <cwd>/src` |
| `grep -n hello one.txt` | lone, translates: the tool's search, `std::grep` with `file: "one.txt"` |
| `grep -rn "a+b" src` | `+` means different things to grep and JavaScript; a directory through bash: `std::bash` |
| `grep -n "a+b" one.txt` | does not translate; one file through bash: `std::grep`, then real grep runs |
| `grep -c hello one.txt` | the tool has no `-c`; one file through bash: `std::grep`, then real grep runs |
| `grep -rn hello src \| head -20` | not lone; a directory through bash: `std::bash` |
| `git status \| grep hello` | fed by a pipe, no path: a filter, only the git question |
| `git status \| grep -rn hello` | `-r` reads the working directory, pipe or not; a directory through bash: `std::bash` |
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
`--exclude-from`, `--include-from` (read another file); `--include`,
`--exclude`, `--exclude-dir` (the shell-free path cannot carry them out,
and the bash path is narrow only for one named file); `-m` (counted per
file); `-P` (BSD grep lacks it); `-z`, `-d`, `-D` (different meanings in
different greps); ugrep's `--filter` and `--save-config`; the long
spellings of short flags. Each letter in the table means the same thing in
GNU grep's manual, ugrep 7.8.4's `--help`, and FreeBSD's grep manual.

Four more refusals:

- **A quoted word that starts with `-`.** Bash strips the quotes, so
  `grep "-R" src` runs `grep -R src`. This applies to a flag's value too,
  so `grep -e "-x" f` is refused even though grep would search for `-x`.
- **A repeated valued flag.** For `grep -e a -e b`, a payload with one
  pattern would misdescribe the search.
- **A flag after the first positional, on the bash path.** BSD grep, and
  GNU grep with `POSIXLY_CORRECT` set, read `-s` in `grep -n x f -s` as a
  second file. The shell-free path sets `optionsFirst: false`, because no
  real grep reads its arguments.
- **No path, outside a pipe.** grep reads the shell's closed stdin.
  Fed by a pipe it is a filter (see "Stages that read a pipe"). The `-r`
  check comes first either way: with `-r` the path is `.`, grep prints
  bare names, and a pipe does not stop it reading files, so `git status
  | grep -rn hello` asks `std::bash` for the directory.

### A lone grep runs the tool's search

`tryShellFreeGrep` applies to a grep that is the whole command line, with
no pipe, chain, or redirect, whose flags are all in
`SHELL_FREE_GREP_FLAGS` (the tool has no `-c`, `-o`, or context lines),
whose directory target has `-r`, and whose pattern translates. It raises
`std::grep` and runs `runGrep`, which calls `_grep`. The payload and the
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

### Any other grep runs real grep, narrow for one file only

`grepSearchEffects` is the `effectsFor` arm for a grep of a path. It
raises `std::grep` only when the path names one file, which real grep and the tool read the same way. A
directory search through bash reads files the tool skips, so it asks
`std::bash`. `readGrep` resolves the path with `_searchTargetIn`, the same
split the tool uses: a file gives its real parent as `dir` and its name as
`file`, so a symlink to `~/.ssh/id_rsa` names `~/.ssh`.

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

`readGrep` and `readFileVerb` resolve a path before anything runs, and
bash runs the line later. That is safe only while nothing that runs before the grep in a
narrow line can change which file the path names. Today the narrow
commands are git reads, file reads, and redirects, and a redirect writes
into a file but cannot turn it into a symlink. Once project scripts are
narrow (ADI-243), `pnpm build && cat out.txt` could replace `out.txt`
between the plan and the run, and that slice has to deal with it. The
shell-free read does not have this gap: `_read` opens the file without
following a final link and checks it is the regular file it resolved.

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
- A missing path is refused, so `cat nope.txt` asks `std::bash`, as
  `grep x nope.txt` does.

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
`std::read` per file and runs `runRead`, which reads the files in order
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

`runRead` returns `_read`'s own failure. The plan already refused a
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

`listEffects` raises one `std::ls { dir, recursive, maxResults: 0 }` per
folder named, and `.` when none is named. Every path goes through
`resolveTargets`: it must be literal, and the payload names the real
folder. A missing path or a glob word makes the command unrecognized. A
listing ignores its stdin, so `git log | ls` is a listing of `.`.

A file given to `ls` or `du` asks for the folder that holds it, with
`recursive: false`. `ls -la one.txt` prints one entry of that folder,
and `du one.txt` prints that one file's size, so the question names
more than runs, which fails safe: a policy that approves listing the
folder has approved seeing every entry in it. `tree` of a file prints
the name and an error, so it's refused, and so is `find` of a file,
because `std::glob` searches a folder. `requireFolder` is the one place
that refusal is written.

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
`args` its arguments, `subcommand` the first argument (or `""`), `cwd`
safeBash's resolved folder, `timeout` the line's time limit in
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
  Some builtins also change what later commands do: `cd .. && cat
  one.txt` reads the parent folder's file while the `std::read` names
  the current one, `hash -p /tmp/x git` makes `git` run `/tmp/x`,
  `enable -f` loads a shared object as a builtin, and `export
  NODE_OPTIONS=...; pnpm test` is the leading-assignment case spread
  over two commands. The message is "`cd` is a bash builtin, not a
  program".
- **Programs that run other programs** (`NO_EXEC_PROGRAMS`). The
  wrappers (`sh`, `xargs`, `env`, `sudo`, ...) would put the wrapper in
  the payload while what runs is in its arguments. The package runners
  (`npx`, `bunx`, `uvx`, `pipx`) take a flag first, so `npx -y foo`
  would save `{ npx, -y }`, which covers every package. `agency` is
  here because a lone `agency` line runs in process, and `recommended`
  approves `std::exec` for agency's safe subcommands, which were chosen
  for the exec tool. `which` and `whereis` are here because a lone
  `which agency` is refused by `tryAgencyPlan`, and a chain must not turn
  the same lookup into a question a saved rule answers. These keep the
  message "no rule for `xargs`", because that's still true and the
  rejection fixtures pin it.
- **A program fed by a pipe or `<`** (`pipedProgram`). The payload's
  `stdin` is empty, so it can't describe what the program reads.
- From earlier checks: a leading assignment, and a command word that
  isn't literal (`./gradlew`).

What a saved rule covers: `@always(command, subcommand)` saves the
program with its first argument, so a rule for `pnpm test` covers `pnpm
test` in any folder and with any later arguments, the same as for the
exec tool. `node -e '...'` is as broad as `sh -c`, so a rule for an
interpreter should be keyed on `subcommand`. The same goes for every
program that takes its program as text: `python3`, `perl`, `ruby`,
`awk`, `sed`, and `jq`. A rule keyed on `awk` and `'{print}'` still
covers every file named after them. `rg --pre=<program>` runs
another program for each file, so a saved rule for `rg` covers that
too.

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
policy. A command with no such effect (`git push`, `git revert`, `git
rev-parse`) has no rule and asks `std::bash`.

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
a command word, the word is literal (`/bin/git` is not `git`), there is
no leading assignment (`GIT_DIR=/x git status`), and the redirects have
effects. It returns the effects and the command to run. For every verb
but git the command is the one it was given.

`effectsFor` is a call to `simpleCommandRule` that returns the effects.
`classifySimple` calls it and passes on both. `gitEffects` has no other
caller, so no path reaches a git rule without the four checks. A second
caller would have to repeat them, and one that forgot the redirects would
let `git log > ~/.zshrc` ask only `std::git::log`.

### The table and the four functions

Nine subcommands have one shape, and each is a row of `GIT_VERBS`: its
flags, how its words are read, and how many refs, paths, and names it
takes. `gitRowRule` checks any row, and `gitPayloads` fills the payload
with one `match` arm per subcommand. Adding one is a row and an arm.

For `branch`, `stash`, `commit`, and `checkout` the allowed words depend
on the flags, so each has a function of its own, using the same helpers.
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

## `cd` on the left of `&&`

```
cd packages/agency-lang && pnpm test
```

This asks one `std::exec` whose `cwd` is the real `packages/agency-lang`.
The `cd` raises nothing. Every path and every payload to its right is
resolved against the new directory.

The rule holds only for `&&`. When the `cd` fails, bash runs nothing to
its right, so the commands there only ever run in the new directory, and
a payload that names it is true. After `;` or `||` the next command runs
whether or not the `cd` worked, in a directory that depends on which, so
no payload for it would be true in both cases.

`classifyAll` walks the command tree and carries the working directory
with it. The refuse wall still reads the flat list from
`flattenCommands`. Each tree node has a rule:

- **`and`**: when the left side is a `cd`, `cdTarget` resolves its
  directory and the right side is classified there. Otherwise the left
  side is classified, and the directory it ends in is passed to the right
  side. `&&` groups to the left, so `cd x && a && b` is
  `(cd x && a) && b`, and that hand-over is how `b` is classified in `x`.
- **`or`**: a left side that ends in another directory is unrecognized,
  so `cd x && a || b` is broad.
- **parentheses and pipeline stages**: each is a subshell, so the
  directory after one is the directory before it. `(cd x && a) && b`
  classifies `b` in the original directory.
- **the top-level list**: a command that ends in another directory must
  be the last one, so `cd x && a; b` is broad and `a; cd x && b` is not.

`cdTarget` accepts one literal argument that resolves to a directory that
exists. `cd` alone, `cd -`, a variable, a second argument, a redirect, or
an assignment is unrecognized. A `cd` in any other position is a simple
command like any other, and `execEffects` refuses it as a builtin. That
covers `cd x` alone, a `cd` on the right of `&&`, and `cd x && cd y && a`,
where the second `cd` is the right side of the inner `&&`.

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

## Chains in process

`tryShellFreeChain` plans a line whose commands are joined by `;`, `&&`,
or `||`, such as

```
echo "=== a.txt ==="; cat a.txt; echo; echo "=== b.txt ==="; cat b.txt
```

`chainLinks` flattens the parse into links, each a simple command with
the join before it: the top-level list is joined by `;`, and an `And` or
`Or` node joins its right side with `&&` or `||`. The parser is
left-associative, so `a && b || c` is `Or(And(a, b), c)`, and the flat
list runs in bash's order.

Each link must plan through `tryShellFreeStep`, the one list of
in-process planners that a lone command also uses: an echo with or
without one redirect, a grep that translates, or a cat, head, or tail
that translates. An `agency` line is not a step. `stepExecOf` turns each
step's plan into a `StepExec`, with an exhaustive match that makes a new
execution kind a type error until someone decides whether a chain may
hold it. The chain raises every step's effects, in order, and runs no
shell.

A parenthesized group or a pipeline refuses the chain. Bash skips
`(b || c)` in `a && (b || c)` as a whole, which a flat list cannot say,
and a pipeline needs a runner of its own (ADI-261). `linksOf` is a
second walk beside `flattenOne` for this reason: `flattenOne` feeds the
refuse wall and must see through both.

The chain is all or nothing. One command the step planners refuse sends
the whole line down the general path, where the refuse wall runs on
every command and the line goes to bash. So `cat a.txt && shred a.txt` is
still refused.

`runChain` copies bash's run rule. `;` runs the next step whatever
happened, `&&` runs it only after a success, and `||` only after a
failure. A skipped step changes nothing. The chain fails when the last
step that ran failed, with the joined text as stdout and that step's
message as stderr. A failed step adds no text, the way a failing
program's complaint goes to stderr. `grep` with no match is a failure,
as its exit code 1 is.

A write step runs inside a `destructive { }` region of `runChain`'s own.
`runWrite` enters one, but that marks `runWrite`'s activation, and a
failure built later in `runChain` (`echo started >> log.txt; grep zzz
one.txt`) would otherwise say nothing destructive ran, so the tool loop
could retry and append twice. The region is entered before `_write`
runs, so a write that fails before writing anything still reports
`destructiveRan: true`, which is the safe direction. A line that runs
through bash is never marked; see "Why a bash call is never
destructive".

A chain's effects may be empty. A chain of echoes raises nothing, as a
lone echo raises nothing: the audit rule is about shell spawns, and a
chain spawns none.

Two outputs differ from bash. A shell-free directory grep's
skipped-folders note lands in the chain's output where that step's text
goes, so `grep -rn TODO src; echo finished` prints the note before
`finished`. And every read is resolved when the plan is made, so in
`echo x > f; cat f` with `f` present, the read prints whatever the write
left, under a `std::read` that named `f` (see "Resolving the path when
the plan is made"). With `f` missing, `cat f` is refused at plan time,
and the line goes to bash.

## Why a bash call is never destructive

This is a decision, made after the alternatives below were weighed. Do
not add a `destructive { }` region around `runBash` without reading it.

The rule: safeBash marks destructive work only where Agency code does
the work. `runWrite` wraps `_write` in a `destructive { }` region, as
the `write` tool does, and `runChain` enters one around each write step.
`runBash` enters none, so a failure from a line that ran through bash
always carries `destructiveRan: false`. safeBash is treated like any
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
git tools have their own 30-second limit.

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
every plan raises at least one effect. `runChain` reaches the same
internals through each step's executor.

That reason holds only if nothing else can call an executor. So the
executors are private functions in `stdlib/safeBash.agency`, not exports.
An exported executor would let any program import it and run a command,
write a file, or read a file with no approval at all.

## `startJob` shares the approval

`startJob` starts a command as a background job. It sits beside `safeBash`
because the two share `approvedPlan`, which plans the command, returns a
refusal, and calls `raiseAll`. Both raise the effect set
`SafeBashEffects`, so an effect added for `safeBash` is added for both. `safeBash` then runs the plan with
`runPlanned`. `startJob` starts a plan of kind `bash` with `_startJob`, and
runs any other plan with `runPlanned`, in the foreground. `_startJob` is
the second place a command runs with no interrupt of its own, and it is
safe for the same reason as the executors: the only path to it runs
through `approvedPlan`.

`approvedPlan` decides from the plan, not from the caller, whether the
command runs as a job. When it does, `raiseOne` puts "in the background"
in the `std::bash` and `std::exec` questions, and the payload's `timeout`
is the job's limit. See `docs/dev/stdlib/jobs.md`.

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
- `lib/stdlib/safeBashRemove.ts`: the delete refusal and the real path of
  an `rm` operand, tested in `safeBashRemove.test.ts`. The plan tests are
  `removePlans`, `removeRefusals`, `removeAfterCd`, and
  `removeAsksLikeTheRemoveTool`. No test runs an `rm`.
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
  covers words with `,`, `@`, `%`, and braces.
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
