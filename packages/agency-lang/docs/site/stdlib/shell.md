# shell

## Types

### ExecResult

```ts
type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L12))

### LsEntry

```ts
type LsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L93))

### GrepMatch

```ts
type GrepMatch = {
  file: string;
  line: number;
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L115))

### StatInfo

```ts
type StatInfo = {
  exists: boolean;
  type: "file" | "dir" | "symlink" | "other" | "missing";
  size: number;
  modifiedMs: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L166))

## Functions

### exec

```ts
exec(command: string, args: string[], cwd: string, timeout: number, stdin: string, allowedCommands: string[], blockedCommands: string[]): ExecResult
```

Run an executable directly with an array of arguments, bypassing the shell. This is safer than bash() because arguments are passed directly to the process without shell interpretation, preventing command injection. Use this when you have a known command and structured arguments. Pass cwd to change the working directory, timeout in milliseconds to enforce a time limit (e.g. timeout: 30s), and stdin to feed input to the command. Set allowedCommands to restrict which executables can be run. Set blockedCommands to reject specific executables.

  @param command - The executable to run
  @param args - Array of arguments to pass
  @param cwd - Working directory for the command
  @param timeout - Time limit in milliseconds (e.g. 30s)
  @param stdin - Input to feed to the command
  @param allowedCommands - Only allow running these executables
  @param blockedCommands - Block running these executables

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| args | `string[]` | [] |
| cwd | `string` | "" |
| timeout | `number` | 0 |
| stdin | `string` | "" |
| allowedCommands | `string[]` | [] |
| blockedCommands | `string[]` | [] |

**Returns:** [ExecResult](#execresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L18))

### bash

```ts
bash(command: string, cwd: string, timeout: number, stdin: string, blockedCommands: string[]): ExecResult
```

Run a shell command string via sh -c and return its stdout, stderr, and exit code. The command is interpreted by the shell, so pipes, redirects, globbing, and other shell features work. However, this means interpolated values are subject to shell interpretation -- use exec() instead when passing untrusted or dynamic arguments. Pass cwd to change the working directory, timeout in milliseconds to enforce a time limit (e.g. timeout: 30s), and stdin to feed input to the command. Set blockedCommands to reject commands that start with specific strings.

  @param command - The shell command to run
  @param cwd - Working directory for the command
  @param timeout - Time limit in milliseconds (e.g. 30s)
  @param stdin - Input to feed to the command
  @param blockedCommands - Block commands that start with these strings

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |
| timeout | `number` | 0 |
| stdin | `string` | "" |
| blockedCommands | `string[]` | [] |

**Returns:** [ExecResult](#execresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L59))

### ls

```ts
ls(dir: string, recursive: boolean): Result
```

List entries in a directory. Each entry includes name, path, type ("file", "dir", "symlink", "other"), and size. Set recursive to true to walk subdirectories. Fails if the directory cannot be read (missing, not a directory, permission denied).

  @param dir - The directory to list
  @param recursive - Whether to walk subdirectories

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` | "." |
| recursive | `boolean` | false |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L100))

### grep

```ts
grep(pattern: string, dir: string, flags: string, maxResults: number): Result
```

Search for a regex pattern in files under a directory. Returns matches with file path, line number, and matched line. Skips node_modules, .git, dist, build. Stops at maxResults. Fails if the pattern is not a valid regex or the directory cannot be read.

  @param pattern - The regex pattern to search for
  @param dir - The directory to search in
  @param flags - Regex flags
  @param maxResults - Maximum number of results to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| dir | `string` | "." |
| flags | `string` | "" |
| maxResults | `number` | 200 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L121))

### glob

```ts
glob(pattern: string, dir: string, maxResults: number): Result
```

Find files whose paths match a glob pattern (e.g. "src/**/*.ts"). Returns paths relative to the current working directory. Stops at maxResults. Fails if the pattern is not valid glob syntax or the directory cannot be read.

  @param pattern - The glob pattern to match
  @param dir - The directory to search in
  @param maxResults - Maximum number of results to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| dir | `string` | "." |
| maxResults | `number` | 500 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L145))

### stat

```ts
stat(filename: string): StatInfo
```

Return metadata about a filesystem entry: whether it exists, its type ("file", "dir", "symlink", "other", or "missing" if absent), size in bytes, and mtime in ms.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |

**Returns:** [StatInfo](#statinfo)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L173))

### exists

```ts
exists(filename: string): boolean
```

Return true if a file or directory exists at the given path.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L180))

### which

```ts
which(command: string): string
```

Locate an executable in PATH and return its absolute path. Returns an empty string if the command is not found. On Windows, also tries PATHEXT extensions.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L187))
