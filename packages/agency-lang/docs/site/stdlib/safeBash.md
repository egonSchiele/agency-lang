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
spellings such as `rm` and `git reset --hard` are refused. That list does not
cover every way to perform a destructive action; approval rules still apply.

Use `planFor` to inspect the planned effects and execution without running
the command. See `docs/dev/stdlib/safe-bash.md` for classification rules.

## Types

### Word

```ts
export type Word =
  | LiteralWord
  | PathWord
  | GlobWord
  | FlagWord
  | SingleQuotedWord
  | DoubleQuotedWord
  | VariableWord
  | InterpolatedVariableWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L106))

### ScriptName

```ts
export type ScriptName = LiteralWord | PathWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L116))

### LiteralWord

```ts
export type LiteralWord = {
  tag: "literal";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L118))

### PathWord

```ts
export type PathWord = {
  tag: "path";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L123))

### GlobWord

An unquoted word bash will expand (`*.ts`, `src/*.md`). Its own node
 so it is never mistaken for the quoted text `'*.ts'`; no rule here
 treats it as a literal.

```ts
/** An unquoted word bash will expand (`*.ts`, `src/*.md`). Its own node
 so it is never mistaken for the quoted text `'*.ts'`; no rule here
 treats it as a literal. */
export type GlobWord = {
  tag: "glob";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L131))

### FlagWord

```ts
export type FlagWord = {
  tag: "flag";
  flagName: string;
  flagValue?: string;
  /** Present and true when the value is an unquoted glob (`--include=*.ts`). */
  valueIsGlob?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L136))

### SingleQuotedWord

```ts
export type SingleQuotedWord = {
  tag: "singleQuoted";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L144))

### DoubleQuotedWord

```ts
export type DoubleQuotedWord = {
  tag: "doubleQuoted";
  parts: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L149))

### VariableWord

```ts
export type VariableWord = {
  tag: "variable";
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L154))

### InterpolatedVariableWord

Adjacent word parts, such as `$HOME.txt` or `"a"b`, that form one Bash argument.

```ts
/** Adjacent word parts, such as `$HOME.txt` or `"a"b`, that form one Bash argument. */
export type InterpolatedVariableWord = {
  tag: "interpolatedVariable";
  parts: (
  | LiteralWord
  | VariableWord
  | SingleQuotedWord
  | DoubleQuotedWord)[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L160))

### Assignment

`name=value` (or `name=` with a null value) before a command.

```ts
/** `name=value` (or `name=` with a null value) before a command. */
export type Assignment = {
  tag: "assignment";
  name: string;
  value?: Word
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L170))

### Redirect

A redirect like `> out.txt`, `>> log`, `2> err.txt`, `< in.txt`, or
 the dup `2>&1` (op `>&`, target a one-digit literal). `fd` is the
 explicit file descriptor (`2` in `2>`), or undefined for the default.
 Heredocs and here-strings are rejected rather than parsed.

```ts
/** A redirect like `> out.txt`, `>> log`, `2> err.txt`, `< in.txt`, or
 the dup `2>&1` (op `>&`, target a one-digit literal). `fd` is the
 explicit file descriptor (`2` in `2>`), or undefined for the default.
 Heredocs and here-strings are rejected rather than parsed. */
export type Redirect = {
  tag: "redirect";
  fd?: number;
  op: string;
  target: Word
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L180))

### SimpleCommand

```ts
export type SimpleCommand = {
  tag: "simpleCommand";
  assignments: Assignment[];
  /* The command name, or null for an assignment-only line (`FOO=bar`).
    Bash requires at least one of a command name or an assignment. */
  command?: ScriptName;
  /** Every word after the command name, in source order. */
  args: Word[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L187))

### Command

```ts
export type Command = SimpleCommand | Pipeline | And | Or | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L198))

### PipelineStage

What may sit between pipes: a simple command or a parenthesized group.

```ts
/** What may sit between pipes: a simple command or a parenthesized group. */
export type PipelineStage = SimpleCommand | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L201))

### Pipeline

`a | b | c`: flat, two or more stages, binding tighter than `&&`/`||`.

```ts
/** `a | b | c`: flat, two or more stages, binding tighter than `&&`/`||`. */
export type Pipeline = {
  tag: "pipeline";
  stages: PipelineStage[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L204))

### And

```ts
export type And = {
  tag: "and";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L209))

### Or

```ts
export type Or = {
  tag: "or";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L215))

### Parens

```ts
export type Parens = {
  tag: "parens";
  command: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L221))

### BashNode

```ts
export type BashNode =
  | Command
  | SimpleCommand
  | Assignment
  | Redirect
  | Word
  | ScriptName
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L226))

### BashAST

```ts
export type BashAST = Command[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L234))

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
  wholeWords?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L662))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L685))

### SplitArgs

A command's arguments checked against a FlagSpec.

```ts
/** A command's arguments checked against a FlagSpec. */
export type SplitArgs = {
  plain: string[];
  values: FlagValue[];
  positionals: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L691))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1294))

### ListWalk

Whether a listing walks the tree always, or only when given -R.

```ts
/** Whether a listing walks the tree always, or only when given -R. */
export type ListWalk = "always" | "withR"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1560))

### FileArgument

What a listing verb does with a path that names a file: list the
 folder that holds it, or refuse.

```ts
/** What a listing verb does with a path that names a file: list the
 folder that holds it, or refuse. */
export type FileArgument = "folder" | "refuse"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1564))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1568))

### FlatCommand

A flattened simple command and whether a pipe supplies its input.

```ts
/** A flattened simple command and whether a pipe supplies its input. */
export type FlatCommand = {
  command: SimpleCommand;
  readsStdin: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L3614))

## Constants

### GREP_FLAGS

The grep flags safeBash can describe exactly. An allowlist: it has to
 hold for GNU grep (Linux), BSD grep (macOS), and a grep a user put on
 their PATH such as ugrep, because the bash path runs whichever grep the
 shell finds. Left out on purpose, so a grep using
 one asks std::bash:
 - `-R`: GNU grep follows every symlink below the path.
 - `-f`, `--exclude-from`, `--include-from` read another file.
 - `--include`, `--exclude`, `--exclude-dir`: the shell-free path cannot
   carry them out, and the bash path is narrow only for one named file,
   where they change nothing.
 - `-m` counts per file, and the payload's maxResults is a total.
 - `-P` is missing from BSD grep.
 - `-z`, `-d`, `-D` mean different things in different greps.
 - ugrep's `--filter` runs a program and `--save-config` writes a file.
 - The long spellings of short flags (`--recursive`, `--ignore-case`).

```ts
/** The grep flags safeBash can describe exactly. An allowlist: it has to
 hold for GNU grep (Linux), BSD grep (macOS), and a grep a user put on
 their PATH such as ugrep, because the bash path runs whichever grep the
 shell finds. Left out on purpose, so a grep using
 one asks std::bash:
 - `-R`: GNU grep follows every symlink below the path.
 - `-f`, `--exclude-from`, `--include-from` read another file.
 - `--include`, `--exclude`, `--exclude-dir`: the shell-free path cannot
   carry them out, and the bash path is narrow only for one named file,
   where they change nothing.
 - `-m` counts per file, and the payload's maxResults is a total.
 - `-P` is missing from BSD grep.
 - `-z`, `-d`, `-D` mean different things in different greps.
 - ugrep's `--filter` runs a program and `--save-config` writes a file.
 - The long spellings of short flags (`--recursive`, `--ignore-case`). */
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
  valued: ["e", "A", "B", "C"],
  optionsFirst: true
}
```

**Type:** [FlagSpec](#flagspec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L720))

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
 names.

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
 names. */
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
  }
}
```

**Type:** `Record<string, ReadVerb>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1314))

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
 walks a folder. tree prints the name and an error, so it refuses. */
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
  }
}
```

**Type:** `Record<string, ListVerb>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L1587))

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
| command | [SimpleCommand](#simplecommand) |  |  |
| cwd | `string` |  | The resolved working directory used in approval payloads. |
| readsStdin | `boolean` | false | Whether a pipe supplies this command's input. |
| origin | `GhRepo \| null` | null | The repository a `gh` command acts on when it names none. Left null, such a command's std::github effects name no repository. |

**Returns:** `Result<Effect[]>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L438))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L3590))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L3887))

### isRefused

```ts
isRefused(command: SimpleCommand): boolean
```

Check whether a command matches an explicitly refused destructive spelling.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](#simplecommand) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4165))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4260))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4284))

### safeBash

```ts
safeBash(
  command: string,
  cwd: string = "",
  timeout: number = 120,
): Result<string> raises <std::bash, std::write, std::grep, std::git::status, std::git::diff, std::git::log, std::git::show, std::git::blame, std::git::branchList, std::git::remoteList, std::git::stashList, std::git::add, std::git::commit, std::git::checkout, std::git::switch, std::git::branchCreate, std::git::branchDelete, std::git::stashPush, std::git::stashPop, std::git::restore, std::github::prGet, std::github::prDiff, std::github::issueGet, std::github::prFiles, std::github::prReviewList, std::github::prReviewCommentList, std::github::prChecks, std::github::issueCommentList, std::github::prList, std::github::issueList, std::github::issueSearch, std::read, std::ls, std::glob, std::exec, std::run, std::guard>
```

Run Bash commands after approval of the actions they perform.
  Return stdout on success. A nonzero exit is a failure carrying the exit
  code, stdout, and stderr, so there is no need to echo `$?` or re-run a
  command to learn how it exited. Read saved long output with readSpill or
  grepSpill, not with bash. A command still running after `timeout`
  seconds is stopped, with everything it started, and the failure carries
  the output so far.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | One or more bash commands. |
| cwd | `string` | "" | Working directory, defaulting to the agent directory or the process directory. |
| timeout | `number` | 120 | Seconds the command may run. Pass more for a command known to be slow, such as a full test suite. |

**Returns:** `Result<string>`

**Throws:** `std::bash`, `std::write`, `std::grep`, `std::read`, `std::ls`, `std::glob`, `std::exec`, `std::git::status`, `std::git::log`, `std::git::diff`, `std::git::show`, `std::git::blame`, `std::git::branchList`, `std::git::remoteList`, `std::git::stashList`, `std::git::add`, `std::git::commit`, `std::git::checkout`, `std::git::switch`, `std::git::branchCreate`, `std::git::branchDelete`, `std::git::stashPush`, `std::git::stashPop`, `std::git::restore`, `std::github::prGet`, `std::github::prDiff`, `std::github::issueGet`, `std::github::prFiles`, `std::github::prReviewList`, `std::github::prReviewCommentList`, `std::github::prChecks`, `std::github::issueCommentList`, `std::github::prList`, `std::github::issueList`, `std::github::issueSearch`, `std::guard`, `std::run`

**Needs:** `fileRead`, `subprocess`, `env`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L4327))
