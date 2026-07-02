---
name: "clipboard"
---

# clipboard

## Effects

### std::clipboardCopy

```ts
effect std::clipboardCopy {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L3))

### std::clipboardPaste

```ts
effect std::clipboardPaste {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L4))

## Functions

### copy

```ts
copy(text: string)
```

A tool for copying text to the system clipboard.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |

**Throws:** `std::clipboardCopy`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L6))

### paste

```ts
paste(): string
```

A tool for reading text from the system clipboard.

**Returns:** `string`

**Throws:** `std::clipboardPaste`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/clipboard.agency#L15))
