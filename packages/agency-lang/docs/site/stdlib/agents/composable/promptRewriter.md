---
name: "promptRewriter"
description: "Rewrite a user prompt before passing it to another agent."
---

# promptRewriter

`promptRewriter` returns only the revised prompt from an isolated
conversation. Use it when a request needs a clearer goal or output format.

## Functions

### promptRewriter

```ts
promptRewriter(prompt: string): string
```

Rewrite a prompt with a clearer goal and output requirements.
  Return the rewritten prompt without answering it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/composable/promptRewriter.agency#L22))
