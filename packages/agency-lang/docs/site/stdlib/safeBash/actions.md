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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L34))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L61))

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
export type Execution = BashExec | EchoExec | WriteExec | RefuseExec
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L75))

### BashExec

```ts
export type BashExec = {
  kind: "bash";
  command: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L77))

### EchoExec

```ts
export type EchoExec = {
  kind: "echo";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L82))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L87))

### RefuseExec

```ts
export type RefuseExec = {
  kind: "refuse";
  reason: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L95))

### Plan

The whole decision about one call to safeBash, made before anything runs.

```ts
/** The whole decision about one call to safeBash, made before anything runs. */
export type Plan = {
  effects: Effect[];
  execution: Execution
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L101))

## Constants

### MAX_STDOUT_LEN

```ts
export static const MAX_STDOUT_LEN = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L20))

## Functions

### writeEffect

```ts
writeEffect(write: WritePayload): Effect
```

The one shared description of a planned redirect write. Both the
  approval side (writeEffect) and the execution side (writeExecution)
  derive from it, so payload/execution parity holds by construction.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L106))

### truncate

```ts
truncate(text: string): string
```

Cap output length. Raw output with no bound is a context-window hazard,
  and a visible loss of fidelity beats an invisible one.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L155))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L166))
