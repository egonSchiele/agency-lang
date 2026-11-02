---
name: "actions"
description: "What safeBash decides, and the three ways it can carry that out."
---

# actions

What safeBash decides, and the three ways it can carry that out.

  A `Plan` is the whole decision about one call, made before anything
  happens: which interrupts to raise, and what to run if they are all
  approved. Deciding and doing are separate steps so the deciding half can
  be tested by handing in a string and looking at the plan.

  The executors call the NON-RAISING internals (`_bash`, `_write`) rather
  than the `bash` and `write` tools, because those raise their own
  interrupts and the caller has already raised a narrower one. See the
  comment on `runBash`.

## Types

### Effect

One interrupt a command needs raised before it may run.

A discriminated union rather than a bag of `any`: the effect set is
closed, so each payload can be typed, and typing them is what makes the
raise sites check that every payload satisfies its effect's contract.

```ts
/** One interrupt a command needs raised before it may run.
 *
 * A discriminated union rather than a bag of `any`: the effect set is
 * closed, so each payload can be typed, and typing them is what makes the
 * raise sites check that every payload satisfies its effect's contract. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L28))

### WritePayload

```ts
export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L40))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L67))

### ReadPayload

The fields the read tool's own std::read interrupt is keyed on: the
real parent of the file, and its name.

```ts
/** The fields the read tool's own std::read interrupt is keyed on: the
 * real parent of the file, and its name. */
export type ReadPayload = {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L88))

### LsPayload

The fields the ls tool's own std::ls interrupt is keyed on. On the
bash path `maxResults` is 0, meaning no cap: real ls, tree, and du list
everything.

```ts
/** The fields the ls tool's own std::ls interrupt is keyed on. On the
 * bash path `maxResults` is 0, meaning no cap: real ls, tree, and du list
 * everything. */
export type LsPayload = {
  dir: string;
  recursive: boolean;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L103))

### GlobPayload

The fields the glob tool's own std::glob interrupt is keyed on. On the
bash path `maxResults` is 0, meaning no cap: real find lists
everything.

```ts
/** The fields the glob tool's own std::glob interrupt is keyed on. On the
 * bash path `maxResults` is 0, meaning no cap: real find lists
 * everything. */
export type GlobPayload = {
  pattern: string;
  dir: string;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L119))

### ExecPayload

The fields the exec tool's own std::exec interrupt carries. From
safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
0 and `stdin` is empty, which is how safeBash runs the line, and an
argument may be an unexpanded glob or `~` that bash expands.

```ts
/** The fields the exec tool's own std::exec interrupt carries. From
 * safeBash, `cwd` is safeBash's resolved working directory, `timeout` is
 * 0 and `stdin` is empty, which is how safeBash runs the line, and an
 * argument may be an unexpanded glob or `~` that bash expands. */
export type ExecPayload = {
  command: string;
  args: string[];
  subcommand: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L136))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L152))

### Execution

What happens if every effect in the plan is approved.

One variant per way a plan can be carried out, each carrying only the
fields that way needs. The dispatch in `safeBash` matches over this
union exhaustively, so adding a variant is a type error at the dispatch
rather than a silent fall-through.

```ts
/** What happens if every effect in the plan is approved.
 *
 * One variant per way a plan can be carried out, each carrying only the
 * fields that way needs. The dispatch in `safeBash` matches over this
 * union exhaustively, so adding a variant is a type error at the dispatch
 * rather than a silent fall-through. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L166))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L168))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L173))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L179))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L184))

### GrepFileNames

Whether grep prints file names: `-H` gives "always", `-h` gives
"never", neither gives "default".

```ts
/** Whether grep prints file names: `-H` gives "always", `-h` gives
 * "never", neither gives "default". */
export type GrepFileNames = "default" | "always" | "never"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L194))

### GrepRender

What a grep command said about printing. The rules that turn this
into grep's output live in `_renderGrepOutput`
(lib/stdlib/grepDialect.ts), whose type of the same name must keep
these fields.

```ts
/** What a grep command said about printing. The rules that turn this
 * into grep's output live in `_renderGrepOutput`
 * (lib/stdlib/grepDialect.ts), whose type of the same name must keep
 * these fields. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L200))

### GrepExec

A lone grep, run through the grep tool's own search with no shell.
The search reads only what `payload` says, so the approval means what
the grep tool's approval means.

```ts
/** A lone grep, run through the grep tool's own search with no shell.
 * The search reads only what `payload` says, so the approval means what
 * the grep tool's approval means. */
export type GrepExec = {
  kind: "grep";
  payload: GrepPayload;
  render: GrepRender
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L213))

### ReadView

How the shell-free path prints a file: whole, numbered (cat -n), the
first `lines` lines (head), or the last `lines` lines (tail). The rules
live in `_renderReadView` (lib/stdlib/readDialect.ts), whose type of
the same name must keep these fields.

```ts
/** How the shell-free path prints a file: whole, numbered (cat -n), the
 * first `lines` lines (head), or the last `lines` lines (tail). The rules
 * live in `_renderReadView` (lib/stdlib/readDialect.ts), whose type of
 * the same name must keep these fields. */
export type ReadView =
  | { kind: "whole" }
  | { kind: "numbered" }
  | { kind: "head"; lines: number }
  | { kind: "tail"; lines: number }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L233))

### ReadExec

A lone cat of one or more files, or a head or tail of one, run
through the read tool's own read with no shell. The read covers only
what `payloads` names, so the approval means what the read tool's
approval means.

```ts
/** A lone cat of one or more files, or a head or tail of one, run
 * through the read tool's own read with no shell. The read covers only
 * what `payloads` names, so the approval means what the read tool's
 * approval means. */
export type ReadExec = {
  kind: "read";
  payloads: ReadPayload[];
  view: ReadView
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L243))

### Join

How a chain step follows the one before it: `;` always runs it, `&&`
only after a success, `||` only after a failure.

```ts
/** How a chain step follows the one before it: `;` always runs it, `&&`
 * only after a success, `||` only after a failure. */
export type Join = "seq" | "and" | "or"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L251))

### StepExec

The executions a chain may hold: every in-process kind, and nothing
that spawns a shell.

```ts
/** The executions a chain may hold: every in-process kind, and nothing
 * that spawns a shell. */
export type StepExec = EchoExec | WriteExec | GrepExec | ReadExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L255))

### ChainStep

```ts
export type ChainStep = {
  join: Join;
  execution: StepExec
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L257))

### ChainExec

Several in-process commands joined by `;`, `&&`, or `||`, run left to
right with bash's rule for each join.

```ts
/** Several in-process commands joined by `;`, `&&`, or `||`, run left to
 * right with bash's rule for each join. */
export type ChainExec = {
  kind: "chain";
  steps: ChainStep[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L264))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L279))

### BroadReason

Why a plan asks the broad std::bash question. `detail` is the parser
message for `unparseable`, the first unrecognized command's message for
`unrecognized`, the render failure for `unrenderable`, and "" for
`noEffects`.

```ts
/** Why a plan asks the broad std::bash question. `detail` is the parser
 * message for `unparseable`, the first unrecognized command's message for
 * `unrecognized`, the render failure for `unrenderable`, and "" for
 * `noEffects`. */
export type BroadReason = {
  kind:
  | "unparseable"
  | "unrecognized"
  | "noEffects"
  | "unrenderable";
  detail: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L288))

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
   *  order; "" for an assignment-only command; [] when unparseable. */
  verbs: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L294))

## Functions

### writeEffect

```ts
writeEffect(write: WritePayload): Effect
```

Both plan sides derive from one WritePayload, so payload/execution
  parity holds by construction.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| write | [WritePayload](#writepayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L49))

### writeExecution

```ts
writeExecution(write: WritePayload): WriteExec
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| write | [WritePayload](#writepayload) |  |

**Returns:** [WriteExec](#writeexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L56))

### grepEffect

```ts
grepEffect(payload: GrepPayload): Effect
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GrepPayload](#greppayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L79))

### readEffect

```ts
readEffect(payload: ReadPayload): Effect
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [ReadPayload](#readpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L93))

### lsEffect

```ts
lsEffect(payload: LsPayload): Effect
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [LsPayload](#lspayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L109))

### globEffect

```ts
globEffect(payload: GlobPayload): Effect
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GlobPayload](#globpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L125))

### execEffect

```ts
execEffect(payload: ExecPayload): Effect
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [ExecPayload](#execpayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L145))

### grepExecution

```ts
grepExecution(payload: GrepPayload, render: GrepRender): GrepExec
```

Both plan sides derive from one GrepPayload, so the question asked and
the search run cannot disagree.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GrepPayload](#greppayload) |  |
| render | [GrepRender](#greprender) |  |

**Returns:** [GrepExec](#grepexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L221))

### readExecution

```ts
readExecution(payloads: ReadPayload[], view: ReadView): ReadExec
```

Both plan sides derive from the same ReadPayloads, so the questions
asked and the files read cannot disagree.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payloads | `ReadPayload[]` |  |
| view | [ReadView](#readview) |  |

**Returns:** [ReadExec](#readexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L271))

### runBash

```ts
runBash(command: string, cwd: string, source: string = ""): Result<string>
```

Run a command string through bash and return what it printed.

  The script runs under bash, found on the search path. When there is no
  bash the result is a failure that says so; nothing falls back to
  another shell.

  On success the value is bash's stdout, raw — nothing added, nothing
  stripped. stderr is discarded on success and reported on failure: two
  captured pipes cannot interleave the way a terminal does, so this is a
  policy either way, and discarding on success keeps the value exactly
  equal to bash's stdout.

  A non-zero exit is a failure, which `&&` and `||` require. The known
  cost: `grep` exits 1 when it finds nothing and `diff` exits 1 when files
  differ, and neither is an error.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` |  |
| source | `string` | "" |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L305))

### runGrep

```ts
runGrep(exec: GrepExec, command: string): Result<string>
```

Run a lone grep through the grep tool's own search and print what grep
  would print. No match is the failure grep's exit code 1 would give.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [GrepExec](#grepexec) |  |
| command | `string` |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L368))

### printGrep

```ts
printGrep(exec: GrepExec): Result<string>
```

What a shell-free grep prints, before long output is saved. No match is
  a failure carrying the notes, the text grep would write to stderr.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [GrepExec](#grepexec) |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L385))

### runRead

```ts
runRead(exec: ReadExec, command: string): Result<string>
```

Run a lone cat, head, or tail through the read tool's own read and
  print what the program would print.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [ReadExec](#readexec) |  |
| command | `string` |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L429))

### printRead

```ts
printRead(exec: ReadExec): Result<string>
```

What a shell-free read prints, before long output is saved: each file
  read in order, the texts joined, and the joined text rendered once. A
  first file with no final newline runs into the second, as real cat
  prints it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [ReadExec](#readexec) |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L441))

### runWrite

```ts
runWrite(exec: WriteExec): Result<string>
```

Perform the write a redirected echo asked for. Returns the empty string,
  which is what bash's stdout for `echo hi > f` is.

  `_write`, NOT `write`, for the same reason `runBash` uses `_bash`: the
  `write` tool raises its own `std::write`, and the caller already raised
  one carrying the content.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [WriteExec](#writeexec) |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L480))

### runChain

```ts
runChain(exec: ChainExec, command: string): Result<string>
```

Run a chain of in-process commands left to right with bash's rule: `;`
  runs the next step whatever happened, `&&` only after a success, `||`
  only after a failure. A skipped step changes nothing. The chain fails
  when the last step that ran failed. A failed step adds no text, the way
  a failing program's complaint goes to stderr.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| exec | [ChainExec](#chainexec) |  |
| command | `string` |  |

**Returns:** `Result<string>`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L503))
