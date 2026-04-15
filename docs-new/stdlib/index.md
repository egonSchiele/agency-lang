# index

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

### printJSON

```ts
printJSON(obj)
```

A tool for printing an object as formatted JSON to the console.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj |  |  |

### input

```ts
input(prompt: string): string
```

A tool for prompting the user for input and returning their response.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | string |  |

**Returns:** string

### sleep

```ts
sleep(seconds: number)
```

A tool for pausing execution for a specified number of seconds.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| seconds | number |  |

### round

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

### fetch

```ts
fetch(url: string): string
```

A tool for fetching a URL and returning the response as text.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

**Returns:** string

### fetchJSON

```ts
fetchJSON(url: string)
```

A tool for fetching a URL and returning the response as parsed JSON.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| url | string |  |

### read

```ts
read(filename: string): string
```

A tool for reading the contents of a file and returning it as a string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |

**Returns:** string

### write

```ts
write(filename: string, content: string)
```

A tool for writing content to a file.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |
| content | string |  |

### readImage

```ts
readImage(filename: string): string
```

A tool for reading an image file and returning its contents as a Base64-encoded string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |

**Returns:** string

### notify

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

### range

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

### mostCommon

```ts
mostCommon(items: any[]): any
```

Return the most common element in an array. Uses JSON serialization for comparison.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| items | any[] |  |

**Returns:** any
