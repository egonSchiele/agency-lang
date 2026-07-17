---
name: Apple Notes
description: Create, read, search, and edit notes in the macOS Notes app from Agency, and how to confine an agent to one folder.
---

# Apple Notes

`std::notes/apple` lets an agent work with the macOS Notes app.

```ts
import { createNote } from "std::notes/apple"

node main() {
  const result = createNote("Findings", "## Summary\n\n- one\n- two")
  print(result)
}
```

macOS only. The first call asks for Automation permission, and macOS will show
a dialog. If nobody answers it, the call fails after 30 seconds.

## Notes are addressed by id

Two notes in the same folder can share a title, so a title is not an address.
Every read and edit takes the note's `id`, which you get from `listNotes` or
`searchNotes`:

```ts
import { searchNotes, appendToNote } from "std::notes/apple"

node main() {
  const found = searchNotes("Q3 planning")
  if (found is success(notes)) {
    appendToNote(notes[0].id, "\n## Update\n\nShipped.")
  }
}
```

`createNote` returns the note it made, so create-then-append needs no search.

## Bodies are Markdown going in, plain text coming out

`createNote` and `appendToNote` take Markdown, which is converted to the HTML
Notes stores. `readNote` returns plain text, not HTML, because HTML would waste
tokens and read badly for a model.

That makes a read-then-write round trip lossy: reading strips the formatting,
and writing it back would flatten the note. Use `appendToNote` rather than
reading, editing, and writing yourself.

## Confining an agent to one folder

Every function takes an optional `folder`. It constrains rather than addresses:
if you pass it, the call fails unless the note is in that folder.

Combined with [partial application](/guide/partial-application), that confines
an agent in a way the model cannot see or route around, because the locked
parameter is stripped from the tool's schema:

```ts
import { createNote, listNotes, readNote } from "std::notes/apple"

node main() {
  const reader = readNote.partial(folder: "Work").rename("readWorkNote")
  const lister = listNotes.partial(folder: "Work").rename("listWorkNotes")
  llm("Summarise my Work notes", { tools: [lister, reader] })
}
```

The model may pass any id it likes. Anything outside Work fails closed.

## Deciding with a policy

Each operation raises its own [effect](/guide/effects), so a
[policy](/guide/policies) can approve reads and reject deletes:

```json
{
  "std::notes::read": [
    { "match": { "folder": "Work" }, "action": "approve" },
    { "action": "reject" }
  ],
  "std::notes::delete": [{ "action": "reject" }]
}
```

`readNote`, `appendToNote`, and `deleteNote` look the note up before raising
their interrupt, so the payload carries the note's real `title`, `folder`, and
`account` even when the call passed only an id. The rule above therefore
matches a bare `readNote(id)` for a note that lives in Work.

One v1 limit: only those three calls populate `account`. `createNote`,
`searchNotes`, and `listNotes` send it as an empty string, and an empty string
matches no glob — not even `"*"` — so a rule that matches on `account` never
applies to them. Match on `folder` instead.

Or constrain a whole node with the capability sets:

```ts
import { NotesRead } from "std::capabilities"

// may read notes; may not write them
node summarise() raises <NotesRead> {
  // ...
}
```

## Locked notes

A note locked with a password cannot be read or edited, and this module will not
try. AppleScript exposes no way to unlock a note, and the workarounds are worse
than the problem. Calls against a locked note fail with a message naming it:

```
Note "Q3 Planning" is locked. Unlock it in Notes.app and retry.
```

## Deleting is recoverable

`deleteNote` moves a note to Recently Deleted, where it stays for about 30 days.
`listFolders` returns that folder like any other.

## Other note apps

**Obsidian needs no module.** An Obsidian vault is a directory of Markdown
files, so [`std::fs`](/stdlib/fs) already does everything:

```ts
import { read, write } from "std::fs"

const VAULT = "/Users/me/vault"

node main() {
  const existing = read("notes.md", VAULT)
  if (existing is success(text)) {
    write(filename: "notes.md", dir: VAULT, content: text + "\n\nAppended.")
  }
}
```

Because those are ordinary file operations, they raise `std::read` and
`std::write`, so the same handlers, policies, and partial application work.

**Bear** is not supported. It has an `x-callback-url` API, but a command-line
process cannot receive the callback, so a create call could not return the id of
the note it made.
