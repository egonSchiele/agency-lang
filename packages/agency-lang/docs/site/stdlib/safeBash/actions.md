---
name: "actions"
description: "Represent and execute plans made by safeBash."
---

# actions

Use `safeBash` from `std::safeBash` to run commands. This module holds its
plan types and executors. Executors assume the caller has already approved
every effect in the plan; they do not raise those approvals themselves.

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
  | { name: "std::grep"; payload: GrepPayload }
  | { name: "std::read"; payload: ReadPayload }
  | { name: "std::ls"; payload: LsPayload }
  | { name: "std::glob"; payload: GlobPayload }
  | { name: "std::exec"; payload: ExecPayload }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L31))

### WritePayload

```ts
export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L43))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L73))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L95))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L111))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L128))

### ExecPayload

The fields the exec tool's own std::exec interrupt carries. From
 safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
 0 and `stdin` is empty, which is how safeBash runs the line, and an
 argument may be an unexpanded glob or `~` that bash expands.

```ts
/** The fields the exec tool's own std::exec interrupt carries. From
 safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
 0 and `stdin` is empty, which is how safeBash runs the line, and an
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L146))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L163))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L176))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L178))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L183))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L189))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L194))

### GrepFileNames

Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default".

```ts
/** Whether grep prints file names: `-H` gives "always", `-h` gives
 "never", neither gives "default". */
export type GrepFileNames = "default" | "always" | "never"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L204))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L210))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L223))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L245))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L255))

### Join

How a chain step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure.

```ts
/** How a chain step follows the one before it: `;` always runs it, `&&`
 only after a success, `||` only after a failure. */
export type Join = "seq" | "and" | "or"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L263))

### StepExec

The executions a chain may hold: every in-process kind, and nothing
 that spawns a shell.

```ts
/** The executions a chain may hold: every in-process kind, and nothing
 that spawns a shell. */
export type StepExec = EchoExec | WriteExec | GrepExec | ReadExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L267))

### ChainStep

```ts
export type ChainStep = {
  join: Join;
  execution: StepExec
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L269))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L276))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L293))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L302))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L308))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L53))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L61))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L85))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L100))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L117))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L134))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L155))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L232))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L284))

### runBash

```ts
runBash(command: string, cwd: string, source: string = ""): Result<string>
```

Execute a Bash command after its planned effects have been approved.
  Return stdout on success, or an exit failure with output on nonzero exit.

Requires Bash on the search path. Successful stderr is omitted from the
result. Nonzero exits return failures, including grep's "no match" and
diff's "files differ" statuses. Long output is saved with a preview.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` |  |
| source | `string` | "" |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L324))

### runGrep

```ts
runGrep(exec: GrepExec, command: string): Result<string>
```

Execute an approved in-process grep plan and return its rendered output.
  No matches return an exit-code-1 failure.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [GrepExec](#grepexec) |  |
| command | `string` |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L373))

### printGrep

```ts
printGrep(exec: GrepExec): Result<string>
```

Execute an approved grep plan and return its full output.
  No matches return a failure carrying any search notes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [GrepExec](#grepexec) |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L390))

### runRead

```ts
runRead(exec: ReadExec, command: string): Result<string>
```

Execute approved file reads and return cat, head, or tail output.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [ReadExec](#readexec) |  |
| command | `string` |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L434))

### printRead

```ts
printRead(exec: ReadExec): Result<string>
```

Execute approved file reads and return their full rendered output.

Files are concatenated before rendering, so a missing final newline joins
the next file's first line. A failed read drops previously collected text.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [ReadExec](#readexec) |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L449))

### runWrite

```ts
runWrite(exec: WriteExec): Result<string>
```

Execute an approved redirected echo write and return an empty stdout string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [WriteExec](#writeexec) |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L484))

### runChain

```ts
runChain(exec: ChainExec, command: string): Result<string>
```

Execute approved in-process commands with Bash-style ;, &&, and || joins.
  Return a failure when the last command executed failed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [ChainExec](#chainexec) |  |
| command | `string` |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L506))
