---
name: "shell"
description: "Run commands, search files, and inspect filesystem metadata."
---

# shell

Use `exec` for an executable with separate arguments, or `bash` for shell
  syntax such as pipes and redirects. Use `ls`, `grep`, and `glob` to inspect
  files. These operations request approval. `stat`, `exists`, and `which`
  provide metadata without an approval interrupt.

  ```ts
  import { bash } from "std::shell"

  node main() {
    const result = bash("ls -la") with approve
    print(result.stdout)
  }
  ```

## Types

### ExecResult

Captured standard output, standard error, and exit code from a command.

```ts
/** Captured standard output, standard error, and exit code from a command. */
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L38))

## Effects

### std::exec

```ts
@always(command, subcommand)
effect std::exec {
  command: string;
  args: string[];
  subcommand: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L45))

### std::bash

```ts
@always(command, cwd)
effect std::bash {
  command: string;
  cwd: string;
  timeout: number;
  stdin: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L54))

### std::ls

```ts
@alwaysUnder(dir)
effect std::ls {
  dir: string;
  recursive: boolean;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L61))

### std::grep

```ts
@alwaysUnder(dir)
effect std::grep {
  pattern: string;
  dir: string;
  file?: string;
  flags: string;
  maxResults: number;
  ignoreCase: boolean;
  wholeWord: boolean;
  filesOnly: boolean;
  invert: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L67))

### std::glob

```ts
@alwaysUnder(dir)
effect std::glob {
  pattern: string;
  dir: string;
  maxResults: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L79))

## Functions

### exec

```ts
exec(
  command: string,
  args: string[] = [],
  cwd: string = "",
  timeout: number = 2m,
  stdin: string = "",
  allowedExecutables: string[] = [],
  blockedCommands: string[] = [],
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): ExecResult raises <std::exec>
```

Run an executable with separate arguments and no shell expansion.
  Use this for commands whose arguments are already available as values.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | The executable to run |
| args | `string[]` | [] | Arguments to pass |
| cwd | `string` | "" | Working directory for the command |
| timeout | `number` | 2m | Time limit in milliseconds (e.g. 30s), after which the command and everything it started is stopped. 0 means no limit. |
| stdin | `string` | "" | Input to feed to the command |
| allowedExecutables | `string[]` | [] | Only allow running these executables (allow-list) |
| blockedCommands | `string[]` | [] | Block running these executables |
| allowedPaths | `string[]` | [] | Only allow cwd values under these path prefixes |
| useAgentCwd | `boolean` | false | When true, a relative or empty cwd is resolved against the agent working directory if one is set; an absolute cwd is left unchanged |

**Returns:** [ExecResult](#execresult)

**Throws:** `std::exec`

**Needs:** `fileRead`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L86))

### bash

```ts
bash(
  command: string,
  cwd: string = "",
  timeout: number = 2m,
  stdin: string = "",
  blockedCommands: string[] = [],
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): ExecResult raises <std::bash>
```

Run a bash command with pipes, redirects, and globbing.
  Use exec with separate arguments when values should remain literal.

`allowedPaths` restricts `cwd`, but bash cannot meaningfully restrict the
  shell command string itself, so prefer running an executable directly with
  structured arguments when capability narrowing matters.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| command | `string` |  | The shell command to run |
| cwd | `string` | "" | Working directory for the command |
| timeout | `number` | 2m | Time limit in milliseconds (e.g. 30s), after which the command and everything it started is stopped. 0 means no limit. |
| stdin | `string` | "" | Input to feed to the command |
| blockedCommands | `string[]` | [] | Block commands that start with these strings |
| allowedPaths | `string[]` | [] | Only allow cwd values under these path prefixes |
| useAgentCwd | `boolean` | false | When true, a relative or empty cwd is resolved against the agent working directory if one is set; an absolute cwd is left unchanged |

**Returns:** [ExecResult](#execresult)

**Throws:** `std::bash`

**Needs:** `fileRead`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L153))

### ls

```ts
ls(
  dir: string = ".",
  recursive: boolean = false,
  maxResults: number = 1000,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::ls>
```

List directory entries, optionally including subdirectories. A recursive
  listing skips node_modules, .git, dist, build, .next, and .cache, and
  anything .gitignore ignores. To list an ignored folder, pass it as dir.
  Narrow dir or raise maxResults when the listing reaches its limit.

Recursive listings skip node_modules, .git, dist, build, .next, and .cache,
plus paths ignored by .gitignore when `respectGitignore` is true. To list an
ignored folder, pass it as `dir`. Non-recursive listings include every entry.
Symlinked entries are omitted.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` | "." |  |
| recursive | `boolean` | false |  |
| maxResults | `number` | 1000 |  |
| allowedPaths | `string[]` | [] | Restrict searches to these directories, or leave empty for no restriction. |
| useAgentCwd | `boolean` | false | Resolve a relative dir against the agent working directory when set. |
| respectGitignore | `boolean` | true | Skip what .gitignore ignores in a recursive listing; false includes ignored files. |

**Returns:** `Result`

**Throws:** `std::ls`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L211))

### grep

```ts
grep(
  pattern: string,
  path | dir: string = ".",
  flags: string = "",
  maxResults: number = 200,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  ignoreCase: boolean = false,
  wholeWord: boolean = false,
  filesOnly: boolean = false,
  invert: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::grep>
```

Search a file or directory recursively with a JavaScript regular expression.
  A directory search skips node_modules, .git, dist, build, .next, and .cache,
  and anything .gitignore ignores. To search an ignored folder, pass it as path.
  Narrow path or refine the pattern when results reach maxResults.

Directory searches skip common build and dependency directories, plus paths
ignored by .gitignore when `respectGitignore` is true. A directly named file
is always searched. To search an ignored folder, pass it as `path`. Symlinked
entries are omitted.

Match paths are relative to the searched directory. For a single-file search,
they contain the filename. Use `filesOnly` when you only need matching paths.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| pattern | `string` |  |  |
| path (also `dir`) | `string` | "." | Directory or single file to search. |
| flags | `string` | "" | Regex flags i, m, s, or u; use the named options for whole-word and inverted searches. |
| maxResults | `number` | 200 |  |
| allowedPaths | `string[]` | [] | Restrict searches to these directories, or leave empty for no restriction. |
| useAgentCwd | `boolean` | false | Resolve a relative path against the agent working directory when set. |
| ignoreCase | `boolean` | false |  |
| wholeWord | `boolean` | false | Match only whole words. |
| filesOnly | `boolean` | false | Return matching file paths instead of lines. |
| invert | `boolean` | false | Return nonmatching lines. |
| respectGitignore | `boolean` | true | Honor .gitignore during directory searches; false includes ignored files. |

**Returns:** `Result`

**Throws:** `std::grep`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L261))

### glob

```ts
glob(
  pattern: string,
  dir: string = ".",
  maxResults: number = 500,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
  respectGitignore: boolean = true,
): Result raises <std::glob>
```

Find files matching a glob such as "src/**/*.ts". The search skips
  node_modules, .git, dist, build, .next, and .cache, and anything .gitignore
  ignores. To search an ignored folder, pass it as dir or start the pattern
  with it. Symlinked entries are omitted.

Searches skip node_modules, .git, dist, build, .next, and .cache, plus paths
ignored by .gitignore when `respectGitignore` is true. To search an ignored
folder, pass it as `dir` or start the pattern with it. Symlinked entries are
omitted.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| pattern | `string` |  |  |
| dir | `string` | "." |  |
| maxResults | `number` | 500 |  |
| allowedPaths | `string[]` | [] | Restrict searches to these directories, or leave empty for no restriction. |
| useAgentCwd | `boolean` | false | Resolve a relative dir against the agent working directory when set. |
| respectGitignore | `boolean` | true | Skip what .gitignore ignores; false includes ignored files. |

**Returns:** `Result`

**Throws:** `std::glob`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L334))

### stat

```ts
stat(
  filename: string,
  dir: string = "",
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): StatInfo
```

Return metadata about a filesystem entry: whether it exists, its type ("file", "dir", "other", or "missing" if absent), size in bytes, and mtime in ms. A symlink below dir is reported as missing. With no dir, the path itself is resolved the way you spelled it.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | The path to stat |
| dir | `string` | "" | Directory to resolve a relative filename against; filename cannot escape it. When empty, filename resolves against the process cwd and absolute paths are accepted |
| allowedPaths | `string[]` | [] | Only allow paths under these prefixes |
| useAgentCwd | `boolean` | false | When true, resolve a relative filename against the agent working directory if one is set; absolute filenames are unaffected |

**Returns:** `StatInfo`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L376))

### exists

```ts
exists(
  filename: string,
  dir: string = "",
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): boolean
```

Return true if a file or directory exists at the given path. A symlink below dir is reported as missing. Probing a path outside allowedPaths raises an error rather than silently returning false.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filename | `string` |  | The path to check |
| dir | `string` | "" | Directory to resolve a relative filename against; filename cannot escape it. When empty, filename resolves against the process cwd and absolute paths are accepted |
| allowedPaths | `string[]` | [] | Only allow paths under these prefixes |
| useAgentCwd | `boolean` | false | When true, resolve a relative filename against the agent working directory if one is set; absolute filenames are unaffected |

**Returns:** `boolean`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L400))

### which

```ts
which(command: string): string
```

Find an executable in PATH, or return an empty string if absent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| command | `string` |  |

**Returns:** `string`

**Needs:** `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/shell.agency#L424))
