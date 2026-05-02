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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L3))

### printJSON

```ts
printJSON(obj)
```

A tool for printing an object as formatted JSON to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L10))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L17))

### sleep

```ts
sleep(seconds: number)
```

A tool for pausing execution for a specified number of seconds.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seconds | `number` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L24))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L31))

### fetch

```ts
fetch(url: string): string
```

A tool for fetching a URL and returning the response as text.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L38))

### fetchJSON

```ts
fetchJSON(url: string)
```

A tool for fetching a URL and returning the response as parsed JSON.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L48))

### read

```ts
read(filename: string): string
```

A tool for reading the contents of a file and returning it as a string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L58))

### write

```ts
write(filename: string, content: string)
```

A tool for writing content to a file.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L68))

### readImage

```ts
readImage(filename: string): string
```

A tool for reading an image file and returning its contents as a Base64-encoded string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L79))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L89))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L100))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L110))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L117))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L124))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L131))

### emit

```ts
emit(data)
```

Emit a custom event to the calling TypeScript code via the onEmit callback.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| data |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L138))
