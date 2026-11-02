---
name: "path"
description: "Build and take apart file paths without accessing the filesystem."
---

# path

Build file paths and extract their directory, filename, or extension.
  These helpers work on path strings without checking whether a file exists.

  ```ts
  import { join, extname } from "std::path"

  node main() {
    const p = join("src", "main.agency")
    print(extname(p))
  }
  ```

  Use `join` to combine path segments. Use `resolve` when you need an
  absolute path, or `relative` to express one path relative to another.

## Functions

### join

```ts
join(...parts: string[]): string
```

Join path segments using the platform separator and normalize the result.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L21))

### resolve

```ts
resolve(...parts: string[]): string
```

Resolve path segments into an absolute path using the run's working directory.

Relative paths start at the run's working directory. An absolute segment
  replaces the segments before it: `resolve("src", "/tmp", "out")` returns
  `"/tmp/out"` on macOS and Linux. With no segments, returns the run's
  working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L34))

### basename

```ts
basename(p: string, ext: string = ""): string
```

Return the last portion of a path.

  @param ext - Exact suffix to remove from the filename, including any leading dot

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |
| ext | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L41))

### dirname

```ts
dirname(p: string): string
```

Return the directory portion of a path.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L50))

### extname

```ts
extname(p: string): string
```

Return the file extension, including the leading dot, or an empty string if there is none.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L57))

### relative

```ts
relative(from: string, to: string): string
```

Return the path from `from` to `to`, resolving relative inputs from the run's working directory.

Both paths resolve from the run's working directory. For example,
  `relative("src", "src/lib/main.agency")` returns `"lib/main.agency"`
  on macOS and Linux. Identical resolved paths produce an empty string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | `string` |  |
| to | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L69))

### isAbsolute

```ts
isAbsolute(p: string): boolean
```

Return true if the path is absolute.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L76))
