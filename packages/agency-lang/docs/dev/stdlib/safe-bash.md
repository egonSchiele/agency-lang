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
  (`astToBash`), so a parser bug degrades to running what was read.
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

`refuse`: the refuse wall (`isRefused`) matches `rm`, `rmdir`, `dd`,
`shred`, `mkfs`, `truncate`, and the destructive git spellings, by command
word including the last part of a path. Nothing is raised. The wall is
friction against the obvious spelling; `find -delete` gets past it and is
approvable under `std::bash`, which is where the control lives.

`shellFree`: a single literal `echo`, with or without one output
redirect, never spawns a shell. The output is computed in Agency and
returned, or written with `_write` under a `std::write` whose payload
carries the bytes. A lone `grep` that translates exactly runs the grep
tool's own search (see "grep" below). A lone `cat`, `head`, or `tail` of
one file runs the read tool's own read (see "The read family" below). An
`agency <sub> <file>` line runs in-process through `std::agency`.

`bash`: everything else. Narrow when every command was recognized
(`git status`, `git log`, `git diff`, `git diff --staged`, a grep of one
named file, a read of named files, a redirect contributing `std::write`
or `std::read`), broad otherwise.

`outcomeOf(plan)` names which of these a plan is (`refuse`, `shellFree`,
`agency`, `narrow`, `broad`) with an exhaustive match over the
`Execution` union, so a new execution kind is a type error there.

## In process when it translates

The shell-free grep and the shell-free read follow one rule. A lone
command whose flags and arguments translate exactly runs the matching
stdlib tool in process, under that tool's effect. Any other command runs
through bash, with a narrow effect only when the payload describes what
bash will do, and `std::bash` otherwise.

| Command | Runs | Raises |
|---|---|---|
| `grep -rn hello src` | `_grep` | `std::grep`, as the grep tool does |
| `cat one.txt` | `_read` | `std::read`, as the read tool does |
| `grep -c hello one.txt` | real grep, through bash | `std::grep` for the one file |
| `wc -l one.txt` | real wc, through bash | `std::read` for the one file |

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
glob). The list is `SHELL_ENV_REMOVED` in
`lib/host/node/nodeSubprocess.ts`. Without `POSIXLY_CORRECT`, GNU
programs in the child read options anywhere on the line. No plan
changes, because the flag tables that care set `optionsFirst`.

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
`echo`'s output goes to. A `glob` word is never a literal:
`literalWordText` refuses it, so every rule that needs a literal (a
redirect target, an `echo` argument, a git argument) treats a command
with one as unrecognized until a later slice gives globs a meaning.

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

`stdinStage(verb, readsStdin, redirects)` joins them, and it is the only
place that reads the flag. A stdin reader fed by a pipe contributes only
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
whose directory target has `-r`, whose directory target is not wholly
ignored by the `.gitignore` files above it, and whose pattern translates. It raises
`std::grep` and runs `runGrep`, which calls `_grep`. The payload and the
search are built from one `GrepPayload`, and the payload's `pattern` is
the JavaScript regex the search uses, with the regex flag `u`, so `.`
matches a whole character, an emoji included, as grep does in a UTF-8
locale.

The `.gitignore` check matters because the tool's search applies the
`.gitignore` files above its root to every entry. Where they ignore
everything in the directory (`**/node_modules/*` for
`grep -rn x node_modules`), the search finds nothing, which the model
would read as "no match". `ignoredFromAbove` (`lib/stdlib/gitignore.ts`)
is true when those files ignore the directory itself, or a made-up name
inside it. Only a rule that covers every entry (`dist/`,
`**/node_modules/*`, `src/*`) ignores the made-up name. Such a grep goes
to the bash path, which asks `std::bash` for a directory.

A rule that ignores only some entries (`.*` for `.DS_Store`, `**/*.js`
for compiled files) does not send the grep to bash. The search then finds
fewer matches than grep would, the same as a search of the repository
root, and the note at the end of the output says what it skipped. Do not
make the check look at the entries themselves: nearly every real folder
holds one ignored file, so nearly every grep would go back to
`std::bash`.

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
that is not literal. GNU reads that as "all but the last five". A row's
`countFlags` must have digit values, so `tail -n +5` and `diff -U x` are
refused too.

Every path must be literal, and it must name a regular file.
`resolveReadPath` resolves each one with `_searchTargetIn`, the resolver
grep uses, which realpaths the path and stats it. An input redirect's
target goes through the same function:

- A folder is refused. With folders, `diff a b` reads every file under
  both, following links, under two questions that name only `a` and `b`.
- A FIFO or a device is refused. `wc -l pipe` would never return, and
  `runBash` has no timeout.
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

The bash parser refuses a comma joined to a flag, so `sort -t, -k2`,
`cut -d, -f1`, and `sort -k2,2n` are unparseable and ask `std::bash`. The
same flags with a space (`cut -d : -f 1`) parse.

### A lone cat, head, or tail runs the read tool's read

`tryShellFreeRead` applies to a lone `cat`, `cat -n`, `head -n N`, or
`tail -n N` of one file, with no redirect, where N is at least 1. It
raises `std::read` and runs `runRead`, which reads the file with `_read`
and prints it with `_renderReadView` (`lib/stdlib/readDialect.ts`):

- `whole`: the text as it is.
- `numbered`: each line after its number, right-aligned in six columns,
  and a tab. A last line with no newline is numbered and keeps no
  newline. An empty file prints nothing.
- `head`: the first N lines, each with its newline if it had one.
- `tail`: the last N lines. A last line with no newline counts as one.

Only `\n` ends a line, so a `\r` stays inside its line. A count of 0 is
refused, because BSD `head -n 0` prints an error and exits 1 while GNU
prints nothing. `cat -b`, `cat -s`, and `-c` go through bash.

A count given twice never reaches the renderer. `splitFlags` takes a
valued flag once, so `head -n 1 -n 2` and `head -2 -n 1` are refused on
every path and ask `std::bash`. GNU head and tail take the last count,
BSD head takes the last, and BSD tail refuses the line, so no one
answer would be right.

`runRead` returns `_read`'s own failure. The plan already refused a
missing file or a folder, so a failure there is a race or a permission
error, and `_read`'s message says which.

`shellFreeReadMatchesRealTools` runs each shell-free row and the real
program over `tests/agency/stdlib/read-fixtures/`, and compares the
output exactly. The fixtures include a file with no final newline, an
empty file, and a file with Windows line endings.

These are left out:

- `echo -n`. macOS `/bin/sh` prints `-n hi` for `echo -n hi`, so a
  shell-free `echo -n` would disagree with the same echo inside a chain.
  It waits on ADI-248, which decides which shell runs the text.
- `wc` in process. GNU and BSD pad the count column differently.
- More than one file in process. `head` prints a header per file.
- `file`, `stat`, `md5sum`, `shasum`, `column`, `xxd`, and `hexdump`.

## Why the executors call `_bash`, `_write`, `_grep`, and `_read`

The `bash`, `write`, `grep`, and `read` tools raise their own interrupts. Calling them
after `raiseAll` would ask the broad question a second time. The bypass
is correct for one reason: the only path to an executor runs through a
`raiseAll` that raised every effect in the plan and returned success, and
every plan raises at least one effect.

## Files and tests

- `stdlib/safeBash.agency`: the classifier, `planFor`, `safeBash`.
- `stdlib/safeBash/actions.agency`: `Plan`, `BroadReason`, `Effect`,
  `Execution`, and the executors.
- `lib/stdlib/safeBash.ts`: the tarsec re-export.
- `lib/stdlib/grepDialect.ts`: the pattern translation, grep's output
  format, and the skipped-folders note.
- `lib/stdlib/readDialect.ts`: what `cat`, `cat -n`, `head`, and `tail`
  print for a file's text.
- `lib/stdlib/shell.ts`: `_searchTargetIn`, which resolves a grep path
  or a read path against safeBash's cwd.
- `lib/stdlib/statelog.ts`: `_debug`.
- `tests/agency/safeBash.agency`: plan tests (`planReasons`,
  `planVerbs`, `planOutcomes`, `wholeStringPlans`, ...), the end-to-end
  runs with interrupt expectations, and the rejection messages.
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
