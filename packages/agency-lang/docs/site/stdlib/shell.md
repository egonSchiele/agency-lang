---
name: "shell"
description: "Run commands and inspect the filesystem. `exec` and `bash` run programs and raise an approval interrupt before doing so. `ls`, `grep`, `glob`, `stat`, `exists`, and `which` are read-only helpers that return results directly."
---

# shell

Run commands and inspect the filesystem. `exec` and `bash` run programs and
  raise an approval interrupt before doing so. `ls`, `grep`, `glob`, `stat`,
  `exists`, and `which` are read-only helpers that return results directly.

  ```ts
  import { bash } from "std::shell"

  node main() {
    const result = bash("ls -la") with approve
    print(result.stdout)
  }
  ```

## Types

## Effects

### std::exec

```ts
effect std::exec {
  command: string;
  args: string[];
  subcommand: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L37))

### std::bash

```ts
effect std::bash {
  command: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L45))

### std::ls

```ts
effect std::ls {
  dir: string;
  recursive: boolean;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L51))

### std::grep

```ts
effect std::grep {
  pattern: string;
  dir: string;
  flags: string;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L56))

### std::glob

```ts
effect std::glob {
  pattern: string;
  dir: string;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L62))

## Functions

### exec

```ts
exec(
  command: string,
  args: string[] = [],
  cwd: string = "",
  timeout: number = 0,
  stdin: string = "",
  allowedExecutables: string[] = [],
  blockedCommands: string[] = [],
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): ExecResult
```

Run an executable directly with an array of arguments, bypassing the shell, and return its stdout, stderr, and exit code. Arguments are passed straight to the process without shell interpretation, which prevents command injection. Prefer this whenever you have a known command and structured arguments.

  @param command - The executable to run
  @param args - Arguments to pass
  @param cwd - Working directory for the command
  @param timeout - Time limit in milliseconds (e.g. 30s)
  @param stdin - Input to feed to the command
  @param allowedExecutables - Only allow running these executables (allow-list)
  @param blockedCommands - Block running these executables
  @param allowedPaths - Only allow cwd values under these path prefixes
  @param useAgentCwd - When true, a relative or empty cwd is resolved against the agent working directory if one is set; an absolute cwd is left unchanged

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| args | `string[]` | [] |
| cwd | `string` | "" |
| timeout | `number` | 0 |
| stdin | `string` | "" |
| allowedExecutables | `string[]` | [] |
| blockedCommands | `string[]` | [] |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** [ExecResult](#execresult)

**Throws:** `std::exec`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L68))

### bash

```ts
bash(
  command: string,
  cwd: string = "",
  timeout: number = 0,
  stdin: string = "",
  blockedCommands: string[] = [],
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): ExecResult
```

Run a shell command string via sh -c and return its stdout, stderr, and exit code. The shell interprets the string, so pipes, redirects, and globbing work. Interpolated values are also subject to shell interpretation, so prefer running an executable directly with structured arguments when passing untrusted or dynamic values.

  @param command - The shell command to run
  @param cwd - Working directory for the command
  @param timeout - Time limit in milliseconds (e.g. 30s)
  @param stdin - Input to feed to the command
  @param blockedCommands - Block commands that start with these strings
  @param allowedPaths - Only allow cwd values under these path prefixes
  @param useAgentCwd - When true, a relative or empty cwd is resolved against the agent working directory if one is set; an absolute cwd is left unchanged

* `allowedPaths` restricts `cwd`, but bash cannot meaningfully restrict the
 * shell command string itself, so prefer running an executable directly with
 * structured arguments when capability narrowing matters.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |
| timeout | `number` | 0 |
| stdin | `string` | "" |
| blockedCommands | `string[]` | [] |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** [ExecResult](#execresult)

**Throws:** `std::bash`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L132))

### ls

```ts
ls(
  dir: string = ".",
  recursive: boolean = false,
  maxResults: number = 1000,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

List entries in a directory. Each entry has name, path, type ("file", "dir", "symlink", or "other"), and size. Set recursive to true to walk subdirectories. Fails if the directory cannot be read.

  A recursive listing skips heavyweight dirs (node_modules, .git, dist, build, .next, .cache) and stops at maxResults. A non-recursive listing still shows those dirs. If entries look truncated, narrow dir or raise maxResults.

  @param dir - The directory to list (relative paths resolve against the module directory)
  @param recursive - Whether to walk subdirectories
  @param maxResults - Maximum number of entries to return
  @param allowedPaths - Only allow listing directories under these prefixes
  @param useAgentCwd - When true, resolve a relative dir against the agent working directory if one is set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` | "." |
| recursive | `boolean` | false |
| maxResults | `number` | 1000 |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::ls`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L181))

### grep

```ts
grep(
  pattern: string,
  dir: string = ".",
  flags: string = "",
  maxResults: number = 200,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

Search for a regex pattern in files under a directory. Returns matches with file path, line number, and matched line. Skips node_modules, .git, dist, build. Fails if the pattern is not a valid regex or the directory cannot be read.

  Returned file values are relative to dir. Returns at most maxResults matches; if matches look truncated, narrow dir or refine the pattern.

  @param pattern - The regex pattern to search for
  @param dir - The directory to search in (relative paths resolve against the module directory)
  @param flags - Regex flags
  @param maxResults - Maximum number of results to return
  @param allowedPaths - Only allow searching under these path prefixes
  @param useAgentCwd - When true, resolve a relative dir against the agent working directory if one is set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| dir | `string` | "." |
| flags | `string` | "" |
| maxResults | `number` | 200 |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::grep`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L217))

### glob

```ts
glob(
  pattern: string,
  dir: string = ".",
  maxResults: number = 500,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

Find files whose paths match a glob pattern (e.g. "src/**/*.ts"). Fails if the pattern is not valid glob syntax or the directory cannot be read.

  @param pattern - The glob pattern to match
  @param dir - The directory to search in (relative paths resolve against the module directory)
  @param maxResults - Maximum number of results to return
  @param allowedPaths - Only allow searching under these path prefixes
  @param useAgentCwd - When true, resolve a relative dir against the agent working directory if one is set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| dir | `string` | "." |
| maxResults | `number` | 500 |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::glob`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L250))

### stat

```ts
stat(
  filename: string,
  dir: string = "",
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  followSymlinks: boolean = false,
): StatInfo
```

Return metadata about a filesystem entry: whether it exists, its type ("file", "dir", "symlink", "other", or "missing" if absent), size in bytes, and mtime in ms.

  @param filename - The path to stat
  @param dir - Directory to resolve a relative filename against; filename cannot escape it. When empty, filename resolves against the process cwd and absolute paths are accepted
  @param allowedPaths - Only allow paths under these prefixes
  @param useAgentCwd - When true, resolve a relative filename against the agent working directory if one is set; absolute filenames are unaffected
  @param followSymlinks - When true, report the symlink target's type and size (a broken link reports "missing"); when false, report the link itself with type "symlink"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| dir | `string` | "" |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |
| followSymlinks | `boolean` | false |

**Returns:** [StatInfo](#statinfo)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L285))

### exists

```ts
exists(
  filename: string,
  dir: string = "",
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): boolean
```

Return true if a file or directory exists at the given path. Probing a path outside allowedPaths raises an error rather than silently returning false.

  @param filename - The path to check
  @param dir - Directory to resolve a relative filename against; filename cannot escape it. When empty, filename resolves against the process cwd and absolute paths are accepted
  @param allowedPaths - Only allow paths under these prefixes
  @param useAgentCwd - When true, resolve a relative filename against the agent working directory if one is set; absolute filenames are unaffected

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| dir | `string` | "" |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L307))

### which

```ts
which(command: string): string
```

Locate an executable in PATH and return its absolute path, or an empty string if not found. On Windows, also tries PATHEXT extensions.

  @param command - The executable to find

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L327))
