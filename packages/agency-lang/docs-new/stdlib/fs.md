# fs

## Types

### EditResult

```ts
type EditResult = {
  replacements: number;
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L3))

### Edit

```ts
type Edit = {
  oldText: string;
  newText: string;
  replaceAll: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L29))

### MultiEditResult

```ts
type MultiEditResult = {
  replacements: number;
  path: string;
  edits: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L35))

### PatchResult

```ts
type PatchResult = {
  applied: number;
  files: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L58))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L8))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L41))

### applyPatch

```ts
applyPatch(patch: string): Result
```

Apply a unified diff to the working tree. Supports file creation (--- /dev/null), line additions, deletions, and context. Fails on a malformed diff or on a context-line mismatch against the current file contents.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| patch | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L63))

### mkdir

```ts
mkdir(dir: string): Result
```

Create a directory, including any missing parent directories. Idempotent: succeeds if the directory already exists. Fails if a non-directory entry already occupies the path, or on permission errors.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L74))

### copy

```ts
copy(src: string, dest: string): Result
```

Copy a file or directory. Directories are copied recursively. Fails if src does not exist or dest cannot be written.

  @param src - The source path
  @param dest - The destination path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L85))

### move

```ts
move(src: string, dest: string): Result
```

Move or rename a file or directory. Falls back to copy+remove if src and dest are on different filesystems. Fails if src does not exist.

  @param src - The source path
  @param dest - The destination path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L100))

### remove

```ts
remove(target: string): Result
```

Delete a file or directory. Directories are removed recursively. Does not fail if the target does not exist.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/fs.agency#L115))
