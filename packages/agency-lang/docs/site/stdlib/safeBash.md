---
name: "safeBash"
---

# safeBash

## Types

### WordPart

One piece of a word. Adjacent parts concatenate: `e'f'"g"$h` is a single
 * word of four parts.

```ts
/** One piece of a word. Adjacent parts concatenate: `e'f'"g"$h` is a single
 * word of four parts. */
export type WordPart =
  | { tag: "literal"; text: string }
  | { tag: "singleQuoted"; text: string }
  | { tag: "doubleQuoted"; parts: WordPart[] }
  | { tag: "variable"; name: string }
  | { tag: "paramExpansion"; expression: string }
  | { tag: "commandSubstitution"; command: List }
  | { tag: "arithmeticExpansion"; expression: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L8))

### BashWord

```ts
export type BashWord = {
  tag: "word";
  parts: WordPart[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L17))

### Assignment

`name=value` (or `name=` with a null value) before a command.

```ts
/** `name=value` (or `name=` with a null value) before a command. */
export type Assignment = {
  tag: "assignment";
  name: string;
  value?: BashWord
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L23))

### Redirect

A redirect like `> out.txt`, `2>&1`, or `<<< "$str"`. `fd` is the
 * explicit file descriptor (`2` in `2>`), or null for the default.

```ts
/** A redirect like `> out.txt`, `2>&1`, or `<<< "$str"`. `fd` is the
 * explicit file descriptor (`2` in `2>`), or null for the default. */
export type Redirect = {
  tag: "redirect";
  fd?: number;
  op: string;
  target: BashWord
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L31))

### SimpleCommand

```ts
export type SimpleCommand = {
  tag: "simpleCommand";
  assignments: Assignment[];
  words: BashWord[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L38))

### IfCommand

```ts
export type IfCommand = {
  tag: "if";
  cond: List;
  thenBody: List;
  elifs: { cond: List; thenBody: List }[];
  elseBody?: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L45))

### LoopCommand

```ts
export type LoopCommand = {
  tag: "loop";
  kind: "while" | "until";
  cond: List;
  body: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L54))

### ForCommand

```ts
export type ForCommand = {
  tag: "for";
  variable: string;
  /** The `in word...` list, or null for the implicit `in "$@"`. */
  words?: BashWord[];
  body: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L62))

### CaseItem

```ts
export type CaseItem = {
  patterns: BashWord[];
  body: List;
  /** `;;`, `;&`, `;;&`, or null when the final item ends at `esac`. */
  terminator?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L71))

### CaseCommand

```ts
export type CaseCommand = {
  tag: "case";
  subject: BashWord;
  items: CaseItem[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L78))

### Subshell

```ts
export type Subshell = {
  tag: "subshell";
  body: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L85))

### Group

```ts
export type Group = {
  tag: "group";
  body: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L91))

### ArithmeticCommand

`(( expression ))` as a command. The expression is kept as raw text.

```ts
/** `(( expression ))` as a command. The expression is kept as raw text. */
export type ArithmeticCommand = {
  tag: "arithmeticCommand";
  expression: string;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L98))

### FunctionDef

```ts
export type FunctionDef = {
  tag: "functionDef";
  name: string;
  body: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L104))

### Command

```ts
export type Command =
  | SimpleCommand
  | IfCommand
  | LoopCommand
  | ForCommand
  | CaseCommand
  | Subshell
  | Group
  | ArithmeticCommand
  | FunctionDef
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L110))

### Pipeline

One or more commands joined by `|` (or `|&`), optionally negated.

```ts
/** One or more commands joined by `|` (or `|&`), optionally negated. */
export type Pipeline = {
  tag: "pipeline";
  negated: boolean;
  commands: Command[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L122))

### AndOr

Pipelines joined by `&&` / `||`, left to right.

```ts
/** Pipelines joined by `&&` / `||`, left to right. */
export type AndOr = {
  tag: "andOr";
  first: Pipeline;
  rest: { op: "&&" | "||"; pipeline: Pipeline }[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L129))

### ListItem

```ts
export type ListItem = {
  tag: "listItem";
  command: Command;
  /** True when the command was followed by `&`. */
  background: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L135))

### List

A sequence of commands separated by `;`, `&`, or newlines — the top
 * level of a script, and the body of every compound command.

```ts
/** A sequence of commands separated by `;`, `&`, or newlines — the top
 * level of a script, and the body of every compound command. */
export type List = {
  tag: "list";
  items: ListItem[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L144))

### BashNode

```ts
export type BashNode =
  | WordPart
  | BashWord
  | Assignment
  | Redirect
  | Command
  | Pipeline
  | AndOr
  | ListItem
  | List
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L154))

### OutputRedirect

A bash command reduced to the only shape v1 can reason about: the words of
 *  a single command, and an optional output redirect.

```ts
/** A bash command reduced to the only shape v1 can reason about: the words of
 *  a single command, and an optional output redirect. */
export type OutputRedirect = {
  op: string;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L168))

### Cmd

```ts
export type Cmd = {
  words: string[];
  redirect?: OutputRedirect
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L173))

### SafeBashResult

```ts
export type SafeBashResult = {
  stdout: string;
  stderr: string;
  exitCode: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L178))

## Constants

### emptyList

```ts
export static const emptyList: List = {
  tag: "list",
  items: []
}
```

**Type:** [List](#list)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L149))

## Functions

### bashParser

```ts
bashParser(code: string): Result<List>
```

Parse a string of bash code into an AST.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |

**Returns:** `Result<List>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L184))

### simplify

```ts
simplify(node: List): Result<Cmd>
```

Reduce a parsed bash AST to a single command's words and output redirect.

  v1 understands one simple command and nothing else. A pipeline, a `&&`
  chain, a subshell, a loop, a background job or a variable assignment is a
  failure — not because they are unsafe, but because collapsing them to a
  word list would lose what makes them different from a single command.

  @param node - The AST from `bashParser`

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | [List](#list) |  |

**Returns:** `Result<Cmd>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L282))

### safeBash

```ts
safeBash(command: string, cwd: string = ""): SafeBashResult
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

**Returns:** [SafeBashResult](#safebashresult)

**Throws:** `std::write`, `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L347))
