# Testing with @agency-lang/tui

The library is designed for testability. Use `ScriptedInput` and `FrameRecorder` to write headless tests with visual artifacts.

## Basic Test Setup

```typescript
import { describe, it, expect } from "vitest";
import {
  Screen, ScriptedInput, FrameRecorder,
  box, text, column,
} from "@agency-lang/tui";

function createTestScreen(width = 80, height = 24) {
  const recorder = new FrameRecorder();
  const input = new ScriptedInput();
  const screen = new Screen({ output: recorder, input, width, height });
  return { screen, recorder, input };
}

describe("my app", () => {
  it("renders the main screen", () => {
    const { screen, recorder } = createTestScreen();

    const frame = screen.render(
      box({ key: "main", border: true },
        text("Hello World")
      )
    );

    // Assert on structure
    expect(frame.findByKey("main")).toBeDefined();

    // Assert on text content
    const main = frame.findByKey("main")!;
    expect(main.toPlainText()).toContain("Hello World");

    // Write visual artifact for debugging
    recorder.writeHTML("test-output/main-screen.html");
  });
});
```

## Step-at-a-Time Testing

For interactive UIs, feed keys and inspect frames after each step:

```typescript
it("navigates a list", async () => {
  const { screen, input, recorder } = createTestScreen();

  // Initial render
  let items = ["A", "B", "C"];
  let selected = 0;

  function renderUI() {
    return screen.render(
      list({ key: "menu", border: true }, items, selected),
      `selected: ${selected}`
    );
  }

  // Step 1: initial state
  let frame = renderUI();
  expect(frame.toPlainText()).toContain("A");

  // Step 2: press down
  input.feedKey({ key: "down" });
  const key = await screen.nextKey();
  selected = 1;
  frame = renderUI();

  // Step 3: verify
  const menu = frame.findByKey("menu")!;
  expect(menu.toPlainText()).toContain("B");

  // Export all frames as HTML for visual inspection
  recorder.writeHTML("test-output/list-navigation.html");
});
```

## Visual Artifacts

`FrameRecorder.writeHTML(path)` produces an HTML file with:
- All captured frames, each labeled with the label passed to `screen.render()`
- Prev/Next buttons and arrow key navigation
- Dark theme with monospace rendering

Open the HTML file in a browser to visually step through each frame.

## Tips

- Use `frame.findByKey("name")` to inspect specific panes without parsing the full screen
- `toPlainText()` is best for assertions; `toHTML()` is best for visual debugging
- Call `recorder.clear()` between test cases to prevent memory buildup
- The `label` parameter on `screen.render()` describes what happened (e.g., "press down", "type 'hello'")
- Screen dimensions default to 80x24 but can be set to any size for testing edge cases
