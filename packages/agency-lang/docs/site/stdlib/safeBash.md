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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L16))

### ScriptName

```ts
export type ScriptName = LiteralWord | PathWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L25))

### LiteralWord

```ts
export type LiteralWord = {
  tag: "literal";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L27))

### PathWord

```ts
export type PathWord = {
  tag: "path";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L32))

### FlagWord

```ts
export type FlagWord = {
  tag: "flag";
  flagName: string;
  flagValue?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L37))

### SingleQuotedWord

```ts
export type SingleQuotedWord = {
  tag: "singleQuoted";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L43))

### DoubleQuotedWord

```ts
export type DoubleQuotedWord = {
  tag: "doubleQuoted";
  parts: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L48))

### VariableWord

```ts
export type VariableWord = {
  tag: "variable";
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L53))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L62))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L72))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L82))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L89))

### Command

```ts
export type Command = SimpleCommand | And | Or | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L103))

### And

```ts
export type And = {
  tag: "and";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L105))

### Or

```ts
export type Or = {
  tag: "or";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L111))

### Parens

```ts
export type Parens = {
  tag: "parens";
  command: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L117))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L122))

### BashAST

```ts
export type BashAST = Command[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L130))

### OutputRedirect

An output redirect reduced to the shape v1 handles: `>` or `>>` to a
 * path, with no explicit file descriptor.

```ts
/** An output redirect reduced to the shape v1 handles: `>` or `>>` to a
 * path, with no explicit file descriptor. */
export type OutputRedirect = {
  op: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L134))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L139))

### makeAction

```ts
makeAction(command: SimpleCommand): Result<Action>
```

Decide what a single command means, without doing any of it.

  Everything this returns is a plain data object, so the whole mapping can
  be tested by looking at what comes out. A command with no better mapping
  becomes a `BashAction`, which is still a decision rather than a hole: it
  says "this one has to go to bash", and `runAction` is what pays the
  approval for it.

  @param command - One simple command from the parsed AST

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](#simplecommand) |  |

**Returns:** `Result<Action>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L387))

### runAction

```ts
runAction(action: Action): Result<string>
```

Do what the action says. The only step with effects.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| action | [Action](safeBash/actions.md#action) |  |

**Returns:** `Result<string>`

**Throws:** `std::write`, `std::git::status`, `std::git::diff`, `std::git::log`, `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L476))

### runCommand

```ts
runCommand(command: Command): Result<string>
```

Run one command, whatever shape it is.

  Every branch returns a `Result`, and a failure is never swallowed: the
  caller has to decide what a failed command means, because `&&` and `||`
  answer that question differently.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [Command](#command) |  |

**Returns:** `Result<string>`

**Throws:** `std::write`, `std::git::status`, `std::git::diff`, `std::git::log`, `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L498))

### commandsToStr

```ts
commandsToStr(commands: Command[]): string
```

Render commands back to bash source, one per line.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| commands | `Command[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L586))

### runCommands

```ts
runCommands(commands: Command[]): Result<string>
```

Run a sequence of commands, stopping at the first failure.

  On a failure the model gets the whole picture rather than a bare error:
  what already ran and what it produced, which command failed and why, and
  what never ran. There is no falling back to bash for the sequence — some
  of it has already happened, and re-running the lot would repeat it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| commands | `Command[]` |  |

**Returns:** `Result<string>`

**Throws:** `std::write`, `std::git::status`, `std::git::diff`, `std::git::log`, `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L601))

### makeActions

```ts
makeActions(source: string): Result<Action[]>
```

Every action a string of bash would turn into, without running any of it.

  This is the whole decision-making half of the module in one call, which
  is what makes it testable: hand it a string, look at what comes out.

  The list is in source order and includes both halves of a `&&` or `||`,
  so it says what each command WOULD do, not what will actually run — only
  running the chain decides that.

  @param source - One or more bash commands

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `Result<Action[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L646))

### safeBash

```ts
safeBash(command: string, cwd: string = ""): Result<string>
```

Run a shell command, using an equivalent tool where one exists.

  `bash` cannot be pre-approved — there is no way to say in advance what an
  arbitrary command string will do — so every call needs a human. Many of
  the commands an agent writes have a tool that does the same job and IS
  pre-approved. This parses the command and uses that tool when it can.

  A command with no equivalent still runs, through bash, approval and all.
  What is NOT possible is silently doing something other than what was
  asked: a command that cannot be mapped is handed to bash unchanged, and a
  sequence that fails partway says exactly how far it got.

  @param command - The shell command to run
  @param cwd - Working directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |

**Returns:** `Result<string>`

**Throws:** `std::bash`, `std::write`, `std::git::status`, `std::git::diff`, `std::git::log`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L713))
