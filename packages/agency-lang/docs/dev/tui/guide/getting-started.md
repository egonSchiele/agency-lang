# Getting Started

## Installation

```bash
pnpm add @agency-lang/tui
```

## Quick Example

```typescript
import {
  Screen, ScriptedInput, FrameRecorder,
  box, row, column, text, list,
} from "@agency-lang/tui";

// Create a screen with test I/O
const recorder = new FrameRecorder();
const input = new ScriptedInput();
const screen = new Screen({ output: recorder, input, width: 80, height: 24 });

// Build a UI
const frame = screen.render(
  column(
    box({ height: 3, border: true, label: " Header " },
      text("{bold}My TUI App{/bold}")
    ),
    row({ flex: 1 },
      list({ key: "items", width: "30%", border: true },
        ["Apple", "Banana", "Cherry"], 0
      ),
      box({ key: "details", flex: 1, border: true },
        text("Selected: Apple")
      ),
    ),
  )
);

// Inspect the frame
const itemsPane = frame.findByKey("items");
console.log(itemsPane?.toPlainText());

// Export as HTML
recorder.writeHTML("output.html");
```

## Core Concepts

### Immediate-Mode Rendering

Unlike retained-mode UI libraries (React, blessed), this library has no persistent widget state. Each render cycle, you build a fresh element tree describing the entire screen. The library resolves layout, produces a frame tree, and outputs to a target.

### Elements and Builders

Elements are plain data objects describing the UI. Builder functions provide a concise API:

- `box(style?, ...children)` — container
- `row(style?, ...children)` — horizontal layout
- `column(style?, ...children)` — vertical layout (default)
- `text(content)` — styled text
- `list(style, items, selectedIndex?)` — selectable list
- `textInput(style, value?)` — text input

### Flexbox-Lite Layout

Elements are laid out using a simplified flexbox model:

- `flexDirection: "row" | "column"` — layout direction (default: column)
- `flex: number` — grow factor for distributing remaining space
- `width` / `height` — fixed (number of columns/rows) or percentage ("50%")
- `justifyContent` — main-axis alignment (flex-start, center, flex-end, space-between)
- `alignItems` — cross-axis alignment (stretch, flex-start, center, flex-end)
- `border: true` — reduces inner area by 1 on each side
- `padding` / `margin` — spacing in columns/rows

Elements with no explicit size and no flex default to `flex: 1`.

### Inline Style Tags

Text content supports inline styling:

```
{bold}bold text{/bold}
{red-fg}red text{/red-fg}
{blue-bg}blue background{/blue-bg}
{bold}{cyan-fg}combined{/cyan-fg}{/bold}
```

Use `escapeStyleTags(userText)` to prevent user-provided text from being interpreted as tags.

### Frame Inspection

After rendering, `screen.render()` returns a `Frame` object:

- `frame.findByKey("name")` — find a nested frame by key
- `frame.toPlainText()` — plain text (for assertions)
- `frame.toHTML()` — HTML with CSS colors (for visual artifacts)
- `frame.image("path.html")` — write HTML to file
