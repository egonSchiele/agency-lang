---
name: "index"
---

# index

The always-available prelude: printing, input, file I/O, and the array
helpers. Every `.agency` file auto-imports these, so you can call them
without an import.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L44))

## Effects

### std::read

```ts
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L28))

### std::write

```ts
effect std::write {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L32))

### std::readImage

```ts
effect std::readImage {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L36))

## Functions

### print

```ts
print(...messages)
```

Print a message to the console.

  @param messages - The values to print

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L46))

### setAgentCwd

```ts
setAgentCwd(dir: string)
```

Set the working directory that path-taking tools resolve relative paths against.

  @param dir - The absolute directory to use as the agent working directory

Set the agent working directory. Path-taking tools (read, write, edit,
  ls, glob, grep, exec, bash, ...) can resolve relative paths against
  the agent working directory if you pass in `useAgentCwd: true` to them.

  This is useful if you're building a coding agent,
  to set the current working directory for the agent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L75))

### getAgentCwd

```ts
getAgentCwd(): string
```

Return the agent working directory, or an empty string if none is set.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L84))

### applyAgentCwd

```ts
applyAgentCwd(dir: string): string
```

Used by read, write, and other functions to resolve
relative paths against the agent working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L94))

### printJSON

```ts
printJSON(obj: any, highlight: boolean)
```

Print an object as formatted JSON to the console.

  @param obj - The object to print
  @param highlight - Whether to syntax-highlight the output

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| highlight | `boolean` | false |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L102))

### input

```ts
input(prompt: string): string
```

Prompt the user for input and return their response.

  @param prompt - The message to show the user

Ctrl-C, race-loser, or time-guard abort releases a blocked input
prompt, which surfaces as an AgencyCancelledError.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L119))

### sleep

```ts
sleep(ms: number)
```

Pause execution for the given duration in milliseconds.

  @param ms - The number of milliseconds to pause

Use unit literals for clarity: sleep(1s), sleep(500ms), sleep(2m).
A long sleep wakes immediately on Ctrl-C, race-loser, or time-guard abort.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| ms | `number` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L130))

### read

```ts
read(filename: string, dir: string, offset: number, limit: number, useAgentCwd: boolean): Result
```

Read the contents of a file and return it as a string.

  @param filename - The file to read
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param offset - 1-indexed line to start at (0 means start of file)
  @param limit - Maximum number of lines to return (0 means read to end of file)
  @param useAgentCwd - Resolve relative paths against the agent working directory instead of dir

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L139))

### write

```ts
write(filename: string, content: string, dir: string, mode: WriteMode, useAgentCwd: boolean): Result
```

Write content to a file.

  @param filename - The file to write
  @param content - The content to write
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param mode - How to handle an existing file
  @param useAgentCwd - Resolve relative paths against the agent working directory instead of dir

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |
| dir | `string` | "." |
| mode | [WriteMode](#writemode) | "overwrite" |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L167))

### writeBinary

```ts
writeBinary(filename: string, base64: string, dir: string, mode: WriteMode, useAgentCwd: boolean): Result
```

Write base64-encoded binary data to a file: images, audio, video, PDFs, or any
  binary. Decodes the base64 and writes raw bytes rather than UTF-8 text.

  @param filename - The file to write
  @param base64 - The binary content, base64-encoded
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param mode - How to handle an existing file
  @param useAgentCwd - Resolve relative paths against the agent working directory instead of dir

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| base64 | `string` |  |
| dir | `string` | "." |
| mode | [WriteMode](#writemode) | "overwrite" |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::writeBinary`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L195))

### readBinary

```ts
readBinary(filename: string, dir: string, useAgentCwd: boolean): Result
```

Read a file and return its contents as a Base64-encoded string. Works for any
  binary file: images, audio, video, PDFs.

  @param filename - The file to read
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param useAgentCwd - Resolve relative paths against the agent working directory instead of dir

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| dir | `string` | "." |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::readBinary`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L223))

### range

```ts
range(start: number, end: number): number[]
```

Generate an array of numbers. With one argument, counts from 0 to start-1;
  with two, from start to end-1.

  @param start - The count with one argument, or the starting number with two
  @param end - The exclusive end number (omit to count up from 0)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| start | `number` |  |
| end | `number` | -1 |

**Returns:** `number[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L246))

### map

```ts
map(arr: any[], func: (any) => any): any[]
```

Map a function over an array, returning a new array of results.

  @param arr - The array to map over
  @param func - The mapping function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L267))

### filter

```ts
filter(arr: any[], func: (any) => any): any[]
```

Return a new array containing only the elements for which the function returns true.

  @param arr - The array to filter
  @param func - The filter function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L281))

### exclude

```ts
exclude(arr: any[], func: (any) => any): any[]
```

Return a new array excluding elements for which the function returns true.

  @param arr - The array to filter
  @param func - The exclusion predicate

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L297))

### find

```ts
find(arr: any[], func: (any) => any): any
```

Return the first element for which the function returns true, or null if none match.

  @param arr - The array to search
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L313))

### findIndex

```ts
findIndex(arr: any[], func: (any) => any): number
```

Return the index of the first element for which the function returns true, or -1 if none match.

  @param arr - The array to search
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L328))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L343))

### flatMap

```ts
flatMap(arr: any[], func: (any) => any): any[]
```

Map a function over an array and flatten the results by one level.

  @param arr - The array to map over
  @param func - The mapping function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L358))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L375))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L390))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L405))

### sortBy

```ts
sortBy(arr: any[], func: (any) => any): any[]
```

Return a new array sorted by the values returned by the function, in ascending order.

  @param arr - The array to sort
  @param func - The sort-key function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L421))

### unique

```ts
unique(arr: any[], func: (any) => any): any[]
```

Return a new array with duplicate elements removed, using the function to determine the identity of each element.

  @param arr - The array to deduplicate
  @param func - The identity-key function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L448))

### groupBy

```ts
groupBy(arr: any[], func: (any) => any): any
```

Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.

  @param arr - The array to group
  @param func - The group-key function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L473))

### callback

```ts
callback(name: string, fn: any)
```

Register a callback for a lifecycle event. A callback registered inside a
  function or node is removed when that returns. One registered at the top
  level stays active for the whole run.

  @param name - The callback hook name, e.g. "onNodeStart", "onFunctionStart", "onLLMCallEnd"
  @param fn - A function that receives the event data

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| fn | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L493))
