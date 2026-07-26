---
name: "safeBash"
---

# safeBash

## Types

### Word

```ts
export type Word =
  | LiteralWord
  | PathWord
  | FlagWord
  | SingleQuotedWord
  | DoubleQuotedWord
  | VariableWord
  | InterpolatedVariableWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L7))

### ScriptName

```ts
export type ScriptName = LiteralWord | PathWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L16))

### LiteralWord

```ts
export type LiteralWord = {
  tag: "literal";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L18))

### PathWord

```ts
export type PathWord = {
  tag: "path";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L23))

### FlagWord

```ts
export type FlagWord = {
  tag: "flag";
  flagName: string;
  flagValue?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L28))

### SingleQuotedWord

```ts
export type SingleQuotedWord = {
  tag: "singleQuoted";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L34))

### DoubleQuotedWord

```ts
export type DoubleQuotedWord = {
  tag: "doubleQuoted";
  parts: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L39))

### VariableWord

```ts
export type VariableWord = {
  tag: "variable";
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L44))

### InterpolatedVariableWord

A word built from two or more adjacent parts: `$HOME.txt`, `"a"b`,
 * `"$HOME"/x`. These are ONE word in bash; split into separate words they
 * become separate arguments and the command means something else.

```ts
/** A word built from two or more adjacent parts: `$HOME.txt`, `"a"b`,
 * `"$HOME"/x`. These are ONE word in bash; split into separate words they
 * become separate arguments and the command means something else.
 */
export type InterpolatedVariableWord = {
  tag: "interpolatedVariable";
  parts: (
  | LiteralWord
  | VariableWord
  | SingleQuotedWord
  | DoubleQuotedWord)[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L53))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L63))

### Redirect

A redirect like `> out.txt`, `>> log`, `2> err.txt` or `< in.txt`.
 * `fd` is the explicit file descriptor (`2` in `2>`), or undefined for the
 * default. Only `>`, `>>`, `<` and `&>` are recognized; `2>&1`, heredocs
 * and here-strings are rejected rather than parsed.

```ts
/** A redirect like `> out.txt`, `>> log`, `2> err.txt` or `< in.txt`.
 * `fd` is the explicit file descriptor (`2` in `2>`), or undefined for the
 * default. Only `>`, `>>`, `<` and `&>` are recognized; `2>&1`, heredocs
 * and here-strings are rejected rather than parsed. */
export type Redirect = {
  tag: "redirect";
  fd?: number;
  op: string;
  target: Word
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L73))

### SimpleCommand

```ts
export type SimpleCommand = {
  tag: "simpleCommand";
  assignments: Assignment[];
  /* The command name, or null for an assignment-only line (`FOO=bar`).
   *  Bash requires at least one of a command name or an assignment. */
  command?: ScriptName;
  /** Every word after the command name, in source order. There is no
   *  `subcommands` field: no syntactic rule separates `git status` from
   *  `echo status`, so splitting them would put a command's real
   *  arguments in whichever bucket the preceding word happened to pick. */
  args: Word[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L80))

### Command

```ts
export type Command = SimpleCommand | And | Or | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L94))

### And

```ts
export type And = {
  tag: "and";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L96))

### Or

```ts
export type Or = {
  tag: "or";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L102))

### Parens

```ts
export type Parens = {
  tag: "parens";
  command: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L108))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L113))

### BashAST

```ts
export type BashAST = Command[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L121))

### OutputRedirect

A bash command reduced to the only shape v1 can reason about: a command
 * name, its arguments as text, and an optional output redirect.

```ts
/** A bash command reduced to the only shape v1 can reason about: a command
 * name, its arguments as text, and an optional output redirect. */
export type OutputRedirect = {
  op: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L125))

### Cmd

```ts
export type Cmd = {
  command: string;
  args: string[];
  redirect?: OutputRedirect
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L130))

## Functions

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L136))

### simplify

```ts
simplify(ast: BashAST): Result<Cmd>
```

Reduce a parsed bash AST to a single command's name, arguments and output
  redirect.

  v1 understands one simple command and nothing else. A `&&` / `||` chain,
  a parenthesized group or a leading variable assignment is a failure — not
  because they are unsafe, but because collapsing them to a command and a
  list of arguments would lose what makes them different from a single
  command.

  @param ast - The AST from `bashParser`

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ast | [BashAST](#bashast) |  |

**Returns:** `Result<Cmd>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L275))

### safeBash

```ts
safeBash(command: string, cwd: string = ""): ExecResult
```

Run a shell command, using an equivalent tool where one exists.

  `bash` cannot be pre-approved — there is no way to say in advance what an
  arbitrary command string will do — so every call needs a human. Many of the
  commands an agent writes have a tool that does the same job and IS
  pre-approved. This parses the command and uses that tool when it can.

  Anything it cannot parse, or cannot map, runs through `bash` exactly as
  before, approval and all. Incompleteness costs an approval, never
  correctness.

  @param command - The shell command to run
  @param cwd - Working directory, passed through to bash on the fallback path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |

**Returns:** [ExecResult](shell.md#execresult)

**Throws:** `std::write`, `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L364))
