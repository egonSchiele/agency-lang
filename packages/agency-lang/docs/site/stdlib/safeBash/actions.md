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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L63))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L93))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L115))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L131))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L148))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L167))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L184))

### GitRepoPayload

The payload of a git effect that names only the repository.

```ts
/** The payload of a git effect that names only the repository. */
export type GitRepoPayload = {
  cwd: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L197))

### GitLogPayload

```ts
export type GitLogPayload = {
  cwd: string;
  ref: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L201))

### GitShowPayload

```ts
export type GitShowPayload = {
  cwd: string;
  ref: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L207))

### GitBlamePayload

```ts
export type GitBlamePayload = {
  cwd: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L212))

### GitAddPayload

```ts
export type GitAddPayload = {
  cwd: string;
  paths: string[];
  all: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L217))

### GitCommitPayload

```ts
export type GitCommitPayload = {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L223))

### GitCheckoutPayload

```ts
export type GitCheckoutPayload = {
  cwd: string;
  target: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L228))

### GitSwitchPayload

```ts
export type GitSwitchPayload = {
  cwd: string;
  branch: string;
  create: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L234))

### GitBranchCreatePayload

```ts
export type GitBranchCreatePayload = {
  cwd: string;
  branch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L240))

### GitBranchDeletePayload

```ts
export type GitBranchDeletePayload = {
  cwd: string;
  branch: string;
  force: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L245))

### GitStashPushPayload

```ts
export type GitStashPushPayload = {
  cwd: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L251))

### GitRestorePayload

```ts
export type GitRestorePayload = {
  cwd: string;
  paths: string[];
  staged: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L256))

### GhRepo

The repository a `gh` command acts on.

```ts
/** The repository a `gh` command acts on. */
export type GhRepo = {
  owner: string;
  repo: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L406))

### GhNumberPayload

```ts
export type GhNumberPayload = {
  owner: string;
  repo: string;
  number: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L411))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L418))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L426))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L435))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L444))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L545))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L547))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L552))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L558))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L563))

### GrepFileNames

Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default".

```ts
/** Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default". */
export type GrepFileNames = "default" | "always" | "never"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L573))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L579))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L592))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L614))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L624))

### Join

How a chain step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure.

```ts
/** How a chain step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure. */
export type Join = "seq" | "and" | "or"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L632))

### StepExec

The executions a chain may hold: every in-process kind, and nothing
 that spawns a shell.

```ts
/** The executions a chain may hold: every in-process kind, and nothing
 that spawns a shell. */
export type StepExec = EchoExec | WriteExec | GrepExec | ReadExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L636))

### ChainStep

```ts
export type ChainStep = {
  join: Join;
  execution: StepExec
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L638))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L645))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L662))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L671))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L677))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L73))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L81))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L105))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L120))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L137))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L154))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L176))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L262))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L270))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L278))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L286))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L294))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L302))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L310))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L318))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L326))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L334))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L342))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L350))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L358))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L366))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L374))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L382))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L390))

### ghPrGetEffect

```ts
ghPrGetEffect(payload: GhNumberPayload, lookup: string | null): Effect
```

Build a std::github::prGet approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhNumberPayload](#ghnumberpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L452))

### ghPrDiffEffect

```ts
ghPrDiffEffect(payload: GhNumberPayload, lookup: string | null): Effect
```

Build a std::github::prDiff approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhNumberPayload](#ghnumberpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L457))

### ghIssueGetEffect

```ts
ghIssueGetEffect(payload: GhNumberPayload, lookup: string | null): Effect
```

Build a std::github::issueGet approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhNumberPayload](#ghnumberpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L462))

### ghPrFilesEffect

```ts
ghPrFilesEffect(payload: GhPagedPayload, lookup: string | null): Effect
```

Build a std::github::prFiles approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhPagedPayload](#ghpagedpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L467))

### ghPrReviewListEffect

```ts
ghPrReviewListEffect(payload: GhPagedPayload, lookup: string | null): Effect
```

Build a std::github::prReviewList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhPagedPayload](#ghpagedpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L472))

### ghPrReviewCommentListEffect

```ts
ghPrReviewCommentListEffect(
  payload: GhPagedPayload,
  lookup: string | null,
): Effect
```

Build a std::github::prReviewCommentList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhPagedPayload](#ghpagedpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L477))

### ghPrChecksEffect

```ts
ghPrChecksEffect(payload: GhPagedPayload, lookup: string | null): Effect
```

Build a std::github::prChecks approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhPagedPayload](#ghpagedpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L482))

### ghIssueCommentListEffect

```ts
ghIssueCommentListEffect(payload: GhPagedPayload, lookup: string | null): Effect
```

Build a std::github::issueCommentList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhPagedPayload](#ghpagedpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L487))

### ghPrListEffect

```ts
ghPrListEffect(payload: GhPrListPayload, lookup: string | null): Effect
```

Build a std::github::prList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhPrListPayload](#ghprlistpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L492))

### ghIssueListEffect

```ts
ghIssueListEffect(payload: GhIssueListPayload, lookup: string | null): Effect
```

Build a std::github::issueList approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhIssueListPayload](#ghissuelistpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L497))

### ghIssueSearchEffect

```ts
ghIssueSearchEffect(payload: GhSearchPayload, lookup: string | null): Effect
```

Build a std::github::issueSearch approval descriptor without raising it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GhSearchPayload](#ghsearchpayload) |  |
| lookup | `string \| null` |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L502))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L526))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L601))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L653))
