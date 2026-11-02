---
name: "fs"
description: "Edit files and create, copy, move, or remove filesystem entries."
---

# fs

Apply text replacements or unified patches, and manage files and directories.
  Mutations require approval through a handler or an interactive response.

  ```ts
  import { edit } from "std::fs"

  node main() {
    const result = edit("notes.txt", [
      { oldText: "draft", newText: "final", replaceAll: true },
    ]) with approve
  }
  ```

## Effects

### std::edit

```ts
@alwaysUnder(dir)
effect std::edit {
  dir: string;
  filename: string;
  edits: Edit[];
  before: string;
  after: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L34))

### std::applyPatch

```ts
effect std::applyPatch {
  patch: string;
  files: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L35))

### std::mkdir

```ts
@alwaysUnder(dir)
effect std::mkdir {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L37))

### std::copy

```ts
@alwaysUnder(src, dest)
effect std::copy {
  src: string;
  dest: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L39))

### std::move

```ts
@alwaysUnder(src, dest)
effect std::move {
  src: string;
  dest: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L41))

### std::remove

```ts
@alwaysUnder(target)
effect std::remove {
  target: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L43))

## Functions

### edit

```ts
edit(
  filename: string,
  edits: Edit[],
  dir: string = ".",
  useAgentCwd: boolean = false,
): Result
```

Apply text replacements in order, writing only if every edit succeeds.
  Prefer one call with multiple edits over many separate calls. Each oldText
  must match uniquely unless replaceAll is true. Use separate edits in the
  same call for distant changes, with just enough oldText to identify each match.

  @param filename - Relative path within dir, without upward traversal or symlink components. To reach another directory, pass it as dir.
  @param edits - Replacements to apply in order; replaceAll replaces every occurrence.
  @param dir - Directory containing the file.
  @param useAgentCwd - Resolve a relative dir against the agent working directory when set.

The `std::edit` interrupt carries the full `before` and `after` file contents
  in its data, so a handler can render a diff itself. A handler receives the
  whole interrupt object, so the contents are at `data.data.before` /
  `data.data.after` (e.g. `print(diff(data.data.before, data.data.after, color: true))`).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| edits | `Edit[]` |  |
| dir | `string` | "." |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::edit`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L52))

### applyPatch

```ts
applyPatch(patch: string, allowedPaths: string[] = []): Result
```

Apply a unified diff to files, including file creation.
  Fails on malformed patches or mismatched context.

  @param allowedPaths - Restrict affected files to these directories, or leave empty for no restriction.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| patch | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `Result`

**Throws:** `std::applyPatch`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L93))

### mkdir

```ts
mkdir(
  dir: string,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

Create a directory and any missing parents. Succeeds if it already exists.

  @param allowedPaths - Restrict creation to these directories, or leave empty for no restriction.
  @param useAgentCwd - Resolve a relative dir against the agent working directory when set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::mkdir`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L115))

### copy

```ts
copy(
  src: string,
  dest: string,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

Copy a file or directory recursively.

  @param allowedPaths - Restrict paths to these directories, or leave empty for no restriction.
  @param useAgentCwd - Resolve relative paths against the agent working directory when set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::copy`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L139))

### move

```ts
move(
  src: string,
  dest: string,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

Move or rename a file or directory.

  @param allowedPaths - Restrict paths to these directories, or leave empty for no restriction.
  @param useAgentCwd - Resolve relative paths against the agent working directory when set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| src | `string` |  |
| dest | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::move`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L169))

### remove

```ts
remove(
  target: string,
  allowedPaths: string[] = [],
  useAgentCwd: boolean = false,
): Result
```

Delete a file or directory recursively. Succeeds if the target is missing.

  @param allowedPaths - Restrict paths to these directories, or leave empty for no restriction.
  @param useAgentCwd - Resolve relative paths against the agent working directory when set.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| target | `string` |  |
| allowedPaths | `string[]` | [] |
| useAgentCwd | `boolean` | false |

**Returns:** `Result`

**Throws:** `std::remove`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/fs.agency#L199))
