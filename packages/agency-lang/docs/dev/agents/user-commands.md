# What the user can type at the agent prompt

This covers the input features of `agency agent` beyond a plain message and
the slash commands: the editor key, file completion, `!command`, and
`/image`.

## Ctrl+G and file completion are in the REPL

Both live in `lib/stdlib/cli.ts`, so every program that calls `repl()` from
`std::ui/cli` has them.

**Ctrl+G.** `installEditorKey` wraps readline's `_ttyWrite`, as the slash
trigger and the cancel key do. On Ctrl+G at the prompt it records the text
typed so far and synthesizes Enter. The loop in `_runLineRepl` sees the
record, and opens the editor in place of running the line. The hand-off is
`openInEditor` from `lib/utils/editor.ts`, the same function
`agency eval new` uses. The REPL gives it a terminal whose input half
pauses readline and leaves raw mode. The output half does nothing, because
the line-mode REPL draws nothing an editor would overwrite.

The key does nothing while a turn runs: `atPrompt` is true only while the
loop waits in `askLine`. A blank save, a failed editor, and an unset
`$EDITOR` all return to the prompt. The saved text goes into history
through `recordPasteEntry`, so a multi-line prompt is recalled as its
one-line preview, as a `/paste` buffer is.

**File completion.** `buildCompleter` in `lib/stdlib/cliCompleter.ts` is
readline's completer. If the last word starts with `@`,
`completeMention` in `lib/stdlib/pathCompletion.ts` lists one directory
through the host and offers the names that match. This comes first, so a
file can be named in a command's arguments, as in `/review @lib/ag`.
Otherwise a line that is the start of a slash command completes over the
palette. A directory is
offered with a trailing `/`, so the next Tab completes inside it. Dot files
are offered once the dot is typed. The model receives the mention as the
user typed it, `@` included, and reads the file with its own tools.

## `!command` and `/image` are in the agent

Both are handled in `_runTurn` in `lib/agents/agency-agent/lib/repl.agency`,
before a line reaches a brain.

**`!command`** (`lib/slashCommands/shell.agency`) runs the rest of the line
with `_bash`, the function behind `std::shell`'s `bash`, and prints the
output. It raises no interrupt and the policy is not asked. The user typed
the command, so it is theirs and not the agent's. This is the one place the
agent runs a shell command with no approval.

Because nothing approves it, a `!` line runs only when the user typed it
and pressed Enter (`isShellCommand` in `repl.agency`). Everything else
that starts with `!` goes to the model as a message:

- **Pasted text.** `watchTypedLine` in `lib/stdlib/cliTypedLine.ts` wraps
  readline's `_ttyWrite` and counts the keys of each piece of input. A
  terminal delivers a paste as one piece, so an Enter inside a paste
  arrives with other keys, and an Enter the user pressed arrives alone.
  Only the second kind marks the line as typed. `lineWasTyped()` in
  `std::ui/cli` reads the mark.
- **A `/paste` buffer and text from the editor.** The REPL calls
  `notTyped()` for both.
- **A message with more than one line.**
- **A line read from a pipe.** With no terminal nothing is typed.

The mark depends on the terminal handing over a paste in one piece. A
paste that the terminal splits just before its last newline would be read
as typed. Pasting `!ls` with no newline and then pressing Enter is typed,
which is what the user meant.

The command has no time limit, and its output is printed when it ends.
Escape stops it: the REPL's cancel key aborts the run, and `_bash` kills
the command on that signal. A stopped command leaves no note.

The output goes to the model with the next message, and so into the saved
session. `!env` or `!cat .env` puts secrets in both.

**`/image`** (`lib/slashCommands/image.agency`) calls `_pasteImage` in
`lib/stdlib/clipboard.ts`, which asks `osascript` to write the clipboard's
image to a new PNG in the temp directory. It works on macOS only. macOS
converts other formats to PNG itself, so an image copied from a browser,
which is TIFF on the clipboard, works too. The path
is passed to the script as an argument and is never part of the script
text. `/image` alone holds the image for the next message. `/image what is
this?` sends that text now, with the image.

## Pending notes

Neither command calls the model. Each leaves a note in
`lib/pendingNotes.agency`, and `renderUserTurn` puts the pending notes
above the user's next message with `withPendingNotes`. A shell note holds
the command, its output, and its exit code. Output over 20,000 characters
keeps its end. An image note holds the file path on a line of its own,
where the attachment scan in `lib/attachments.agency` finds it and attaches
the file. That scan reads the file with `readBinary`, so the policy is
asked about the read, as it is for a path the user drags in.

The notes are a `let` global, so a session saved between the command and
the next message keeps them.
