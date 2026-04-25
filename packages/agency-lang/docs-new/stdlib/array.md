# array

## Functions

### map

```ts
map(arr: any[], func: (any) => any): any[]
```

Map a function over an array, returning a new array of results.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L0))

### filter

```ts
filter(arr: any[], func: (any) => any): any[]
```

Return a new array containing only the elements for which the function returns true.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L11))

### exclude

```ts
exclude(arr: any[], func: (any) => any): any[]
```

Return a new array excluding elements for which the function returns true. Inverse of filter.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L24))

### find

```ts
find(arr: any[], func: (any) => any): any
```

Return the first element for which the function returns true, or null if none match.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L37))

### findIndex

```ts
findIndex(arr: any[], func: (any) => any): number
```

Return the index of the first element for which the function returns true, or -1 if none match.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L49))

### reduce

```ts
reduce(arr: any[], initial: any, func: (any, any) => any): any
```

Reduce an array to a single value by applying a function to an accumulator and each element.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| initial | `any` |  |
| func | `(any, any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L61))

### flatMap

```ts
flatMap(arr: any[], func: (any) => any): any[]
```

Map a function over an array and flatten the results by one level.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L72))

### every

```ts
every(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for every element in the array.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L86))

### some

```ts
some(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for at least one element in the array.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L98))

### count

```ts
count(arr: any[], func: (any) => any): number
```

Count the number of elements in the array for which the function returns true.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L110))

### sortBy

```ts
sortBy(arr: any[], func: (any) => any): any[]
```

Return a new array sorted by the values returned by the function, in ascending order.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L123))

### unique

```ts
unique(arr: any[], func: (any) => any): any[]
```

Return a new array with duplicate elements removed, using the function to determine the identity of each element.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L147))

### groupBy

```ts
groupBy(arr: any[], func: (any) => any): any
```

Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L169))
