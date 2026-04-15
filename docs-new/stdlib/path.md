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
| parts | string[] |  |

**Returns:** string

### resolve

```ts
resolve(...parts: string[]): string
```

Resolve path segments into an absolute path, relative to the current working directory.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| parts | string[] |  |

**Returns:** string

### basename

```ts
basename(p: string, ext: string): string
```

Return the last portion of a path. If ext is given and the path ends with it, ext is trimmed off.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | string |  |
| ext | string | "" |

**Returns:** string

### dirname

```ts
dirname(p: string): string
```

Return the directory portion of a path.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | string |  |

**Returns:** string

### extname

```ts
extname(p: string): string
```

Return the extension of a path (including the leading dot), or an empty string if there is none.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | string |  |

**Returns:** string

### relative

```ts
relative(from: string, to: string): string
```

Return the relative path from 'from' to 'to'.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| from | string |  |
| to | string |  |

**Returns:** string

### isAbsolute

```ts
isAbsolute(p: string): boolean
```

Return true if the path is absolute.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| p | string |  |

**Returns:** boolean
