---
name: "index"
---

# index

## Effects

### std::read

```ts
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L45))

### std::write

```ts
effect std::write {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L49))

### std::readImage

```ts
effect std::readImage {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L53))

## Functions

### print

```ts
print(...messages)
```

A tool for printing a message to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L58))

### setAgentCwd

```ts
setAgentCwd(dir: string)
```

Set the agent working directory. Path-taking tools (read, write, edit,
  ls, glob, grep, exec, bash, ...) resolve relative paths against it.
  Pass an absolute path. Branch-scoped: a fork/race/parallel branch can
  change it without affecting the parent.

  @param dir - Absolute directory to use as the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L77))

### getAgentCwd

```ts
getAgentCwd(): string
```

Return the agent working directory, or an empty string when none is
  set. See setAgentCwd.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L89))

### applyAgentCwd

```ts
applyAgentCwd(dir: string): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L103))

### printJSON

```ts
printJSON(obj: any, highlight: boolean)
```

A tool for printing an object as formatted JSON to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| highlight | `boolean` | false |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L111))

### input

```ts
input(prompt: string): string
```

A tool for prompting the user for input and returning their response.

  Cancellation: a blocked input prompt is released on Ctrl-C, race-loser, or time-guard abort, surfacing as an AgencyCancelledError.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L123))

### sleep

```ts
sleep(ms: number)
```

Pause execution for the given duration in milliseconds. Use with unit literals for clarity: sleep(1s), sleep(500ms), sleep(2m).

  Cancellation: a long sleep wakes up immediately on Ctrl-C, race-loser, or time-guard abort.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L132))

### read

```ts
read(filename: string, dir: string, offset: number, limit: number, useAgentCwd: boolean): Result
```

A tool for reading the contents of a file and returning it as a string. The filename is resolved relative to dir.

  By default the full file is returned. Pass `offset` (1-indexed) and/or
  `limit` to paginate a large file — when either is set, a truncation
  note is appended naming the line range and total line count. `0` for
  either argument means "unset" (Agency does not have undefined
  arguments).

  @param filename - The file to read
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param offset - 1-indexed line to start at (0 means start of file)
  @param limit - Maximum number of lines to return (0 means read to end of file)
  @param useAgentCwd - When true, resolve relative paths against the agent working directory (see setAgentCwd) if one is set. Opt-in: defaults to false so behavior is unchanged for everyone who hasn't intentionally enabled it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| dir | `string` | "." |
| offset | `number` | 0 |
| limit | `number` | 0 |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L141))

### write

```ts
write(filename: string, content: string, dir: string, mode: string, useAgentCwd: boolean): Result
```

A tool for writing content to a file. The filename is resolved relative to dir.

  The `mode` parameter controls how an existing file is handled:
  - "overwrite" (default): replace the file if it exists, create it if not
  - "append": append to the file if it exists, create it if not
  - "create-only": fail if the file already exists

  @param filename - The file to write
  @param content - The content to write
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param mode - How to handle an existing file: "overwrite" | "append" | "create-only"
  @param useAgentCwd - When true, resolve relative paths against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |
| dir | `string` | "." |
| mode | `string` | "overwrite" |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L175))

### writeBinary

```ts
writeBinary(filename: string, base64: string, dir: string, mode: string, useAgentCwd: boolean): Result
```

Write base64-encoded binary data to a file (images, audio, video, PDFs, any
  binary). Decodes the base64 and writes raw bytes — unlike write(), which
  writes UTF-8 text. The filename is resolved relative to dir.

  The `mode` parameter controls how an existing file is handled:
  - "overwrite" (default): replace the file if it exists, create it if not
  - "append": append to the file if it exists, create it if not
  - "create-only": fail if the file already exists

  @param filename - The file to write
  @param base64 - The binary content, base64-encoded (e.g. from generateImage() or readBinary())
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param mode - How to handle an existing file: "overwrite" | "append" | "create-only"
  @param useAgentCwd - When true, resolve relative paths against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| base64 | `string` |  |
| dir | `string` | "." |
| mode | `string` | "overwrite" |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::writeBinary`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L208))

### readBinary

```ts
readBinary(filename: string, dir: string, useAgentCwd: boolean): Result
```

Read a file and return its contents as a Base64-encoded string. Works for any
  binary file (images, audio, video, PDFs). The filename is resolved relative to
  dir. Pair with writeBinary() to round-trip binary data.

  @param filename - The file to read
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param useAgentCwd - When true, resolve relative paths against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| dir | `string` | "." |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::readBinary`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L242))

### range

```ts
range(start: number, end: number): number[]
```

Generate an array of numbers. With one argument, generates from 0 to start-1. With two arguments, generates from start to end-1.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| start | `number` |  |
| end | `number` | -1 |

**Returns:** `number[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L266))

### map

```ts
map(arr: any[], func: (any) => any): any[]
```

Map a function over an array, returning a new array of results.

  @param arr - The array to map over
  @param func - The function to apply to each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L283))

### filter

```ts
filter(arr: any[], func: (any) => any): any[]
```

Return a new array containing only the elements for which the function returns true.

  @param arr - The array to filter
  @param func - The function that returns true for elements to keep

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L297))

### exclude

```ts
exclude(arr: any[], func: (any) => any): any[]
```

Return a new array excluding elements for which the function returns true. Inverse of filter.

  @param arr - The array to filter
  @param func - The function that returns true for elements to exclude

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L313))

### find

```ts
find(arr: any[], func: (any) => any): any
```

Return the first element for which the function returns true, or null if none match.

  @param arr - The array to search
  @param func - The function that returns true for the desired element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L329))

### findIndex

```ts
findIndex(arr: any[], func: (any) => any): number
```

Return the index of the first element for which the function returns true, or -1 if none match.

  @param arr - The array to search
  @param func - The function that returns true for the desired element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L344))

### reduce

```ts
reduce(arr: any[], initial: any, func: (any, any) => any): any
```

Reduce an array to a single value by applying a function to an accumulator and each element.

  @param arr - The array to reduce
  @param initial - The initial accumulator value
  @param func - The reducer function receiving (accumulator, element)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| initial | `any` |  |
| func | `(any, any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L359))

### flatMap

```ts
flatMap(arr: any[], func: (any) => any): any[]
```

Map a function over an array and flatten the results by one level.

  @param arr - The array to map over
  @param func - The function to apply to each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L374))

### every

```ts
every(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for every element in the array.

  @param arr - The array to test
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L391))

### some

```ts
some(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for at least one element in the array.

  @param arr - The array to test
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L406))

### count

```ts
count(arr: any[], func: (any) => any): number
```

Count the number of elements in the array for which the function returns true.

  @param arr - The array to count in
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L421))

### sortBy

```ts
sortBy(arr: any[], func: (any) => any): any[]
```

Return a new array sorted by the values returned by the function, in ascending order.

  @param arr - The array to sort
  @param func - The function returning the sort key for each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L437))

### unique

```ts
unique(arr: any[], func: (any) => any): any[]
```

Return a new array with duplicate elements removed, using the function to determine the identity of each element.

  @param arr - The array to deduplicate
  @param func - The function returning the identity key for each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L464))

### groupBy

```ts
groupBy(arr: any[], func: (any) => any): any
```

Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.

  @param arr - The array to group
  @param func - The function returning the group key for each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L489))

### callback

```ts
callback(name: string, fn: any)
```

Register a scoped callback for the dynamic extent of the calling function or node.
  When the caller returns, the callback is automatically removed. Top-level callbacks
  (registered outside any function or node) are active for the whole run.

  @param name - One of the Agency callback hook names (e.g. "onNodeStart", "onFunctionStart", "onLLMCallEnd")
  @param fn - A function that receives the event data

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| fn | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L509))
