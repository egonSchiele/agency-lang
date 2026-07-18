# Sticky interrupt prompt for the line-mode agent

**Status:** design, awaiting review
**Date:** 2026-07-17
**Author:** Aditya Bhargava (with Claude)

---

## What this is about, in one sentence

When the Agency agent stops to ask you to approve an action, and other
work is still running in the background and printing as it goes, the
approval question should stay pinned to the bottom of the terminal while
the background output scrolls past above it, instead of the question
getting buried under that output.

The rest of this document explains the pieces you need to understand the
problem, walks through exactly why the question gets buried today, and
then lays out the design that fixes it.

---

## Background: the things you need to know first

This section assumes no prior knowledge of how the agent draws to the
screen. If you already know how line mode, interrupts, and the
concurrency model work, you can skip to "The problem" below. But the fix
touches all three, so it is worth being precise.

### The Agency agent and "the agent"

The Agency agent is a terminal program that helps you write and run
Agency code. Its source lives in `lib/agents/agency-agent/`, written in
Agency itself. It runs as a chat loop: you type a message, the agent
works on it (often calling tools like `read`, `write`, `bash`, or one of
its specialist sub-agents), and it prints a reply. Throughout this
document, "the agent" means this program.

### Line mode versus the TUI

The agent can draw its interface two different ways.

The first way is a full-screen interface built on an internal rendering
engine, similar in spirit to a curses program. It takes over the whole
terminal ("the alt-screen"), keeps a status bar pinned, and repaints the
visible screen on every frame. In this document that is "the TUI" (text
user interface). Its code is `std::ui` (`stdlib/ui.agency`, backed by
`lib/stdlib/ui.ts`).

The agent started on the TUI but then switched to a simpler second way,
called "line mode." Line mode does not take over the screen. It prints
plain lines to the terminal the same way any ordinary command-line
program does, and it reads input with Node's built-in `readline`
library. The trade-off is deliberate: line mode gives up the pinned
status bar and the live repaint, and in exchange every message becomes a
real line in the terminal's scrollback, so you get native scrolling,
text search, copy-paste, and clickable links for free. The code is
`std::ui/cli` (`stdlib/ui/cli.agency`, backed by `lib/stdlib/cli.ts`).
`lib/stdlib/cli.ts` is the single most important file for this project.

**The agent runs in line mode.** The TUI path still exists in the
codebase, unused by the agent, kept in case we want it back. This
project changes line mode only. It does not touch the TUI.

The switch is a one-line import change in `agent.agency` (see the comment
block around `agent.agency:132`), because both modules expose the same
three functions: `repl` (run the chat loop), `pushMessage` (print a line
into the transcript), and `clearMessages` (wipe the transcript).

### How line mode actually prints a line

This is the crux, so it is worth tracing end to end with real code.

Everything the agent prints mid-turn goes through `pushMessage`. For
example, when the agent starts a tool call, this callback fires
(`agent.agency:203`):

```
callback("onToolCallStart") as data {
  if (_showTraces()) {
    pushMessage(color.yellow("⏺ ${data.toolName}(${formatArgs(data.args)})"))
  }
}
```

`pushMessage` is defined in `stdlib/ui.agency:869`. Its first line is the
one that matters:

```
export def pushMessage(message: string) {
  if (_activeRepl == null) {
    print(message)
    return
  }
  ... // TUI path: append to transcript, trigger a repaint
}
```

`_activeRepl` is the currently-running TUI screen. In line mode there is
no TUI screen, so `_activeRepl` is `null`, and `pushMessage` falls
straight through to `print(message)`. `print` is the Agency built-in
that maps to `_print` in `lib/stdlib/builtins.ts:19`, which is just:

```
export function _print(...messages: any[]): void {
  console.log(...messages);
}
```

And `console.log` writes to `process.stdout`. So the whole path is:

```
onToolCallStart → pushMessage → print → console.log → process.stdout.write
```

The takeaway: **in line mode, every trace line is written directly to
stdout, one line at a time, wherever the cursor happens to be at that
moment.** Nothing coordinates these writes with anything else on screen.

### The "Thinking" spinner, and the one trick this whole design builds on

While the agent is working on your turn, line mode shows a one-line
spinner at the bottom: `⣾ Thinking 3s`. It lives in `startSpinner`
(`lib/stdlib/cli.ts:330`).

The spinner has already solved a small version of our exact problem.
A spinner sitting at the bottom of the screen would get overwritten the
instant a trace line prints. To prevent that, `startSpinner` replaces
`process.stdout.write` with a wrapped version. The wrapper, on every
outside write, first emits a "clear this line" escape code, then lets the
real write through:

```
stdoutAny.write = function patchedWrite(this, chunk, ...rest) {
  realWrite(CLEAR_LINE);          // erase the spinner row
  return realWrite(chunk, ...rest); // then print the trace line
};
```

The spinner's own timer then redraws itself on the next tick. The net
effect: the spinner and the streaming trace lines coexist without
fighting. **This "wrap `process.stdout.write` so outside writes make room
for pinned content" is the seed of the entire design below.** We are
going to generalize it from one pinned line to a multi-line pinned
prompt.

The spinner is turned off whenever the agent needs to ask you something,
through a global hook named `__agencyStopSpinner` that the REPL installs
(`lib/stdlib/cli.ts:843`). "Thinking" is the wrong thing to show while
you are being asked a question.

### Interrupts and policies

An "interrupt" is Agency's mechanism for pausing execution to get a
human decision. When the agent tries to take an action that needs
approval (running a shell command, writing a file), the action raises an
interrupt instead of just happening.

A "policy" is a saved set of rules that answers interrupts automatically
so you are not asked every single time. For example, a policy might say
"reads are always fine, but shell commands always ask." Policies are
stored in `~/.agency-agent/policy.json`. The reference docs are
`https://agency-lang.com/guide/interrupts.html` and
`https://agency-lang.com/guide/policies.html`.

The agent installs one policy handler at startup, `cliPolicyHandler`
from `std::policy` (`stdlib/policy.agency`). When an interrupt reaches
it, the handler checks the saved policy. If a rule matches, it approves
or rejects silently. If nothing matches, it asks you. The asking happens
in `askUser` (`stdlib/policy.agency:667`), which builds a little menu of
choices (approve once, reject once, approve always, and so on) and calls
`chooseOption` to display it:

```
const answer = withLock("std::tty") {
  return chooseOption(title, body, items, allowFreeText: true, allowCancel: true)
}
```

Two details here are load-bearing for this design:

- **`withLock("std::tty")`.** This is a mutual-exclusion lock. Only one
  piece of code holding the `"std::tty"` lock runs at a time. Because
  every interrupt prompt is wrapped in it, **at most one approval
  question is ever on screen at once.** Two branches that both hit an
  interrupt take turns; they do not both prompt simultaneously. This is
  important: our problem is never "two prompts fighting each other." It
  is always "one prompt fighting with background output."

- **`chooseOption`.** This is the generic menu function
  (`stdlib/ui.agency:1032`). It has three internal paths. If the TUI is
  active it draws an in-screen modal. If stdout is not a terminal (piped
  output, tests) it runs a plain input loop. And in the case that
  matters for us, an interactive line-mode terminal, it calls the
  `autocomplete` primitive, which is backed by the third-party npm
  package `prompts` (`lib/stdlib/ui.ts:840`, `_promptsAutocomplete`).

### What the `prompts` package does, and why it is fragile here

The `prompts` package draws an interactive menu at the current cursor
position: a question, a list of choices, a highlighted row. As you press
arrow keys or type to filter, it repaints the menu **in place** by moving
the cursor up by the number of rows it last drew, clearing them, and
drawing again.

That in-place repaint is the fragile part. `prompts` assumes it is the
only thing writing to the bottom of the screen. It has no idea that
anything else might print. There is no public hook to tell it "content
appeared above you, recalculate." If some other code writes a line into
the region `prompts` is managing, `prompts`'s next repaint does its
cursor arithmetic from the wrong starting point and the menu smears.

### The concurrency model, briefly

Agency can run work in parallel. A `fork` runs a block once per item, in
parallel; each parallel copy is called a "branch." A single `llm(...)`
call that asks for several tools at once also runs those tool calls as
parallel branches. Branches run as ordinary asynchronous work on one
JavaScript event loop. They are not OS threads. That single-threaded
detail matters later: two branches never write to stdout at literally the
same instant. They interleave, one whole write at a time.

The full details are in `docs/dev/concurrent-interrupts.md`. For this
design you only need three facts:

1. Several branches can run at once.
2. When one branch hits an interrupt and the policy handler stops to ask
   you, that branch is blocked waiting for your answer, but the other
   branches keep running.
3. A running branch that makes tool calls keeps firing the
   `onToolCallStart` / `onToolCallEnd` callbacks, which keep calling
   `pushMessage`, which in line mode keeps printing straight to stdout.

---

## The problem

Put the pieces together.

The agent is working on your turn. Two branches are running in parallel.
Branch A wants to run `rm -rf build/`. That needs approval, so it raises
an interrupt, the policy handler catches it, and `askUser` opens the
`prompts` menu at the bottom of the terminal. The "Thinking" spinner is
stopped. Branch A is now blocked, waiting for you.

But branch B is still running. It calls `grep`, then `read`, then
another `read`. Each one fires `onToolCallStart`, which calls
`pushMessage`, which in line mode calls `console.log`, which writes a
trace line straight to stdout, right into the middle of the region the
`prompts` menu is trying to manage.

`prompts` never learns those lines appeared. On your next keypress it
repaints from the wrong origin. The menu tears, scrolls up, or gets
shoved off screen under branch B's chatter. The question you are
supposed to answer is now buried, and it is not obvious that anything is
even waiting on you.

Here is roughly what you see, with `▮` marking where the menu is trying
to live:

```
⏺ grep("build")
  ⎿ 2 matches
? bash: rm -rf build/ › approve once     ▮  ← the menu draws here
⏺ read("Makefile")                          ← branch B prints over it
  ⎿ 40 lines
⏺ read("build.ts")                          ← and again
? bash: rm -rf build/ › approve once     ▮  ← half-redrawn, wrong place
  ⎿ ...
```

The desired behavior instead:

```
⏺ grep("build")             ← background output scrolls up here,
  ⎿ 2 matches                 as normal scrollback, above the line
⏺ read("Makefile")
  ⎿ 40 lines
⏺ read("build.ts")
──────────────────────────────────────────
 bash: rm -rf build/  — approve?      ← and the prompt stays pinned at
 a=approve once   r=reject once         the very bottom, always visible,
 aa=always  ap=always here  rr=never    always clearly the thing waiting
 or type a reason · Enter to submit     on you
 > _
```

---

## Goals and non-goals

### Goals

- When an approval prompt is open in line mode and other branches are
  still producing output, keep the prompt pinned to the bottom of the
  terminal.
- Let the background trace lines stream into normal scrollback above the
  prompt, live, as they are produced.
- Do this without visible flicker under realistic output rates.
- Keep the change surgical: only the approval prompt changes. Every other
  prompt in the agent keeps working exactly as it does today.

### Non-goals

- The TUI path. It already composes the prompt and the transcript in one
  render loop, so it has no interleaving problem. Untouched.
- Non-terminal output (piped, tests, headless one-shot runs with no
  terminal). These already fall back to a plain input loop. Untouched.
- The other interactive prompts: `/paste`, the slash-command palette,
  and the `/model`, `/models`, `/search`, `/settings`, `/local`
  commands. All of these run while the agent is idle and waiting for you
  to type, so nothing is streaming underneath them. They keep using the
  `prompts` package. Untouched. (`/model` in particular shows a long,
  filterable list of models, which the press-a-key prompt below is not
  suited for. That is a second, independent reason to leave it alone.)
- Buffering background output until you answer. We considered printing
  the background traces only after you respond, which would be much
  simpler. We chose live streaming instead, because seeing the work
  continue is the point.

---

## Decisions already made (and why)

Two product decisions were settled during design. They are recorded here
so the plan does not reopen them.

### Decision 1: stream background output live, above the prompt

The alternative was to hold background trace lines while the prompt is
open and flush them all after you answer. Buffering is simpler because
nothing on screen moves while you decide. We rejected it. The whole
reason to keep the prompt visible is so you can watch the rest of the
work proceed while you decide, so the output has to be live.

### Decision 2: the pinned prompt is a "type your answer, then Enter" line, not a navigable menu

The current line-mode prompt is the `prompts` package's autocomplete
widget: arrow keys move a highlight, typing filters the list, Enter
selects, and free text becomes a rejection reason. That widget owns its
own in-place repaint, which is exactly what fights our
redraw-after-every-write approach. Coordinating with it would mean
reaching into its private internals to force a repaint, which is brittle
across versions of the package. So we render the prompt ourselves and own
the input loop.

We do **not** resolve on a single bare keypress. An earlier version of
this decision did, and it was wrong. The option keys are `a`, `r`, `aa`,
`ap`, `rr` (`stdlib/policy.agency:681-706`), and `a` is a prefix of
`aa`/`ap` while `r` is a prefix of `rr`. A bare `a` cannot tell "approve
once" from the first key of "approve always," so instant resolution makes
`aa`, `ap`, and `rr` unreachable. Worse, a free-text rejection reason
often starts with `a` or `r` ("actually, do X instead"), so if the first
keystroke resolved an option, such a reason could never be typed. Free
text reasons are an existing, valued feature, so dropping them to keep a
"no Enter" model is not acceptable.

So the pinned prompt is a one-line input you type into, then press Enter.
On Enter, the typed text is interpreted exactly the way `chooseOption`'s
existing non-terminal branch already interprets it
(`stdlib/ui.agency:1078-1087`): if it matches an option key, that option
fires; otherwise, if free text is allowed and the text is non-empty, it
becomes a rejection reason; an empty line re-prompts (the must-answer
contract). Reusing that contract, rather than inventing a new one, means
the safety-critical "the user can never skip the prompt" guarantee is the
same one already in the code.

The cost versus a bare keypress is one Enter. For a safety-approval
prompt that is arguably a feature, because it removes any accidental
instant-approve on a stray key. The change in feel versus today is that
there is no live-filtered list and no arrow-key navigation: the options
are shown statically, and you type the key (or a reason) and press Enter.

---

## The design

Three components. Named pieces below use invented names; each is labeled
where it first appears.

### Component 1: the bottom-region coordinator (invented name)

**What it does.** It owns a block of text pinned to the bottom of the
terminal (call it "the footer"), and it makes sure any other write to
stdout lands *above* the footer, in scrollback, with the footer redrawn
underneath afterward. It generalizes the spinner's one-line trick to any
number of lines.

**Where it lives.** `lib/stdlib/cli.ts` (the line-mode module).

**How you use it.** A small interface, invented name `installBottomRegion`:

```
const region = installBottomRegion(() => footerLines);  // footerLines: string[]
region.refresh();   // the footer content changed; repaint it
region.teardown();  // remove the footer; unpatch stdout
```

`installBottomRegion` takes a render function that returns the current
footer as an array of lines. On install, it draws the footer and replaces
`process.stdout.write` with a wrapper. The wrapper, on every outside
write, produces a single atomic frame (see "Anti-flicker" below) that:
erases the footer, lets the outside text through so the terminal scrolls
it up into scrollback, then redraws the footer at the new bottom.
`teardown` erases the footer and restores the original
`process.stdout.write`.

**What it depends on.** Only `process.stdout` and the terminal width
(`process.stdout.columns`). It does not know what the footer contains. It
does not know about prompts, policies, or interrupts. That ignorance is
the point: it is a generic "keep this text at the bottom" utility.

**Relationship to the spinner (a correctness argument, not just tidiness).**
The spinner is the same idea with a one-line footer and a timer. Both
`startSpinner` and `installBottomRegion` monkeypatch the *same*
`process.stdout.write`. If they stay as two independent patchers,
correctness depends on a load-bearing ordering: the spinner must be
stopped *before* the region installs and torn down *after* it. That is
because `startSpinner`'s teardown does `stdoutAny.write = realWrite`,
restoring the real write it captured at spinner start (`cli.ts` teardown
closure). If the region patched first and the spinner tore down second,
that teardown would clobber the region's patch with the stale write, and
the prompt would stop making room for background output. The flow does
honor that ordering, but leaving two patchers in place means every future
edit has to preserve it. Folding the spinner into this one coordinator
makes "exactly one owner of the bottom region" a structural guarantee
instead of an ordering discipline. That is why we fold it in. Only one
region is ever active at a time, which the `"std::tty"` lock (one prompt
at a time) plus the spinner-stops-before-prompt rule already ensure. It
is called out as its own step in the plan so it can be reviewed on its
own.

### Component 2: the sticky interrupt prompt (invented name for the widget)

**What it does.** It renders the approval question as the footer, reads a
typed line terminated by Enter, and returns the user's choice. It is the
"type your answer, then Enter" widget from Decision 2.

**Where it lives.** `lib/stdlib/cli.ts`.

**What it renders.** The footer is: a divider rule, the interrupt title
(for example `bash: rm -rf build/  — approve?`), a short body showing the
action's details, the option rows shown as `key=label`, a hint line, and
a one-line input showing what you have typed so far. With sample data:

```
──────────────────────────────────────────
 bash: rm -rf build/  — approve?
 a=approve once   r=reject once
 aa=always  ap=always here  rr=never
 or type a reason · Enter to submit
 > aa_
```

**How it reads input.** By intercepting `readline`'s internal
`_ttyWrite`, the exact technique three existing features already use:
the slash-command trigger (`installSlashTrigger`, `cli.ts:496`), the
Escape-to-cancel key (`installCancelKey`, `cli.ts:548`), and the
`/paste` multi-line editor (`readMultiline`, `cli.ts:1153`). A keypress
maps to an action through a small pure classifier in the spirit of the
existing `classifyPasteKey` (`cli.ts:1134`):

- A printable character appends to the input buffer and refreshes the
  input line (via `region.refresh()`).
- Backspace deletes the last character of the buffer.
- Enter commits the buffer, resolved the way `chooseOption`'s
  non-terminal branch resolves it: an exact option-key match returns that
  key; otherwise a non-empty buffer returns as a free-text rejection
  reason; an **empty buffer is a no-op that re-prompts**, preserving the
  must-answer contract (Finding 2).
- Escape cancels the whole request (details under Edge cases).
- Ctrl+C exits the process with code 130 (details under Edge cases).

**Raw-mode precondition.** The widget installs mid-turn, and `_ttyWrite`
interception only receives keystrokes while stdin is in raw mode. Like
`readMultiline` (`cli.ts:1177`, with its long comment on why), the widget
asserts raw mode on install and restores the prior mode on teardown. This
is implementation-critical: without it, keystrokes bypass the widget's
`_ttyWrite` and the pinned prompt responds to nothing (Finding 5).

**What it returns.** The chosen key (`"a"`, `"r"`, `"aa"`, `"ap"`,
`"rr"`) or the typed reason string. This is exactly what `chooseOption`
returns today, so the code in `askUser` that interprets the answer does
not change:

```
return match(answer) {
  "a"  => ({ action: "approve", reason: null })
  "r"  => ({ action: "reject",  reason: null })
  ...
  _    => ({ action: "reject",  reason: answer })  // free-text reason
}
```

**What it depends on.** Component 1 (it renders itself as that footer),
the running `readline` interface (which it reuses rather than spawning a
second one, see "A robustness win" below), raw-mode assertion on stdin,
and the spinner-stop hook (`__agencyStopSpinner`) so "Thinking"
disappears the moment it opens.

### Component 3: the integration seam (how the policy prompt reaches the widget)

The tricky part is routing *only* the approval prompt to the new widget,
while every other caller of `chooseOption` keeps its current behavior.

**Why not just change `chooseOption`.** `chooseOption` is generic and has
many callers. `/model` and friends call it while idle, and `/model` needs
the scrollable, filterable list that the press-a-key widget cannot
provide. So we must not globally swap `chooseOption` to the sticky widget.

**The seam.** Introduce one new Agency primitive in `std::ui/cli`,
invented name `interruptChoice`, with the same signature as
`chooseOption`. It is backed by a TS bridge, invented name
`_interruptChoice`. The bridge asks one question: is a line-mode REPL
currently running and able to host a pinned footer? If yes, it uses the
sticky widget. If no, it delegates to the ordinary `chooseOption`, so the
TUI modal, the non-terminal input loop, and the plain `prompts` path all
still work untouched (headless one-shot runs, tests, and so on).

**How the bridge detects a running REPL.** The line-mode REPL
(`_runLineRepl`) already installs several process-global hooks while it
runs and removes them on exit: `__agencyStopSpinner`,
`__agencyClearHistory`, and an input override on the runtime context. We
add one more in the same install-and-restore block: a hook, invented name
`__agencyInterruptPrompt`, that points at the sticky widget wired to this
REPL's `readline` interface and coordinator. `_interruptChoice` checks
for that hook. Present means a REPL is live; absent means fall back.

**The one stdlib change.** `askUser` in `stdlib/policy.agency` calls
`interruptChoice` instead of `chooseOption`. The surrounding
`withLock("std::tty")` stays. That single call-site change is the entire
behavioral switch. Everything else in `policy.agency` is unchanged.

**The two gates never overlap.** `chooseOption`'s first path fires on
`_activeRepl != null` (the TUI is active). `_interruptChoice`'s sticky
path fires on `__agencyInterruptPrompt` being set (a line-mode REPL is
active). These are different globals, but only `_runLineRepl` ever
installs `__agencyInterruptPrompt`, and it never runs alongside a TUI, so
the two are mutually exclusive. The "delegate back to `chooseOption`"
fallback therefore cannot double-handle a case the sticky path already
owns (Finding 6).

Note the scope of the benefit: because the fix lives in `std::policy` and
`std::ui/cli`, not in the agent, any line-mode command-line agent built
on `cliPolicyHandler` gets the pinned prompt, not just this one agent.
That is the right altitude for the change.

### How it all flows together

The concurrent scenario, end to end:

```
turn running; spinner is a 1-line bottom region
 ├─ branch A: tool trips policy
 │     → handler → askUser → withLock("std::tty") → interruptChoice
 │       → _interruptChoice sees __agencyInterruptPrompt is set
 │         → stop the spinner
 │         → installBottomRegion(render = the approval footer)
 │         → wait for a keypress
 └─ branch B: still running
       → onToolCallStart → pushMessage → print → console.log
         → the patched process.stdout.write:
             erase footer · write the trace line (scrolls up) · redraw footer
 you press [a]
   → widget resolves "a" → region.teardown() → interruptChoice returns "a"
   → askUser returns approve() → branch A continues
```

Because JavaScript is single-threaded, each patched write is one complete
frame. Branch B's writes and branch A's footer never interleave
mid-frame, so no extra locking is needed beyond the `"std::tty"` lock
that already serializes the prompt itself.

### A robustness win: no second readline

Worth stating, because it makes Decision 2 look less like a feel
trade-off and more like the sturdier design. The `prompts` package
creates its *own* second `readline` on the shared `process.stdin` and
calls `rl.close()` when it resolves, which pauses shared stdin and drops
the terminal out of raw mode. That is exactly why `_runPrompt` has to
snapshot and restore `wasPaused` and `wasRaw` (`lib/stdlib/ui.ts`), or it
would silently kill the outer REPL. The sticky widget reuses the
*existing* readline through `_ttyWrite` interception and never spawns a
second one, so none of that snapshot-and-restore dance is needed. Owning
the widget removes a whole hazard class rather than just avoiding a fight
with `prompts`'s repaint.

---

## Anti-flicker requirements

Flicker is the main risk in any "pin content to the bottom" scheme, so
these are hard requirements, not nice-to-haves. The reasoning: a naive
implementation that erases the footer in one write and redraws it in a
separate write leaves a window where the footer is blank, which the eye
catches as a flash. The rules below close that window.

1. **One atomic frame per repaint.** Build the entire sequence, move the
   cursor to the footer's top row, clear from there to the end of the
   screen, emit the outside text (the terminal scrolls it up naturally),
   then reprint the footer, as a single string, and hand it to one
   `process.stdout.write` call. Terminals composite a single write
   without showing the half-erased middle state.

2. **Hide the cursor while a region is live.** Emit the "hide cursor"
   escape (`\x1b[?25l`) when a region installs and "show cursor"
   (`\x1b[?25h`) on teardown, so the cursor does not strobe between the
   reason line and the top of the next redraw.

3. **Wrap each frame in synchronized-output mode.** Bracket each frame
   with the DEC synchronized-update escapes (`\x1b[?2026h` before,
   `\x1b[?2026l` after). Terminals that support it (iTerm2, kitty,
   WezTerm, recent Windows Terminal) hold the frame until it is complete,
   eliminating any tearing. Terminals that do not support it ignore the
   escape harmlessly, and rule 1 still protects them.

4. **Redraw on events, never on a timer.** The footer repaints only when
   an outside write occurs or when the user types into the reason line.
   An open prompt with nothing streaming under it repaints zero times.
   (The spinner keeps its own timer for its animation frames; that is the
   spinner's business, not the coordinator's.)

### Refinement: coalesce bursts (include in the spec, implement if needed)

One residual risk, named honestly: if several trace lines land in the
same event-loop tick, they trigger several back-to-back full-footer
repaints. Rule 1 means none of them blank-flashes, but the footer text
could visibly "twitch." The fix is to coalesce: on each outside write,
mark the region dirty and schedule the actual footer repaint on a
microtask or `setImmediate`, so N writes in one tick collapse into one
repaint. The outside text itself is still written immediately (it must
not be delayed or reordered); only the footer redraw is deferred to the
end of the tick.

This is included in the design as a defined refinement. It should be
implemented behind the same coordinator interface so turning it on is
an internal change with no call-site impact. Whether to ship it in the
first version or add it only if real usage shows visible twitching is a
judgment call for implementation and review; the plan should treat it as
a distinct, optional step rather than baking it into the core loop from
the start.

---

## Edge cases

- **An interrupt body that is very long.** Some actions carry large
  detail blobs. Cap the footer's body to a small number of lines (about
  six) and truncate the rest with an ellipsis, so the pinned region
  always fits on screen and the erase/redraw arithmetic stays bounded.
  The full detail is still available in the scrollback above once the
  prompt closes, because auto-approved edits already print their diff and
  a rejected action's context is in the transcript.

- **A terminal narrower than a footer line, or a resize mid-prompt.**
  The number of physical rows a footer occupies depends on wrapping, so
  the coordinator must count rows by *visible* width (with color escape
  codes stripped) against `process.stdout.columns`, not by the number of
  logical lines. Recompute on each redraw, and repaint on the terminal
  resize event so the footer stays coherent if the window changes while
  you are deciding.

- **The spinner.** It is stopped before the footer installs, through the
  existing `__agencyStopSpinner` hook, so only one bottom region is ever
  active. Matching today's behavior, the spinner does not restart for the
  rest of the turn after any prompt; the turn simply continues and prints
  its result.

- **The end-of-turn status footer.** `cli.ts` prints a one-line dim
  status line after a turn completes (`printFooter`, the
  `─── agency-agent · $… ───` line, `cli.ts:724`). It is a third writer
  to the bottom of the screen, alongside the spinner and the prompt, but
  it never collides: it renders only after the turn finishes, when no
  prompt is open and nothing is streaming. Named here so the census of
  "who writes to the bottom" is complete rather than quietly omitting a
  known bottom writer (Finding 7).

- **Escape.** The approval prompt is opened with `allowCancel: true`
  today, which means Escape cancels the whole request rather than
  re-prompting. The sticky widget preserves this: Escape raises
  `AgencyCancelledError`, which unwinds the turn back to the REPL prompt,
  the same as pressing Escape during the "Thinking" phase.

- **Ctrl+C is a deliberate divergence from the `_ttyWrite` siblings, not
  an inherited default.** The sticky widget is architecturally a
  `_ttyWrite` interceptor like `readMultiline` and `installCancelKey`,
  and those do a *soft* cancel on Ctrl+C: `classifyPasteKey` (`cli.ts:1134`)
  maps Ctrl+C to `"cancel"` and `readMultiline` resolves it as `null`
  (no process exit), while `installCancelKey` passes Ctrl+C straight
  through to the original `_ttyWrite`. Only `_runPrompt` (the `prompts`
  wrapper) hard-exits with code 130, and it only needs to because
  `prompts` otherwise swallows Ctrl+C into an infinite re-prompt loop, a
  problem this widget does not have. For a safety-approval prompt we still
  choose to exit on Ctrl+C (code 130): quitting is the safe response (it
  must not approve and must not hang), and it keeps line-mode Ctrl+C
  consistent whether the prompt came from `prompts` or from this widget.
  The implementer must therefore **not** copy `classifyPasteKey`'s
  soft-cancel for Ctrl+C, or the approval prompt would silently
  reject-and-continue instead of quitting (Finding 3).

- **Free-text rejection reason.** Typing text and pressing Enter returns
  that text as the reason. `askUser`'s existing final `match` arm turns a
  non-key answer into `reject(reason)`, so the model sees the reason as
  the tool's result and can course-correct. Unchanged from today.

---

## Testing

Follow the existing convention in `lib/stdlib/cli.ts`: pure helper
functions are exported for tests through an `_internal` object
(`cli.ts:1240`), and the imperative shell is exercised by a smoke test.

Pure, unit-tested helpers:

- Footer row-count given content plus terminal width, including wrapped
  and color-coded lines (strip escapes before measuring).
- The atomic-frame builder: given "erase N rows, print this text, redraw
  this footer," it returns the exact escape-code string. Assert the
  cursor moves, the clear, the synchronized-output brackets, and the
  cursor-hide are all present and correctly ordered.
- The keypress-to-action classifier for the widget, mirroring the tests
  around `classifyPasteKey`: option key, printable character, Enter,
  Escape, Ctrl+C, and ignored keys (arrows, function keys).
- Option-row rendering from a list of `{key, label}` items.

Integration smoke test:

- Drive a scripted keypress sequence at the sticky widget while
  interleaving calls that write lines through the coordinator, and assert
  that the footer is present and intact in the final output and that the
  interleaved lines appear above it in order.

These tests need no LLM calls. They exercise pure rendering and input
logic, which is exactly what the agency-execution and stdlib unit tests
are for.

---

## What this design deliberately does not change

Stated plainly so review can hold it to this:

- No change to the TUI (`std::ui`) rendering path.
- No change to `chooseOption` itself, nor to any caller of it other than
  `askUser`.
- No change to `/paste`, the slash palette, `/model`, `/models`,
  `/search`, `/settings`, or `/local`.
- No change to the policy data model, the approve/reject/always
  semantics, or the `"std::tty"` lock.
- No new concurrency primitive and no new locking. The single-threaded
  event loop plus the existing `"std::tty"` lock are sufficient.

---

## Open questions for review

1. **RESOLVED — spinner fold-in.** Decided: fold the spinner into the
   shared coordinator. The reason is correctness, not tidiness. Two
   patchers of the same `process.stdout.write` otherwise depend on a
   load-bearing teardown order; a single owner makes it structural. See
   Component 1. Kept as its own reviewable step in the plan.

2. **Burst coalescing in v1 (still open).** Ship the microtask-coalescing
   refinement in the first version, or wait until real usage shows visible
   twitching? Recommendation: build the coordinator so coalescing can be
   turned on without call-site changes, and decide during implementation
   review based on how the un-coalesced version looks in practice.

3. **RESOLVED — where the new primitive lives.** `interruptChoice` lives
   in `std::ui/cli`, because the behavior is inherently line-mode; the
   altitude review endorsed this placement. `std::policy` calls it and
   does not re-export it.
