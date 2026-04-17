# index

[View source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency)

## Functions

### print [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L1)

```ts
print(...messages)
```

A tool for printing a message to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages |  |  |

### printJSON [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L8)

```ts
printJSON(obj)
```

A tool for printing an object as formatted JSON to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj |  |  |

### input [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L15)

```ts
input(prompt: string): string
```

A tool for prompting the user for input and returning their response.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | string |  |

**Returns:** string

### sleep [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L22)

```ts
sleep(seconds: number)
```

A tool for pausing execution for a specified number of seconds.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seconds | number |  |

### round [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L29)

```ts
round(num: number, precision: number): number
```

A tool for rounding a number to a specified number of decimal places.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| num | number |  |
| precision | number |  |

**Returns:** number

### fetch [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L36)

```ts
fetch(url: string): string
```

A tool for fetching a URL and returning the response as text.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

**Returns:** string

### fetchJSON [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L48)

```ts
fetchJSON(url: string)
```

A tool for fetching a URL and returning the response as parsed JSON.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

### read [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L60)

```ts
read(filename: string): string
```

A tool for reading the contents of a file and returning it as a string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |

**Returns:** string

### write [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L72)

```ts
write(filename: string, content: string)
```

A tool for writing content to a file.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |
| content | string |  |

### readImage [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L85)

```ts
readImage(filename: string): string
```

A tool for reading an image file and returning its contents as a Base64-encoded string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |

**Returns:** string

### notify [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L97)

```ts
notify(title: string, message: string): boolean
```

A tool for showing a native OS notification with a title and message. Returns true if the notification was sent.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | string |  |
| message | string |  |

**Returns:** boolean

### range [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L110)

```ts
range(start: number, end: number): number[]
```

Generate an array of numbers. With one argument, generates from 0 to start-1. With two arguments, generates from start to end-1.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| start | number |  |
| end | number | -1 |

**Returns:** number[]

### mostCommon [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L120)

```ts
mostCommon(items: any[]): any
```

Return the most common element in an array. Uses JSON serialization for comparison.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| items | any[] |  |

**Returns:** any

### keys [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L127)

```ts
keys(obj: any): string[]
```

Return an array of an object's own enumerable property names.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |

**Returns:** string[]

### values [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L134)

```ts
values(obj: any): any[]
```

Return an array of an object's own enumerable property values.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |

**Returns:** any[]

### entries [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/index.agency#L141)

```ts
entries(obj: any): any[]
```

Return an array of an object's own enumerable entries, each as { key, value }.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |

**Returns:** any[]
