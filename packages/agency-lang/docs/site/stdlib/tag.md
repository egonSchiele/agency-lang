---
name: "tag"
description: "Attach arbitrary tags to values and read them back anywhere in your program."
---

# tag

Attach arbitrary tags to values and read them back anywhere in
your program.

Tags are stored in a side table, so nothing is attached to the value itself
and TypeScript interop is unaffected. Two semantics, by value kind:

- **Primitives** (string, number, boolean) are keyed by **value**: tagging one
  copy of `"secret"` tags every equal `"secret"` in the current branch.
- **Objects and arrays** are keyed by **reference**: tagging one object does
  not tag a structurally-equal but distinct object.

The built-in `redact` tag marks a value so it is replaced with `"[REDACTED]"`
in state logs — useful for API keys and other secrets.

  ```ts
  import { redact } from "std::tag"

  def callApi(apiKey: string) {
    redact(apiKey)          // apiKey shows as "[REDACTED]" in state logs
    return fetch("https://api.example.com", { headers: { key: apiKey } })
  }
  ```

Note: object/array tags are branch-local — they do not survive `fork`/`race`/
`parallel` branches or interrupt/resume. Primitive (value) tags survive both.

## Functions

### tag

```ts
tag(value: any, key: string, val: any = true): any
```

Attach a tag to a value. Primitives are keyed by value; objects by
  reference. `val` defaults to `true`. Returns the value's current tags.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |
| key | `string` |  |
| val | `any` | true |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L30))

### setTags

```ts
setTags(value: any, tags: any): any
```

Attach multiple tags at once from a `{ key: value }` object. Returns the
  value's current tags.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |
| tags | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L36))

### getTags

```ts
getTags(value: any): any
```

Return all tags on a value as an object, or an empty object if none. The
  result is a shallow copy; nested tag values are shared references.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L42))

### redact

```ts
redact(value: any): any
```

Mark a value so it is replaced with "[REDACTED]" in state logs. Shorthand
  for tag(value, "redact", true). Returns the value's current tags.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L48))

### removeTag

```ts
removeTag(value: any, key: string): any
```

Remove a single tag from a value. Returns the value's remaining tags.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |
| key | `string` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L54))

### removeAllTags

```ts
removeAllTags(value: any): any
```

Remove all tags from a value. Returns an empty object.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/tag.agency#L59))
