---
name: "actions"
description: "Represent and execute plans made by safeBash."
---

# actions

Use `safeBash` from `std::safeBash` to run commands. This module holds the
types that describe a plan: the approvals it asks for and what runs after
they are granted. The code that runs a plan lives in `std::safeBash` and is
not exported, because it skips the approvals the plan already raised.

```ts
import { outcomeOf, planFor } from "std::safeBash"

node main() {
  const plan = planFor("git status", "/project")
  print(outcomeOf(plan))
}
```

A plan pairs the required approvals with an execution. Inspect the plan to
test classification without executing its commands.

## Types

### Word

One word of a parsed command, as the parser read it.

```ts
/** One word of a parsed command, as the parser read it. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L26))

### ScriptName

```ts
export type ScriptName = LiteralWord | PathWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L36))

### LiteralWord

```ts
export type LiteralWord = {
  tag: "literal";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L38))

### PathWord

```ts
export type PathWord = {
  tag: "path";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L43))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L51))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L56))

### SingleQuotedWord

```ts
export type SingleQuotedWord = {
  tag: "singleQuoted";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L64))

### DoubleQuotedWord

```ts
export type DoubleQuotedWord = {
  tag: "doubleQuoted";
  parts: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L69))

### VariableWord

```ts
export type VariableWord = {
  tag: "variable";
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L74))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L80))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L90))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L100))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L107))

### Command

```ts
export type Command = SimpleCommand | Pipeline | And | Or | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L118))

### PipelineStage

What may sit between pipes: a simple command or a parenthesized group.

```ts
/** What may sit between pipes: a simple command or a parenthesized group. */
export type PipelineStage = SimpleCommand | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L121))

### Pipeline

`a | b | c`: flat, two or more stages, binding tighter than `&&`/`||`.

```ts
/** `a | b | c`: flat, two or more stages, binding tighter than `&&`/`||`. */
export type Pipeline = {
  tag: "pipeline";
  stages: PipelineStage[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L124))

### And

```ts
export type And = {
  tag: "and";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L129))

### Or

```ts
export type Or = {
  tag: "or";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L135))

### Parens

```ts
export type Parens = {
  tag: "parens";
  command: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L141))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L146))

### BashAST

```ts
export type BashAST = Command[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L154))

### Effect

A required approval, with a payload checked for its effect.

```ts
/** A required approval, with a payload checked for its effect. */
export type Effect =
  | { name: "std::bash" }
  | { name: "std::bash::readonly" }
  | { name: "std::write"; payload: WritePayload }
  | { name: "std::git::status"; payload: { cwd: string } }
  | { name: "std::git::log"; payload: { cwd: string; ref: string; path: string } }
  | { name: "std::git::diff"; payload: GitDiffPayload }
  | { name: "std::git::show"; payload: GitShowPayload }
  | { name: "std::git::blame"; payload: GitBlamePayload }
  | { name: "std::git::branchList"; payload: GitRepoPayload }
  | { name: "std::git::remoteList"; payload: GitRepoPayload }
  | { name: "std::git::stashList"; payload: GitRepoPayload }
  | { name: "std::git::add"; payload: GitAddPayload }
  | { name: "std::git::commit"; payload: GitCommitPayload }
  | { name: "std::git::checkout"; payload: GitCheckoutPayload }
  | { name: "std::git::switch"; payload: GitSwitchPayload }
  | { name: "std::git::branchCreate"; payload: GitBranchCreatePayload }
  | { name: "std::git::branchDelete"; payload: GitBranchDeletePayload }
  | { name: "std::git::stashPush"; payload: GitStashPushPayload }
  | { name: "std::git::stashPop"; payload: GitRepoPayload }
  | { name: "std::git::restore"; payload: GitRestorePayload }
  | { name: "std::grep"; payload: GrepPayload }
  | { name: "std::read"; payload: ReadPayload }
  | { name: "std::ls"; payload: LsPayload }
  | { name: "std::glob"; payload: GlobPayload }
  | { name: "std::exec"; payload: ExecPayload }
  | { name: "std::remove"; payload: RemovePayload }
  | { name: "std::mkdir"; payload: MkdirPayload }
  | { name: "std::env"; payload: { name: string } }
  | { name: "std::github::prGet"; payload: GhNumberPayload; lookup: string
  | null }
  | { name: "std::github::prDiff"; payload: GhNumberPayload; lookup: string
  | null }
  | { name: "std::github::issueGet"; payload: GhNumberPayload; lookup: string
  | null }
  | { name: "std::github::prFiles"; payload: GhPagedPayload; lookup: string
  | null }
  | { name: "std::github::prReviewList"; payload: GhPagedPayload; lookup: string
  | null }
  | { name: "std::github::prReviewCommentList"; payload: GhPagedPayload; lookup: string
  | null }
  | { name: "std::github::prChecks"; payload: GhPagedPayload; lookup: string
  | null }
  | { name: "std::github::issueCommentList"; payload: GhPagedPayload; lookup: string
  | null }
  | { name: "std::github::prList"; payload: GhPrListPayload; lookup: string
  | null }
  | { name: "std::github::issueList"; payload: GhIssueListPayload; lookup: string
  | null }
  | { name: "std::github::issueSearch"; payload: GhSearchPayload; lookup: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L157))

### WritePayload

```ts
export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L198))

### GrepPayload

The fields the grep tool's own std::grep interrupt carries.

```ts
/** The fields the grep tool's own std::grep interrupt carries. */
export type GrepPayload = {
  pattern: string;
  dir: string;
  file?: string;
  flags: string;
  maxResults: number;
  ignoreCase: boolean;
  wholeWord: boolean;
  filesOnly: boolean;
  invert: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L228))

### ReadPayload

The fields the read tool's own std::read interrupt is keyed on: the
 real parent of the file, and its name.

```ts
/** The fields the read tool's own std::read interrupt is keyed on: the
 real parent of the file, and its name. */
export type ReadPayload = {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L250))

### RemovePayload

The field the remove tool's own std::remove interrupt is keyed on: the
 real whole path of what is deleted.

```ts
/** The field the remove tool's own std::remove interrupt is keyed on: the
 real whole path of what is deleted. */
export type RemovePayload = {
  target: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L265))

### MkdirPayload

The field the mkdir tool's own std::mkdir interrupt carries: the real
 path of the folder, including steps that do not exist yet.

```ts
/** The field the mkdir tool's own std::mkdir interrupt carries: the real
 path of the folder, including steps that do not exist yet. */
export type MkdirPayload = {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L279))

### LsPayload

The fields the ls tool's own std::ls interrupt is keyed on. On the
 bash path `maxResults` is 0, meaning no cap: real ls, tree, and du list
 everything.

```ts
/** The fields the ls tool's own std::ls interrupt is keyed on. On the
 bash path `maxResults` is 0, meaning no cap: real ls, tree, and du list
 everything. */
export type LsPayload = {
  dir: string;
  recursive: boolean;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L302))

### GlobPayload

The fields the glob tool's own std::glob interrupt is keyed on. On the
 bash path `maxResults` is 0, meaning no cap: real find lists
 everything.

```ts
/** The fields the glob tool's own std::glob interrupt is keyed on. On the
 bash path `maxResults` is 0, meaning no cap: real find lists
 everything. */
export type GlobPayload = {
  pattern: string;
  dir: string;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L319))

### ExecPayload

The fields the exec tool's own std::exec interrupt carries. From
 safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
 0 in the plan and safeBash's own limit when raised, `stdin` is empty,
 which is how safeBash runs the line, and an
 argument may be an unexpanded glob or `~` that bash expands.

```ts
/** The fields the exec tool's own std::exec interrupt carries. From
 safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
 0 in the plan and safeBash's own limit when raised, `stdin` is empty,
 which is how safeBash runs the line, and an
 argument may be an unexpanded glob or `~` that bash expands. */
export type ExecPayload = {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L338))

### GitDiffPayload

```ts
export type GitDiffPayload = {
  cwd: string;
  ref: string;
  ref2: string;
  staged: boolean;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L354))

### GitRepoPayload

The payload of a git effect that names only the repository.

```ts
/** The payload of a git effect that names only the repository. */
export type GitRepoPayload = {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L367))

### GitLogPayload

```ts
export type GitLogPayload = {
  cwd: string;
  ref: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L371))

### GitShowPayload

```ts
export type GitShowPayload = {
  cwd: string;
  ref: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L377))

### GitBlamePayload

```ts
export type GitBlamePayload = {
  cwd: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L382))

### GitAddPayload

```ts
export type GitAddPayload = {
  cwd: string;
  paths: string[];
  all: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L387))

### GitCommitPayload

```ts
export type GitCommitPayload = {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L393))

### GitCheckoutPayload

```ts
export type GitCheckoutPayload = {
  cwd: string;
  target: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L398))

### GitSwitchPayload

```ts
export type GitSwitchPayload = {
  cwd: string;
  branch: string;
  create: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L404))

### GitBranchCreatePayload

```ts
export type GitBranchCreatePayload = {
  cwd: string;
  branch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L410))

### GitBranchDeletePayload

```ts
export type GitBranchDeletePayload = {
  cwd: string;
  branch: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L415))

### GitStashPushPayload

```ts
export type GitStashPushPayload = {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L421))

### GitRestorePayload

```ts
export type GitRestorePayload = {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L426))

### GhRepo

The repository a `gh` command acts on.

```ts
/** The repository a `gh` command acts on. */
export type GhRepo = {
  owner: string;
  repo: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L576))

### GhNumberPayload

```ts
export type GhNumberPayload = {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L581))

### GhPagedPayload

`perPage` 0 means every page `gh` fetches for one pull request or issue.

```ts
/** `perPage` 0 means every page `gh` fetches for one pull request or issue. */
export type GhPagedPayload = {
  owner: string;
  repo: string;
  number: number;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L588))

### GhPrListPayload

```ts
export type GhPrListPayload = {
  owner: string;
  repo: string;
  state: string;
  base: string;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L596))

### GhIssueListPayload

```ts
export type GhIssueListPayload = {
  owner: string;
  repo: string;
  state: string;
  labels: string[];
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L605))

### GhSearchPayload

```ts
export type GhSearchPayload = {
  owner: string;
  repo: string;
  query: string;
  perPage: number;
  page: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L614))

### Execution

What happens if every effect in the plan is approved.

```ts
/** What happens if every effect in the plan is approved. */
export type Execution = BashExec | AgencyExec | RefuseExec | StepsExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L689))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L691))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L696))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L702))

### WriteExec

```ts
export type WriteExec = {
  kind: "write";
  filename: string;
  dir: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L707))

### GrepFileNames

Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default".

```ts
/** Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default". */
export type GrepFileNames = "default" | "always" | "never"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L717))

### GrepRender

What a grep command said about printing. The rules that turn this
 into grep's output live in `_renderGrepOutput`
 (lib/stdlib/grepDialect.ts), whose type of the same name must keep
 these fields.

```ts
/** What a grep command said about printing. The rules that turn this
 into grep's output live in `_renderGrepOutput`
 (lib/stdlib/grepDialect.ts), whose type of the same name must keep
 these fields. */
export type GrepRender = {
  /** `-n` was given. */
  lineNumbers: boolean;
  fileNames: GrepFileNames;
  /** The path as bash hands it to grep, or "" when none was written. */
  argument: string;
  /** The path names one file, not a directory. */
  oneFile: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L723))

### GrepExec

A lone grep, run through the grep tool's own search with no shell.
 The search reads only what `payload` says, so the approval means what
 the grep tool's approval means.

```ts
/** A lone grep, run through the grep tool's own search with no shell.
 The search reads only what `payload` says, so the approval means what
 the grep tool's approval means. */
export type GrepExec = {
  kind: "grep";
  payload: GrepPayload;
  render: GrepRender;
  /** The saved output searched, by name, when the path is one. The
    search then reads the store, never the disk. */
  saved?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L736))

### SavedPath

A saved output named by path: the folder part as the command wrote it,
 with its trailing separator, and the saved name.

```ts
/** A saved output named by path: the folder part as the command wrote it,
 with its trailing separator, and the saved name. */
export type SavedPath = {
  folder: string;
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L760))

### ReadSource

Where a resolved read path's bytes are: a file on disk, or a saved
 output in the store. A saved source keeps the folder as written so a
 rule can name the copy's path in its effect, but it is read by name.

```ts
/** Where a resolved read path's bytes are: a file on disk, or a saved
 output in the store. A saved source keeps the folder as written so a
 rule can name the copy's path in its effect, but it is read by name. */
export type ReadSource =
  | { kind: "disk"; dir: string; filename: string }
  | { kind: "saved"; folder: string; name: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L768))

### ReadView

How the shell-free path prints a file: whole, numbered (cat -n), the
 first `lines` lines (head), or the last `lines` lines (tail). The rules
 live in `_renderReadView` (lib/stdlib/readDialect.ts), whose type of
 the same name must keep these fields.

```ts
/** How the shell-free path prints a file: whole, numbered (cat -n), the
 first `lines` lines (head), or the last `lines` lines (tail). The rules
 live in `_renderReadView` (lib/stdlib/readDialect.ts), whose type of
 the same name must keep these fields. */
export type ReadView =
  | { kind: "whole" }
  | { kind: "numbered" }
  | { kind: "head"; lines: number }
  | { kind: "tail"; lines: number }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L789))

### ReadExec

A lone cat of one or more files, or a head or tail of one, run
 through the read tool's own read with no shell. The read covers only
 what `payloads` names, so the approval means what the read tool's
 approval means.

```ts
/** A lone cat of one or more files, or a head or tail of one, run
 through the read tool's own read with no shell. The read covers only
 what `payloads` names, so the approval means what the read tool's
 approval means. */
export type ReadExec = {
  kind: "read";
  sources: ReadSource[];
  view: ReadView
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L799))

### Join

How a step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure.

```ts
/** How a step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure. */
export type Join = "seq" | "and" | "or"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L807))

### TextFilter

What a later stage of a pipeline does to the text of the stage before
 it. `view` is a `cat`, `head`, or `tail` that names no file. `match` is
 a `grep` that names no file: the fields are the grep tool's query, and
 `lineNumbers` is `-n`.

```ts
/** What a later stage of a pipeline does to the text of the stage before
 it. `view` is a `cat`, `head`, or `tail` that names no file. `match` is
 a `grep` that names no file: the fields are the grep tool's query, and
 `lineNumbers` is `-n`. */
export type TextFilter =
  | { kind: "view"; view: ReadView }
  | { kind: "match"; pattern: string; flags: string; ignoreCase: boolean; wholeWord: boolean; invert: boolean; lineNumbers: boolean }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L813))

### PipeExec

A pipeline whose every stage safeBash runs itself. `first` produces
 the text and asks the pipeline's only questions; each filter takes the
 text of the stage before it.

```ts
/** A pipeline whose every stage safeBash runs itself. `first` produces
 the text and asks the pipeline's only questions; each filter takes the
 text of the stage before it. */
export type PipeExec = {
  kind: "pipe";
  first: EchoExec | GrepExec | ReadExec;
  filters: TextFilter[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L820))

### StepExec

What a step safeBash runs itself can be. None of these starts a
 shell.

```ts
/** What a step safeBash runs itself can be. None of these starts a
 shell. */
export type StepExec =
  | EchoExec
  | WriteExec
  | GrepExec
  | ReadExec
  | PipeExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L828))

### LineStep

One step of a line that runs a step at a time.

```ts
/** One step of a line that runs a step at a time. */
export type LineStep = RunStep | CdStep | GroupStep
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L831))

### RunStep

One simple command or one pipeline, as the model wrote it.

```ts
/** One simple command or one pipeline, as the model wrote it. */
export type RunStep = {
  kind: "run";
  join: Join;
  source: Command;
  /** The folder as the plan had it, which is what the payloads name. */
  cwd: string;
  /** `cwd` with every link followed, for the folder check. */
  realCwd: string;
  /** The text the up-front plan rebuilt for this step. */
  text: string;
  effects: Effect[];
  /** Whether a word of the command reads `$?`, the status of the step before. */
  readsStatus: boolean;
  /** Null when the step goes through bash. Otherwise the in-process
    execution. */
  inProcess?: StepExec
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L834))

### CdStep

A `cd`. `cwd` is the folder it was planned in, and `dir` is the real
  folder the plan resolved. `guarded` is true for a `cd` that is a whole
  command of the top-level list: after it, a step whose shell cannot
  start in `dir` ends the line (`StepsState.missingFolderStops`).

```ts
/** A `cd`. `cwd` is the folder it was planned in, and `dir` is the real
  folder the plan resolved. `guarded` is true for a `cd` that is a whole
  command of the top-level list: after it, a step whose shell cannot
  start in `dir` ends the line (`StepsState.missingFolderStops`). */
export type CdStep = {
  kind: "cd";
  join: Join;
  source: SimpleCommand;
  cwd: string;
  dir: string;
  guarded: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L856))

### GroupStep

A parenthesized group. Its folder changes end at the closing parenthesis.

```ts
/** A parenthesized group. Its folder changes end at the closing parenthesis. */
export type GroupStep = {
  kind: "group";
  join: Join;
  steps: LineStep[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L866))

### StepsExec

A line that runs a step at a time, with bash's rule for each join.
 Every step runs in process, or every step that is not a `cd` or a group
 runs through bash.

```ts
/** A line that runs a step at a time, with bash's rule for each join.
 Every step runs in process, or every step that is not a `cd` or a group
 runs through bash. */
export type StepsExec = {
  kind: "steps";
  /** The whole rebuilt line, which the debug log records. */
  command: string;
  steps: LineStep[];
  /** The repository a `gh` step was planned with, for planning it again. */
  origin?: GhRepo
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L875))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L896))

### BroadReason

Why a plan asks the broad std::bash question. `detail` is the parser
 message for `unparseable`, the first unrecognized command's message for
 `unrecognized`, the render failure for `unrenderable`, and "" for
 `noEffects`.

```ts
/** Why a plan asks the broad std::bash question. `detail` is the parser
 message for `unparseable`, the first unrecognized command's message for
 `unrecognized`, the render failure for `unrenderable`, and "" for
 `noEffects`. */
export type BroadReason = {
  kind:
  | "unparseable"
  | "unrecognized"
  | "noEffects"
  | "unrenderable";
  detail: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L905))

### Plan

The whole decision about one call to safeBash, made before anything runs.

```ts
/** The whole decision about one call to safeBash, made before anything runs. */
export type Plan = {
  effects: Effect[];
  execution: Execution;
  /** Why the plan asks the broad std::bash question, or null when it does not. */
  broadReason?: BroadReason;
  /** The command word of every simple command planFor decided over, in
    order; "" for an assignment-only command; [] when unparseable. */
  verbs: string[];
  /** Every saved output the line names. A shell line gets a fresh copy of
    each before it starts, and a read is left unasked only for these. */
  savedPaths: SavedPath[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L911))

### FileAccess

One file a plan reads, searches, lists, finds in, writes, or removes,
 read back out of the effect that asks about it. A `find` access names the
 folder searched, not the files found.

```ts
/** One file a plan reads, searches, lists, finds in, writes, or removes,
 read back out of the effect that asks about it. A `find` access names the
 folder searched, not the files found. */
export type FileAccess = {
  mode:
  | "read"
  | "search"
  | "list"
  | "find"
  | "write"
  | "remove";
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L927))

## Functions

### writeEffect

```ts
writeEffect(write: WritePayload): Effect
```

Build a write approval descriptor without raising it.

Build the write approval from the same payload used by `writeExecution`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| write | [WritePayload](#writepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L208))

### writeExecution

```ts
writeExecution(write: WritePayload): WriteExec
```

Build a file-write execution plan without running it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| write | [WritePayload](#writepayload) |  |

**Returns:** [WriteExec](#writeexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L216))

### grepEffect

```ts
grepEffect(payload: GrepPayload): Effect
```

Build a grep approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GrepPayload](#greppayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L240))

### readEffect

```ts
readEffect(payload: ReadPayload): Effect
```

Build a file-read approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [ReadPayload](#readpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L255))

### removeEffect

```ts
removeEffect(payload: RemovePayload): Effect
```

Build a delete approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [RemovePayload](#removepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L269))

### mkdirEffect

```ts
mkdirEffect(payload: MkdirPayload): Effect
```

Build a make-folder approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [MkdirPayload](#mkdirpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L283))

### envEffect

```ts
envEffect(name: string): Effect
```

Build an approval descriptor for reading an environment variable, without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L291))

### lsEffect

```ts
lsEffect(payload: LsPayload): Effect
```

Build a directory-listing approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [LsPayload](#lspayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L308))

### globEffect

```ts
globEffect(payload: GlobPayload): Effect
```

Build a file-search approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GlobPayload](#globpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L325))

### execEffect

```ts
execEffect(payload: ExecPayload): Effect
```

Build a command-execution approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [ExecPayload](#execpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L346))

### gitStatusEffect

```ts
gitStatusEffect(payload: GitRepoPayload): Effect
```

Build a std::git::status approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitRepoPayload](#gitrepopayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L432))

### gitLogEffect

```ts
gitLogEffect(payload: GitLogPayload): Effect
```

Build a std::git::log approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitLogPayload](#gitlogpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L440))

### gitDiffEffect

```ts
gitDiffEffect(payload: GitDiffPayload): Effect
```

Build a std::git::diff approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitDiffPayload](#gitdiffpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L448))

### gitShowEffect

```ts
gitShowEffect(payload: GitShowPayload): Effect
```

Build a std::git::show approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitShowPayload](#gitshowpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L456))

### gitBlameEffect

```ts
gitBlameEffect(payload: GitBlamePayload): Effect
```

Build a std::git::blame approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitBlamePayload](#gitblamepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L464))

### gitBranchListEffect

```ts
gitBranchListEffect(payload: GitRepoPayload): Effect
```

Build a std::git::branchList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitRepoPayload](#gitrepopayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L472))

### gitRemoteListEffect

```ts
gitRemoteListEffect(payload: GitRepoPayload): Effect
```

Build a std::git::remoteList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitRepoPayload](#gitrepopayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L480))

### gitStashListEffect

```ts
gitStashListEffect(payload: GitRepoPayload): Effect
```

Build a std::git::stashList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitRepoPayload](#gitrepopayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L488))

### gitAddEffect

```ts
gitAddEffect(payload: GitAddPayload): Effect
```

Build a std::git::add approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitAddPayload](#gitaddpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L496))

### gitCommitEffect

```ts
gitCommitEffect(payload: GitCommitPayload): Effect
```

Build a std::git::commit approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitCommitPayload](#gitcommitpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L504))

### gitCheckoutEffect

```ts
gitCheckoutEffect(payload: GitCheckoutPayload): Effect
```

Build a std::git::checkout approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitCheckoutPayload](#gitcheckoutpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L512))

### gitSwitchEffect

```ts
gitSwitchEffect(payload: GitSwitchPayload): Effect
```

Build a std::git::switch approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitSwitchPayload](#gitswitchpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L520))

### gitBranchCreateEffect

```ts
gitBranchCreateEffect(payload: GitBranchCreatePayload): Effect
```

Build a std::git::branchCreate approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitBranchCreatePayload](#gitbranchcreatepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L528))

### gitBranchDeleteEffect

```ts
gitBranchDeleteEffect(payload: GitBranchDeletePayload): Effect
```

Build a std::git::branchDelete approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitBranchDeletePayload](#gitbranchdeletepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L536))

### gitStashPushEffect

```ts
gitStashPushEffect(payload: GitStashPushPayload): Effect
```

Build a std::git::stashPush approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitStashPushPayload](#gitstashpushpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L544))

### gitStashPopEffect

```ts
gitStashPopEffect(payload: GitRepoPayload): Effect
```

Build a std::git::stashPop approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitRepoPayload](#gitrepopayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L552))

### gitRestoreEffect

```ts
gitRestoreEffect(payload: GitRestorePayload): Effect
```

Build a std::git::restore approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GitRestorePayload](#gitrestorepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L560))

### pendingLookups

```ts
pendingLookups(effects: Effect[]): string[]
```

The distinct folders whose origin remote these effects still need, in the order first seen.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| effects | `Effect[]` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L670))

### grepExecution

```ts
grepExecution(
  payload: GrepPayload,
  render: GrepRender,
  saved: string | null = null,
): GrepExec
```

Build a grep execution plan without running the search.

Build the search execution from the same payload used by `grepEffect`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GrepPayload](#greppayload) |  |
| render | [GrepRender](#greprender) |  |
| saved | `string \| null` | null |

**Returns:** [GrepExec](#grepexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L748))

### readPayloadOf

```ts
readPayloadOf(source: ReadSource): ReadPayload
```

Return the read approval payload that names this source.

The std::read payload for a source: the file, or the copy's path.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | [ReadSource](#readsource) |  |

**Returns:** [ReadPayload](#readpayload)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L773))

### readExecution

```ts
readExecution(sources: ReadSource[], view: ReadView): ReadExec
```

Build a file-read execution plan without reading files.

Build file reads from the sources whose payloads `readEffect` asks about.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| sources | `ReadSource[]` |  |
| view | [ReadView](#readview) |  |

**Returns:** [ReadExec](#readexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L887))

### accessesOf

```ts
accessesOf(effects: Effect[]): FileAccess[]
```

Return the files the given plan effects read, search, list, find in, write, or remove, in order.

The file accesses among a plan's effects, in order. Only file effects are
accesses: `git checkout -- a.txt` overwrites a file, but its effect is
`std::git::checkout`. So the list is not everything a line does.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| effects | `Effect[]` |  |

**Returns:** `FileAccess[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L970))
