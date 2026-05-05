# object

## Functions

### mapValues

```ts
mapValues(obj: any, func: (any, string) => any): any
```

Return a new object with the same keys, but with each value transformed by the function. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L1))

### mapEntries

```ts
mapEntries(obj: any, func: (any, string) => any): any
```

Return a new object by applying the function to each entry. The function receives (value, key) and should return { key, value }.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L12))

### filterEntries

```ts
filterEntries(obj: any, func: (any, string) => boolean): any
```

Return a new object containing only the entries for which the function returns true. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L24))

### everyEntry

```ts
everyEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for every entry in the object. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L37))

### someEntry

```ts
someEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for at least one entry in the object. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L49))
