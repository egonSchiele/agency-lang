# index

The imports from this file get auto-imported into every .agency file, so you can use these tools without needing to import them manually.

## Functions

### print

```ts
print(...messages)
```

A tool for printing a message to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L4))

### printJSON

```ts
printJSON(obj)
```

A tool for printing an object as formatted JSON to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L11))

### input

```ts
input(prompt: string): string
```

A tool for prompting the user for input and returning their response.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L18))

### sleep

```ts
sleep(seconds: number)
```

A tool for pausing execution for a specified number of seconds.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seconds | `number` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L25))

### round

```ts
round(num: number, precision: number): number
```

A tool for rounding a number to a specified number of decimal places.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| num | `number` |  |
| precision | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L32))

### fetch

```ts
fetch(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[]): string
```

A tool for fetching a URL and returning the response as text. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L39))

### fetchJSON

```ts
fetchJSON(baseUrl: string, path: string, headers: Record<string, any>, allowedDomains: string[])
```

A tool for fetching a URL and returning the response as parsed JSON. Provide baseUrl and optionally path (they are joined). Set headers for custom request headers. Set allowedDomains to restrict which domains can be fetched.

  @param baseUrl - The base URL to fetch
  @param path - Optional path appended to baseUrl
  @param headers - Custom request headers
  @param allowedDomains - Restrict fetches to these domains (empty allows all)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| baseUrl | `string` |  |
| path | `string` | "" |
| headers | `Record<string, any>` | {} |
| allowedDomains | `string[]` | [] |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L55))

### read

```ts
read(dir: string, filename: string): string
```

A tool for reading the contents of a file and returning it as a string. If dir is provided, the filename is resolved relative to that directory.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The file to read

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L71))

### write

```ts
write(dir: string, filename: string, content: string)
```

A tool for writing content to a file. If dir is provided, the filename is resolved relative to that directory.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The file to write
  @param content - The content to write

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L85))

### readImage

```ts
readImage(dir: string, filename: string): string
```

A tool for reading an image file and returning its contents as a Base64-encoded string. If dir is provided, the filename is resolved relative to that directory.

  @param dir - The directory containing the file (use "" for current directory)
  @param filename - The image file to read

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| filename | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L101))

### notify

```ts
notify(title: string, message: string): boolean
```

A tool for showing a native OS notification with a title and message. Returns true if the notification was sent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| message | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L115))

### range

```ts
range(start: number, end: number): number[]
```

Generate an array of numbers. With one argument, generates from 0 to start-1. With two arguments, generates from start to end-1.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| start | `number` |  |
| end | `number` | -1 |

**Returns:** `number[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L126))

### mostCommon

```ts
mostCommon(items: any[]): any
```

Return the most common element in an array. Uses JSON serialization for comparison.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| items | `any[]` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L136))

### keys

```ts
keys(obj: any): string[]
```

Return an array of an object's own enumerable property names.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L143))

### values

```ts
values(obj: any): any[]
```

Return an array of an object's own enumerable property values.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L150))

### entries

```ts
entries(obj: any): any[]
```

Return an array of an object's own enumerable entries, each as { key, value }.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L157))

### emit

```ts
emit(data)
```

Emit a custom event to the calling TypeScript code via the onEmit callback.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| data |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L164))
