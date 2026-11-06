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
`openInEditor` from `lib/eval/newTest/editor.ts`, the same function
`agency eval new` uses. The REPL gives it a terminal whose input half
pauses readline and leaves raw mode. The output half does nothing, because
the line-mode REPL draws nothing an editor would overwrite.

The key does nothing while a turn runs: `atPrompt` is true only while the
loop waits in `askLine`. A blank save, a failed editor, and an unset
`$EDITOR` all return to the prompt. The saved text goes into history
through `recordPasteEntry`, so a multi-line prompt is recalled as its
one-line preview, as a `/paste` buffer is.

**File completion.** `buildCompleter` is readline's completer. A line that
starts with `/` completes over the slash palette. Otherwise, if the last
word starts with `@`, `completeMention` in `lib/stdlib/pathCompletion.ts`
lists one directory and offers the names that match. A directory is
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
agent runs a shell command with no approval, and it is reachable only from
a line the user typed at the prompt.

**`/image`** (`lib/slashCommands/image.agency`) calls `_pasteImage` in
`lib/stdlib/clipboard.ts`, which asks `osascript` to write the clipboard's
image to a new PNG in the temp directory. It works on macOS only. The path
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
