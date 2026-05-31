# `std::ui` Redesign + REPL Widget — Design

## Problem

The current `stdlib/ui.agency` is a thin imperative wrapper over a
hand-rolled ANSI-escape renderer in [`lib/stdlib/ui.ts`](../../packages/agency-lang/lib/stdlib/ui.ts).
It exposes a flat bag of `log`/`status`/`chat`/`code`/`diff`/`prompt`
calls, owns a fixed two-region layout, and offers no extensibility.

This is doubly unfortunate because the agency repo *already* has a
fully declarative, React/Ink-style TUI engine in
[`lib/tui/`](../../packages/agency-lang/lib/tui/):

- [`elements.ts`](../../packages/agency-lang/lib/tui/elements.ts) —
  `box` / `text` / `list` / `textInput` with flexbox-style layout
  (`flexDirection`, `flex`, `padding`, `border`, `justifyContent`,
  `width: "50%"`, `scrollable`, `visible`).
- [`builders.ts`](../../packages/agency-lang/lib/tui/builders.ts) —
  `box(style, ...children)`, `row(...)`, `column(...)`, `text(s)`,
  `line(s)`, `list(...)`, `textInput(...)`.
- [`screen.ts`](../../packages/agency-lang/lib/tui/screen.ts) — a
  `Screen` class with `render(tree)` and an Elm-style
  `runLoop({ initialState, render, handleKey, isDone })`.
- [`input/`](../../packages/agency-lang/lib/tui/input/) — raw
  `KeyEvent` source with arrow keys, modifiers, and a scripted
  variant for tests.

The debugger ([`lib/debugger/ui.ts`](../../packages/agency-lang/lib/debugger/ui.ts))
already consumes this layer in 663 lines of state-machine UI. It
works.

At the same time, the agency-agent is missing three table-stakes REPL
features other CLI agents have:

1. **A status line** showing per-turn response time + session cost +
   model + (optionally) current category.
2. **Input history** with up-arrow recall, persisted across sessions.
3. **A command palette** triggered by `/` that autocompletes built-in
   commands like `/exit`, `/help`, `/clear` against the current
   typed prefix.

All three need a richer input than `std::index.input()` provides, and
that input wants to live inside a declarative TUI it can take over the
screen with.

Goal: redesign `std::ui` as a clean two-layer Agency surface over the
existing `lib/tui/` engine, ship the three REPL features as a
high-level `repl()` widget on top, and rewrite the agency-agent's
REPL loop onto the new widget as the acceptance test.

## Non-goals

- A new TS-side TUI engine. `lib/tui/` is sound; this work only
  exposes it. Internal renderer changes are out of scope.
- Streaming LLM output to the scroll area. `route()` returns the full
  reply today and `repl()` consumes it whole. Streaming is a future
  follow-up tracked separately.
- A general "reactive bindings" model (Svelte-style observables).
  The Elm/Ink shape — pure `render(state) → tree`, pure
  `handleKey(state, ev) → state` — matches the existing TS engine
  and is enough for v1.
- Mouse support. The TUI engine doesn't decode mouse events today;
  this work doesn't add them.
- Web / browser rendering. `lib/tui/render/html.ts` exists but
  isn't wired through `std::ui`; deferred.

## What already exists

The agency-side `std::ui` ([`stdlib/ui.agency`](../../packages/agency-lang/stdlib/ui.agency))
exports 9 imperative functions: `initUI`, `destroyUI`, `log`, `status`,
`chat`, `code`, `diff`, `separator`, `startSpinner`, `stopSpinner`,
`prompt`, `getConfirmation`, `emptyLine`. None reach the declarative
engine. This module is deleted and rewritten in this work; it has no
significant external consumers (verified by repo grep).

The TS engine exports through [`lib/tui/index.ts`](../../packages/agency-lang/lib/tui/index.ts):
`Screen`, `box`, `row`, `column`, `text`, `line`, `lines`, `list`,
`textInput`, `render`, `TerminalInput`, `TerminalOutput`,
`ScriptedInput`, `KeyEvent`, `Element`, `Style`. We bridge to these
directly from the new Agency surface.

`std::policy.cliPolicyHandler` ([`stdlib/policy.agency`](../../packages/agency-lang/stdlib/policy.agency))
prompts the user via `print()` + `input()` directly to the raw
terminal. When a REPL owns the screen, those raw writes collide with
the fixed bottom regions. This spec resolves the collision via a
private probe (see "Policy handler integration" below).

## Decisions made during brainstorming

1. **Two layers in one module.** A declarative *core* exposing the
   `lib/tui/` engine 1:1 to Agency, plus an opinionated *widget*
   (`repl`) for the agent-REPL common case. Users pick the level that
   matches their need.
2. **Idiomatic Agency block syntax.** Container builders use the
   `column() as col { col.row(...) as r { ... } ... }` shape, with
   methods on the receiving Builder appending children to the
   enclosing parent. Leaf builders take named args and no block.
3. **Flat named-arg style props.** Style properties (`flex`,
   `padding`, `bg`, `fg`, `border`, etc.) are individual named
   parameters on each builder, not a nested `Style` record. Optional
   numeric props use Agency's `flex?: number` shorthand (which
   desugars to `flex: number | null = null`) so the runtime can
   distinguish "user passed `flex: 0`" from "didn't pass `flex`".
4. **Top-level `def`s for runLoop callbacks.** `runLoop`'s `render`
   / `handleKey` / `isDone` take function references (existing
   top-level `def`s), not inline blocks. Inline blocks aren't
   typed strongly enough for the closed-over state pattern that
   makes runLoop ergonomic.
5. **Clean break, no compat shim.** The old imperative `std::ui` is
   removed entirely. It has no significant external consumers and
   the new API is strictly more capable.
6. **Policy handler probes `std::ui`.** `cliPolicyHandler` gains a
   private check for an active REPL and routes its prompt + answer
   through the REPL's scroll output area when one is found. The
   public `cliPolicyHandler(opts)` signature does not change.
7. **Timer-based render loop.** `repl()` re-renders every ~100ms
   regardless of input so the status line ticks live while
   `route()` is mid-turn. Pure event-driven (option B) would freeze
   the status until the next keypress, which feels broken on long
   LLM calls.

## Architecture

```diagram
╭─────────────────────────────────────────────────────────────────────╮
│ Agency programs                                                     │
│                                                                     │
│   import { repl, ... } from "std::ui"                               │
│                                                                     │
│ ╭───────────────────────────────────────────────────────────────╮  │
│ │ Layer 2 — opinionated widgets (pure Agency)                   │  │
│ │   repl(prompt:, output:, status:, paletteCommands:, ...)      │  │
│ │   future: dashboard(), wizard(), selector(), ...              │  │
│ ╰───────────────────────────────────────────────────────────────╯  │
│ ╭───────────────────────────────────────────────────────────────╮  │
│ │ Layer 1 — declarative core (Agency wrappers over TS engine)   │  │
│ │   column / row / box / line / text / list / textInput         │  │
│ │   runLoop / renderOnce / readKey                              │  │
│ │   Element / Builder / KeyEvent / Style props                  │  │
│ ╰───────────────────────────────────────────────────────────────╯  │
╰──────────────────────────┬──────────────────────────────────────────╯
                           ▼
         ╭─────────────────────────────────────╮
         │ TS-side bridge (lib/stdlib/ui.ts)   │
         │   _runLoop, _renderOnce, _readKey   │
         ╰─────────────────────────────────────╯
                           ▼
         ╭─────────────────────────────────────╮
         │ lib/tui/ (existing, unchanged)      │
         │   Screen + Elements + InputSource   │
         ╰─────────────────────────────────────╯
```

## Layer 1 — declarative core

### Public types

```ts
// Opaque tree node. Users construct only via builders.
export type Element = {
  type: "box" | "text" | "list" | "textInput";
  // (internal fields elided from docs)
}

// Builder receiver passed to each container's block. Method calls
// append child Elements to the enclosing parent in source order.
export type Builder = {
  row: any;        // (Style args..., block) -> Element
  column: any;     // (Style args..., block) -> Element
  box: any;        // (Style args..., block) -> Element
  line: any;       // (content, Style args...) -> Element
  text: any;       // (content) -> Element
  list: any;       // (items, selectedIndex, Style args...) -> Element
  textInput: any;  // (value, Style args...) -> Element
}

export type KeyEvent = {
  // Either a named special key — "up" | "down" | "left" | "right" |
  // "enter" | "escape" | "backspace" | "tab" | "home" | "end" |
  // "pageup" | "pagedown" | "delete" | "insert" — or a single
  // printable character (e.g. "q", "/", " "). Mirrors the TS
  // engine's encoding in lib/tui/input/terminal.ts; there is no
  // separate `char` field.
  key: string;
  shift: boolean;
  ctrl: boolean;
}
```

### Top-level container openers

Each opens a fresh container and runs its trailing block with a
`Builder` for the new element's children.

```ts
export def column(
  flex?: number,
  width?: number,
  height?: number,
  padding?: number,
  border: boolean = false,
  borderColor: string = "",
  label: string = "",
  bg: string = "",
  fg: string = "",
  visible: boolean = true,
  block: (Builder) -> void
): Element
```

`row` and `box` have identical shape; `row` defaults
`flexDirection: "row"`, `column` defaults `"column"`, `box` leaves it
unset (children-position-only).

### Builder methods

`Builder` has the same set of methods. Container methods take a
trailing block; leaf methods don't.

```ts
// On a Builder named `parent`:
parent.row(bg: "blue", height: 1) as r { ... }         // container
parent.line("hello", fg: "gray")                       // leaf
parent.list(items: rows, selectedIndex: cursor, flex: 1)  // leaf
parent.textInput(value: buf, flex: 1)                  // leaf
```

Implementation: each Builder is constructed at the start of a
container block; its methods are PFAs of internal `_addRow` /
`_addLine` / etc. with the parent's children array pre-bound.

### Render primitives

```ts
// Single-shot render of an Element tree.
export def renderOnce(tree: Element)

// Elm-style state-machine loop. Renders the initial state, waits for
// each KeyEvent, runs handleKey to produce the next state, re-renders,
// and exits when isDone returns true. Returns the final state.
export def runLoop(
  initialState: any,
  render: (any) -> Element,
  handleKey: (any, KeyEvent) -> any,
  isDone: (any) -> boolean,
  tickMs?: number,   // periodic re-render (omit for pure event-driven)
): any

// Low-level: read one key. Blocks until a key is pressed.
export def readKey(): KeyEvent
```

The `tickMs` parameter is what powers Layer 2's status-line liveness:
`repl()` calls `runLoop` with `tickMs: 100`. Layer 1 users who want
pure event-driven rendering omit it.

### Style props

All flexbox / decoration / color props from
[`lib/tui/elements.ts`](../../packages/agency-lang/lib/tui/elements.ts)
are exposed as named args on every builder:

| Prop            | Type                | Meaning                                                |
|---              |---                  |---                                                     |
| `flex`          | `number?`           | flex grow factor                                       |
| `width`         | `number?`           | exact columns (percentage-string overload deferred — see Open questions) |
| `height`        | `number?`           | exact rows                                             |
| `minWidth`      | `number?`           |                                                        |
| `minHeight`     | `number?`           |                                                        |
| `maxWidth`      | `number?`           |                                                        |
| `maxHeight`     | `number?`           |                                                        |
| `padding`       | `number?`           | uniform padding (per-side variants deferred — see Open questions) |
| `border`        | `boolean`           | draw single-line border                                |
| `borderColor`   | `string`            | color name or hex (`""` = default)                     |
| `label`         | `string`            | text in top border                                     |
| `labelColor`    | `string`            |                                                        |
| `bg`            | `string`            | background color                                       |
| `fg`            | `string`            | foreground color                                       |
| `bold`          | `boolean`           |                                                        |
| `scrollable`    | `boolean`           | enable scroll viewport                                 |
| `scrollOffset`  | `number?`           | 0-indexed line offset                                  |
| `visible`       | `boolean`           | invisible elements take no layout space (default true) |

Percentage strings for `width`/`height` are deferred — the TS engine
supports them but Agency string-typed numeric props need typechecker
support we haven't planned for.

### Example: log viewer

```ts
import { runLoop, column, KeyEvent, Element, Builder } from "std::ui"
import { max, min } from "std::math"

type LogState = { logs: string[]; cursor: number; done: boolean }

def view(s: LogState): Element {
  return column() as col {
    col.row(bg: "blue", fg: "white", height: 1) as header {
      header.line("Log viewer  (q to quit)")
    }
    col.list(items: s.logs, selectedIndex: s.cursor, flex: 1, border: true)
    col.line("${s.cursor + 1} / ${s.logs.length}", fg: "gray", height: 1)
  }
}

def reduce(s: LogState, k: KeyEvent): LogState {
  if (k.key == "q")    { return { ...s, done: true } }
  if (k.key == "up")   { return { ...s, cursor: max(0, s.cursor - 1) } }
  if (k.key == "down") { return { ...s, cursor: min(s.logs.length - 1, s.cursor + 1) } }
  return s
}

def isDone(s: LogState): boolean { return s.done }

node main() {
  runLoop(
    initialState: { logs: readLog(), cursor: 0, done: false },
    render: view,
    handleKey: reduce,
    isDone: isDone,
  )
}
```

## Layer 2 — `repl()` widget

The high-level entry point for interactive CLI agents. Bundles status
line + scroll output + history + palette + input into one call. Built
entirely on Layer 1 in Agency — no TS-side primitive for `repl`
itself.

### Public signature

```ts
export def repl(
  prompt: string = "> ",
  output: () -> string[],                    // re-evaluated every render
  status: () -> { left: string, right: string },  // re-evaluated every render
  historyFile: string = "",                  // "" = in-memory only
  historyMax: number = 1000,
  paletteCommands: Record<string, string> = {},  // command -> description; iterated in insertion order
  onSubmit: (string) -> boolean,             // return false to exit
  tickMs: number = 100,                      // status refresh cadence
)
```

### Lifecycle

1. **Init.** Take over the screen via `Screen` (raw mode, alt buffer,
   cursor-hide). Assign the live `Screen` reference to the
   module-level `_activeScreen` let in `std::ui` so the policy
   handler can probe it (see "Policy handler integration" below).
2. **Hydrate history.** If `historyFile` is set, read + parse it.
   Missing / malformed = empty history (warn to scroll area).
3. **Render loop.** `runLoop` with `tickMs: 100`. State holds input
   buffer, cursor pos, history index, palette open/closed, palette
   filter, palette selection.
4. **Per-tick.** Re-call `output()` and `status()`; re-render.
5. **Per-key.** Update state, then re-render. Keys are described in
   the "Key bindings" section below.
6. **On submit.** Append input to history, persist if `historyFile`
   set, clear input, call `onSubmit(line)`. If it returns `false`,
   exit the loop.
7. **Teardown.** Restore terminal, reset `_activeScreen` back to
   `null`. Runs in a `finally`-style block so Ctrl-C and exceptions
   still restore the terminal.

### Rendered layout

```diagram
╭───────────────────────────────────────────────╮
│  scrolling output area  (← output())          │  flex: 1, scrollable
│  ...                                          │
│                                               │
├───────────────────────────────────────────────┤
│  /exit   — Exit the agent      (visible only  │  list, when paletteOpen
│  /help   — Show help            when palette  │
│  /clear  — Clear conversation   is triggered) │
├───────────────────────────────────────────────┤
│  agency-agent           $0.0234 · 1820ms      │  ← status(), height: 1
├───────────────────────────────────────────────┤
│  > hello world█                               │  ← textInput, height: 1
╰───────────────────────────────────────────────╯
```

When the palette is closed, the palette row is `visible: false` and
takes no layout space.

### Key bindings (default)

| Key           | When palette closed                | When palette open                           |
|---            |---                                 |---                                          |
| `up`          | Previous history entry             | Move palette cursor up                      |
| `down`        | Next history entry (or clear)      | Move palette cursor down                    |
| `enter`       | Submit input → `onSubmit`          | Replace input with selected command, close palette |
| `escape`      | (no-op)                            | Close palette, keep typed buffer            |
| `tab`         | (no-op)                            | Same as `enter` in palette                  |
| `/` (buffer empty)        | Open palette, filter = ""         | Appended to palette filter (re-rank)  |
| `backspace` (buffer non-empty)   | Delete last char from buffer | Delete last char from filter        |
| `backspace` (buffer empty)       | (no-op)                      | Close palette                       |
| printable char            | Append to buffer                  | Append to palette filter (re-rank)    |
| `ctrl+c`      | Exit loop. Does NOT call `onSubmit`. If a turn is in flight, the existing cancellation mechanism propagates and `onSubmit` returns with an `AgencyCancelledError`; the loop then exits in its `finally`. | Close palette (does not exit) |
| `ctrl+l`      | Clear scroll area                  | (no-op)                                     |

The palette filter is matched against command names with a simple
case-insensitive substring; future fuzzy match is a follow-up.

### Internal state

```ts
type ReplState = {
  buffer: string;
  cursorPos: number;
  history: string[];
  historyIdx: number;          // history.length = "new entry"
  paletteOpen: boolean;
  paletteFilter: string;       // text after `/`
  paletteCursor: number;       // index into filtered list
  done: boolean;
  statusCache: { left: string, right: string };  // refreshed per tick
  outputCache: string[];                          // refreshed per tick
}
```

### Example: agency-agent rewrite

```ts
import { repl } from "std::ui"
import { route, AgentSpec, RouterConfig } from "std::agent"
import { getCost } from "std::agency"
import { now } from "std::date"
import { env } from "std::system"

let outputLines: string[] = []
let lastTurnMs: number = 0

def runTurn(msg: string): boolean {
  if (msg == "/exit") { return false }
  outputLines.push("you: ${msg}")
  const start = now()
  const reply = route(start: "code", agents: { ... }, maxHops: 3, userMsg: msg)
  lastTurnMs = now() - start
  outputLines.push("agent: ${reply}")
  return true
}

def buildStatus(): { left: string, right: string } {
  return { left: "agency-agent", right: "$${getCost()} · ${lastTurnMs}ms" }
}

def listOutput(): string[] { return outputLines }

node main() {
  repl(
    prompt: "> ",
    output: listOutput,
    status: buildStatus,
    historyFile: "${env("HOME")}/.agency-agent/history",
    historyMax: 1000,
    paletteCommands: {
      "/exit":  "Exit the agent",
      "/help":  "Show help",
      "/clear": "Clear the conversation",
    },
    onSubmit: runTurn,
  )
}
```

This replaces ~80 lines of the agency-agent's REPL plumbing.

## Policy handler integration

When `cliPolicyHandler` runs inside an active `repl()`, its
"prompt the user with (a)/(r)/(aa)/(ap)/(rr)" UX has to land in
the REPL's scroll area + temporarily take over the input row,
not raw-write over the screen.

Mechanism (private; not part of public API):

1. `std::ui` holds a module-level `let _activeScreen: ScreenRef | null
   = null` (Agency side). `repl()` assigns it to its live `Screen` on
   init and resets it to `null` on teardown. The probe is a plain
   value comparison (`if (_activeScreen != null)`) — no accessor
   function.
2. `std::ui` exposes one private function
   `_routePrompt(text: string, choices: string[]) -> string` for
   other stdlib modules to use. It reads `_activeScreen` directly;
   if `null`, falls back to raw `print()` + `input()`. If non-null,
   it writes `text` to the active REPL's scroll buffer and
   temporarily replaces the input row's textInput with a constrained
   one (only accepts entries from `choices`).
3. `cliPolicyHandler`'s `askUser` (currently in
   [`stdlib/policy.agency`](../../packages/agency-lang/stdlib/policy.agency))
   switches from `print(...)` + `input("> ")` to
   `_routePrompt(menuText, validAnswers)`. Behavior outside a
   `repl()` is unchanged.

`_activeScreen` lives on the Agency side (not the TS bridge) because
its only readers and writers are Agency-side stdlib code, and Agency
module-level `let`s already give us the per-program singleton scoping
we need via the GlobalStore.

Cost: one cross-module dependency (`std::policy` → `std::ui`'s
private `_routePrompt`) and one shared private flag. Benefit: zero
changes to user code; `cliPolicyHandler(...)` works identically
inside and outside a REPL.

Reversibility: removing the probe restores the current
print-to-raw-stdout behavior. No public API surface added.

## Re-render cadence

`runLoop` with `tickMs: 100` re-renders 10× per second whenever there
isn't a fresher trigger (keypress). `output()` and `status()` are
re-evaluated on every render, so:

- The cost ticker in the status line updates roughly every 100ms
  while `route()` is mid-turn.
- Tool-call callbacks (`onToolCallStart` / `onToolCallEnd` in the
  agency-agent) can push lines into `outputLines` and the next tick
  picks them up automatically — no explicit `refresh()` call needed.

Render cost: each tick runs the layout engine on the current tree
plus a diff against the previous frame
([`lib/tui/render/`](../../packages/agency-lang/lib/tui/render/)).
Modern terminals at 80×24 cost well under 1ms per render. CPU at
idle is ~0.1%. Acceptable.

Pure event-driven mode is still available via `runLoop` with `tickMs`
omitted (Layer 1 users who want it).

## Migration / clean break

`stdlib/ui.agency` and `lib/stdlib/ui.ts` are deleted and rewritten.
No compatibility shims for `initUI` / `log` / `chat` / `code` / `diff`
/ etc. Justification:

- Repo grep shows no significant consumers outside the module's own
  tests.
- The new API is strictly more capable — anything `log("foo")` did,
  `outputLines.push("foo")` (or a direct call to a Layer 1 builder)
  does.
- A compat shim would re-implement the same imperative ANSI logic on
  top of the new declarative core, doubling the surface for an
  unused path.

The CHANGELOG entry under "Breaking changes" lists every removed
function and the suggested replacement.

## Error handling

| Failure                                | Behavior                                                |
|---                                     |---                                                      |
| Terminal not a TTY                     | `repl()` writes a plaintext fallback (line-buffered) and the palette / history features no-op. Logged once on init. |
| `historyFile` parent dir missing       | Warning to scroll area; in-memory history only.         |
| `historyFile` parse error              | Warning, treat as empty history.                        |
| `output()` throws                      | Caught; show "(output error: <msg>)" in scroll area. Render continues. |
| `status()` throws                      | Caught; status reverts to last successful values. Logged once. |
| `onSubmit` throws                      | Caught; print "(turn failed: <msg>)" to scroll area. Loop continues. |
| Ctrl-C during `route()`                | Existing cancellation propagates; `finally` block restores terminal. |
| Terminal resize                        | Screen instance receives `SIGWINCH`, re-queries size, next render uses new dimensions. The TS engine already handles this. |
| Window too small (< 10 cols / 5 rows)  | Render best-effort; document the minimum.               |

## Testing

The TS engine has a `ScriptedInput`
([`lib/tui/input/scripted.ts`](../../packages/agency-lang/lib/tui/input/scripted.ts))
and a `FrameRecorder`
([`lib/tui/output/recorder.ts`](../../packages/agency-lang/lib/tui/output/recorder.ts))
that together let us drive the loop with canned keys and capture
frames as plain text. Reuse for all `std::ui` tests.

| Test                                       | Layer | Verifies                                            |
|---                                         |---    |---                                                  |
| `tests/agency/ui-builders-leaf`            | 1     | `line` / `text` / `list` / `textInput` produce expected Element shapes |
| `tests/agency/ui-builders-container`       | 1     | `column` / `row` / `box` with block populate children in order |
| `tests/agency/ui-builders-style-props`     | 1     | Named style args propagate to the resulting Element |
| `tests/agency/ui-runloop-basic`            | 1     | Scripted up/down/enter sequence drives state transitions and final state matches expected |
| `tests/agency/ui-runloop-tick`             | 1     | `tickMs: 50` re-renders ≥ 2× over 150ms without keys |
| `tests/agency/ui-repl-history`             | 2     | Up/down recall, persist+reload across `repl()` sessions |
| `tests/agency/ui-repl-palette-open`        | 2     | `/` opens palette, typing filters, Enter inserts command, Esc closes |
| `tests/agency/ui-repl-status-tick`         | 2     | Status fn re-evaluated each tick |
| `tests/agency/ui-repl-onsubmit-false-exits`| 2     | `onSubmit` returning `false` cleanly exits the loop |
| `tests/agency-js/ui-policy-integration`    | 2     | `cliPolicyHandler` prompts through `_routePrompt` when REPL active, through stdio when not |
| `tests/agency-js/agency-agent-smoke`       | E2E   | Scripted REPL session: type message, route runs, status updates, exit cleanly |

Manual smoke test in the agency-agent plan covers terminal-resize,
real LLM-driven cost updates, and visual fidelity of the rendered UI.

## Migration plan

The agency-agent rewrite is the acceptance test for the new module.

1. Implement Layer 1 (Agency + TS bridge) + unit tests.
2. Implement Layer 2 (`repl()` in Agency on top of Layer 1) + unit
   tests.
3. Wire `_routePrompt` and update `cliPolicyHandler` to probe; cover
   with `ui-policy-integration`.
4. Rewrite `lib/agents/agency-agent/agent.agency` onto `repl()`,
   delete the old REPL loop, add `/exit` / `/help` / `/clear`
   commands.
5. Delete old `stdlib/ui.agency` + `lib/stdlib/ui.ts`. Run full
   `pnpm test:run`.
6. Manual smoke test the agent.

Per-step verification gates and rollback notes live in the
implementation plan (`docs/superpowers/plans/2026-05-30-stdlib-ui-redesign.md`,
to be written next).

## Open questions / deferred items

| Item                                | Disposition                                       |
|---                                  |---                                                |
| String percentage props (`"50%"`)   | Deferred; needs typechecker work for mixed-type params. |
| Per-side padding/margin             | Deferred; cur. uniform only. Add as `paddingTop` / `paddingLeft` / etc. when needed. |
| Mouse events                        | Deferred. `KeyEvent` is the only input v1.        |
| LLM-streaming into scroll area      | Deferred; needs `route()` to return an iterator.  |
| Web/browser rendering               | Deferred; `lib/tui/render/html.ts` exists but isn't wired. |
| Fuzzy palette search                | Deferred; substring match for v1.                 |
| Multi-line input (Shift+Enter)      | Deferred; single line for v1.                     |
| Persistent scroll position          | Deferred; always pinned to bottom in v1.          |
| In-REPL `/help` content             | Static string baked into `repl()`; full help screen is a follow-up. |
| `repl()` callable from a thread     | Single-instance only in v1 (uses a module-level `_activeScreen`). Multi-instance is a future redesign of the policy probe mechanism. |
