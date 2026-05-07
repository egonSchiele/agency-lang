# array

## Functions

### map

```ts
map(arr: any[], func: (any) => any): any[]
```

Map a function over an array, returning a new array of results.

  @param arr - The array to map over
  @param func - The function to apply to each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L1))

### filter

```ts
filter(arr: any[], func: (any) => any): any[]
```

Return a new array containing only the elements for which the function returns true.

  @param arr - The array to filter
  @param func - The function that returns true for elements to keep

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L15))

### exclude

```ts
exclude(arr: any[], func: (any) => any): any[]
```

Return a new array excluding elements for which the function returns true. Inverse of filter.

  @param arr - The array to filter
  @param func - The function that returns true for elements to exclude

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L31))

### find

```ts
find(arr: any[], func: (any) => any): any
```

Return the first element for which the function returns true, or null if none match.

  @param arr - The array to search
  @param func - The function that returns true for the desired element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L47))

### findIndex

```ts
findIndex(arr: any[], func: (any) => any): number
```

Return the index of the first element for which the function returns true, or -1 if none match.

  @param arr - The array to search
  @param func - The function that returns true for the desired element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L62))

### reduce

```ts
reduce(arr: any[], initial: any, func: (any, any) => any): any
```

Reduce an array to a single value by applying a function to an accumulator and each element.

  @param arr - The array to reduce
  @param initial - The initial accumulator value
  @param func - The reducer function receiving (accumulator, element)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| initial | `any` |  |
| func | `(any, any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L77))

### flatMap

```ts
flatMap(arr: any[], func: (any) => any): any[]
```

Map a function over an array and flatten the results by one level.

  @param arr - The array to map over
  @param func - The function to apply to each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L92))

### every

```ts
every(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for every element in the array.

  @param arr - The array to test
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L109))

### some

```ts
some(arr: any[], func: (any) => any): boolean
```

Return true if the function returns true for at least one element in the array.

  @param arr - The array to test
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L124))

### count

```ts
count(arr: any[], func: (any) => any): number
```

Count the number of elements in the array for which the function returns true.

  @param arr - The array to count in
  @param func - The predicate function

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L139))

### sortBy

```ts
sortBy(arr: any[], func: (any) => any): any[]
```

Return a new array sorted by the values returned by the function, in ascending order.

  @param arr - The array to sort
  @param func - The function returning the sort key for each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L155))

### unique

```ts
unique(arr: any[], func: (any) => any): any[]
```

Return a new array with duplicate elements removed, using the function to determine the identity of each element.

  @param arr - The array to deduplicate
  @param func - The function returning the identity key for each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L182))

### groupBy

```ts
groupBy(arr: any[], func: (any) => any): any
```

Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.

  @param arr - The array to group
  @param func - The function returning the group key for each element

**Parameters:**

| Name | Type | Default |
|---|---|---|
| arr | `any[]` |  |
| func | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/array.agency#L207))
