---
name: "clipboard"
description: "Read and write the system clipboard."
---

# clipboard

Read and write the system clipboard.

  ```ts
  import { copy, paste } from "std::clipboard"

  node main() {
    copy("hello")
    const text = paste()
  }
  ```

## Effects

### std::clipboardCopy

```ts
@capabilities(subprocess)
effect std::clipboardCopy {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L16))

### std::clipboardPaste

```ts
@capabilities(subprocess)
effect std::clipboardPaste {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L18))

## Functions

### copy

```ts
copy(text: string)
```

Copy text to the system clipboard.

  @param text - The text to copy

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |

**Throws:** `std::clipboardCopy`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L20))

### paste

```ts
paste(): string
```

Read text from the system clipboard and return it.

**Returns:** `string`

**Throws:** `std::clipboardPaste`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L33))
