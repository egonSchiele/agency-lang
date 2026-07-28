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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L21))

### ScriptName

```ts
export type ScriptName = LiteralWord | PathWord
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L30))

### LiteralWord

```ts
export type LiteralWord = {
  tag: "literal";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L32))

### PathWord

```ts
export type PathWord = {
  tag: "path";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L37))

### FlagWord

```ts
export type FlagWord = {
  tag: "flag";
  flagName: string;
  flagValue?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L42))

### SingleQuotedWord

```ts
export type SingleQuotedWord = {
  tag: "singleQuoted";
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L48))

### DoubleQuotedWord

```ts
export type DoubleQuotedWord = {
  tag: "doubleQuoted";
  parts: Word[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L53))

### VariableWord

```ts
export type VariableWord = {
  tag: "variable";
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L58))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L67))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L77))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L87))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L94))

### Command

```ts
export type Command = SimpleCommand | And | Or | Parens
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L108))

### And

```ts
export type And = {
  tag: "and";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L110))

### Or

```ts
export type Or = {
  tag: "or";
  left: Command;
  right: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L116))

### Parens

```ts
export type Parens = {
  tag: "parens";
  command: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L122))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L127))

### BashAST

```ts
export type BashAST = Command[]
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L135))

## Functions

### effectsFor

```ts
effectsFor(command: SimpleCommand, cwd: string): Result<Effect[]>
```

Which interrupts this one command needs raised.

  A failure means the command is not recognized. The caller turns that
  into a `std::bash` question for the whole string rather than trying to
  ask a narrow question about part of it.

  @param command - One simple command from the parsed AST
  @param cwd - The resolved working directory, for payloads that need it

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](#simplecommand) |  |
| cwd | `string` |  |

**Returns:** `Result<Effect[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L244))

### planFor

```ts
planFor(source: string, cwd: string): Plan
```

Decide everything about a call before any of it happens.

  Parses the string, classifies every command, and works out which
  interrupts to raise and what to run. Nothing here has an effect, which
  is what makes the decision testable: hand in a string, look at the plan.

  @param source - One or more bash commands
  @param cwd - The resolved working directory

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| cwd | `string` |  |

**Returns:** [Plan](safeBash/actions.md#plan)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L626))

### isRefused

```ts
isRefused(command: SimpleCommand): boolean
```

True when this command must not run, whatever anyone approves.

  Matches the command word, including the last part of a path, so `rm`,
  `/bin/rm` and `./rm` are all refused.

  This wall is friction against the obvious spelling, not a guarantee.
  `find . -delete` and `xargs rm` get past it and are approvable under
  `std::bash`, which is where the actual control lives.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | [SimpleCommand](#simplecommand) |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L712))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L788))

### resolveCwd

```ts
resolveCwd(cwd: string): string
```

Which directory a command runs in: the caller's, or the agent's when the
  caller did not say.

  Resolved once, at the top, and then carried on every action. An action
  that did not carry it would run wherever the process happened to be,
  which is the same command doing two different things.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cwd | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L812))

### safeBash

```ts
safeBash(
  command: string,
  cwd: string = "",
): Result<string> raises <std::bash, std::write, std::git::status, std::git::diff, std::git::log>
```

Run a shell command, asking the narrowest question that describes it.

  `bash` cannot be pre-approved, because a command is a string and a
  string could do anything, so every call needs a human. Many of the
  commands an agent writes can be identified, and for those we ask a more
  specific question — one a policy can answer in advance.

  Nothing runs until every question is answered. If everything is
  approved, the whole string goes to bash in one call, so bash does the
  control flow and produces the output.

  @param command - One or more bash commands
  @param cwd - Working directory. Defaults to the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |

**Returns:** `Result<string>`

**Throws:** `std::bash`, `std::write`, `std::git::status`, `std::git::log`, `std::git::diff`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L833))
