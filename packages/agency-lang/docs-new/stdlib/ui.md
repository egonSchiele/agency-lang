# ui

## Functions

### initUI

```ts
initUI(title: string)
```

Initialize a terminal UI with a scrollable output area and a fixed input bar at the bottom. Call this once at the start of your agent. The title is shown in the scrollable output area on init; use status() to populate the status bar.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L2))

### destroyUI

```ts
destroyUI()
```

Tear down the terminal UI and restore normal terminal behavior. Called automatically on exit, but you can call it early if needed.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L9))

### log

```ts
log(message: string)
```

Print a message to the scrollable output area. Supports ANSI colors.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L16))

### status

```ts
status(left: string, right: string)
```

Update the status bar. The left text appears on the left side, the right text on the right.

  @param left - Text for the left side
  @param right - Text for the right side

**Parameters:**

| Name | Type | Default |
|---|---|---|
| left | `string` |  |
| right | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L23))

### chat

```ts
chat(role: string, message: string)
```

Print a chat message with a colored role prefix. Built-in colors: "user" (cyan), "agent" (white). Other roles appear dim.

  @param role - The speaker role
  @param message - The message text

**Parameters:**

| Name | Type | Default |
|---|---|---|
| role | `string` | "" |
| message | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L33))

### code

```ts
code(filename: string, content: string)
```

Display a code block with a filename header and line numbers, inside a bordered box.

  @param filename - The filename to display
  @param content - The code content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L43))

### diff

```ts
diff(filename: string, content: string)
```

Display a diff with colored +/- lines, inside a bordered box with the filename as a header.

  @param filename - The filename to display
  @param content - The diff content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | `string` |  |
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L53))

### separator

```ts
separator(label: string)
```

Print a horizontal line with an optional label. Useful for visually grouping output sections.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L63))

### startSpinner

```ts
startSpinner(text: string)
```

Show an animated spinner in the input bar with a label. Useful while the agent is thinking or running a long operation.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` | "working" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L70))

### stopSpinner

```ts
stopSpinner()
```

Stop the spinner and clear the input bar.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L77))

### prompt

```ts
prompt(question: string): string
```

Prompt the user for text input in the fixed input bar at the bottom of the screen. The question appears as a hint. Returns the user's input as a string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L84))

### getConfirmation

```ts
getConfirmation(question: string): boolean
```

Ask the user a yes/no question in the input bar. Returns true if the user answers yes (y/yes), false otherwise. Useful inside handler blocks to approve or reject interrupts interactively.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L91))

### emptyLine

```ts
emptyLine()
```

Print an empty line. Useful for adding spacing in the output.

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L102))
