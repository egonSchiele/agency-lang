---
name: "system"
---

# system

Talk to the host OS: read command-line args and environment
variables, find the current directory, show notifications, take screenshots,
open URLs, and read from stdin.

  ```ts
  import { args, env, notify } from "std::system"

  node main() {
    const home = env("HOME")
    notify("Done", "Processed ${args().length} arguments")
  }
  ```

## Effects

### std::screenshot

```ts
effect std::screenshot {
  filepath: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L30))

### std::exit

```ts
effect std::exit {
  code: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L31))

### std::setEnv

```ts
effect std::setEnv {
  name: string;
  value: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L32))

### std::openUrl

```ts
effect std::openUrl {
  url: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L33))

### std::notify

```ts
effect std::notify {
  title: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L34))

## Functions

### notify

```ts
notify(title: string, message: string): boolean
```

Show a native OS notification. Returns true if the notification was sent.

  @param title - The notification title
  @param message - The notification body text

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| message | `string` |  |

**Returns:** `boolean`

**Throws:** `std::notify`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L36))

### screenshot

```ts
screenshot(filepath: string, x: number, y: number, width: number, height: number, allowedPaths: string[])
```

Take a screenshot and save it to a file. Pass x, y, width, and height to capture a specific region.

  @param filepath - Path to save the screenshot
  @param x - X coordinate of the capture region; -1 for the full screen
  @param y - Y coordinate of the capture region; -1 for the full screen
  @param width - Width of the capture region; -1 for the full screen
  @param height - Height of the capture region; -1 for the full screen
  @param allowedPaths - Only allow saving under these path prefixes

Ctrl-C, a race loss, or a time-guard abort interrupts an in-progress
screencapture.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L52))

### exit

```ts
exit(code: number)
```

Terminate the process immediately with the given exit code. Use with caution. This skips any cleanup or pending operations.
  @param code - Exit code (0 for success, non-zero for failure)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `number` | 0 |

**Throws:** `std::exit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L77))

### args

```ts
args(): string[]
```

Return the command-line arguments passed to the Agency program (excluding the node executable and script path).

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L88))

### cwd

```ts
cwd(): string
```

Return the absolute path of the current working directory of the Agency process.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L95))

### dirname

```ts
dirname(): string
```

Return the absolute path of the directory containing this Agency module's compiled JavaScript.

* By convention the compiled-JS directory is the same directory as the source
 * `.agency` file. Use this to build paths to resources shipped alongside your
 * Agency file (prompts, fixtures, etc.):
 *
 *   import { dirname } from "std::system"
 *   import { join } from "std::path"
 *   const promptDir = join(dirname(), "prompts")
 *   const prompt = read("system.md", promptDir)
 *
 * Falls back to the current working directory when called outside any Agency
 * execution frame (e.g. from non-Agency host code).

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L115))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L122))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L129))

### isTTY

```ts
isTTY(): boolean
```

Return true if standard input is connected to a terminal. Returns false when stdin is piped or redirected from a file. Use this to detect non-interactive invocations (e.g. `echo "hi" | my-agent`) and adjust output accordingly.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L143))

### readStdin

```ts
readStdin(): string
```

Read all of standard input until EOF and return it as a string. Blocks until the input stream closes. Intended for non-interactive invocations where the user pipes input into the program.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L150))

### openUrl

```ts
openUrl(url: string): Result
```

Open a URL in the user's default browser.

  @param url - The URL to open

macOS-only. Ctrl-C, a race loss, or a time-guard abort kills the in-flight
`open` subprocess.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |

**Returns:** `Result`

**Throws:** `std::openUrl`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L159))

### setTitle

```ts
setTitle(title: string): void
```

Set the process title (as shown in system monitors, `ps` output, and the terminal window). This can help users identify the process, especially when running multiple agents simultaneously.

  @param title - The new process title

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** `void`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L172))
