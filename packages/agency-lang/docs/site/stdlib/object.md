---
name: "object"
---

# object

## Functions

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L3))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L10))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L17))

### mapValues

```ts
mapValues(obj: any, func: (any, string) => any): any
```

Return a new object with the same keys, but with each value transformed by the function. The function receives (value, key).

  @param obj - The object to transform
  @param func - The function receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L24))

### mapEntries

```ts
mapEntries(obj: any, func: (any, string) => any): any
```

Return a new object by applying the function to each entry. The function receives (value, key) and should return { key, value }.

  @param obj - The object to transform
  @param func - The function receiving (value, key) returning {key, value}

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L38))

### filterEntries

```ts
filterEntries(obj: any, func: (any, string) => boolean): any
```

Return a new object containing only the entries for which the function returns true. The function receives (value, key).

  @param obj - The object to filter
  @param func - The predicate receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L53))

### everyEntry

```ts
everyEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for every entry in the object. The function receives (value, key).

  @param obj - The object to test
  @param func - The predicate receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L69))

### someEntry

```ts
someEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for at least one entry in the object. The function receives (value, key).

  @param obj - The object to test
  @param func - The predicate receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L84))
