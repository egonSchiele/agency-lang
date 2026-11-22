---
name: "safeBash"
description: "Run Bash commands with approvals matched to their actions."
---

# safeBash

```ts
import { safeBash } from "std::safeBash"

node main() {
  return safeBash("git status")
}
```

Recognized commands ask for specific approvals such as a file read or Git
status. When a command cannot be described that way, the whole command
asks for `std::bash` approval. Handlers and policies decide the requests
before execution begins.

Some echo, grep, cat, head, and tail commands run in process. Other commands
run under Bash, preserving the command's control flow. Explicit destructive
spellings such as `dd` and `git reset --hard` are refused. That list does not
cover every way to perform a destructive action; approval rules still apply.

`rm` and `rmdir` ask for `std::remove` approval for each path, as the
`remove` function does. They are refused for the filesystem root, the home
folder, a top-level folder, and the working directory or a folder that
holds it.

Use `planFor` to inspect the planned effects and execution without running
the command. See `docs/dev/stdlib/safe-bash.md` for classification rules.

## Types

### FlagSpec

Which flags a verb takes. Short letters are listed one per entry, so a
 combined `-rn` is checked letter by letter. A long flag that takes no
 value is listed as written (`--color=never`).

```ts
/** Which flags a verb takes. Short letters are listed one per entry, so a
 combined `-rn` is checked letter by letter. A long flag that takes no
 value is listed as written (`--color=never`). */
export type FlagSpec = {
  /** Flags that stand alone. */
  plain: string[];
  /** Flags that take a value, from the rest of the word (`-A3`), after
   `=` (`--regexp=x`), or from the next word (`-A 3`). Each may appear
   once. */
  valued: string[];
  /** Every flag must come before the first positional word. True for a
   command real grep will run: BSD grep, and GNU grep with
   POSIXLY_CORRECT set, read a later `-s` as a file to search. */
  optionsFirst: boolean;
  /** The valued flag a bare digit flag stands for: with `n`, head's `-20`
   is `-n 20`. A digit flag after a valued flag is that flag's value,
   so `head -n -5` stays a refused value. */
  digitFlag?: string;
  /** A single-dash flag is one word, listed with its dash (`-name`), and
   never a run of letters. True for find. No verb mixes the two kinds,
   so a table holds letters or words, not both. */
  wholeWords?: boolean;
  /** Read a long flag joined to a quoted value, `--include="*.ts"`, as
   that flag. Off unless a table turns it on: a quoted value can hold a
   space, a comma, or a glob character, which a bare value cannot, and
   each table's checks were written for bare values. */
  quotedValues?: boolean;
  /** The valued flags that may be given more than once. */
  repeatable?: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L867))

### FlagValue

One valued flag and its value. `flag` is the letter for a short flag
 (`A`) and the whole name for a long one (`--regexp`).

```ts
/** One valued flag and its value. `flag` is the letter for a short flag
 (`A`) and the whole name for a long one (`--regexp`). */
export type FlagValue = {
  flag: string;
  value: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L897))

### SplitArgs

A command's arguments checked against a FlagSpec.

```ts
/** A command's arguments checked against a FlagSpec. */
export type SplitArgs = {
  plain: string[];
  values: FlagValue[];
  positionals: Word[];
  /** Whether a flag came after the first positional, which a table
   without `optionsFirst` allows. */
  lateFlag: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L903))

### ReadVerb

A read verb's flags, how many paths it takes, and which of its valued
 flags hold a count.

```ts
/** A read verb's flags, how many paths it takes, and which of its valued
 flags hold a count. */
export type ReadVerb = {
  flags: FlagSpec;
  /** head and tail take one path, because several files print headers;
   uniq takes one, because a second positional is its output file; diff
   and cmp compare exactly two. */
  paths: CountRange;
  /** The valued flags whose value must be digits, such as `-n` on head. */
  countFlags: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1692))

### ListWalk

Whether a listing walks the tree always, or only when given -R.

```ts
/** Whether a listing walks the tree always, or only when given -R. */
export type ListWalk = "always" | "withR"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L2237))

### FileArgument

What a listing verb does with a path that names a file: list the
 folder that holds it, or refuse.

```ts
/** What a listing verb does with a path that names a file: list the
 folder that holds it, or refuse. */
export type FileArgument = "folder" | "refuse"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L2241))

### ListVerb

A verb that lists directories: its flags, which valued flags hold a
 count, and whether it walks the tree.

```ts
/** A verb that lists directories: its flags, which valued flags hold a
 count, and whether it walks the tree. */
export type ListVerb = {
  flags: FlagSpec;
  /** The valued flags whose value must be digits, such as `-L` on tree. */
  countFlags: string[];
  recursive: ListWalk;
  /** What a file given to the verb asks: its folder, or nothing. */
  files: FileArgument
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L2245))

### FlatCommand

A flattened simple command and whether a pipe supplies its input.

```ts
/** A flattened simple command and whether a pipe supplies its input. */
export type FlatCommand = {
  command: SimpleCommand;
  readsStdin: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4553))

### SafeBashEffects

Every effect `safeBash` can raise. `startJob` raises the same ones,
  since both ask through `approvedPlan`, so both signatures name this set.

```ts
/** Every effect `safeBash` can raise. `startJob` raises the same ones,
  since both ask through `approvedPlan`, so both signatures name this set. */
export effectSet SafeBashEffects = <std::bash, std::bash::readonly, std::write, std::remove, std::mkdir, std::grep, std::git::status, std::git::diff, std::git::log, std::git::show, std::git::blame, std::git::branchList, std::git::remoteList, std::git::stashList, std::git::add, std::git::commit, std::git::checkout, std::git::switch, std::git::branchCreate, std::git::branchDelete, std::git::stashPush, std::git::stashPop, std::git::restore, std::github::prGet, std::github::prDiff, std::github::issueGet, std::github::prFiles, std::github::prReviewList, std::github::prReviewCommentList, std::github::prChecks, std::github::issueCommentList, std::github::prList, std::github::issueList, std::github::issueSearch, std::read, std::ls, std::glob, std::exec, std::env, std::run, std::guard>
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5905))

### JobHandle

Which running job: what `startShellJob` returns, and what `std::jobs`
  takes to read, stop, or list one. Plain data, saved with the run. It is
  defined here and re-exported by `std::jobs`, which imports this module:
  a type in `std::jobs` would make the two modules import each other.

```ts
/** Which running job: what `startShellJob` returns, and what `std::jobs`
  takes to read, stop, or list one. Plain data, saved with the run. It is
  defined here and re-exported by `std::jobs`, which imports this module:
  a type in `std::jobs` would make the two modules import each other. */
export type JobHandle = {
  id: string;
  kind: string;
  label: string;
  startedAt: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L6158))

### ShellStart

How `startShellJob` ran a command: as a job, or in the foreground
  because only a plain shell command can be a job.

```ts
/** How `startShellJob` ran a command: as a job, or in the foreground
  because only a plain shell command can be a job. */
export type ShellStart =
  | { ran: "job"; handle: JobHandle }
  | { ran: "foreground"; output: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L6167))

## Constants

### GREP_FLAGS

The grep flags safeBash can describe exactly. An allowlist: it has to
 hold for GNU grep (Linux), BSD grep (macOS), and a grep a user put on
 their PATH such as ugrep, because the bash path runs whichever grep the
 shell finds. Left out on purpose, so a grep using
 one asks std::bash:
 - `-R`: GNU grep follows every symlink below the path.
 - `-f`, `--exclude-from`, `--include-from` read another file.
 - `-m` counts per file, and the payload's maxResults is a total.
 - `-P` is missing from BSD grep.
 - `-z`, `-d`, `-D` mean different things in different greps.
 - ugrep's `--filter` runs a program and `--save-config` writes a file.
 - The long spellings of short flags (`--recursive`, `--ignore-case`).
 `--include`, `--exclude`, and `--exclude-dir` only narrow what grep
 reads. A flag may come after a path because safeBash writes a search's
 flags first; a grep that reads a pipe runs as written, so `readGrep`
 refuses a late flag there.

```ts
/** The grep flags safeBash can describe exactly. An allowlist: it has to
 hold for GNU grep (Linux), BSD grep (macOS), and a grep a user put on
 their PATH such as ugrep, because the bash path runs whichever grep the
 shell finds. Left out on purpose, so a grep using
 one asks std::bash:
 - `-R`: GNU grep follows every symlink below the path.
 - `-f`, `--exclude-from`, `--include-from` read another file.
 - `-m` counts per file, and the payload's maxResults is a total.
 - `-P` is missing from BSD grep.
 - `-z`, `-d`, `-D` mean different things in different greps.
 - ugrep's `--filter` runs a program and `--save-config` writes a file.
 - The long spellings of short flags (`--recursive`, `--ignore-case`).
 `--include`, `--exclude`, and `--exclude-dir` only narrow what grep
 reads. A flag may come after a path because safeBash writes a search's
 flags first; a grep that reads a pipe runs as written, so `readGrep`
 refuses a late flag there. */
export static const GREP_FLAGS: FlagSpec = {
  plain: [
    "n",
    "r",
    "i",
    "w",
    "l",
    "v",
    "E",
    "F",
    "c",
    "h",
    "H",
    "o",
    "s",
    "--color=never",
  ],
  valued: ["e", "A", "B", "C", "--include", "--exclude", "--exclude-dir"],
  optionsFirst: false,
  quotedValues: true,
  repeatable: ["--include", "--exclude", "--exclude-dir"]
}
```

**Type:** [FlagSpec](#flagspec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L936))

### READ_VERBS

The verbs that read the files they name, or their stdin when they
 name none. Every letter means the same thing in GNU, BSD, and busybox
 coreutils. Left out: cat -A -e -t -v (GNU and BSD spell the escapes
 differently); tail -f (never returns); tail -r (BSD only); wc -L (GNU
 only); diff -r (reads a whole tree under a question that names one
 folder) and -y (column width depends on the terminal); sort -o
 (writes a file), -m, -c; uniq's second positional. tac is not on
 macOS; the line is recognized and the shell reports it missing. sort
 may spill a large input to files under $TMPDIR, which no payload
 names. The checksums read the whole file; `shasum -c` would read every
 file a list names, so the only flag in their rows is shasum's `-a`, which
 picks the algorithm by number (`shasum -a 256 file`). `file` opens the file
 and prints what its first bytes say, such as `OpenSSH private key`, so
 it is a read too.

```ts
/** The verbs that read the files they name, or their stdin when they
 name none. Every letter means the same thing in GNU, BSD, and busybox
 coreutils. Left out: cat -A -e -t -v (GNU and BSD spell the escapes
 differently); tail -f (never returns); tail -r (BSD only); wc -L (GNU
 only); diff -r (reads a whole tree under a question that names one
 folder) and -y (column width depends on the terminal); sort -o
 (writes a file), -m, -c; uniq's second positional. tac is not on
 macOS; the line is recognized and the shell reports it missing. sort
 may spill a large input to files under $TMPDIR, which no payload
 names. The checksums read the whole file; `shasum -c` would read every
 file a list names, so the only flag in their rows is shasum's `-a`, which
 picks the algorithm by number (`shasum -a 256 file`). `file` opens the file
 and prints what its first bytes say, such as `OpenSSH private key`, so
 it is a read too. */
export static const READ_VERBS: Record<string, ReadVerb> = {
  cat: {
    flags: {
      plain: ["n", "b", "s"],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  head: {
    flags: {
      plain: [],
      valued: ["n", "c"],
      optionsFirst: true,
      digitFlag: "n"
    },
    paths: AT_MOST_ONE,
    countFlags: ["n", "c"]
  },
  tail: {
    flags: {
      plain: [],
      valued: ["n", "c"],
      optionsFirst: true,
      digitFlag: "n"
    },
    paths: AT_MOST_ONE,
    countFlags: ["n", "c"]
  },
  wc: {
    flags: {
      plain: ["l", "w", "c", "m"],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  diff: {
    flags: {
      plain: ["u", "q", "N", "w", "b", "B", "--color=never"],
      valued: ["U"],
      optionsFirst: true
    },
    paths: EXACTLY_TWO,
    countFlags: ["U"]
  },
  cmp: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    paths: EXACTLY_TWO,
    countFlags: []
  },
  sort: {
    flags: {
      plain: ["n", "r", "u", "f", "b"],
      valued: ["k", "t"],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  uniq: {
    flags: {
      plain: ["c", "d", "u", "i"],
      valued: [],
      optionsFirst: true
    },
    paths: AT_MOST_ONE,
    countFlags: []
  },
  cut: {
    flags: {
      plain: [],
      valued: ["d", "f", "c"],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  nl: {
    flags: {
      plain: [],
      valued: ["b"],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  tac: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  rev: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  md5sum: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  shasum: {
    flags: {
      plain: [],
      valued: ["a"],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: ["a"]
  },
  sha256sum: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  },
  file: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    paths: ANY_NUMBER,
    countFlags: []
  }
}
```

**Type:** `Record<string, ReadVerb>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1716))

### LIST_VERBS

The verbs that list the folders they name, or `.` when they name
 none. Every letter means the same thing in GNU and BSD. Left out: `-L`
 on every verb (follows symlinks out of the folder) and `ls -G` (color
 on macOS, no group column on GNU). tree is not on macOS by default;
 the line is recognized and the shell reports it missing. A recursive
 listing through bash shows the entries under `.git` and `node_modules`
 that the ls tool's walk leaves out, and no file's contents. Given a
 file, ls prints that one entry and du that one file's size, so both
 ask for the folder that holds it, with no walk even though du always
 walks a folder. tree prints the name and an error, so it refuses.
 `stat` prints a file's or folder's size, owner, and times, which `ls
 -l` prints too, so it asks what `ls -l` asks and never walks.

```ts
/** The verbs that list the folders they name, or `.` when they name
 none. Every letter means the same thing in GNU and BSD. Left out: `-L`
 on every verb (follows symlinks out of the folder) and `ls -G` (color
 on macOS, no group column on GNU). tree is not on macOS by default;
 the line is recognized and the shell reports it missing. A recursive
 listing through bash shows the entries under `.git` and `node_modules`
 that the ls tool's walk leaves out, and no file's contents. Given a
 file, ls prints that one entry and du that one file's size, so both
 ask for the folder that holds it, with no walk even though du always
 walks a folder. tree prints the name and an error, so it refuses.
 `stat` prints a file's or folder's size, owner, and times, which `ls
 -l` prints too, so it asks what `ls -l` asks and never walks. */
export static const LIST_VERBS: Record<string, ListVerb> = {
  ls: {
    flags: {
      plain: [
        "l",
        "a",
        "A",
        "h",
        "1",
        "t",
        "r",
        "S",
        "R",
        "d",
        "p",
        "F",
        "--color=never",
      ],
      valued: [],
      optionsFirst: true
    },
    countFlags: [],
    recursive: "withR",
    files: "folder"
  },
  tree: {
    flags: {
      plain: ["a", "d", "--noreport"],
      valued: ["L", "I"],
      optionsFirst: true
    },
    countFlags: ["L"],
    recursive: "always",
    files: "refuse"
  },
  du: {
    flags: {
      plain: ["s", "h", "a", "c"],
      valued: ["d"],
      optionsFirst: true
    },
    countFlags: ["d"],
    recursive: "always",
    files: "folder"
  },
  stat: {
    flags: {
      plain: [],
      valued: [],
      optionsFirst: true
    },
    countFlags: [],
    recursive: "withR",
    files: "folder"
  }
}
```

**Type:** `Record<string, ListVerb>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L2266))

## Functions

### effectsFor

```ts
effectsFor(
  command: SimpleCommand,
  cwd: string,
  readsStdin: boolean = false,
  origin: GhRepo | null = null,
): Result<Effect[]>
```

Classify the approvals needed by one simple command.
  Return a failure when it needs the broader Bash approval.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | [SimpleCommand](safeBash/actions.md#simplecommand) |  |  |
| cwd | `string` |  | The resolved working directory used in approval payloads. |
| readsStdin | `boolean` | false | Whether a pipe supplies this command's input. |
| origin | `GhRepo \| null` | null | The repository a `gh` command acts on when it names none. Left null, such a command's std::github effects name no repository. |

**Returns:** `Result<Effect[]>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L370))

### outcomeOf

```ts
outcomeOf(plan: Plan): string
```

Name a plan's outcome: refuse, shellFree, agency, narrow, or broad.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| plan | [Plan](safeBash/actions.md#plan) |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4523))

### planFor

```ts
planFor(source: string, cwd: string, origin: GhRepo | null = null): Plan
```

Plan approvals and execution for Bash source without running the command.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| source | `string` |  |  |
| cwd | `string` |  | The working directory used to resolve paths during classification. |
| origin | `GhRepo \| null` | null | The repository a `gh` command acts on when it names none. Left null, such a command's std::github effects name no repository and say which folder to look it up in. |

**Returns:** [Plan](safeBash/actions.md#plan)

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4812))

### removeRefusal

```ts
removeRefusal(command: SimpleCommand, cwd: string): string
```

Why an rm or rmdir is refused, or an empty string when it is not: a target that is the filesystem root, the home folder, a top-level folder, or the working directory or a folder that holds it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](safeBash/actions.md#simplecommand) |  |
| cwd | `string` |  |

**Returns:** `string`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5657))

### isRefused

```ts
isRefused(command: SimpleCommand): boolean
```

Check whether a command matches an explicitly refused destructive spelling.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](safeBash/actions.md#simplecommand) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5738))

### bashParser

```ts
bashParser(code: string): Result<BashAST>
```

Parse a string of bash code into an AST.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |

**Returns:** `Result<BashAST>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5836))

### resolveCwd

```ts
resolveCwd(cwd: string): string
```

Use the requested directory, then the agent directory, then the process directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5860))

### safeBash

```ts
safeBash(
  command: string,
  cwd: string = "",
  timeout: number = 120,
  exitIsFailure: boolean = true,
): Result<string> raises <SafeBashEffects>
```

Run Bash commands after approval of the actions they perform.
  Return stdout on success. A nonzero exit is a failure carrying stdout,
  stderr, and a last line `Command exited with code N`, so there is no need
  to echo `$?` or re-run a command to learn how it exited. Output longer
  than 2000 lines or 50,000 characters is saved as a file and its last lines
  are returned, with the file's path. Read that path like any file, with
  tail, grep, sed -n or any other command, or with read. A
  command still running after `timeout` seconds is stopped, with everything
  it started, and the failure carries the output so far.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | One or more bash commands. |
| cwd | `string` | "" | Working directory, defaulting to the agent directory or the process directory. |
| timeout | `number` | 120 | Seconds the command may run. Pass more for a command known to be slow, such as a full test suite. |
| exitIsFailure | `boolean` | true | Whether a nonzero exit is a failure. When false, it is a successful result holding the same text. |

**Returns:** `Result<string>`

**Throws:** `std::bash`, `std::bash::readonly`, `std::write`, `std::grep`, `std::read`, `std::ls`, `std::glob`, `std::exec`, `std::remove`, `std::mkdir`, `std::env`, `std::git::status`, `std::git::log`, `std::git::diff`, `std::git::show`, `std::git::blame`, `std::git::branchList`, `std::git::remoteList`, `std::git::stashList`, `std::git::add`, `std::git::commit`, `std::git::checkout`, `std::git::switch`, `std::git::branchCreate`, `std::git::branchDelete`, `std::git::stashPush`, `std::git::stashPop`, `std::git::restore`, `std::github::prGet`, `std::github::prDiff`, `std::github::issueGet`, `std::github::prFiles`, `std::github::prReviewList`, `std::github::prReviewCommentList`, `std::github::prChecks`, `std::github::issueCommentList`, `std::github::prList`, `std::github::issueList`, `std::github::issueSearch`, `std::guard`, `std::run`

**Needs:** `fileRead`, `subprocess`, `env`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5907))

### startJob

```ts
startJob(
  command: string,
  cwd: string = "",
  maxMinutes: number = 60,
): Result<string> raises <SafeBashEffects>
```

Start a shell command in the background and return its job id at once, while the command keeps running. Use it for a command expected to run for minutes or longer, such as a download, a server, a watch, or a long script. It asks the same approvals as running the command in the foreground. The job keeps running until it exits, reaches maxMinutes, or is stopped with stopJob, even after this program ends. Only a plain shell command becomes a job. A file read, an echo, or an agency command runs in the foreground instead, however long it takes. A command that prints more than 10 MiB on one stream is stopped, so redirect such output to a file.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | One or more bash commands. |
| cwd | `string` | "" | Working directory, defaulting to the agent directory or the process directory. |
| maxMinutes | `number` | 60 | Minutes the job may run before it is stopped, at most 720. |

**Returns:** `Result<string>`

**Throws:** `std::bash`, `std::bash::readonly`, `std::write`, `std::grep`, `std::read`, `std::ls`, `std::glob`, `std::exec`, `std::remove`, `std::mkdir`, `std::env`, `std::git::status`, `std::git::log`, `std::git::diff`, `std::git::show`, `std::git::blame`, `std::git::branchList`, `std::git::remoteList`, `std::git::stashList`, `std::git::add`, `std::git::commit`, `std::git::checkout`, `std::git::switch`, `std::git::branchCreate`, `std::git::branchDelete`, `std::git::stashPush`, `std::git::stashPop`, `std::git::restore`, `std::github::prGet`, `std::github::prDiff`, `std::github::issueGet`, `std::github::prFiles`, `std::github::prReviewList`, `std::github::prReviewCommentList`, `std::github::prChecks`, `std::github::issueCommentList`, `std::github::prList`, `std::github::issueList`, `std::github::issueSearch`, `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L6135))

### startShellJob

```ts
startShellJob(
  command: string,
  label: string,
  cwd: string = "",
  maxMinutes: number = 60,
  foreground: boolean = true,
): Result<ShellStart> raises <SafeBashEffects>
```

Start a shell command as a detached job, after asking the approvals running it in the foreground would ask. The job keeps running after this program ends, until it exits, reaches maxMinutes, or is stopped. Only a plain shell command becomes a job; any other command runs in the foreground, or is refused when foreground is false.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | One or more bash commands. |
| label | `string` |  | What a list of jobs shows for this one. |
| cwd | `string` | "" | Working directory, defaulting to the agent directory or the process directory. |
| maxMinutes | `number` | 60 | Minutes the job may run before it is stopped, at most 720. |
| foreground | `boolean` | true | Whether a command that cannot be a job runs in the foreground. |

**Returns:** `Result<ShellStart>`

**Throws:** `std::bash`, `std::bash::readonly`, `std::write`, `std::grep`, `std::read`, `std::ls`, `std::glob`, `std::exec`, `std::remove`, `std::mkdir`, `std::env`, `std::git::status`, `std::git::log`, `std::git::diff`, `std::git::show`, `std::git::blame`, `std::git::branchList`, `std::git::remoteList`, `std::git::stashList`, `std::git::add`, `std::git::commit`, `std::git::checkout`, `std::git::switch`, `std::git::branchCreate`, `std::git::branchDelete`, `std::git::stashPush`, `std::git::stashPop`, `std::git::restore`, `std::github::prGet`, `std::github::prDiff`, `std::github::issueGet`, `std::github::prFiles`, `std::github::prReviewList`, `std::github::prReviewCommentList`, `std::github::prChecks`, `std::github::issueCommentList`, `std::github::prList`, `std::github::issueList`, `std::github::issueSearch`, `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L6172))
