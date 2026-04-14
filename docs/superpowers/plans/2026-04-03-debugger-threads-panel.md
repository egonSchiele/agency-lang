# Debugger Threads Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a panel to the debugger UI that displays message thread contents from the current checkpoint frame, appearing next to the source pane when threads exist.

**Architecture:** Add a `getThreadMessages()` accessor to `UIState` that extracts thread data from the checkpoint frame. In `DebuggerUI`, create a threads box (initially hidden) and toggle its visibility + source pane width on each `render()` based on whether threads exist.

**Tech Stack:** blessed (terminal UI), smoltalk (message types), vitest (tests)

---

### Task 1: Add `getThreadMessages()` to UIState

**Files:**
- Modify: `lib/debugger/uiState.ts`
- Test: `lib/debugger/uiState.test.ts`

- [ ] **Step 1: Write the failing test for `getThreadMessages` returning null when no threads**

Add to the `setCheckpoint` describe block in `lib/debugger/uiState.test.ts`:

```typescript
it("should return null for getThreadMessages when no threads in frame", async () => {
  const ui = new UIState();
  await ui.setCheckpoint(makeCheckpoint());
  expect(ui.getThreadMessages()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/debugger/uiState.test.ts`
Expected: FAIL — `getThreadMessages is not a function`

- [ ] **Step 3: Write the failing test for `getThreadMessages` returning thread data**

Add to the `setCheckpoint` describe block in `lib/debugger/uiState.test.ts`:

```typescript
it("should return active thread messages from getThreadMessages", async () => {
  const ui = new UIState();
  await ui.setCheckpoint(
    makeCheckpoint({
      stack: makeStackJSON([
        {
          args: {},
          locals: {},
          threads: {
            threads: {
              "0": {
                messages: [
                  { role: "user", content: "Hello" },
                  { role: "assistant", content: "Hi there" },
                ],
              },
              "1": {
                messages: [
                  { role: "user", content: "Other thread" },
                ],
              },
            },
            counter: 2,
            activeStack: ["0"],
          },
        },
      ]),
    }),
  );
  const result = ui.getThreadMessages();
  expect(result).not.toBeNull();
  expect(result!.threadId).toBe("0");
  expect(result!.messages).toEqual([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ]);
});
```

- [ ] **Step 4: Write the failing test for empty threads object**

```typescript
it("should return null for getThreadMessages when threads object has no threads", async () => {
  const ui = new UIState();
  await ui.setCheckpoint(
    makeCheckpoint({
      stack: makeStackJSON([
        {
          args: {},
          locals: {},
          threads: {
            threads: {},
            counter: 0,
            activeStack: [],
          },
        },
      ]),
    }),
  );
  expect(ui.getThreadMessages()).toBeNull();
});
```

- [ ] **Step 5: Implement `getThreadMessages()` in UIState**

Add this method to `UIState` in `lib/debugger/uiState.ts`. The extraction logic lives on `Checkpoint.getThreadMessages()`, so this is a thin delegate:

```typescript
getThreadMessages(): { threadId: string; messages: { role: string; content: string }[] } | null {
  if (!this.checkpoint) return null;
  return this.checkpoint.getThreadMessages();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:run -- lib/debugger/uiState.test.ts`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add lib/debugger/uiState.ts lib/debugger/uiState.test.ts
git commit -m "feat: add getThreadMessages() to UIState for debugger threads panel"
```

---

### Task 2: Add threads panel to DebuggerUI

**Files:**
- Modify: `lib/debugger/ui.ts`

- [ ] **Step 1: Add the threadsBox property and create it in the constructor**

In `lib/debugger/ui.ts`, add a new property alongside the other boxes:

```typescript
private threadsBox: blessed.Widgets.BoxElement;
```

In the constructor, after the `sourceBox` creation (after line 101), create the threads box (initially hidden):

```typescript
this.threadsBox = blessed.box({
  ...baseStyle,
  top: 0,
  left: "65%",
  width: "35%",
  height: "40%",
  label: " threads ",
  hidden: true,
  style: {
    border: { fg: "cyan" },
    label: { fg: "cyan" },
  },
});
```

Append it to the screen after `this.screen.append(this.sourceBox)`:

```typescript
this.screen.append(this.threadsBox);
```

- [ ] **Step 2: Add a `bold()` helper method**

Add this private method to `DebuggerUI` next to the existing `fmt()` and `highlight()` helpers:

```typescript
private bold(str: string): string {
  return `{bold}${str}{/bold}`;
}
```

- [ ] **Step 3: Add the `renderThreadsPane()` method**

Add this private method to `DebuggerUI`:

```typescript
private renderThreadsPane(): void {
  const threadData = this.state.getThreadMessages();
  if (!threadData) {
    this.threadsBox.hide();
    this.sourceBox.width = "100%";
    this.focusablePanes = this.focusablePanes.filter(
      (p) => p.name !== "threadsBox",
    );
    if (this.focusIndex >= this.focusablePanes.length) {
      this.focusIndex = 0;
    }
    return;
  }

  // Resize source and show threads
  this.sourceBox.width = "65%";
  this.threadsBox.show();

  // Add to focusable panes if not already there
  if (!this.focusablePanes.some((p) => p.name === "threadsBox")) {
    // Insert after sourceBox (index 1)
    this.focusablePanes.splice(1, 0, {
      box: this.threadsBox,
      name: "threadsBox",
      color: "cyan",
    });
  }

  // Set label with thread ID
  const label = threadData.threadId
    ? ` threads: ${threadData.threadId} `
    : " threads ";
  this.threadsBox.setLabel(label);

  // Format messages
  const content = threadData.messages
    .map((m) => {
      const truncated =
        m.content.length > 200 ? m.content.slice(0, 197) + "..." : m.content;
      return `  ${this.bold(`[${this.fmt(m.role)}]`)} ${this.fmt(truncated)}`;
    })
    .join("\n");

  this.threadsBox.setContent(content);
  this.threadsBox.setScrollPerc(100);
}
```

- [ ] **Step 4: Call `renderThreadsPane()` in the `render()` method**

In the `render()` method, add `this.renderThreadsPane()` after `this.renderSourcePane()` (after line 266):

```typescript
this.renderThreadsPane();
```

- [ ] **Step 5: Build and verify**

Run: `pnpm run build`
Expected: clean build with no errors

- [ ] **Step 6: Run all debugger tests**

Run: `pnpm test:run -- lib/debugger/`
Expected: all existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add lib/debugger/ui.ts
git commit -m "feat: add threads panel to debugger UI"
```
