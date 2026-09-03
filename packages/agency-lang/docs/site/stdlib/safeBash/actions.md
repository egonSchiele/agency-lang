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
 *
 * A discriminated union rather than a bag of `any`: the effect set is
 * closed, so each payload can be typed, and typing them is what makes the
 * raise sites check that every payload satisfies its effect's contract.

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
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L39))

### WritePayload

```ts
export type WritePayload = {
  dir: string;
  filename: string;
  content: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L46))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L72))

### Execution

What happens if every effect in the plan is approved.
 *
 * One variant per way a plan can be carried out, each carrying only the
 * fields that way needs. The dispatch in `safeBash` matches over this
 * union exhaustively, so adding a variant is a type error at the dispatch
 * rather than a silent fall-through.

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
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L86))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L88))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L93))

### AgencyExec

An `agency <subcommand> <file>` line, run through std::agency's cli().

```ts
/** An `agency <subcommand> <file>` line, run through std::agency's cli(). */
export type AgencyExec = {
  kind: "agency";
  args: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L99))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L104))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L112))

### Plan

The whole decision about one call to safeBash, made before anything runs.

```ts
/** The whole decision about one call to safeBash, made before anything runs. */
export type Plan = {
  effects: Effect[];
  execution: Execution
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L118))

## Constants

### MAX_STDOUT_LEN

```ts
export static const MAX_STDOUT_LEN = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L22))

### TOOL_OUTPUT_DIR

```ts
export static const TOOL_OUTPUT_DIR = ".agency-agent/tool-output"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L32))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L55))

### writeExecution

```ts
writeExecution(write: WritePayload): WriteExec
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| write | [WritePayload](#writepayload) |  |

**Returns:** [WriteExec](#writeexec)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L62))

### runBash

```ts
runBash(command: string, cwd: string): Result<string>
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

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L123))

### keepOutput

```ts
keepOutput(text: string, cwd: string, exitCode: number): string
```

What the model gets back for a command's output.

  Short output comes back exactly as printed. Long output is saved to a
  file under `cwd` and replaced by a preview: the exit code, the first and
  last lines, the file's location, and which tools read it. Raw output
  with no bound is a context-window hazard, but cutting it off hid whether
  a build had finished, and the model re-ran it through bash to find out.
  The file goes under `cwd` because that is where the agent's read tools
  are approved without asking.

  If the file cannot be written, the output is cut at the cap with a
  visible marker, the way it always was.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| cwd | `string` |  |
| exitCode | `number` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L172))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L228))
