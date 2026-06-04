---
title: "system"
name: "system"
---

# system

## Functions

### screenshot

```ts
screenshot(filepath: string, x: number, y: number, width: number, height: number, allowedPaths: string[])
```

A tool for taking a screenshot and saving it to a file. Optionally specify x, y, width, and height to capture a specific region. Set allowedPaths to restrict where the screenshot file may be written.

  Cancellation: an in-progress screencapture is interrupted on Ctrl-C, race-loser, or time-guard abort.

  @param filepath - Path to save the screenshot
  @param x - X coordinate of capture region
  @param y - Y coordinate of capture region
  @param width - Width of capture region
  @param height - Height of capture region
  @param allowedPaths - Only allow saving under these path prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| x | `number` | -1 |
| y | `number` | -1 |
| width | `number` | -1 |
| height | `number` | -1 |
| allowedPaths | `string[]` | [] |

**Throws:** `std::screenshot`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L3))

### exit

```ts
exit(code: number)
```

Terminate the process immediately with the given exit code. Use with caution — this skips any cleanup or pending operations.
  @param code - Exit code (0 for success, non-zero for failure)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `number` | 0 |

**Throws:** `std::exit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L23))

### args

```ts
args(): string[]
```

Return the command-line arguments passed to the Agency program (excluding the node executable and script path).

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L34))

### cwd

```ts
cwd(): string
```

Return the absolute path of the current working directory of the Agency process.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L41))

### dirname

```ts
dirname(): string
```

Return the absolute path of the directory containing the *compiled
  JavaScript* of this Agency module. By convention this is the same
  directory as the source `.agency` file. Use this to build paths to
  resources shipped alongside your Agency file (prompts, fixtures, etc.):

      import { dirname } from "std::system"
      import { join } from "std::path"
      const promptDir = join(dirname(), "prompts")
      const prompt = read("system.md", promptDir)

  Falls back to the current working directory when called outside any
  Agency execution frame (e.g. from non-Agency host code).

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L48))

### env

```ts
env(name: string): string | null
```

Read an environment variable. Returns null if the variable is not set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L66))

### setEnv

```ts
setEnv(name: string, value: string): Result
```

Set an environment variable in the current process. Fails if the name is empty or contains '='. The change is visible to child processes spawned afterward but does not persist outside the current process.

  @param name - The environment variable name
  @param value - The value to set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| value | `string` |  |

**Returns:** `Result`

**Throws:** `std::setEnv`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L73))

### openUrl

```ts
openUrl(url: string): Result
```

Open a URL in the user's default browser. Currently macOS-only.

  Cancellation: the in-flight `open` subprocess is killed on Ctrl-C, race-loser, or time-guard abort.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |

**Returns:** `Result`

**Throws:** `std::openUrl`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/system.agency#L87))
