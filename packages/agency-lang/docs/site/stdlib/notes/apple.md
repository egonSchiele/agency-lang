---
name: "apple"
---

# apple

Create, read, search, and edit notes in the macOS Notes app. macOS only, and
  the first call asks for Automation permission.

  ```ts
  import { createNote } from "std::notes/apple"

  node main() {
    const result = createNote("Findings", "## Summary\n\n- one\n- two")
    print(result)
  }
  ```

  Notes are addressed by their opaque `id`, not by title, because two notes in
  the same folder may share a title. Get ids from `listNotes` or `searchNotes`.

  Every function takes an optional `folder`, which constrains rather than
  addresses: if you pass it, the call fails unless the note is in that folder.
  Combined with partial application, that confines an agent to one folder in a
  way the model cannot see or route around:

  ```ts
  const inbox = createNote.partial(folder: "Agency Inbox").rename("addToInbox")
  llm("Log your findings", { tools: [inbox] })
  ```

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L42))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L49))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L59))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L68))

### std::notes::append

```ts
effect std::notes::append {
  account: string;
  folder: string;
  title: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L69))

### std::notes::read

```ts
effect std::notes::read {
  account: string;
  folder: string;
  title: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L70))

### std::notes::search

```ts
effect std::notes::search {
  account: string;
  folder: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L71))

### std::notes::list

```ts
effect std::notes::list {
  account: string;
  folder: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L72))

### std::notes::delete

```ts
effect std::notes::delete {
  account: string;
  folder: string;
  title: string;
  id: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L73))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L116))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L149))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L179))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L201))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L220))

### listFolders

```ts
listFolders(): Result<Folder[]> raises <std::notes::list>
```

List the folders in the Notes app, with a count of the notes in each.

**Returns:** `Result<Folder[]>`

**Throws:** `std::notes::list`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L236))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/notes/apple.agency#L248))
