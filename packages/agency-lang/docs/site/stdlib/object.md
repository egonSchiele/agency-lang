---
name: "object"
---

# object

Helpers for working with objects: read their keys, values, and entries,
and transform them with `mapValues`, `mapEntries`, and `filterEntries`.

```ts
import { keys, mapValues } from "std::object"

node main() {
  const scores = { alice: 1, bob: 2 }
  print(keys(scores))   // ["alice", "bob"]

  const scaled = mapValues(scores) as (value, key) {
    return value * 10
  }
  print(scaled)         // { alice: 10, bob: 20 }
}
```

## Functions

### keys

```ts
keys(obj: any): string[]
```

Return an array of an object's own enumerable property names.

  @param obj - The object

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L21))

### values

```ts
values(obj: any): any[]
```

Return an array of an object's own enumerable property values.

  @param obj - The object

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L30))

### entries

```ts
entries(obj: any): any[]
```

Return an array of an object's own enumerable entries, each as { key, value }.

  @param obj - The object

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L39))

### mapValues

```ts
mapValues(obj: any, func: (any, string) => any): any
```

Return a new object with the same keys, but with each value transformed by the function.

  @param obj - The object to transform
  @param func - The function receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L48))

### mapEntries

```ts
mapEntries(obj: any, func: (any, string) => any): any
```

Return a new object by applying the function to each entry.

  @param obj - The object to transform
  @param func - The function receiving (value, key) returning {key, value}

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L62))

### filterEntries

```ts
filterEntries(obj: any, func: (any, string) => boolean): any
```

Return a new object containing only the entries for which the function returns true.

  @param obj - The object to filter
  @param func - The predicate receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L77))

### everyEntry

```ts
everyEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for every entry in the object.

  @param obj - The object to test
  @param func - The predicate receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L93))

### someEntry

```ts
someEntry(obj: any, func: (any, string) => boolean): boolean
```

Return true if the function returns true for at least one entry in the object.

  @param obj - The object to test
  @param func - The predicate receiving (value, key)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| obj | `any` |  |
| func | `(any, string) => boolean` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/object.agency#L108))
