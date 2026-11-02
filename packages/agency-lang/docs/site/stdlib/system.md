---
name: "system"
description: "Talk to the host OS: read command-line args and environment variables, find the current directory, show notifications, take screenshots, open URLs, and read from stdin."
---

# system

Talk to the host OS: read command-line args and environment
variables, find the current directory, show notifications, take screenshots,
open URLs, and read from stdin.

  ```ts
  import { args, env, notify } from "std::system"

  node main() {
    const home = env("HOME") with approve
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L31))

### std::exit

```ts
effect std::exit {
  code: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L32))

### std::env

```ts
@always(name)
effect std::env {
  name: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L34))

### std::setEnv

```ts
@always(name)
effect std::setEnv {
  name: string;
  value: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L36))

### std::openUrl

```ts
@always(host)
effect std::openUrl {
  url: string;
  host: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L38))

### std::notify

```ts
effect std::notify {
  title: string;
  body: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L39))

## Functions

### notify

```ts
notify(title: string, message: string): boolean raises <std::notify>
```

Show a native OS notification. Returns true if it was sent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| message | `string` |  |

**Returns:** `boolean`

**Throws:** `std::notify`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L42))

### screenshot

```ts
screenshot(
  filepath: string,
  x: number = -1,
  y: number = -1,
  width: number = -1,
  height: number = -1,
  allowedPaths: string[] = [],
) raises <std::screenshot>
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

**Needs:** `fileRead`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L56))

### exit

```ts
exit(code: number = 0) raises <std::exit>
```

Terminate the process with an exit code.

  @param code - Zero for success, nonzero for failure.

Flushes pending Statelog deliveries before terminating. Other pending work
and cleanup may not finish.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| code | `number` | 0 |

**Throws:** `std::exit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L86))

### args

```ts
args(): string[]
```

Return the command-line arguments passed to the Agency program (excluding the node executable and script path).

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L98))

### cwd

```ts
cwd(): string
```

Return the run's current working directory as an absolute path.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L105))

### env

```ts
env(name: string): string | null
```

Read an environment variable, or return null if unset or access is denied.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string | null`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L121))

### setEnv

```ts
setEnv(name: string, value: string): Result raises <std::setEnv>
```

Set an environment variable on the host.

  @param name - A nonempty variable name without = or NUL bytes
  @param value - Must not contain NUL bytes

On the Node host, the change affects this process and child processes
started afterward. It does not change the launching shell's environment.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| value | `string` |  |

**Returns:** `Result`

**Throws:** `std::setEnv`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L140))

### isTTY

```ts
isTTY(): boolean
```

Return whether standard input is connected to a terminal.

Use this to distinguish interactive input from piped or redirected input.

**Returns:** `boolean`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L158))

### readStdin

```ts
readStdin(): string
```

Read piped or redirected standard input as text, waiting until the stream closes.

**Returns:** `string`

**Needs:** `terminal`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L166))

### openUrl

```ts
openUrl(url: string): Result raises <std::openUrl>
```

Open a URL in the user's default browser.

macOS-only. Ctrl-C, a race loss, or a time-guard abort kills the in-flight
`open` subprocess.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |

**Returns:** `Result`

**Throws:** `std::openUrl`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L182))

### setTitle

```ts
setTitle(title: string): void
```

Set the process title shown in system monitors.

Use a descriptive title to distinguish several running agents in system
monitors and `ps` output.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

**Returns:** `void`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/system.agency#L198))
