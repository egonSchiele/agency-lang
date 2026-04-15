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

### LsEntry

```ts
type LsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number
}
```

### GrepMatch

```ts
type GrepMatch = {
  file: string;
  line: number;
  text: string
}
```

### StatInfo

```ts
type StatInfo = {
  exists: boolean;
  type: "file" | "dir" | "symlink" | "other" | "missing";
  size: number;
  modifiedMs: number
}
```

## Functions

### bash

```ts
bash(command: string, cwd: string, timeout: number, stdin: string): BashResult
```

Run a shell command and return its stdout, stderr, and exit code. Pass cwd to change the working directory, timeout (seconds) to enforce a time limit, and stdin to feed input to the command.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | string |  |
| cwd | string | "" |
| timeout | number | 0 |
| stdin | string | "" |

**Returns:** BashResult

### ls

```ts
ls(dir: string, recursive: boolean): Result
```

List entries in a directory. Each entry includes name, path, type ("file", "dir", "symlink", "other"), and size. Set recursive to true to walk subdirectories. Fails if the directory cannot be read (missing, not a directory, permission denied).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | string | "." |
| recursive | boolean | false |

**Returns:** Result

### grep

```ts
grep(pattern: string, dir: string, flags: string, maxResults: number): Result
```

Search for a regex pattern in files under a directory. Returns matches with file path, line number, and matched line. Skips node_modules, .git, dist, build. Stops at maxResults. Fails if the pattern is not a valid regex or the directory cannot be read.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | string |  |
| dir | string | "." |
| flags | string | "" |
| maxResults | number | 200 |

**Returns:** Result

### glob

```ts
glob(pattern: string, dir: string, maxResults: number): Result
```

Find files whose paths match a glob pattern (e.g. "src/**/*.ts"). Returns paths relative to the current working directory. Stops at maxResults. Fails if the pattern is not valid glob syntax or the directory cannot be read.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | string |  |
| dir | string | "." |
| maxResults | number | 500 |

**Returns:** Result

### stat

```ts
stat(filename: string): StatInfo
```

Return metadata about a filesystem entry: whether it exists, its type ("file", "dir", "symlink", "other", or "missing" if absent), size in bytes, and mtime in ms.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |

**Returns:** StatInfo

### exists

```ts
exists(filename: string): boolean
```

Return true if a file or directory exists at the given path.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |

**Returns:** boolean
