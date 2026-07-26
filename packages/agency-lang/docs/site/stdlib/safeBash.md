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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L5))

### BashWord

```ts
export type BashWord = {
  tag: "word";
  parts: WordPart[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L27))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L33))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L41))

### SimpleCommand

```ts
export type SimpleCommand = {
  tag: "simpleCommand";
  assignments: Assignment[];
  words: BashWord[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L48))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L55))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L64))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L72))

### CaseItem

```ts
export type CaseItem = {
  patterns: BashWord[];
  body: List;
  /** `;;`, `;&`, `;;&`, or null when the final item ends at `esac`. */
  terminator?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L81))

### CaseCommand

```ts
export type CaseCommand = {
  tag: "case";
  subject: BashWord;
  items: CaseItem[];
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L88))

### Subshell

```ts
export type Subshell = {
  tag: "subshell";
  body: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L95))

### Group

```ts
export type Group = {
  tag: "group";
  body: List;
  redirects: Redirect[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L101))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L108))

### FunctionDef

```ts
export type FunctionDef = {
  tag: "functionDef";
  name: string;
  body: Command
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L114))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L120))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L132))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L139))

### ListItem

```ts
export type ListItem = {
  tag: "listItem";
  command: Command;
  /** True when the command was followed by `&`. */
  background: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L145))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L154))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L164))

## Constants

### emptyList

```ts
export static const emptyList: List = {
  tag: "list",
  items: []
}
```

**Type:** [List](#list)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L159))

## Functions

### bashParser

```ts
bashParser(code: string): Result<List>
```

Parse a string of bash code into an AST

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `string` |  |

**Returns:** `Result<List>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L175))

### simplify

```ts
simplify(node: BashNode): any
```

Convert a Bash AST into a simpler JSON representation.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| node | [BashNode](#bashnode) |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/safeBash.agency#L186))
