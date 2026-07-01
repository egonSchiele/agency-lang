---
name: "index"
---

# index

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L46))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L65))

### getAgentCwd

```ts
getAgentCwd(): string
```

Return the agent working directory, or an empty string when none is
  set. See setAgentCwd.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L77))

### applyAgentCwd

```ts
applyAgentCwd(dir: string): string
```

Resolve `dir` against the agent working directory when one is set;
  otherwise return `dir` unchanged. Used by the path-taking stdlib
  wrappers so a set agent cwd overrides their default base. `_resolve`
  short-circuits on an absolute `dir`, and resolve(base, "") returns
  base, so this works for both the fs default (".") and shell default ("").

  @param dir - The directory argument to resolve.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L85))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L102))

### parseJSON

```ts
parseJSON(text: string): any
```

Parse a JSON string and return the corresponding value (object, array, string, number, boolean, or null). Throws if the input is not valid JSON.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L114))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L121))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L130))

### round

```ts
round(num: number, precision: number): number
```

A tool for rounding a number to a specified number of decimal places.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| num | `number` |  |
| precision | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L139))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L146))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L180))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L213))

### notify

```ts
notify(title: string, message: string): boolean
```

A tool for showing a native OS notification with a title and message. Returns true if the notification was sent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| message | `string` |  |

**Returns:** `boolean`

**Throws:** `std::notify`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L237))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L248))

### mostCommon

```ts
mostCommon(items: any[]): any
```

Return the most common element in an array. Uses JSON serialization for comparison.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| items | `any[]` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L258))

### keys

```ts
keys(obj: any): string[]
```

Return an array of an object's own enumerable property names.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L265))

### values

```ts
values(obj: any): any[]
```

Return an array of an object's own enumerable property values.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L272))

### entries

```ts
entries(obj: any): any[]
```

Return an array of an object's own enumerable entries, each as { key, value }.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L279))

### emit

```ts
emit(data)
```

Emit a custom event to the calling TypeScript code via the onEmit callback.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| data |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L286))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/index.agency#L293))
