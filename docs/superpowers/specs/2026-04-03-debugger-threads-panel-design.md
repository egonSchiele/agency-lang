# Debugger Threads Panel

## Summary

Add a panel to the debugger UI that displays message thread contents from the current checkpoint frame. The panel appears to the right of the source pane when threads exist, and is hidden otherwise.

## Behavior

- When the current frame's `threads` field is non-null and contains at least one thread, show the threads panel.
- When there are no threads, hide the panel and keep the source pane at 100% width.
- The panel updates on every `render()` call since different checkpoints may have different thread states.

## Layout

When threads are present:
- Source pane: top 40%, left 65%
- Threads pane: top 40%, right 35%

When no threads:
- Source pane: top 40%, 100% width (current behavior)

## Panel Content

- Label: ` threads: <activeThreadId> ` (or ` threads ` if no active thread)
- Content: messages from the active thread (top of `activeStack`), formatted as:
  ```
  [user] What is 2+2?
  [assistant] The answer is 4.
  [tool] calculator: {"result": 4}
  ```
- Long message content truncated to 200 chars per line
- Auto-scrolls to bottom (most recent messages)
- Added to focusable panes list so user can tab to it and scroll

## Implementation

### `lib/debugger/uiState.ts`

Add a method to expose the current frame's thread data:

```ts
getThreadMessages(): { threadId: string; messages: { role: string; content: string }[] } | null
```

This reads the checkpoint's current frame, checks if `threads` is non-null, finds the active thread (top of `activeStack`), and returns its messages. Returns `null` if no threads exist.

### `lib/debugger/ui.ts`

1. Create the threads box in the constructor (initially hidden), styled consistently with other panels.
2. Add `renderThreadsPane()` method that calls `state.getThreadMessages()`, formats each message as `[role] content` (truncated), and sets the panel content.
3. In `render()`, after setting the checkpoint, check if thread data exists:
   - If yes: resize source to `width: "65%"`, show threads panel at `left: "65%", width: "35%"`, render threads.
   - If no: restore source to `width: "100%"`, hide threads panel.
4. Add/remove from `focusablePanes` based on visibility.
