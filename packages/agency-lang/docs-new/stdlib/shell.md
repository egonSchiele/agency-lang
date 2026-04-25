# shell

## Types

### BashResult

```ts
type BashResult = {
  stdout: string;
  stderr: string;
  exitCode: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L2))

### LsEntry

```ts
type LsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L24))

### GrepMatch

```ts
type GrepMatch = {
  file: string;
  line: number;
  text: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L45))

### StatInfo

```ts
type StatInfo = {
  exists: boolean;
  type: "file" | "dir" | "symlink" | "other" | "missing";
  size: number;
  modifiedMs: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L82))

## Functions

### bash

```ts
bash(command: string, cwd: string, timeout: number, stdin: string): BashResult
```

Run a shell command and return its stdout, stderr, and exit code. Pass cwd to change the working directory, timeout (seconds) to enforce a time limit, and stdin to feed input to the command.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |
| cwd | `string` | "" |
| timeout | `number` | 0 |
| stdin | `string` | "" |

**Returns:** [BashResult](#bashresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L8))

### ls

```ts
ls(dir: string, recursive: boolean): Result
```

List entries in a directory. Each entry includes name, path, type ("file", "dir", "symlink", "other"), and size. Set recursive to true to walk subdirectories. Fails if the directory cannot be read (missing, not a directory, permission denied).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` | "." |
| recursive | `boolean` | false |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L31))

### grep

```ts
grep(pattern: string, dir: string, flags: string, maxResults: number): Result
```

Search for a regex pattern in files under a directory. Returns matches with file path, line number, and matched line. Skips node_modules, .git, dist, build. Stops at maxResults. Fails if the pattern is not a valid regex or the directory cannot be read.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| dir | `string` | "." |
| flags | `string` | "" |
| maxResults | `number` | 200 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L51))

### glob

```ts
glob(pattern: string, dir: string, maxResults: number): Result
```

Find files whose paths match a glob pattern (e.g. "src/**/*.ts"). Returns paths relative to the current working directory. Stops at maxResults. Fails if the pattern is not valid glob syntax or the directory cannot be read.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| dir | `string` | "." |
| maxResults | `number` | 500 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L67))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L89))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L96))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/shell.agency#L103))
