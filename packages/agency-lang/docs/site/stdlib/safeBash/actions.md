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
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L27))

### WritePayload

```ts
export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L35))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L62))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L81))

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
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L95))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L97))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L102))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L108))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L113))

### GrepFileNames

Whether grep prints file names: `-H` gives "always", `-h` gives
"never", neither gives "default".

```ts
/** Whether grep prints file names: `-H` gives "always", `-h` gives
 * "never", neither gives "default". */
export type GrepFileNames = "default" | "always" | "never"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L123))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L129))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L142))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L158))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L167))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L173))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L44))

### writeExecution

```ts
writeExecution(write: WritePayload): WriteExec
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| write | [WritePayload](#writepayload) |  |

**Returns:** [WriteExec](#writeexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L51))

### grepEffect

```ts
grepEffect(payload: GrepPayload): Effect
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| payload | [GrepPayload](#greppayload) |  |

**Returns:** [Effect](#effect)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L74))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L150))

### runBash

```ts
runBash(command: string, cwd: string, source: string = ""): Result<string>
```

Run a command string through bash and return what it printed.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L184))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L243))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L290))
