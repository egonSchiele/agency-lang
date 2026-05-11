# path

## Functions

### join

```ts
join(...parts: string[]): string
```

Join path segments using the platform separator, normalizing the result.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L3))

### resolve

```ts
resolve(...parts: string[]): string
```

Resolve path segments into an absolute path, relative to the current working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L10))

### basename

```ts
basename(p: string, ext: string): string
```

Return the last portion of a path. If ext is given and the path ends with it, ext is trimmed off.

  @param p - The file path
  @param ext - Extension to strip from the result

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |
| ext | `string` | "" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L17))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L27))

### extname

```ts
extname(p: string): string
```

Return the extension of a path (including the leading dot), or an empty string if there is none.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L34))

### relative

```ts
relative(from: string, to: string): string
```

Return the relative path from 'from' to 'to'.

  @param from - The starting path
  @param to - The target path

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | `string` |  |
| to | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L41))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/path.agency#L51))
