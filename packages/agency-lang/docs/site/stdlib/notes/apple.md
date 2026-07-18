---
name: "apple"
description: "Create, read, search, and edit notes in the macOS Notes app. macOS only; the first call asks for Automation permission."
---

# apple

Create, read, search, and edit notes in the macOS Notes app. macOS only.
  The first call asks for Automation permission with a system dialog. If
  nobody answers the dialog, the call fails after 30 seconds.

  ```ts
  import { createNote } from "std::notes/apple"

  node main() {
    const result = createNote("Findings", "## Summary\n\n- one\n- two")
    print(result)
  }
  ```

  ## Notes are addressed by id

  Two notes in the same folder can share a title, so a title is not an
  address. Every read and edit takes the note's `id`, which comes from
  `listNotes` or `searchNotes`:

  ```ts
  import { searchNotes, appendToNote } from "std::notes/apple"

  node main() {
    const found = searchNotes("Q3 planning")
    if (found is success(notes)) {
      appendToNote(notes[0].id, "\n## Update\n\nShipped.")
    }
  }
  ```

  `createNote` returns the note it made, including its id, so
  create-then-append needs no search.

  ## Bodies are Markdown going in, plain text coming out

  `createNote` and `appendToNote` take Markdown and convert it to the HTML
  that Notes stores. `readNote` returns plain text. That makes a
  read-then-write round trip lossy: reading strips the formatting, and
  writing the text back would flatten the note. Use `appendToNote` instead
  of reading, editing, and rewriting a note yourself.

  ## Confining an agent to one folder

  Every function takes an optional `folder`. It constrains rather than
  addresses: if you pass it, the call fails unless the note is in that
  folder. Combined with partial application, that confines an agent in a way
  the model cannot see or route around, because the locked parameter is
  stripped from the tool's schema:

  ```ts
  import { listNotes, readNote } from "std::notes/apple"

  node main() {
    const reader = readNote.partial(folder: "Work").rename("readWorkNote")
    const lister = listNotes.partial(folder: "Work").rename("listWorkNotes")
    llm("Summarise my Work notes", { tools: [lister, reader] })
  }
  ```

  The model may pass any id it likes. Anything outside Work fails closed.

  ## Deciding with a policy

  Each operation raises its own effect, so a policy can approve reads and
  reject deletes:

  ```json
  {
    "std::notes::read": [
      { "match": { "folder": "Work" }, "action": "approve" },
      { "action": "reject" }
    ],
    "std::notes::delete": [{ "action": "reject" }]
  }
  ```

  `readNote`, `appendToNote`, and `deleteNote` look the note up before
  raising their interrupt, so the payload carries the note's real `title`,
  `folder`, and `account` even when the call passed only an id. The rule
  above therefore matches a bare `readNote(id)` for a note that lives in
  Work.

  One v1 limit: only those three calls populate `account`. `createNote`,
  `searchNotes`, and `listNotes` send it as an empty string, and an empty
  string matches no glob. A rule that matches on `account` never applies to
  them, so match on `folder` instead.

  The `NotesRead`, `NotesWrite`, and `Notes` sets in `std::capabilities`
  cover the same split for constraining a whole node.

  ## Locked notes

  A note locked with a password cannot be read or edited, and this module
  will not try. Calls against a locked note fail before their interrupt is
  raised, with a message naming the note.

  ## Deleting is recoverable

  `deleteNote` moves a note to Recently Deleted, where it stays for about
  30 days. `listFolders` returns that folder like any other.

  ## Other note apps

  Obsidian needs no module. A vault is a directory of Markdown files, so
  `std::fs` already covers it, and the same handlers, policies, and partial
  application apply. Bear is not supported: its `x-callback-url` API cannot
  deliver a callback to a command-line process, so a create call could not
  return the new note's id.

## Types

### Folder

A folder in Notes. `noteCount` is derived, not stored.

```ts
/** A folder in Notes. `noteCount` is derived, not stored. */
export type Folder = {
  id: string;
  name: string;
  noteCount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L127))

### Note

A note's metadata. Deliberately contains no body.

```ts
/** A note's metadata. Deliberately contains no body. */
export type Note = {
  id: string;
  title: string;
  folder: string;
  account: string;
  modified: string;
  passwordProtected: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L134))

### NoteContent

A note including its content, as plaintext.

```ts
/** A note including its content, as plaintext. */
export type NoteContent = {
  id: string;
  title: string;
  folder: string;
  account: string;
  body: string;
  modified: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L144))

## Effects

### std::notes::create

```ts
effect std::notes::create {
  account: string;
  folder: string;
  title: string;
  folderCreated: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L153))

### std::notes::append

```ts
effect std::notes::append {
  account: string;
  folder: string;
  title: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L154))

### std::notes::read

```ts
effect std::notes::read {
  account: string;
  folder: string;
  title: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L155))

### std::notes::search

```ts
effect std::notes::search {
  account: string;
  folder: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L156))

### std::notes::list

```ts
effect std::notes::list {
  account: string;
  folder: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L157))

### std::notes::delete

```ts
effect std::notes::delete {
  account: string;
  folder: string;
  title: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L158))

## Functions

### createNote

```ts
createNote(
  title: string,
  body: string,
  folder: string = "Agency Notes",
): Result<Note> raises <std::notes::create>
```

Create a note in the Notes app and return it, including its new id.

  @param title - The note's title
  @param body - The note's content, as Markdown
  @param folder - The folder to create it in. Created if it does not exist.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| title | `string` |  |
| body | `string` |  |
| folder | `string` | "Agency Notes" |

**Returns:** `Result<Note>`

**Throws:** `std::notes::create`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L206))

### appendToNote

```ts
appendToNote(
  id: string,
  body: string,
  folder: string | null = null,
): Result<Note> raises <std::notes::append>
```

Append Markdown to an existing note. Get the id from listNotes or searchNotes.

  @param id - The note's id
  @param body - The content to append, as Markdown
  @param folder - If given, the call fails unless the note is in this folder

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| body | `string` |  |
| folder | `string \| null` | null |

**Returns:** `Result<Note>`

**Throws:** `std::notes::append`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L239))

### readNote

```ts
readNote(
  id: string,
  folder: string | null = null,
): Result<NoteContent> raises <std::notes::read>
```

Read a note's contents as plain text. Get the id from listNotes or searchNotes.

  @param id - The note's id
  @param folder - If given, the call fails unless the note is in this folder

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| folder | `string \| null` | null |

**Returns:** `Result<NoteContent>`

**Throws:** `std::notes::read`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L269))

### searchNotes

```ts
searchNotes(
  query: string,
  folder: string | null = null,
): Result<Note[]> raises <std::notes::search>
```

Search notes by their text and return matching notes' metadata, without their
  contents.

  @param query - The text to search for
  @param folder - If given, only search this folder

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |
| folder | `string \| null` | null |

**Returns:** `Result<Note[]>`

**Throws:** `std::notes::search`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L291))

### listNotes

```ts
listNotes(
  folder: string | null = null,
): Result<Note[]> raises <std::notes::list>
```

List notes' metadata, without their contents.

  @param folder - If given, only list this folder

**Parameters:**

| Name | Type | Default |
|---|---|---|
| folder | `string \| null` | null |

**Returns:** `Result<Note[]>`

**Throws:** `std::notes::list`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L310))

### listFolders

```ts
listFolders(): Result<Folder[]> raises <std::notes::list>
```

List the folders in the Notes app, with a count of the notes in each.

**Returns:** `Result<Folder[]>`

**Throws:** `std::notes::list`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L326))

### deleteNote

```ts
deleteNote(
  id: string,
  folder: string | null = null,
): Result<null> raises <std::notes::delete>
```

Delete a note. It moves to the Recently Deleted folder, where it stays for
  about 30 days.

  @param id - The note's id
  @param folder - If given, the call fails unless the note is in this folder

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| folder | `string \| null` | null |

**Returns:** `Result<null>`

**Throws:** `std::notes::delete`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L338))
