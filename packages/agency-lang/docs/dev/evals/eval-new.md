# `agency eval new`: a form that writes a test

`agency eval new <suite-dir>` opens a five-field form and, on save, writes
one test folder into the suite: `test.json`, plus a copy of a files
directory when one was named. It writes no grader module. A test with a
`goal` and no `graders.ts` is scored by the bundled goal judge, which is
the grader the form means. This page is the map of the code, with the rules
in it that are easy to break.

## The files

```text
scripts/agency.ts              registers `eval new`
lib/cli/eval/new.ts            the terminal, one key table per mode, handleKey, runLoop
lib/eval/newTest/form.ts       FormState, FormAction, reduceForm, FIELDS          (pure)
lib/eval/newTest/formView.ts   renderForm(state): Element                          (pure)
lib/eval/newTest/write.ts      validateForm, testJsonFor, writeTest, nextCommands
lib/eval/newTest/editor.ts     editorCommand, withTerminalReleased, openInEditor
lib/tui/lineEditor.ts          one-line editing keys, shared with the label screen
lib/tui/untrusted.ts           sanitizeUntrusted and pastedText, shared the same way
```

The split is the label screen's: a plain state object, a reducer, a render
function, and `Screen.runLoop`. Everything but a short `handleKey` is pure
and tested without a terminal.

## One table defines a field

`FIELDS` in `form.ts` is the only place a field exists: its name, label,
whether it is required, whether Enter opens `$EDITOR` on it, and the help
shown while it is empty. The reducer moves the cursor through it, the view
draws it, and `validateForm` reads `required` from it. A sixth field is one
row there and one key in `testJsonFor`, which lists the fields that become
`test.json` keys: `description`, `input` and `goal`. `files` is not a key,
because the loader finds `./files` by itself. An empty `input` is left out,
because the loader refuses an empty string and reads a missing key as
"takes no input".

## Modes and intents

The form, the "discard?" question and the "wrote" screen are one state
with a `mode`. Every transition is a reducer case, including the two that
depend on the outside world. `editInEditor` and `save` are intents: the
reducer leaves the state alone, the command performs the effect, and the
outcome comes back as `editorReturned`, `saved` or `saveFailed`. So
"a failed save shows the first problem and moves the cursor to its field"
is a reducer test, and `handleKey` in `new.ts` is: pick the action (the
line editor while a field is being typed into, else the mode's key table),
reduce, and for an intent run the effect and reduce its outcome.

The key tables are `KeyBinding<FormAction>` lists, so the footer hints come
from the same table that handles the keys.

## The write

`writeTest` builds the folder under `<suite>/.staging-<id>/` and renames it
into place, so a failure part way leaves nothing. A stale staging folder
from a crash is removed first with `safeDeleteDirectoryWithin`. The files
directory is copied through `readTreeRefusingSymlinks` from the
grader-files snapshot: a symlink anywhere in it is refused, not followed.
The target is checked again right before the rename, because a rename onto
an existing empty directory can succeed silently.

## Handing the terminal to `$EDITOR`

`input` and `goal` open in `$EDITOR` when it is set. The hand-off has an
order, and it lives in one function, `withTerminalReleased`: suspend the
output (leave the alternate screen, drop the cached grid, so the next
render is a full redraw), release the input, run the editor, reclaim the
input, resume the output, with the last two in a `finally`.

`TerminalInput.release()` does one thing the Ctrl+Z path did not: after removing its
`data` listener it calls `process.stdin.pause()`. Without the pause the
stream stays flowing with no listener, Node keeps reading the terminal and
dropping the bytes, and a child editor reading the same terminal loses
keystrokes at random. Ctrl+Z goes through the same function and is
unharmed by a paused stream. The headless tests cannot see this; typing
fast into vim from the form is the test.

`$EDITOR` is split on spaces, so `code --wait` works. A quoted path with a
space in it is not supported. When the variable is unset, the long fields
edit in place on one line like the others.

## Testing

`form.test.ts`, `write.test.ts` and `editor.test.ts` need no terminal.
`formView.test.ts` renders through `Screen` into a `FrameRecorder` and
pins the rows. `new.test.ts` drives the whole command with a
`ScriptedInput`, feeding each key once the frame shows the state a person
would react to, the way `lib/runsExplorer/run.test.ts` drives the explorer.
