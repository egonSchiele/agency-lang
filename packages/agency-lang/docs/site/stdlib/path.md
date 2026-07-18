---
name: "path"
description: "Pure helpers for building and taking apart file paths: join, resolve, basename, dirname, extname, relative, and isAbsolute. None of these touch the filesystem."
---

# path

Pure helpers for building and taking apart file paths: join, resolve,
  basename, dirname, extname, relative, and isAbsolute. None of these touch the
  filesystem.

  ```ts
  import { join, extname } from "std::path"

  node main() {
    const p = join("src", "main.agency")
    print(extname(p))
  }
  ```

## Functions

### join

```ts
join(...parts: string[]): string
```

Join path segments using the platform separator and normalize the result.

  @param parts - Path segments to join

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L18))

### resolve

```ts
resolve(...parts: string[]): string
```

Resolve path segments into an absolute path, relative to the current working directory.

  @param parts - Path segments to resolve

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L27))

### basename

```ts
basename(p: string, ext: string = ""): string
```

Return the last portion of a path.

  @param p - The file path
  @param ext - If given and the path ends with this extension, it is trimmed off the result

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |
| ext | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L36))

### dirname

```ts
dirname(p: string): string
```

Return the directory portion of a path.

  @param p - The file path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L46))

### extname

```ts
extname(p: string): string
```

Return the extension of a path (including the leading dot), or an empty string if there is none.

  @param p - The file path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L55))

### relative

```ts
relative(from: string, to: string): string
```

Return the relative path from one path to another.

  @param from - The starting path
  @param to - The target path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | `string` |  |
| to | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L64))

### isAbsolute

```ts
isAbsolute(p: string): boolean
```

Return true if the path is absolute.

  @param p - The path to check

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/path.agency#L74))
