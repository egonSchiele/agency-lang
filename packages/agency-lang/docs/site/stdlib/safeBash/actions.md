---
name: "actions"
description: "The things a bash command can turn into."
---

# actions

The things a bash command can turn into.

  Every command `safeBash` runs is first translated into an `Action`: a plain
  data object saying what should happen, with nothing having happened yet.
  Deciding *what* a command means and *doing* it are separate steps, so the
  deciding half can be tested by handing in a string and looking at the
  actions that come out.

  `bash` itself is an action, so a command with no better mapping is still
  represented here rather than being a hole in the model.

## Types

### Action

```ts
export type Action =
  | PrintAction
  | WriteFileAction
  | GitAction
  | BashAction
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L19))

### PrintAction

```ts
export type PrintAction = {
  type: "print";
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L25))

### WriteFileAction

```ts
export type WriteFileAction = {
  type: "writeFile";
  filename: string;
  dir: string;
  content: string;
  mode: "append" | "overwrite"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L30))

### GitAction

```ts
export type GitAction = GitStatusAction | GitDiffAction | GitLogAction
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L38))

### GitStatusAction

```ts
export type GitStatusAction = {
  type: "gitStatus";
  cwd?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L40))

### GitDiffAction

```ts
export type GitDiffAction = {
  type: "gitDiff";
  path?: string;
  staged?: boolean;
  cwd?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L45))

### GitLogAction

```ts
export type GitLogAction = {
  type: "gitLog";
  path?: string;
  cwd?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L52))

### BashAction

The fallback: run the command through bash exactly as written.
 *
 * `command` is the command re-rendered from its AST, not the caller's
 * original string, so a sequence that runs three commands and falls back on
 * the second sends bash only the second one.

```ts
/** The fallback: run the command through bash exactly as written.
 *
 * `command` is the command re-rendered from its AST, not the caller's
 * original string, so a sequence that runs three commands and falls back on
 * the second sends bash only the second one. */
export type BashAction = {
  type: "bash";
  command: string;
  cwd?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L63))

## Constants

### MAX_STDOUT_LEN

```ts
export static const MAX_STDOUT_LEN = 2000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L17))

## Functions

### printAction

```ts
printAction(action: PrintAction): Result<string>
```

Print to stdout. No interrupt: printing has no effect to approve.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [PrintAction](#printaction) |  |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L69))

### writeAction

```ts
writeAction(action: WriteFileAction): Result<string>
```

Write a file. `write` raises the `std::write` interrupt, so this is gated
  the same way any other write is.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [WriteFileAction](#writefileaction) |  |

**Returns:** `Result<string>`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L77))

### gitStatusAction

```ts
gitStatusAction(action: GitStatusAction): Result<string>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [GitStatusAction](#gitstatusaction) |  |

**Returns:** `Result<string>`

**Throws:** `std::git::status`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L94))

### gitDiffAction

```ts
gitDiffAction(action: GitDiffAction): Result<string>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [GitDiffAction](#gitdiffaction) |  |

**Returns:** `Result<string>`

**Throws:** `std::git::diff`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L99))

### gitLogAction

```ts
gitLogAction(action: GitLogAction): Result<string>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [GitLogAction](#gitlogaction) |  |

**Returns:** `Result<string>`

**Throws:** `std::git::log`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L108))

### bashAction

```ts
bashAction(action: BashAction): Result<string>
```

Run the command through bash, approval and all.

  A non-zero exit is a failure rather than a success carrying a bad exit
  code, so a `&&` chain stops on it the way bash would.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [BashAction](#bashaction) |  |

**Returns:** `Result<string>`

**Throws:** `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash/actions.agency#L113))
