---
name: "fs"
---

# fs

## Types

## Effects

### std::edit

```ts
effect std::edit {
  dir: string;
  filename: string;
  edits: Edit[];
  before: string;
  after: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L17))

### std::applyPatch

```ts
effect std::applyPatch {
  patch: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L18))

### std::mkdir

```ts
effect std::mkdir {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L19))

### std::copy

```ts
effect std::copy {
  src: string;
  dest: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L20))

### std::move

```ts
effect std::move {
  src: string;
  dest: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L21))

### std::remove

```ts
effect std::remove {
  target: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L22))

## Functions

### edit

```ts
edit(filename: string, edits: Edit[], dir: string, useAgentCwd: boolean): Result
```

Edit a single file by applying one or more text replacements atomically. Each edit has `oldText`, `newText`, and `replaceAll`. Every edit's `oldText` must match a unique, non-overlapping region of the original file (matches are looked up against the file as it stands when the edit runs, after earlier edits). Set `replaceAll: true` on an edit to replace every occurrence. When any edit fails, nothing is written.

  Prefer one `edit` call with multiple entries over many `edit` calls. Keep each `oldText` as small as possible while still being unique — do not pad with unchanged context just to connect distant changes; instead, split them into separate entries in the same `edits` array.

  The `std::edit` interrupt carries the full `before` and `after` file contents in its data, so a handler can render a diff itself. A handler receives the whole interrupt object, so the contents are at `data.data.before` / `data.data.after` (e.g. `print(diff(data.data.before, data.data.after, color: true))`).

  @param filename - The file to edit
  @param edits - Array of edit objects with oldText, newText, replaceAll
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param useAgentCwd - When true, resolve relative paths against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| edits | `Edit[]` |  |
| dir | `string` | "." |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::edit`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L24))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L57))

### mkdir

```ts
mkdir(dir: string, allowedPaths: string[], useAgentCwd: boolean): Result
```

Create a directory, including any missing parent directories. Idempotent: succeeds if the directory already exists. Fails if a non-directory entry already occupies the path, or on permission errors. Set allowedPaths to restrict which path prefixes are permitted.

  @param dir - The directory to create
  @param allowedPaths - Only allow paths starting with these prefixes
  @param useAgentCwd - When true, resolve a relative dir against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::mkdir`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L71))

### copy

```ts
copy(src: string, dest: string, allowedPaths: string[], useAgentCwd: boolean): Result
```

Copy a file or directory. Directories are copied recursively. Fails if src does not exist or dest cannot be written. Set allowedPaths to restrict which path prefixes are permitted.

  @param src - The source path
  @param dest - The destination path
  @param allowedPaths - Only allow paths starting with these prefixes
  @param useAgentCwd - When true, resolve relative src/dest against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::copy`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L89))

### move

```ts
move(src: string, dest: string, allowedPaths: string[], useAgentCwd: boolean): Result
```

Move or rename a file or directory. Falls back to copy+remove if src and dest are on different filesystems. Fails if src does not exist. Set allowedPaths to restrict which path prefixes are permitted.

  @param src - The source path
  @param dest - The destination path
  @param allowedPaths - Only allow paths starting with these prefixes
  @param useAgentCwd - When true, resolve relative src/dest against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::move`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L110))

### remove

```ts
remove(target: string, allowedPaths: string[], useAgentCwd: boolean): Result
```

Delete a file or directory. Directories are removed recursively. Does not fail if the target does not exist. Set allowedPaths to restrict which path prefixes are permitted.

  @param target - The path to delete
  @param allowedPaths - Only allow paths starting with these prefixes
  @param useAgentCwd - When true, resolve a relative target against the agent working directory (see setAgentCwd) if one is set. Defaults to false.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::remove`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L131))
