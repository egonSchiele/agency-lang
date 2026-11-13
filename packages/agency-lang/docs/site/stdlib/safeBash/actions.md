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

### Effect

A required approval, with a payload checked for its effect.

```ts
/** A required approval, with a payload checked for its effect. */
export type Effect =
  | { name: "std::bash" }
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L26))

### WritePayload

```ts
export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L64))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L94))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L116))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L131))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L146))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L163))

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
  subcommand: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L182))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L199))

### GitRepoPayload

The payload of a git effect that names only the repository.

```ts
/** The payload of a git effect that names only the repository. */
export type GitRepoPayload = {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L212))

### GitLogPayload

```ts
export type GitLogPayload = {
  cwd: string;
  ref: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L216))

### GitShowPayload

```ts
export type GitShowPayload = {
  cwd: string;
  ref: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L222))

### GitBlamePayload

```ts
export type GitBlamePayload = {
  cwd: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L227))

### GitAddPayload

```ts
export type GitAddPayload = {
  cwd: string;
  paths: string[];
  all: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L232))

### GitCommitPayload

```ts
export type GitCommitPayload = {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L238))

### GitCheckoutPayload

```ts
export type GitCheckoutPayload = {
  cwd: string;
  target: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L243))

### GitSwitchPayload

```ts
export type GitSwitchPayload = {
  cwd: string;
  branch: string;
  create: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L249))

### GitBranchCreatePayload

```ts
export type GitBranchCreatePayload = {
  cwd: string;
  branch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L255))

### GitBranchDeletePayload

```ts
export type GitBranchDeletePayload = {
  cwd: string;
  branch: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L260))

### GitStashPushPayload

```ts
export type GitStashPushPayload = {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L266))

### GitRestorePayload

```ts
export type GitRestorePayload = {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L271))

### GhRepo

The repository a `gh` command acts on.

```ts
/** The repository a `gh` command acts on. */
export type GhRepo = {
  owner: string;
  repo: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L421))

### GhNumberPayload

```ts
export type GhNumberPayload = {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L426))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L433))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L441))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L450))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L459))

### Execution

What happens if every effect in the plan is approved.

```ts
/** What happens if every effect in the plan is approved. */
export type Execution =
  | BashExec
  | EchoExec
  | WriteExec
  | AgencyExec
  | RefuseExec
  | GrepExec
  | ReadExec
  | ChainExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L531))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L533))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L538))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L544))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L549))

### GrepFileNames

Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default".

```ts
/** Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default". */
export type GrepFileNames = "default" | "always" | "never"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L559))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L565))

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
  render: GrepRender
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L578))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L600))

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
  payloads: ReadPayload[];
  view: ReadView
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L610))

### Join

How a chain step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure.

```ts
/** How a chain step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure. */
export type Join = "seq" | "and" | "or"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L618))

### StepExec

The executions a chain may hold: every in-process kind, and nothing
 that spawns a shell.

```ts
/** The executions a chain may hold: every in-process kind, and nothing
 that spawns a shell. */
export type StepExec = EchoExec | WriteExec | GrepExec | ReadExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L622))

### ChainStep

```ts
export type ChainStep = {
  join: Join;
  execution: StepExec
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L624))

### ChainExec

Several in-process commands joined by `;`, `&&`, or `||`, run left to
 right with bash's rule for each join.

```ts
/** Several in-process commands joined by `;`, `&&`, or `||`, run left to
 right with bash's rule for each join. */
export type ChainExec = {
  kind: "chain";
  steps: ChainStep[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L631))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L648))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L657))

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
  verbs: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L663))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L74))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L82))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L106))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L121))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L135))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L152))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L169))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L191))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L277))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L285))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L293))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L301))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L309))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L317))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L325))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L333))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L341))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L349))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L357))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L365))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L373))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L381))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L389))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L397))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L405))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L512))

### grepExecution

```ts
grepExecution(payload: GrepPayload, render: GrepRender): GrepExec
```

Build a grep execution plan without running the search.

Build the search execution from the same payload used by `grepEffect`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GrepPayload](#greppayload) |  |
| render | [GrepRender](#greprender) |  |

**Returns:** [GrepExec](#grepexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L587))

### readExecution

```ts
readExecution(payloads: ReadPayload[], view: ReadView): ReadExec
```

Build a file-read execution plan without reading files.

Build file reads from the same payloads used by `readEffect`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payloads | `ReadPayload[]` |  |
| view | [ReadView](#readview) |  |

**Returns:** [ReadExec](#readexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L639))
