# fs

## Types

### Edit

```ts
type Edit = {
  oldText: string;
  newText: string;
  replaceAll: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L4))

### EditResult

```ts
type EditResult = {
  replacements: number;
  path: string;
  edits: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L10))

### PatchResult

```ts
type PatchResult = {
  applied: number;
  files: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L50))

### Workspace

* A bundle of file-system tools anchored to a single directory. Every
 * function inside resolves its `filename` / `pattern` argument relative
 * to `dir` (including subdirectories). Construct with `openDir(dir)`.
 *
 * The bundle is built via partial application — each function is a
 * fresh AgencyFunction with `dir` bound at construction time. Re-call
 * `openDir(newDir)` to re-anchor (the previous bundle keeps pointing
 * at the old dir).

```ts
/**
 * A bundle of file-system tools anchored to a single directory. Every
 * function inside resolves its `filename` / `pattern` argument relative
 * to `dir` (including subdirectories). Construct with `openDir(dir)`.
 *
 * The bundle is built via partial application — each function is a
 * fresh AgencyFunction with `dir` bound at construction time. Re-call
 * `openDir(newDir)` to re-anchor (the previous bundle keeps pointing
 * at the old dir).
 */
export type Workspace = {
  read: any;
  write: any;
  edit: any;
  ls: any;
  glob: any;
  grep: any;
  bash: any;
  tools: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L139))

## Functions

### edit

```ts
edit(filename: string, edits: Edit[], dir: string, printDiff: boolean): Result
```

Edit a single file by applying one or more text replacements atomically. Each edit has `oldText`, `newText`, and `replaceAll`. Every edit's `oldText` must match a unique, non-overlapping region of the original file (matches are looked up against the file as it stands when the edit runs, after earlier edits). Set `replaceAll: true` on an edit to replace every occurrence. When any edit fails, nothing is written.

  Prefer one `edit` call with multiple entries over many `edit` calls. Keep each `oldText` as small as possible while still being unique — do not pad with unchanged context just to connect distant changes; instead, split them into separate entries in the same `edits` array.

  @param filename - The file to edit
  @param edits - Array of edit objects with oldText, newText, replaceAll
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param printDiff - When true, print a colored diff to stdout after the edit applies

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| edits | `Edit[]` |  |
| dir | `string` | "." |
| printDiff | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::edit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L16))

### printDiff

```ts
printDiff(oldText: string, newText: string)
```

Print a colored, line-based diff of `oldText` vs `newText` to stdout.
  Deletions are shown in red with a `-` prefix, insertions in green
  with a `+` prefix, unchanged context is dimmed. Useful for showing
  what an edit actually changed before / after committing it.

  @param oldText - The original text
  @param newText - The replacement text

**Parameters:**

| Name | Type | Default |
|---|---|---|
| oldText | `string` |  |
| newText | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L37))

### applyPatch

```ts
applyPatch(patch: string, allowedPaths: string[]): Result
```

Apply a unified diff to the working tree. Supports file creation (--- /dev/null), line additions, deletions, and context. Fails on a malformed diff or on a context-line mismatch against the current file contents. Set allowedPaths to restrict which path prefixes can be touched by the patch.

  @param patch - The unified diff to apply
  @param allowedPaths - Only allow patches that touch files under these prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| patch | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::applyPatch`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L55))

### mkdir

```ts
mkdir(dir: string, allowedPaths: string[]): Result
```

Create a directory, including any missing parent directories. Idempotent: succeeds if the directory already exists. Fails if a non-directory entry already occupies the path, or on permission errors. Set allowedPaths to restrict which path prefixes are permitted.

  @param dir - The directory to create
  @param allowedPaths - Only allow paths starting with these prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::mkdir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L69))

### copy

```ts
copy(src: string, dest: string, allowedPaths: string[]): Result
```

Copy a file or directory. Directories are copied recursively. Fails if src does not exist or dest cannot be written. Set allowedPaths to restrict which path prefixes are permitted.

  @param src - The source path
  @param dest - The destination path
  @param allowedPaths - Only allow paths starting with these prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::copy`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L83))

### move

```ts
move(src: string, dest: string, allowedPaths: string[]): Result
```

Move or rename a file or directory. Falls back to copy+remove if src and dest are on different filesystems. Fails if src does not exist. Set allowedPaths to restrict which path prefixes are permitted.

  @param src - The source path
  @param dest - The destination path
  @param allowedPaths - Only allow paths starting with these prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::move`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L99))

### remove

```ts
remove(target: string, allowedPaths: string[]): Result
```

Delete a file or directory. Directories are removed recursively. Does not fail if the target does not exist. Set allowedPaths to restrict which path prefixes are permitted.

  @param target - The path to delete
  @param allowedPaths - Only allow paths starting with these prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::remove`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L115))

### openDir

```ts
openDir(dir: string, allowedPaths: string[]): Workspace
```

Build a Workspace anchored at `dir` — a bundle of file-system tools
  (`read`, `write`, `edit`, `ls`, `glob`, `grep`, `bash`) that all
  resolve filenames (or `cwd` for `bash`) against `dir` and its
  subtree. Designed to be handed to an LLM as a coherent surface:
  instead of giving the model a dozen tools that each take a `dir`
  arg, give it the bundle's members so they only have to think about
  the filename. The bundle also exposes a `tools` array containing
  every member in order, so you can splat it into a tools list:
  `tools: [...workspace.tools, otherTool]`.

  Each bundle member is constructed via `.partial(dir: dir)`, so `dir`
  is captured at `openDir` time. To re-anchor an agent to a new
  directory, call `openDir(newDir)` again and use the new bundle.

  Defense-in-depth sandboxing: `allowedPaths` is bound on `ls`,
  `glob`, and `grep`. It defaults to `[dir]` so those tools refuse to
  operate outside the anchor directory unless you explicitly pass a
  broader allow-list. Relative entries in `allowedPaths` resolve
  against the same directory as `dir` (the calling module's
  directory), matching how `ls`/`glob`/`grep` already resolve `dir`.

  `bash` is NOT sandboxed by `allowedPaths`: that argument only
  validates `cwd`, while the shell command itself can read or write
  anywhere the process can reach. `bash` is included in the bundle
  for convenience (its `cwd` is pinned to `dir`), but treat it as
  unsandboxed — gate it with user approval or `blockedCommands` if
  you care about confinement. `read`/`write`/`edit` do not accept
  `allowedPaths` but are already confined to `dir` by `resolvePath`,
  which rejects absolute filenames and `..` escapes.

  @param dir - The directory to anchor every bundled tool against
  @param allowedPaths - Sandbox roots bound on ls/glob/grep.
    Defaults to `[dir]` when empty. Relative entries resolve against
    the same base as `dir`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** [Workspace](#workspace)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L155))
