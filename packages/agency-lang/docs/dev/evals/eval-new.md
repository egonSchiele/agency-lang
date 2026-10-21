# `agency eval new`: a form that writes a test

`agency eval new <suite-dir>` opens a five-field form with a graders
section under it and, on save, writes one test folder into the suite.
`agency eval edit <test-dir>` opens the same form over an existing test
and saves it back in place. The form writes
`test.json`, a `graders.json` when at least one grader was added, plus,
when creating, a copy of a files directory when one was named. It writes
no grader module.
A test with a `goal` and no graders is scored by the bundled goal judge,
which is the grader the form means when the section is empty. This page
is the map of the code, with the rules in it that are easy to break.

## The files

```text
scripts/agency.ts              registers `eval new` and `eval edit`
lib/cli/eval/new.ts            one key table per mode, handleKey, runForm (the loop both commands share)
lib/cli/eval/edit.ts           `eval edit`: loadTestForm, then runForm
lib/cli/eval/formTerminal.ts   the real terminal and `$EDITOR`, shared by both commands
lib/eval/newTest/load.ts       a test folder -> FormState, and the refusals                (eval edit)
lib/eval/newTest/form.ts       FormState, FormAction, reduceForm, FIELDS, Row, rowsOf (pure)
lib/eval/newTest/graders.ts    the questions per grader kind as tables; answers <-> graders.json objects (pure)
lib/eval/newTest/formView.ts   renderForm, bodyLines, scrolledToCursor              (pure)
lib/eval/newTest/write.ts      validateForm, testJsonFor, gradersJsonText, writeTest, TestWriteError, nextCommands
lib/eval/gradersJson/schema.ts checkSpec and graderProblem, which the form validates a grader through
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

## The graders section

Under the five fields is a section headed `graders`. Ctrl+N adds one. Its
first row asks what to check, and the rows below it appear as the answers
come:

```text
graders
  1. what to check    count things in the trace
     count            tool calls
     which tool       fetchMarkdown
     only repeats     yes
     at most          0
     name             no-repeated-fetches
     must pass        yes
     weight           1 (optional)
```

The cursor is a `Row`: a field, or one question of one grader
(`{ kind: "grader", index, question }`). `rowsOf(state)` lists every row in
order, and movement, "last row", and the view all read it, so a row that
is not in that list cannot be reached.

The questions live in `graders.ts` as tables. `KIND_QUESTION` is the first
row. `KIND_QUESTIONS` holds one list per kind, and `TAIL_QUESTIONS` is what
every kind ends with: name, must pass, passing score (a must-pass goal,
or any goal once it holds one), weight. A sixth kind is one entry in `KIND_QUESTIONS` and one
label in `KIND_LABELS`. The measure and count options are built from the
schema's `MEASURES` and `COUNTS` through label tables typed on them, so a
measure added to the schema without a label fails the typecheck here.

Each question has an `output` that says how its answer is written:
`text`, `number`, `yesNo`, `list`, or `none`. One table, `OUTPUTS`, holds
the conversion in both directions, and nothing else in the module turns an
answer into a field. `scoring` on a number grader is the one `none`
question: it only decides whether `max` or `full` and `zero` are asked.

Answers are never pruned. A question with a `when` is hidden while its
`when` is false, and `questionsFor` filters the rows, so changing a count
from tool calls to errors hides the tool rows and changing it back shows
them with their old values. `specObjectFor` writes only the rows that are
shown, so the hidden tool name does not reach the file. A question with
`repeat: true` (a checklist's points) is expanded to one row per filled
answer plus one empty row, named `point.0`, `point.1`, and so on.

A choice row is picked with Left and Right. Letters type nothing there:
the reducer's `withEdit` returns the state unchanged for a choice row, so
`s` on "must pass" cannot change it. The form's key table still binds no
letter. `AUTO_FILL` is a table of defaults applied after a pick: it fills
`passingScore` with `0.5` when a goal grader becomes must-pass, and `max`
with `0` when a count grader is picked, since the parser requires that
limit and a row with no value would otherwise read as optional. A number
row holding only spaces counts as empty.

Ctrl+X on a grader's first row asks `remove this grader?  y / n`, a third
question mode beside save and quit. It is Ctrl+X and not Ctrl+D because
`cursorBindings` in `lib/tui/keymap.ts` pages down on Ctrl+D in every
other Agency TUI.

### Validation goes through the parser

The form holds no rule of its own about what a grader needs. `validateForm`
hands `specObjectFor(draft)` to `graderProblem` in
`lib/eval/gradersJson/schema.ts`, which is `parseSpec`'s check with the
problem returned as data instead of thrown: the field it is about, or
`null` for a rule that spans fields, and the parser's words.
`questionForField` in `graders.ts` turns the field into a row: a field
that names a shown question is that row, a repeating question's list key
(`points`) is its first row (`point.0`), and `kind` or a cross-field rule
is the kind row. The one exception to the parser's words is a grader with
no kind picked: the form says `pick what to check with ← →` itself, and
Enter on that row shows the same message instead of saving. The one check
the parser makes only at file level, two graders with one name, is
repeated per row so the cursor lands on the second one's name.

A goal is required only while there are no graders, because the bundled
goal judge scores only a test with none (`goalJudge` in
`lib/eval/grading/gradeRun.ts`). For the same reason the goal row shows
`not judged while the test has graders; add a goal grader to judge it`
once a grader exists.

### Scrolling

A test with several graders is taller than a terminal. The body is a flat
list of one-line elements, `bodyLines(state, width)`, each tagged with the
row it belongs to, and `renderForm` draws the slice from `state.scrollTop`.
The toolkit's `scrollable` style cannot do this: it shifts an element's
own text lines, and a column's children stay where the layout put them.
So a typed cursor row that wraps to `n` lines is `n` one-line elements,
the text input last. The lines above the input are ordinary `line`
elements, which read style tags, so their braces are escaped; the input
reads none, so its text is not.

`scrolledToCursor` runs after every key in `handleKey`. It moves
`scrollTop` with `followCursor` and `clampScroll` from `lib/tui/scroll.ts`
so the cursor row is on screen: its last line when the cursor came down
onto it, its first line (the one with the label) when it came up. A row
that vanished (a grader removed, a count changed) is absorbed too. One
function computes the wrapping, and drawing and scrolling both read it.

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
row, so the footer message lands the cursor on `files` for a bad files
directory and on `id` for the rest. `graders.json` is written into the
staging folder beside `test.json` when there is at least one grader, from
`gradersJsonText`, and never when there is none.

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

## Editing a test

`agency eval edit bar-evals/says-its-name` opens the form over an
existing folder:

```text
EDIT TEST  bar-evals/says-its-name

  folder name   says-its-name
  description   The script is told its name and asked for it.█
  input         What's your name?
  files         files/ (2 files)
  goal          The reply says its name.

graders
  no graders: the goal above is judged by the bundled goal judge
```

`loadTestForm` in `load.ts` builds the state. It asks the loader first
(`loadInputs` on the folder, which reads a folder holding a `test.json` as
one test), so every refusal the loader makes is inherited: not a
directory, a `test.json` that is not an object, both grader files. The
goal is not required at load, because a test missing one is what the
form is for. Then it reads the raw `test.json` again, because the loader
normalizes to a `Test` and drops the keys the form never shows. That raw
object is `editing.base`, and `testJsonFor(values, base, locks)` writes
`description`, `input` and `goal` over it on save, deleting a key whose
field was emptied (the loader refuses an empty string). A hand-written
test keeps its `tags`, `timeoutSec`, `expected`, `metadata`,
`harnessMaxCost`, `harnessMustPass`, and an `id` it spelled out.

Three rows can be locked. A lock is a text in `state.locks` shown dim in
the value column; `rowsOf` leaves a locked row out, so the cursor never
lands on it, and `validateForm` does not check it, which is what skips
the folder-name checks. The folder name is always locked: renaming a test
is moving a folder. The files row is always locked: replacing a test's
seeded files would mean deleting the old copy. The loader is asked to
leave `files` alone (`skipFiles`), so a git source is not cloned to draw
the row. It reads `files/ (12 files)` when the sibling folder is what the
file names or finds, counted by its own path with `lstat` so a link is
refused, `none` when there is no files entry at all, or the path as
written when it points somewhere else. Lock text that came from the file
is sanitized where it is built, since it is drawn by the style parser. A
structured `input`
(an object) locks the input row with `structured input: edit the file`
and is left in the base as it was. A `graders.ts`, or a `graders` path
pointing anywhere but the sibling `graders.json`, sets `gradersLock` and
the section shows that text and has no rows, because a `graders.json` the
form wrote would be ignored while `graders` points elsewhere.

Two refusals are the form's own: an `id` in `test.json` that differs from
the folder name (`rename the folder or the id`), and a `rubric`, since
the loader refuses a goal beside a rubric and the form would write one.

`isDirty` compares with what was loaded, not with empty, so quitting an
unchanged test asks nothing. The graders are compared as the objects
`specObjectFor` builds, serialized, and never as the file's text: a
`mustPass: false` in the file and a `no` in the form then compare equal.
That comparison only sees rows the form shows, so every field the file
may hold needs a row that is shown while it has a value. The passing
score row is the one case: it is asked for a must-pass goal, and stays
once it holds a value, so a `passingScore` on a goal that is not
must-pass is neither hidden nor dropped on save.

The write keeps one shape for both modes. `stagedFiles` is the "what":
`test.json`, and `graders.json` when there is a grader, written into
`<suite>/.staging-<id>/`. `COMMITS` is the "how", keyed by `create` or
`replace`. `replace` first checks, with `lstat`, that each target
(`<testDir>/test.json`, `<testDir>/graders.json`) is absent or a plain
file, so a target that became a directory or a symlink fails before
anything moves and the originals stay as they were. When the last grader
was removed from an editable section, the old `graders.json` is moved
into the staging folder next, and the `graders` key the file may have
spelled out is left out of `test.json`, or the loader would look for the
file this save removes. Then each staged file is renamed over its
original, one step each; a rename that fails puts the old `graders.json`
back and says which files were already written, so the folder holds the
originals or the new files. A section locked by a `graders` path
elsewhere never touches a sibling `graders.json`, since the form never
read it. The old file leaves with the staging folder rather than through
`safeDeleteFile`, which refuses a path outside the nearest
`package.json`, which every suite in a temp directory is.

The folder path is resolved once at the top of `loadTestForm`, so `.`
names the folder and every comparison with what the loader returns (which
is absolute) is absolute against absolute. A test graded by harness pairs
under `files/` sets `editing.harnessGraded`, and a goal is then not
required at save, as it is not while the section is locked.

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

`form.test.ts`, `graders.test.ts`, `write.test.ts` and `editor.test.ts`
need no terminal.
`formView.test.ts` renders through `Screen` into a `FrameRecorder` and
pins the rows. `new.test.ts` and `edit.test.ts` drive the whole command with a
`ScriptedInput` through the poller in `formTestHarness.ts`, feeding each
key once the frame shows the state a person would react to, the way
`lib/runsExplorer/run.test.ts` drives the explorer. `load.test.ts` builds
test folders under a temp directory. Both commands take the terminal as a
factory, `openTerminal`, so the tests hand it a scripted one and the
checks on the path run before any terminal is opened. The signal handling in the hand-off needs a real
terminal and a real editor, and has no test.
