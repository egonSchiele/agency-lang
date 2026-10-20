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
lib/eval/newTest/write.ts      validateForm, testJsonFor, writeTest, TestWriteError, nextCommands
lib/eval/newTest/editor.ts     editorCommand, withTerminalReleased, openInEditor
lib/tui/lineEditor.ts          one-line editing keys, shared with the label screen
lib/tui/untrusted.ts           sanitizeUntrusted and pastedText, shared the same way
```

The split is the label screen's: a plain state object, a reducer, a render
function, and `Screen.runLoop`. Everything but a short `handleKey` is pure
and tested without a terminal.

## One table defines a field

`FIELDS` in `form.ts` is the only place a field exists: its name, label,
whether it is required, whether Ctrl+E opens `$EDITOR` on it, and the help
shown while it is empty. The `id` field is labelled "folder name", because
that is what it is to the person typing it; the name stays `id` in code
and in the loader. The reducer moves the cursor through it, the view
draws it, and `validateForm` reads `required` from it. A sixth field is one
row there and one key in `testJsonFor`, which lists the fields that become
`test.json` keys: `description`, `input` and `goal`. `files` is not a key,
because the loader finds `./files` by itself. An empty `input` is left out,
because the loader refuses an empty string and reads a missing key as
"takes no input".

## Every field is live

There is no edit mode. The field under the cursor is a text input, and a
key the mode's key table does not name is typed into it at once, through
the line editor's `append` and `backspace`. So `handleKey` consults the
key table first and the line editor second, and no letter may ever be
bound in the form's key table: `s` is a letter someone types into a goal.
Save is Ctrl+S, quit is Ctrl+C, and the editor hand-off is Ctrl+E. Enter
moves down, and on the last field it saves: two bindings on the same key,
each guarded by `when`, so the hint follows the cursor. Escape is not
bound in the form. The terminal reads an Option chord as an Alt chord now
(see `docs/dev/cli/tui/dev/input-output.md`), but an older terminal can
still send a bare Escape for a key it does not know, and quitting on one
of those partway through a word would throw the form away.

Both saving and quitting ask first, and both questions answer to `y`
alone: never to the key that asked them, so a held Ctrl+C or Enter cannot
ask and answer in one go, and `n` or Escape goes back to the form. The
save question is there because Enter is the save key on `goal`, the field
most likely to hold several sentences: an Enter meant as a line break, or
a `\r` from a paste in a terminal without bracketed paste, must not write
a half-finished test. `requestSave` validates and, when the form is
complete, asks; `save` is the `y`. A write that fails after the question
(the folder appeared meanwhile) returns to the form with the problem.

There is no "wrote" screen. `saved` sets `done` and records the folder in
`written`, and the command prints the folder and the next commands after
`screen.destroy()`, where they stay in the scrollback. A screen that any
key dismisses could not promise that.

A keystroke clears the footer message. A failed save puts the cursor on
the field with the problem, so the next thing typed fixes it in place.

## Modes and intents

The form and its two questions are one state with a `mode`. Every
transition is a reducer case, including the three that depend on the
outside world. `editInEditor`, `requestSave` and `save` are intents: the
reducer leaves the state alone, the command performs the effect, and the
outcome comes back as `editorReturned`, `askSave`, `saved` or
`saveFailed`. So
"a failed save shows the first problem and moves the cursor to its field"
is a reducer test, and `handleKey` in `new.ts` is: pick the action (the
mode's key table, else the line editor), reduce, and for an intent run the
effect and reduce its outcome.

The key tables are `KeyBinding<FormAction>` lists, so the footer hints come
from the same table that handles the keys.

## The write

`writeTest` builds the folder under `<suite>/.staging-<id>/` and renames it
into place. If anything fails before the rename, the staging folder is
removed, so a failure part way leaves nothing: the loader treats every
subdirectory holding a `test.json` as a test, and a half-written staging
folder would otherwise run as one. A stale staging folder from a crash is
removed first with `safeDeleteDirectoryWithin`, and its refusal (a file at
that path, or a link that escapes the suite) stops the write rather than
being built on. The target is checked again right before the rename,
because a rename onto an existing empty directory can succeed silently.

A problem the user can fix is thrown as a `TestWriteError` that names the
field, so the footer message lands the cursor on `files` for a bad files
directory and on `id` for the rest.

The files directory is copied byte for byte with `copyFileSync`, walking
the tree with `walkTreeRefusingSymlinks` from the grader-files snapshot. A
fixture can be a PNG or a database, so the copy must not go through a
string. The directory is copied only when it passes these checks, made in
`validateForm` and again at write time in case the disk changed:

- It must sit inside the suite by name: `isStrictDescendant` on the
  resolved path, which lets `..cache` through and refuses `..`, `.` and
  `/elsewhere`.
- It must exist as a directory.
- It must be reached without a symlink: its real path must equal the
  suite's real path plus the typed name. That one comparison refuses a
  link as the directory itself, a link anywhere above it, and a link that
  points back inside the suite, without any code that follows links.

An empty files directory is copied as an empty `files/`, so the test shows
what it was given.

## Handing the terminal to `$EDITOR`

`input` and `goal` open in `$EDITOR` on Ctrl+E when it is set. The hand-off has an
order, and it lives in one function, `withTerminalReleased`: release the
output, release the input, run the editor, reclaim the input, reclaim the
output, with the last two in a `finally`. Both terminal classes have a
`release()` and a `reclaim()`.

`TerminalOutput.release()` leaves the alternate screen and drops the cached
grid, so the next render is a full redraw. It then takes its `SIGTSTP` and
`SIGCONT` handlers off, and replaces its `SIGINT` handler with one that
does nothing, until `reclaim()`. The keys a user presses inside the editor
reach this process too, because both share the terminal's process group:

- Ctrl+Z in the editor sends `SIGTSTP` to the group. With the handler
  installed this process would not stop, and the handler could not run
  either while `spawnSync` blocks, so the editor stops, this process waits,
  and the shell never shows a prompt. With the handler off, both stop and
  `fg` continues both.
- `SIGCONT` after that `fg` must not redraw the form or put stdin back in
  raw mode while the editor still owns the terminal, so both classes take
  their `SIGCONT` handler off.
- Ctrl+C in the editor sends `SIGINT` to the group. With no handler at all
  this process would die; with its usual handler it would tear the form
  down once the editor exits. Ignoring it leaves the editor to act on it.

`TerminalInput.release()` removes its `data` listener and calls
`process.stdin.pause()`. Without the pause the stream stays flowing with no
listener, Node keeps reading the terminal and dropping the bytes, and a
child editor reading the same terminal loses keystrokes at random. The
headless tests cannot see this; typing fast into vim from the form is the
test.

The text comes back from a temp folder under `.agency-tmp/`, which is
removed whole with `safeDeleteDirectory`, so a backup or swap file the
editor left does not stop the saved text reaching the form. The final
newline an editor ends a file with is dropped, so the value matches what
typing it in place gives. An editor that cannot start (`$EDITOR` names a
missing program) becomes the footer message; the form and everything
typed stay.

`$EDITOR` is split on spaces, so `code --wait` works. A quoted path with a
space in it is not supported. When the variable is unset, Ctrl+E does
nothing and the long fields are typed on one line like the others.

## What is drawn

Every string that came from outside the form goes through
`sanitizeUntrusted` before it is drawn: field values, the suite path from
the command line, and the footer message (which quotes paths). A path can
carry an escape sequence or a `{red-fg}` style tag as easily as a value
can. The one exception is the cursor row, drawn as a `textInput`: that
element reads no style tags, so its value only has its control characters
removed, or a typed `{` would show as `\{`. The lines printed after the
screen closes are not drawn by the style parser at all, so they too only
have their control characters removed: a `{` in a suite path must print
as `{`, or the command could not be copied.

The cursor row wraps like the others, in `cursorRows`: the value is
wrapped first and handed to the `textInput` with a newline per row, since
a text input clips a long line rather than wrapping it. `wrapText` drops
the spaces at the end of a row once a value wraps, which would make a
space typed at the end of a long goal look like nothing happened, so the
value is wrapped without its trailing spaces and they are put back on the
last row. A row that fills the width gets an empty row after it, because
a text input leaves the cursor out when its last row is full.

## Testing

`form.test.ts`, `write.test.ts` and `editor.test.ts` need no terminal.
`formView.test.ts` renders through `Screen` into a `FrameRecorder` and
pins the rows. `new.test.ts` drives the whole command with a
`ScriptedInput`, feeding each key once the frame shows the state a person
would react to, the way `lib/runsExplorer/run.test.ts` drives the explorer.
`evalNew` takes the terminal as a factory, `openTerminal`, so the tests
hand it a scripted one and the suite-directory check runs before any
terminal is opened. The signal handling in the hand-off needs a real
terminal and a real editor, and has no test.
