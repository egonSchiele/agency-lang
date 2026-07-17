# std::notes/apple — Apple Notes integration for the Agency standard library

Date: 2026-07-16
Status: Design, awaiting owner review
Scope: One new stdlib module, one new function in an existing stdlib module, one addition to the capability sets

---

## 1. Background: what this is and why it is worth building

### 1.1 The thing we are integrating with

Apple Notes is the note-taking app that ships with macOS. It stores notes in
folders, and the folders live under accounts (iCloud, "On My Mac", and so on).
People keep a lot of their working life in it. That is exactly why an agent that
can put things there is useful, and exactly why it needs to be careful.

Notes has no HTTP API, no command-line tool, and no config file you can write.
The only supported way to automate it is AppleScript, Apple's scripting language
for driving Mac applications. You run AppleScript from a terminal with the
`osascript` binary, which is already on every Mac.

### 1.2 What we want an agent to be able to do

The driving use cases, in the order people will actually hit them:

- An agent finishes some research and appends its findings to a running note.
- An agent creates a new note in a specific folder to capture a result.
- An agent reads a note the user points it at, in order to summarise or act on it.
- An agent searches the user's notes to find the one that is relevant.

The first two are writes and were the original request. The last two are reads,
and the owner explicitly asked for them, which is a meaningful decision that
Section 3.2 explains.

### 1.3 Why this belongs in the standard library

Agency already has an Apple-ecosystem foothold. `stdlib/messaging/imessage.agency`
sends iMessages by shelling out to `osascript`. `stdlib/clipboard.agency` reads and
writes the system clipboard. `stdlib/calendar.agency` talks to Google Calendar.
So a Notes module is not a new category of thing for the stdlib. It is the next
one in an established line, and it can copy the shape of the existing ones almost
exactly.

### 1.4 Terminology used in this document

Some of these are Agency terms and some are macOS terms. They get mixed together
constantly below, so they are defined once here.

- **sdef** — the "scripting definition" file that describes what an app exposes
  to AppleScript. It is the app's API documentation, shipped inside the app
  bundle. Notes' sdef lives at
  `/System/Applications/Notes.app/Contents/Resources/Notes.sdef`.
- **TCC** — "Transparency, Consent, and Control", the macOS permission system.
  It is why you see "Terminal wants to control Notes" dialogs. A grant is per
  (calling app, target app) pair.
- **Automation permission** — the specific TCC permission needed to drive
  another app with AppleScript.
- **Effect** — in Agency, the name attached to an interrupt, like `std::read`.
  Handlers and policies dispatch on it.
- **Interrupt** — in Agency, a pause that asks for approval before continuing.
- **PFA** — partial function application. `fn.partial(name: value)` produces a
  new function with that argument locked. The locked parameter is stripped from
  the JSON schema, so an LLM never learns it existed.
- **Policy** — a plain object mapping effects to approve/reject rules, matched
  against the interrupt payload, with glob support.

---

## 2. What we learned about the Notes AppleScript API

All of this came from reading the sdef directly and from running one live probe.
It is written down here because several of these findings drove design decisions,
and because a future reader will otherwise reasonably assume we guessed.

### 2.1 The object model

Notes exposes four classes: `account`, `folder`, `note`, and `attachment`.
Folders contain notes and can contain other folders. That is the whole model.

### 2.2 The note properties, and which ones we can write

This table is copied from the sdef, not from memory:

| Property | Type | Access | Notes |
|---|---|---|---|
| `name` | text | read/write | The title. See the open question in Section 9.1. |
| `id` | text | read-only | An opaque `x-coredata://...` string. Stable. |
| `container` | folder | read-only | The folder the note is in. |
| `body` | text | **read/write** | HTML. The only writable content field. |
| `plaintext` | text | read-only | The note's text without markup. |
| `creation date` | date | read-only | |
| `modification date` | date | read-only | |
| `password protected` | boolean | read-only | Whether the note is locked. |
| `shared` | boolean | read-only | Whether the note is shared. |

The single most important line in that table is that **`body` is writable**. If
it were read-only there would be no append feature and no module. Everything
else follows from it.

### 2.3 The commands

Notes defines only two commands of its own: `open note location` and `show`. It
pulls in the standard Cocoa suite via an `xi:include` of
`/System/Library/ScriptingDefinitions/CocoaStandard.sdef`, and that is where
`make`, `delete`, `count`, and `exists` come from. So creation is:

```applescript
make new note at folder "Inbox" with properties {name:"Title", body:"<p>Hi</p>"}
```

and deletion is the standard `delete` command.

### 2.4 We read plaintext but we write HTML

`body` is HTML and it is the only writable content field. `plaintext` is clean
text and it is read-only. This asymmetry is not a detail, it shapes the API:

- Every write path must produce HTML from something.
- Every read path should return `plaintext`, because handing an LLM a wall of
  Apple's HTML wastes tokens and reads badly.
- Therefore a read followed by a write is **lossy**. Reading gives you text with
  the formatting stripped; writing that text back would destroy the note's
  formatting.

That last point is the reason `appendToNote` exists as its own operation instead
of letting callers do their own read-modify-write. The module must own the round
trip so it can keep it in the HTML domain.

### 2.5 Duplicate titles are legal and common

Notes lets two notes in the same folder share a title. "Meeting Notes" appearing
three times is normal usage, not an edge case. Any API that addresses a note by
its title is therefore ambiguous by construction. This drove the decision in
Section 3.3.

### 2.6 The first call blocks for two minutes and then fails opaquely

This is the finding that came from a live probe rather than from reading, and it
is the one most likely to bite users.

Running a plain read-only query against Notes on a machine that has never granted
Automation permission does not fail fast. It blocks. macOS puts a consent dialog
on screen and `osascript` waits. If nobody clicks the dialog, the call
eventually dies with:

```
37:53: execution error: Notes got an error: AppleEvent timed out. (-1712)
```

Two things matter here:

- **It takes about 120 seconds.** That is AppleScript's default AppleEvent
  timeout. For an agent making a tool call, two minutes of nothing is
  indistinguishable from a hang.
- **The error is `-1712`, "AppleEvent timed out".** It is not a permission
  error. The same code covers "the user never clicked the dialog", "Notes is
  busy", and "Notes is wedged". Nothing in the exit status distinguishes them.

An earlier draft of this design claimed the call hangs forever and that
`osascript` has no timeout. Both claims were wrong, and the probe disproved them.
The corrected behaviour is what Section 6.1 designs against.

`lib/stdlib/imessage.ts` has this same latent problem today and handles neither
half of it.

### 2.7 There is no way to unlock a locked note

The word "password" appears exactly once in the entire sdef, at line 137, as the
read-only `password protected` boolean. There is no unlock command, no password
parameter, and no related property. Notes exposes two commands total and neither
is relevant.

AppleScript therefore cannot open a locked note, at any price. This is not a
capability we are declining to expose. It does not exist. Section 3.7 covers
what we do instead and why the workarounds are worse than the problem.

---

## 3. The decisions, and the reasoning behind each

Each of these was a real fork with a real cost. They are written as the argument
that was actually had, not as a list of conclusions, because the conclusions are
only useful if the next person can tell whether the reasoning still holds.

### 3.1 Apple Notes only. Not Bear, not Obsidian.

The original question asked about all three. The answer differs sharply per app,
and the effort ranking is the opposite of the intuition.

**Obsidian needs no module at all.** An Obsidian vault is a directory of markdown
files. Creating and appending notes is `std::fs`, which Agency already has. There
is a community plugin (`obsidian-local-rest-api`) that serves a REST API on
`https://127.0.0.1:27124`, and it has a genuinely nice `PATCH` that can target a
specific heading or block reference. But it requires the user to install a
community plugin and keep the app running, in order to do something that plain
file writes already do. Shipping `std::notes/obsidian` as a wrapper around
`write()` would be a thin wrapper over an existing primitive, which is the
altitude mistake this codebase's own anti-patterns doc warns about. A guide page
showing the `std::fs` pattern serves users better than a module.

**Bear has a real API but a lopsided one.** Bear implements `x-callback-url`:
`bear://x-callback-url/create?title=...&text=...` and `/add-text` with
`mode=append`. Some calls need a token from Help → Advanced → API Token. The
problem is the return path. From a command line, `open "bear://..."` is
fire-and-forget. Getting a value back, such as the id of a note you just
created, requires an `x-success` callback URL pointing at something that can
receive a URL scheme, and a short-lived CLI process is not that. So `create`
could not return an id, every call would activate the Bear UI and steal focus,
and the resulting API would be write-only and shaped very differently from this
one. Bear deserves its own design conversation, not a footnote in this one.

**Apple Notes is the one with no escape hatch.** There is no file to write and no
alternative interface. It is also the one with a clean precedent to copy. So it
is the one worth building.

### 3.2 Full CRUD, including reading note bodies

The narrow reading of the original request is create and append. The owner chose
the full surface: create, append, read, search, list, and delete.

This is a much bigger security surface, and it should be named as such. It means
an LLM can reach the contents of the user's personal notes. Every note. That is
a real expansion, and a module that only wrote would be trivially safer.

The reason it is defensible here and would not be in another language is that
Agency has the machinery to contain it, and containment is the language's entire
thesis. Reads are gated by interrupts. Effects let a policy approve reads and
reject deletes. PFA can lock an agent to one folder in a way the model cannot
see or route around. Handlers compose so that any handler up the chain can reject
regardless of what the callee pre-approved. Declining to expose reads because
they are dangerous would be conceding that those mechanisms do not work.

The obligation this creates: the safety design in Section 5 has to be right, and
it is not optional polish. It is the thing that earns the surface.

### 3.3 Address notes by id, not by title

Because duplicate titles are legal (Section 2.5), a title is not an address.
`appendToNote("Meeting Notes", ...)` has no correct behaviour when three notes
match. It can append to the first, which is arbitrary, or fail, which makes the
API useless exactly when a user has a normal amount of notes.

So every read and mutation takes the opaque `id`. Ids come from `listNotes` or
`searchNotes`. This makes the natural agent flow two steps, search and then act,
which is more verbose. The verbosity buys never writing to the wrong note. That
trade is worth it.

**A correction worth recording.** An earlier version of this argument claimed
id-based addressing was what made the PFA folder-locking example work. That was
wrong, and backwards. `createNote(title, body, folder)` does not take an id at
all, so `.partial(folder: "Inbox")` works identically under either scheme. Worse,
id-addressing actively *weakens* PFA, because `readNote(id)` has no folder
parameter for PFA to lock. Section 3.4 is the repair for a problem that this
decision caused.

### 3.4 An optional `folder` argument that asserts rather than addresses

Under id-addressing, PFA covers only part of the surface:

| Function | Has a folder parameter | PFA can scope it |
|---|---|---|
| `createNote(title, body, folder)` | yes | yes |
| `searchNotes(query, folder?)` | yes | yes |
| `listNotes(folder?)` | yes | yes |
| `readNote(id)` | no | **no** |
| `appendToNote(id, body)` | no | **no** |
| `deleteNote(id)` | no | **no** |

The three functions PFA cannot scope are read a body, mutate a note, and delete a
note. They are the sharpest three. Leaving them scopable only by policy would
mean the most dangerous operations have the fewest locks.

The repair is to give those three an optional `folder` argument that does not
address anything. The id still identifies the note. If `folder` is supplied, the
call fails unless the note's actual container matches it.

```ts
readNote(id: string, folder?: string): Result
// id addresses. folder constrains. omitted folder means no constraint.
```

This costs nothing at runtime. The pre-flight lookup (Section 5.3) already reads
the note's container to build the interrupt payload, so the assertion is a string
comparison on data already in hand. It adds no AppleScript.

What it buys:

```ts
const workReader = readNote.partial(folder: "Work").rename("readWorkNote")
llm("Summarise my Work notes", { tools: [listNotes.partial(folder: "Work"), workReader] })
// the model may pass any id it likes. Anything outside Work fails closed.
```

The argument is optional, so omitting it behaves exactly as if it did not exist.
The change is purely additive.

### 3.5 Markdown in, rendered to HTML by a new function in std::markdown

Writes need HTML (Section 2.4). Three options were considered.

Accepting **plaintext** and escaping it is the smallest possible change: escape
`&`, `<`, `>`, turn newlines into `<br>`, done. But an agent that writes
`## Findings` gets the literal characters `## Findings` in the note. No headings,
no lists, ever. A note-taking module that cannot produce a bullet list is a weak
one.

Accepting **raw HTML** gives the most power and hands an LLM the ability to
inject arbitrary markup into the user's personal notes. No.

Accepting **markdown** is what agents already emit without being asked, and
`std::markdown` already has a complete markdown parser producing a typed AST. It
has `renderForCli`, which walks that AST and emits ANSI. What it does not have is
an HTML renderer. So the work is one more renderer over an AST that already
exists.

The renderer goes in **`std::markdown` as `renderForHtml`, not inside
`std::notes/apple`**. It sits beside `renderForCli` as a peer. This is an
altitude call: markdown-to-HTML is a general capability that email, image
captions, and report generation all want. Burying it inside the Notes module
would hide a reusable thing inside a specific one.

The cost is honest: this makes the work touch two modules and adds a real chunk
of implementation that is not Notes-specific. It is still the right shape.

### 3.6 Pass data as argv, never interpolate it into script source

Note titles, bodies, and search queries are LLM-authored. An LLM's output may be
influenced by a web page it read, an email it summarised, or a file it opened. So
this is untrusted text flowing into a script that `osascript` will execute.

`imessage.ts`, the module this one is otherwise copying, builds its script by
interpolating data into a template string and then hand-escaping quotes and
backslashes. That defends at the wrong layer. The data is still parsed as code,
and correctness depends forever on the escape function anticipating every
AppleScript metacharacter.

Instead, the script is a constant and the data arrives as arguments:

```ts
const SCRIPT = `on run argv
  set noteTitle to item 1 of argv
  set noteBody to item 2 of argv
  ...
end run`

await execFileAsync("osascript", ["-e", SCRIPT, "-", title, body])
```

`argv` values are never parsed as AppleScript. This removes the vulnerability
class instead of escaping around it.

The `imessage.ts` instance is filed separately as issue #561 rather than fixed
here, to keep this work scoped and that fix reviewable on its own.

### 3.7 Locked notes fail closed. We do not accept a password.

Section 2.7 established that AppleScript cannot unlock a note. The question is
what to do instead, and whether any workaround is worth it.

**GUI scripting** could drive the unlock dialog via System Events and type the
password. It needs an Accessibility grant, which is a far broader TCC permission
than Automation, because it lets the process control any application's interface.
Asking a user to hand an agent full UI control in order to read one note is a bad
trade. It is also fragile against any dialog change.

**Decrypting `NoteStore.sqlite` directly** means reimplementing Apple's key
derivation against an undocumented schema, and bypasses the OS permission model
that makes the rest of this module safe.

There is also an Agency-specific argument that would apply even if the API
existed. A password arriving as a function argument lands in places this runtime
deliberately persists. Checkpoints serialise function arguments, which is what
makes `restore(cp, { args: {...} })` work, so the password would be written into
checkpoint JSON on disk. `std::tag` redaction covers statelog and
`std::auth/keyring` could supply the secret, but the checkpoint path leaks
quietly. A design where the secret never enters the runtime beats one that has to
chase it through every persistence layer.

So: detect the `password protected` flag and fail with a message that tells the
user what to do.

> Note "Q3 Planning" is locked. Unlock it in Notes.app and retry.

An `unlockNote(id)` that calls `show` to surface the note in the UI and raises an
interrupt asking the human to unlock it manually was considered and explicitly
rejected by the owner. It is not future work. It is out of scope.

---

## 4. The API surface

Module path: `stdlib/notes/apple.agency`, imported as `std::notes/apple`.
TypeScript helper: `lib/stdlib/appleNotes.ts`, imported by the Agency module as
`agency-lang/stdlib-lib/appleNotes.js`.

The layout follows the existing convention, which is nested `.agency` and flat
`.ts`: `stdlib/messaging/imessage.agency` pairs with `lib/stdlib/imessage.ts`.
The `notes/` namespace leaves room for a future `notes/bear` without implying we
are building one.

### 4.1 Types

```ts
/** A folder in Notes. */
export type Folder = {
  id: string
  name: string
  noteCount: number
}
```

`noteCount` is **not** a folder property. The sdef gives `folder` only `name`,
`id`, `shared`, and `container`. The count has to be derived with
`count of notes of folder`, which is an extra query per folder, so `listFolders`
on a user with many folders pays for it. It is included because an agent choosing
a folder benefits from knowing which ones are empty. If the spike shows the cost
is bad, drop the field rather than making `listFolders` slow.

```ts

/** A note's metadata. Deliberately contains no body. */
export type Note = {
  id: string
  title: string
  folder: string
  modified: string
  passwordProtected: boolean
}

/** A note including its content, as plaintext. */
export type NoteContent = {
  id: string
  title: string
  folder: string
  body: string
  modified: string
}
```

`Note` and `NoteContent` are separate types on purpose. Functions that list or
search return `Note`, and no body ever crosses that boundary. Only `readNote`
returns `NoteContent`. The type split makes "does this call expose note contents"
answerable by looking at the signature.

### 4.2 Functions

```ts
createNote(title: string, body: string, folder: string = "Notes"): Result
// -> success(Note) with the new id, so create-then-append needs no search.

appendToNote(id: string, body: string, folder?: string): Result
// -> success(Note). body is markdown. folder asserts, see 3.4.

readNote(id: string, folder?: string): Result
// -> success(NoteContent). body is plaintext, see 2.4.

searchNotes(query: string, folder?: string): Result
// -> success(Note[]). Metadata only. folder scopes the search.

listNotes(folder?: string): Result
// -> success(Note[]). Metadata only.

listFolders(): Result
// -> success(Folder[])

deleteNote(id: string, folder?: string): Result
// -> success(null). Moves to Recently Deleted, see 6.5.
```

`body` on `createNote` and `appendToNote` is markdown. `body` on `NoteContent` is
plaintext. That is confusing enough to be worth a docstring on each, and it is a
direct consequence of Section 2.4 rather than a choice we made.

---

## 5. Safety model

Three layers, all of them existing language features. Nothing new is invented.

### 5.1 Effects

```ts
effect std::notes::create { folder: string, title: string }
effect std::notes::append { folder: string, title: string, id: string }
effect std::notes::read   { folder: string, title: string, id: string }
effect std::notes::search { query: string }
effect std::notes::list   { folder: string }
effect std::notes::delete { folder: string, title: string, id: string }
```

Per-operation effects rather than one blanket `std::notes`, so that a policy can
approve reads and reject deletes. A single effect would make the whole mechanism
useless here.

Payloads carry `folder` and `title` because those are what policies glob against:

```json
{
  "std::notes::read": [
    { "match": { "folder": "Work" }, "action": "approve" },
    { "action": "reject" }
  ],
  "std::notes::delete": [{ "action": "reject" }]
}
```

Payload design is safety design. A payload that omitted `folder` would make
folder-scoped policies impossible to write.

### 5.2 Capability sets

Added to `stdlib/capabilities.agency`, mirroring the existing
`FileRead`/`FileWrite`/`FileSystem` shape:

```ts
/** Read-only Notes access: reading, searching, and listing. */
export effectSet NotesRead = <std::notes::read, std::notes::search, std::notes::list>

/** Notes mutation: creating, appending, and deleting. */
export effectSet NotesWrite = <std::notes::create, std::notes::append, std::notes::delete>

/** All Notes access, reads and writes. */
export effectSet Notes = <NotesRead, NotesWrite>
```

### 5.3 The pre-flight lookup, and the gap it opens

To put `folder` and `title` into the `std::notes::read` payload, we must know
them before raising the interrupt. So there is a metadata query that is itself
not gated.

That query reads two properties and nothing else:

```applescript
tell application "Notes"
  set n to note id (item 1 of argv)
  return (name of n) & tab & (name of container of n) & tab & (password protected of n)
end tell
```

`body` and `plaintext` are never touched. The unguarded step learns a title, a
folder name, and a locked flag. It never learns a single byte of note content.

The reason this is acceptable is not that titles are unimportant. It is that the
step is unreachable without already having passed a gate. The only ways to obtain
a note id are `listNotes` and `searchNotes`, and both raise interrupts. So an
agent holding an id has already been approved for a call that showed it that
title. The lookup cannot enumerate anything and cannot reveal anything the caller
was not already shown.

This should be documented in the module source, not left implicit.

### 5.4 Retry markers

Following the split that `clipboard.agency` demonstrates:

- `createNote`, `appendToNote`, `deleteNote`: raise an interrupt, then wrap the
  effect in a `destructive { }` region. The gate sits outside the region, so a
  rejected gate leaves the tool callable, while a failure after the write starts
  removes it.
- `readNote`, `searchNotes`, `listNotes`, `listFolders`: marked `idempotent`, and
  they raise an interrupt but have **no** destructive region. Reads are safe to
  re-run but still need permission. This is exactly what `paste()` does, and for
  the same reason.

### 5.5 What PFA buys

```ts
const inbox = createNote.partial(folder: "Agent Inbox").rename("addToInbox")
llm("Log your findings", { tools: [inbox] })
// the model never learns that `folder` is a parameter
```

Combined with the folder assertion from Section 3.4, this covers the whole
surface rather than half of it.

---

## 6. Error handling

### 6.1 The two-minute timeout and the opaque -1712

Every script is wrapped so that we choose the bound instead of inheriting
AppleScript's 120-second default:

```applescript
with timeout of 30 seconds
  ...
end timeout
```

Thirty seconds is a starting value, not a researched one. It should be a
module-level constant so it is trivially changeable.

`-1712` maps to a failure that names the most likely cause without asserting it,
because Section 2.6 established that the code genuinely cannot distinguish causes:

> Notes did not respond within 30s. This usually means macOS automation
> permission was not granted. Check System Settings → Privacy & Security →
> Automation.

The phrasing is deliberately "usually means" rather than "means".

### 6.2 Platform check

Non-`darwin` fails immediately with a clear message, copying `imessage.ts`:

```ts
if (process.platform !== "darwin") {
  throw new Error("Apple Notes is only available on macOS.")
}
```

### 6.3 Locked notes

The pre-flight lookup returns the `password protected` flag. If it is true,
`readNote`, `appendToNote`, and `deleteNote` fail closed with the message from
Section 3.7. We never attempt to unlock.

### 6.4 Append is one script, not two

Read, concatenate, and write all happen inside a single `osascript` invocation,
so there is no gap between processes where another writer could land:

```applescript
set n to note id (item 1 of argv)
set body of n to (body of n) & (item 2 of argv)
```

This narrows the race. It does not eliminate it. Notes offers no transaction, so
a user typing into the note at that exact moment can still lose a keystroke. The
honest claim is "meaningfully safer than two round trips", not "atomic".

### 6.5 deleteNote is recoverable

`delete` moves the note to Recently Deleted, where it stays for about 30 days.
This should be in the docstring, because the function name suggests something
more final than what happens.

### 6.6 Failure mode summary

| Condition | Result |
|---|---|
| Not macOS | Immediate failure, clear message |
| Automation permission not granted | Blocks up to the timeout, then `-1712` mapped to a permission hint |
| Note is locked | Fail closed, tell the user to unlock in Notes.app |
| `folder` assertion does not match | Fail closed |
| Note id does not exist | Failure naming the id |
| Folder does not exist on create | Failure naming the folder |

---

## 7. std::markdown.renderForHtml

A new exported function in `stdlib/markdown.agency`, backed by
`lib/stdlib/markdown.ts`, sitting beside `renderForCli` as a peer.

```ts
export def renderForHtml(blocks: any[]): string {
  """
  Render a Markdown AST to an HTML string.

  @param blocks - The array of block nodes to render
  """
  return _renderMarkdownForHtml(blocks)
}
```

It walks the same AST `parse` produces. Coverage needed for the Notes use case:
headings, paragraphs, bold, italic, strikethrough, inline code, code blocks,
ordered and unordered lists, links, and block quotes.

Two rules that matter:

- **Text content is HTML-escaped.** `&`, `<`, and `>` in a text node become
  entities. Otherwise a note containing `a < b` corrupts the markup.
- **`html-block` and `inline-html` nodes are dropped, not passed through.**
  The markdown AST preserves raw HTML from the source. Emitting it would
  reintroduce exactly the injection path Section 3.6 closes, because the markdown
  is LLM-authored. Dropping is the safe default. If a caller genuinely wants raw
  HTML in a note, that is a separate, explicit decision, and not one this module
  makes for them.

The second rule is a real behavioural difference from `renderForCli`, and it will
surprise someone eventually. It needs a docstring and a test.

---

## 8. Testing

### 8.1 What we cannot test

Real Notes.app cannot be touched in CI. CI has no TCC grant, and Section 2.6
established precisely what that costs: a two-minute block and an opaque failure.
Any test that reaches the real app would be a two-minute flake.

### 8.2 appleNotes.ts unit tests

Following the `imessage.test.ts` pattern exactly: mock `child_process.execFile`,
force `process.platform = "darwin"` in `beforeEach`, restore it in `afterEach`,
and assert against the generated script and argv.

Cases:

- argv construction for each function, asserting data lands in argv and not in
  the script source.
- **The injection test.** A title of `"; do shell script "rm -rf ~"; "` must
  appear as an inert argv entry. This is the most important test in the module.
- `-1712` maps to the permission-hint failure.
- Locked note fails closed and never issues a body read.
- `folder` assertion mismatch fails closed.
- Non-darwin fails immediately.
- Unknown id produces a failure naming the id.

### 8.3 renderForHtml unit tests

Pure function, no mocks. The cheapest and highest-value tests here. In
`lib/stdlib/__tests__/markdown.test.ts` alongside the existing renderer tests:
headings at each level, nested emphasis, code blocks with and without a language,
both list kinds, links, block quotes, HTML-escaping of text content, and
`html-block` being dropped.

### 8.4 Agency-level tests

In `tests/agency/`. These need no LLM calls, per the project's testing guidance:

- Each function raises its interrupt with the correct effect and payload.
- Rejecting the interrupt halts before any write.
- `.partial(folder:)` narrows the tool schema so `folder` is absent from it.
- The folder assertion rejects a mismatched note.

### 8.5 Live verification

Manual and opt-in, never in CI. This has to happen at least once against a real
Notes.app before the module ships, because a dictionary is documentation and
documentation is sometimes wrong. Section 9 is the list of things that can only
be settled this way.

---

## 9. Open questions requiring a live spike

These are unresolved. They should be settled by a spike before implementation
rather than designed around, because guessing wrong on either means rewriting a
code path.

### 9.1 Does setting `name` actually set the title?

The sdef says `name` is read/write. Widely repeated folklore says Notes derives a
note's title from the first line of the `body` and ignores `name`. Both cannot be
true.

This decides whether `createNote` sets `name` directly or has to prepend an
`<h1>` to the rendered body. It changes the create path and it changes what
`renderForHtml` output has to look like at the top.

Spike: create a note with `name` and `body` set to different values, then read
back `name`.

### 9.2 Are `name` and `container` readable on a locked note?

Section 5.3's pre-flight assumes it can read a locked note's title and folder in
order to report them. If Notes errors on any property access to a locked note,
that assumption breaks.

This decides whether locked notes show up in `listNotes` as visible-but-unreadable
or are invisible entirely, which decides what the Section 6.3 error message can
even say.

Spike: lock a note, then read `name`, `container`, and `password protected`.

### 9.3 What does `searchNotes` map onto?

AppleScript `whose` clauses can filter on properties. Whether a body text search
is expressible as a `whose` clause, and whether it is fast enough on a large
corpus, is unverified. The fallback is fetching metadata and filtering in
TypeScript, which would mean `searchNotes` cannot search body text at all without
reading every body, which would defeat the read gate entirely.

This is the highest-risk unknown in the design. If `whose` cannot search bodies,
`searchNotes` either becomes title-only or it has to be cut.

### 9.4 Is `"Notes"` a safe default folder?

Section 4.2 gives `createNote` a default of `folder: string = "Notes"`. That is an
assumption and it has two problems.

Folder names are user-visible strings, and macOS localises them. On a French
system the default folder is likely "Notes" still, but this is unverified, and any
localisation at all makes a hardcoded English default wrong. Separately, folders
live under accounts (iCloud, "On My Mac"), and a user with both may have two
folders named "Notes". Addressing by bare name does not say which.

Options, in order of preference:

- Resolve the true default folder at runtime rather than hardcoding a name, if
  AppleScript exposes a way to ask for it.
- Make `folder` required, so the caller always states it. Slightly worse
  ergonomics, no wrong guesses.
- Keep the `"Notes"` default and document that it is English-default-account only.

Spike: check whether the default folder is reachable without naming it, and what
happens when two accounts both have a "Notes" folder.

This interacts with Section 10's decision to keep accounts out of scope. If the
two-accounts case is common, that exclusion may not survive.

---

## 10. Out of scope

- **Bear and Obsidian.** Section 3.1.
- **Unlocking password-protected notes.** Section 3.7. Explicitly rejected, not
  deferred.
- **Attachments.** The sdef exposes an `attachment` class. Not in this design.
- **Accounts.** Folders are addressed by name in the default account. Multi-account
  addressing is not in this design.
- **Fixing imessage.ts.** Filed as issue #561.
- **Moving notes between folders.** Not requested.

---

## 11. Work breakdown

Rough shape for the implementation plan, which is a separate document.

1. Live spike to settle Section 9. Blocks everything else.
2. `renderForHtml` in `std::markdown`, plus its tests. Independent of the spike,
   so it can go first or in parallel.
3. `lib/stdlib/appleNotes.ts`: argv-based script construction, error mapping,
   pre-flight lookup, plus unit tests.
4. `stdlib/notes/apple.agency`: types, effects, functions, docstrings.
5. `stdlib/capabilities.agency`: the three effect sets.
6. Agency-level tests in `tests/agency/`.
7. Docs. Module doc comments generate the stdlib reference page via `agency doc`,
   so they are written in the source rather than hand-edited. A guide page
   showing the Obsidian `std::fs` pattern is worth including here, since Section
   3.1 makes it the answer for Obsidian users.
8. Manual live verification against real Notes.app.
