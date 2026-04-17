# ui

[View source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency)

## Functions

### initUI [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L1)

```ts
initUI(title: string)
```

Initialize a terminal UI with a scrollable output area and a fixed input bar at the bottom. Call this once at the start of your agent. The title is shown in the scrollable output area on init; use status() to populate the status bar.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | string |  |

### destroyUI [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L8)

```ts
destroyUI()
```

Tear down the terminal UI and restore normal terminal behavior. Called automatically on exit, but you can call it early if needed.

### log [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L15)

```ts
log(message: string)
```

Print a message to the scrollable output area. Supports ANSI colors.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | string |  |

### status [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L22)

```ts
status(left: string, right: string)
```

Update the status bar. The left text appears on the left side, the right text on the right.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| left | string |  |
| right | string | "" |

### chat [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L29)

```ts
chat(role: string, message: string)
```

Print a chat message with a colored role prefix. Built-in colors: "user" (cyan), "agent" (white). Other roles appear dim.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| role | string | "" |
| message | string | "" |

### code [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L36)

```ts
code(filename: string, content: string)
```

Display a code block with a filename header and line numbers, inside a bordered box.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |
| content | string |  |

### diff [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L43)

```ts
diff(filename: string, content: string)
```

Display a diff with colored +/- lines, inside a bordered box with the filename as a header.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filename | string |  |
| content | string |  |

### separator [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L50)

```ts
separator(label: string)
```

Print a horizontal line with an optional label. Useful for visually grouping output sections.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| label | string | "" |

### startSpinner [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L57)

```ts
startSpinner(text: string)
```

Show an animated spinner in the input bar with a label. Useful while the agent is thinking or running a long operation.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | string | "working" |

### stopSpinner [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L64)

```ts
stopSpinner()
```

Stop the spinner and clear the input bar.

### prompt [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L71)

```ts
prompt(question: string): string
```

Prompt the user for text input in the fixed input bar at the bottom of the screen. The question appears as a hint. Returns the user's input as a string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | string |  |

**Returns:** string

### getConfirmation [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L78)

```ts
getConfirmation(question: string): boolean
```

Ask the user a yes/no question in the input bar. Returns true if the user answers yes (y/yes), false otherwise. Useful inside handler blocks to approve or reject interrupts interactively.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | string |  |

**Returns:** boolean

### emptyLine [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/ui.agency#L89)

```ts
emptyLine()
```

Print an empty line. Useful for adding spacing in the output.
