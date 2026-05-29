# fs

## Types

### EditResult

```ts
type EditResult = {
  replacements: number;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L4))

### Edit

```ts
type Edit = {
  oldText: string;
  newText: string;
  replaceAll: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L30))

### MultiEditResult

```ts
type MultiEditResult = {
  replacements: number;
  path: string;
  edits: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L36))

### PatchResult

```ts
type PatchResult = {
  applied: number;
  files: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L59))

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
  multiedit: any;
  ls: any;
  glob: any;
  grep: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L148))

## Functions

### edit

```ts
edit(filename: string, oldText: string, newText: string, replaceAll: boolean, dir: string): Result
```

Edit a file by replacing oldText with newText. By default oldText must match exactly once in the file; pass replaceAll=true to replace every occurrence. Fails if oldText is not found or appears multiple times (unless replaceAll is set).

  @param filename - The file to edit
  @param oldText - The text to find
  @param newText - The replacement text
  @param replaceAll - Replace all occurrences instead of just the first
  @param dir - The directory to resolve the filename against (defaults to ".")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| oldText | `string` |  |
| newText | `string` |  |
| replaceAll | `boolean` | false |
| dir | `string` | "." |

**Returns:** `Result`

**Throws:** `std::edit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L9))

### multiedit

```ts
multiedit(filename: string, edits: Edit[], dir: string): Result
```

Apply a sequence of edits to a single file atomically. Each edit has oldText, newText, and replaceAll. Fails if any edit's oldText is not found or is ambiguous; when any edit fails, nothing is written.

  @param filename - The file to edit
  @param edits - Array of edit objects with oldText, newText, and replaceAll
  @param dir - The directory to resolve the filename against (defaults to ".")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| edits | `Edit[]` |  |
| dir | `string` | "." |

**Returns:** `Result`

**Throws:** `std::multiedit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L42))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L64))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L78))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L92))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L108))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L124))

### openDir

```ts
openDir(dir: string): Workspace
```

Build a Workspace anchored at `dir` — a bundle of file-system
  tools (`read`, `write`, `edit`, `multiedit`, `ls`, `glob`, `grep`)
  that all resolve filenames against `dir` and its subtree. Designed
  to be handed to an LLM as a coherent surface: instead of giving
  the model a dozen tools that each take a `dir` arg, give it the
  bundle's members so they only have to think about the filename.

  Each bundle member is constructed via `.partial(dir: dir)`, so `dir`
  is captured at `openDir` time. To re-anchor an agent to a new
  directory, call `openDir(newDir)` again and use the new bundle.

  @param dir - The directory to anchor every bundled tool against

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** [Workspace](#workspace)

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L158))
