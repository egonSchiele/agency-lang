---
name: "index"
description: "Printing, input, file access, and collection helpers available without imports."
---

# index

The always-available prelude: printing, input, file I/O, and the array
helpers. Every `.agency` file auto-imports these, so you can call them
without an import.

```ts
const names = ["Ada", "Grace"]
print(names)
print(range(3))
```

## Types

### WriteMode

How an existing file is handled on write:
  "overwrite" replaces it, "append" adds to it, "create-only" fails if it
  already exists.

```ts
/** How an existing file is handled on write:
  "overwrite" replaces it, "append" adds to it, "create-only" fails if it
  already exists. */
export type WriteMode = "overwrite" | "append" | "create-only"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L77))

### Call

What a decorator learns about the function it wraps. The `name` is
  the definition's original name. Its `args` hold the parameters by name,
  with block parameters left out. The `id` is the function's opaque runtime
  identity, shared by partial, renamed, and preapproved copies. It is not
  a source path or an identifier guaranteed to stay the same across builds.
  The `inToolCall` flag records whether the invocation began inside a
  tool call made by `llm()` in this run, including calls from that tool's
  body or branches. Subprocess and MCP calls do not inherit this context.
  Use these fields for reporting. Direct callers and edited checkpoints
  can supply their values, so do not use them to grant permissions or skip
  approvals. See the Decorators guide page.

```ts
/** What a decorator learns about the function it wraps. The `name` is
  the definition's original name. Its `args` hold the parameters by name,
  with block parameters left out. The `id` is the function's opaque runtime
  identity, shared by partial, renamed, and preapproved copies. It is not
  a source path or an identifier guaranteed to stay the same across builds.
  The `inToolCall` flag records whether the invocation began inside a
  tool call made by `llm()` in this run, including calls from that tool's
  body or branches. Subprocess and MCP calls do not inherit this context.
  Use these fields for reporting. Direct callers and edited checkpoints
  can supply their values, so do not use them to grant permissions or skip
  approvals. See the Decorators guide page. */
export type Call = {
  name: string;
  args: object;
  id: string;
  inToolCall: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L90))

## Effects

### std::read

```ts
@alwaysUnder(dir)
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L46))

### std::write

```ts
@alwaysUnder(dir)
effect std::write {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L51))

### std::readImage

```ts
@alwaysUnder(dir)
effect std::readImage {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L56))

### std::readBinary

```ts
@alwaysUnder(dir)
effect std::readBinary {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L62))

### std::writeBinary

```ts
@alwaysUnder(dir)
effect std::writeBinary {
  dir: string;
  filename: string;
  mode: WriteMode
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L68))

## Functions

### print

```ts
print(...messages: any[])
```

Print a message to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages | `any[]` |  |

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L93))

### setAgentCwd

```ts
setAgentCwd(dir: string)
```

Set the base for relative paths in tools called with useAgentCwd: true.

Set the agent working directory. Path-taking tools (read, write, edit,
  ls, glob, grep, exec, bash, ...) can resolve relative paths against
  the agent working directory if you pass in `useAgentCwd: true` to them.

  This is useful if you're building a coding agent,
  to set the current working directory for the agent.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | The absolute directory to use as the agent working directory |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L120))

### getAgentCwd

```ts
getAgentCwd(): string
```

Return the agent working directory, or an empty string if none is set.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L129))

### applyAgentCwd

```ts
applyAgentCwd(dir: string): string
```

Resolve a relative path against the agent working directory. Absolute paths
  and paths with no agent working directory set pass through unchanged.

File and shell tools call this when their `useAgentCwd` option is true.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L139))

### printJSON

```ts
printJSON(obj: any, highlight: boolean = false)
```

Print an object as formatted JSON to the console.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| obj | `any` |  |  |
| highlight | `boolean` | false | Whether to syntax-highlight the output |

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L152))

### input

```ts
input(prompt: string): string
```

Prompt the user for input and return their response.

Ctrl-C, race-loser, or time-guard abort releases a blocked input
prompt, which surfaces as an AgencyCancelledError.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L169))

### sleep

```ts
sleep(ms: number)
```

Pause execution for the given duration in milliseconds.

Use unit literals for clarity: sleep(1s), sleep(500ms), sleep(2m).
A long sleep wakes immediately on Ctrl-C, race-loser, or time-guard abort.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L178))

### saveDraft

```ts
saveDraft(value: any)
```

Save the current scope's best answer so far for recovery if a guard stops it.
  Call again as the answer improves.

Use this to retain a partial answer when a guard stops unfinished work.
The last saved value wins and must match the enclosing scope's return type.
Drafts belong to their function, node, or guard block; a caller can pass a
callee's draft onward with `return callee()`, or save a draft of its own.
Calling at module scope is an error. Without a guard, saving a draft does
not affect the normal return value.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| value | `any` |  | A partial result matching the enclosing scope's return type |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L193))

### read

```ts
read(
  filename: string,
  dir: string = ".",
  offset: number = 0,
  limit: number = 0,
  useAgentCwd: boolean = false,
): Result raises <std::read>
```

Read the contents of a file and return it as a string.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | Relative path inside dir; absolute paths, ~, escapes, and symlink components are refused. To reach another directory, pass it as dir. |
| dir | `string` | "." | Base directory for filename |
| offset | `number` | 0 | 1-indexed line to start at (0 means start of file) |
| limit | `number` | 0 | Maximum number of lines to return (0 means read to end of file) |
| useAgentCwd | `boolean` | false | Resolve a relative dir against the agent working directory |

**Returns:** `Result`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L204))

### write

```ts
write(
  filename: string,
  content: string,
  dir: string = ".",
  mode: WriteMode = "overwrite",
  useAgentCwd: boolean = false,
): Result raises <std::write>
```

Write content to a file.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | Relative path inside dir; absolute paths, ~, escapes, and symlink components are refused. To reach another directory, pass it as dir. |
| content | `string` |  |  |
| dir | `string` | "." | Base directory for filename |
| mode | [WriteMode](#writemode) | "overwrite" | How to handle an existing file |
| useAgentCwd | `boolean` | false | Resolve a relative dir against the agent working directory |

**Returns:** `Result`

**Throws:** `std::write`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L237))

### writeBinary

```ts
writeBinary(
  filename: string,
  base64: string,
  dir: string = ".",
  mode: WriteMode = "overwrite",
  useAgentCwd: boolean = false,
): Result raises <std::writeBinary>
```

Decode base64 data and write the bytes to a file.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | Relative path inside dir; absolute paths, ~, escapes, and symlink components are refused. To reach another directory, pass it as dir. |
| base64 | `string` |  |  |
| dir | `string` | "." | Base directory for filename |
| mode | [WriteMode](#writemode) | "overwrite" | How to handle an existing file |
| useAgentCwd | `boolean` | false | Resolve a relative dir against the agent working directory |

**Returns:** `Result`

**Throws:** `std::writeBinary`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L271))

### readBinary

```ts
readBinary(
  filename: string,
  dir: string = ".",
  useAgentCwd: boolean = false,
): Result raises <std::readBinary>
```

Read a binary file as a base64-encoded string.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | Relative path inside dir; absolute paths, ~, escapes, and symlink components are refused. To reach another directory, pass it as dir. |
| dir | `string` | "." | Base directory for filename |
| useAgentCwd | `boolean` | false | Resolve a relative dir against the agent working directory |

**Returns:** `Result`

**Throws:** `std::readBinary`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L304))

### range

```ts
range(start: number, end: number = -1): number[]
```

Generate an array of numbers. With one argument, counts from 0 to start-1;
  with two, from start to end-1.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| start | `number` |  | The count with one argument, or the starting number with two |
| end | `number` | -1 | The exclusive end number (omit to count up from 0) |

**Returns:** `number[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L330))

### map

```ts
map(arr: any[], func: (any) -> any): any[]
```

Map a function over an array, returning a new array of results.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L348))

### mapWithIndex

```ts
mapWithIndex(arr: any[], func: (any, any) -> any): any[]
```

Apply a function to each item of an array along with its index, and
  return a new array of the results.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any, any) => any` |  | Called with the item and its zero-based index |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L373))

### filter

```ts
filter(arr: any[], func: (any) -> any): any[]
```

Return a new array containing only the elements for which the function returns true.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element; return true to keep it |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L383))

### exclude

```ts
exclude(arr: any[], func: (any) -> any): any[]
```

Return a new array excluding elements for which the function returns true.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element; return true to exclude it |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L398))

### find

```ts
find(arr: any[], func: (any) -> any): any
```

Return the first element for which the function returns true, or null if none match.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L413))

### findIndex

```ts
findIndex(arr: any[], func: (any) -> any): number
```

Return the index of the first element for which the function returns true, or -1 if none match.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L427))

### reduce

```ts
reduce(arr: any[], initial: any, func: (any, any) -> any): any
```

Reduce an array to a single value by applying a function to an accumulator and each element.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| initial | `any` |  | The initial accumulator value |
| func | `(any, any) => any` |  | The reducer function receiving (accumulator, element) |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L441))

### flatMap

```ts
flatMap(arr: any[], func: (any) -> any): any[]
```

Map a function over an array and flatten the results by one level.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L455))

### flatten

```ts
flatten(arr: any[]): any[]
```

Flatten an array of arrays by one level.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L471))

### every

```ts
every(arr: any[], func: (any) -> any): boolean
```

Return true if the function returns true for every element in the array.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L484))

### some

```ts
some(arr: any[], func: (any) -> any): boolean
```

Return true if the function returns true for at least one element in the array.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L498))

### count

```ts
count(arr: any[], func: (any) -> any): number
```

Count the number of elements in the array for which the function returns true.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Called with each element |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L512))

### sortBy

```ts
sortBy(arr: any[], func: (any) -> any): any[]
```

Return a new array sorted by the values returned by the function, in ascending order.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Returns the sort key for each element |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L527))

### unique

```ts
unique(arr: any[], func: (any) -> any): any[]
```

Return a new array with duplicate elements removed, using the function to determine the identity of each element.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Returns the identity key for each element |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L553))

### groupBy

```ts
groupBy(arr: any[], func: (any) -> any): any
```

Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| arr | `any[]` |  |  |
| func | `(any) => any` |  | Returns the group key for each element |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L577))

### callback

```ts
callback(name: string, fn: any)
```

Register a callback for a lifecycle event. A callback registered inside a
  function or node is removed when that returns. One registered at the top
  level stays active for the whole run.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The callback hook name, e.g. "onNodeStart", "onFunctionStart", "onLLMCallEnd" |
| fn | `any` |  | A function that receives the event data |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L596))
