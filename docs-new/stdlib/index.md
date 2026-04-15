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

### map

```ts
map(arr: any[], func: (any) => any): any[]
```

Map a function over an array, returning a new array of results.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any[]

### filter

```ts
filter(arr: any[], func: (any) => any): any[]
```

Return a new array containing only the elements for which the function returns true.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any[]

### exclude

```ts
exclude(arr: any[], func: (any) => any): any[]
```

Return a new array excluding elements for which the function returns true. Inverse of filter.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any[]

### find

```ts
find(arr: any[], func: (any) => any): any
```

Return the first element for which the function returns true, or null if none match.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any

### findIndex

```ts
findIndex(arr: any[], func: (any) => any): number
```

Return the index of the first element for which the function returns true, or -1 if none match.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** number

### reduce

```ts
reduce(arr: any[], initial: any, func: (any, any) => any): any
```

Reduce an array to a single value by applying a function to an accumulator and each element.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| initial | any |  |
| func | (any, any) => any |  |

**Returns:** any

### flatMap

```ts
flatMap(arr: any[], func: (any) => any): any[]
```

Map a function over an array and flatten the results by one level.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any[]

### every

```ts
every(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for every element in the array.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** boolean

### some

```ts
some(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for at least one element in the array.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** boolean

### count

```ts
count(arr: any[], func: (any) => any): number
```

Count the number of elements in the array for which the function returns true.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** number

### sortBy

```ts
sortBy(arr: any[], func: (any) => any): any[]
```

Return a new array sorted by the values returned by the function, in ascending order.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any[]

### unique

```ts
unique(arr: any[], func: (any) => any): any[]
```

Return a new array with duplicate elements removed, using the function to determine the identity of each element.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any[]

### groupBy

```ts
groupBy(arr: any[], func: (any) => any): any
```

Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | any[] |  |
| func | (any) => any |  |

**Returns:** any
