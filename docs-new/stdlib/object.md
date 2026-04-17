# object

[View source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency)

## Functions

### mapValues [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L0)

```ts
mapValues(obj: any, func: (any, string) => any): any
```

Return a new object with the same keys, but with each value transformed by the function. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |
| func | (any, string) => any |  |

**Returns:** any

### mapEntries [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L11)

```ts
mapEntries(obj: any, func: (any, string) => any): any
```

Return a new object by applying the function to each entry. The function receives (value, key) and should return { key, value }.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |
| func | (any, string) => any |  |

**Returns:** any

### filterEntries [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L23)

```ts
filterEntries(obj: any, func: (any, string) => boolean): any
```

Return a new object containing only the entries for which the function returns true. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |
| func | (any, string) => boolean |  |

**Returns:** any

### everyEntry [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L36)

```ts
everyEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for every entry in the object. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |
| func | (any, string) => boolean |  |

**Returns:** boolean

### someEntry [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/object.agency#L48)

```ts
someEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for at least one entry in the object. The function receives (value, key).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | any |  |
| func | (any, string) => boolean |  |

**Returns:** boolean
