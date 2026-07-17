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

### 2.7 A locked note's body reads as empty, and that is dangerous

This came from the live spike (Section 9.2). It is the most important safety
finding in the document.

Reading `body` of a locked note does not fail. Notes returns an **empty string**:

```
--- body (EXPECTED TO FAIL or return empty) ---
                                                  <- blank. No error, no content.
```

Now recall what append does (Section 6.4). It reads the body, concatenates, and
writes it back. On a locked note that becomes:

```applescript
set body of n to "" & "the new text"
```

That **replaces the note's contents with the appended text**. The user's locked
note is destroyed, silently, by an operation named "append".

The `password protected` flag is readable, so the guard in Section 6.3 catches
this. But the framing matters, and the original draft got it wrong. That guard is
not a nicety that produces a friendlier error. It is the only thing standing
between a locked note and silent data loss. It must never be skipped, never
reordered to after the read, and never removed as apparently-dead code. Section
8.2 requires a test whose whole job is to fail if someone does.

We do not know whether `set body` on a locked note would actually succeed. It may
error harmlessly. The design must not depend on finding out.

### 2.8 There are two permission errors, and one of them is clear

Section 2.6 said `-1712` is the only signal and cannot distinguish causes. That
is incomplete. A second error exists:

```
execution error: Not authorized to send Apple events to Notes. (-1743)
```

They mean different things:

| Code | Meaning |
|---|---|
| `-1743` | Not authorized. No grant, or it was denied. No dialog is pending. |
| `-1712` | AppleEvent timed out. Usually a consent dialog is on screen, unanswered. |

`-1743` is unambiguous and should be mapped as a clean permission error. `-1712`
stays ambiguous and keeps its hedged wording. Section 6.1 maps both.

Worth knowing: **TCC grants are per calling application.** A grant given to
Terminal does not extend to any other process. That is how `-1743` appears on a
machine where Notes automation already works fine for the user, and it is why
Section 9.2 could not be settled without the owner present.

### 2.9 There is no way to unlock a locked note

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

### 3.1a Status of this document

**Revised 2026-07-16** after an external review and a live spike against real
Notes.app. The revision folded in eleven review findings and four measured
answers. Two things the original asserted turned out to be wrong, and both are
corrected in place rather than quietly dropped:

- The `osascript` argv example in Section 3.6 was off by one. Verified wrong.
- Section 2.6 claimed `-1712` was the only permission signal. See Section 2.8.

One blocker remains open, in Section 9.2. It must be settled before the Notes
module is implemented.

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

await execFileAsync("osascript", ["-e", SCRIPT, title, body])
```

`argv` values are never parsed as AppleScript. This removes the vulnerability
class instead of escaping around it.

**Do not put a `-` before the arguments.** An earlier draft of this spec did.
`osascript` does not treat `-` as a separator; it passes it straight through as
`item 1 of argv`, shifting every real argument by one. Verified on macOS 14.7.4:

```
$ osascript -e 'on run argv
  return argv
end run' - "hello" "world"
-, hello, world          # the `-` is argv item 1

$ osascript -e 'on run argv
  return argv
end run' "hello" "world"
hello, world             # correct
```

The security claim itself is verified, not assumed. Passing this section's own
injection payload as an argument returns it inert, with no evaluation and no
shell-out:

```
$ osascript -e 'on run argv
  return item 1 of argv
end run' '"; do shell script "echo pwned"; "'
"; do shell script "echo pwned"; "
```

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
  account: string
  modified: string
  passwordProtected: boolean
}

/** A note including its content, as plaintext. */
export type NoteContent = {
  id: string
  title: string
  folder: string
  account: string
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
createNote(title: string, body: string, folder: string = "Agency Notes",
           account?: string): Result<Note> raises <std::notes::create>

appendToNote(id: string, body: string, folder?: string,
             account?: string): Result<Note> raises <std::notes::append>

readNote(id: string, folder?: string,
         account?: string): Result<NoteContent> raises <std::notes::read>

searchNotes(query: string, folder?: string,
            account?: string): Result<Note[]> raises <std::notes::search>

listNotes(folder?: string,
          account?: string): Result<Note[]> raises <std::notes::list>

listFolders(account?: string): Result<Folder[]> raises <std::notes::list>

deleteNote(id: string, folder?: string,
           account?: string): Result<null> raises <std::notes::delete>
```

Four things about these signatures are deliberate, and three of them came from
review findings.

**Typed results, not bare `Result`.** Section 4.1 argues the `Note` /
`NoteContent` split makes "does this call expose note contents" answerable from
the signature. A bare `Result` with the real type in a comment does not deliver
that, because a comment is not a signature. `stdlib/agency.agency` already uses
`Result<TypeCheckReport>` and friends, so this is the house style.

**`raises` on every signature.** `stdlib/capabilities.agency`'s own module doc
says individual functions should declare the specific effect they raise, and
`stdlib/git.agency` follows it (`export idempotent def gitStatus(...): GitStatus
raises <std::git::status>`). `imessage.agency` does not, which is where the
original omission came from. `git.agency` is the newer and better precedent.

**`account` is optional and defaults to the default account.** See Section 3.4.
It exists so folder scoping is a real guarantee rather than an advisory one.

**`folder` defaults to `"Agency Notes"`, and may not exist yet.** Chosen by the
owner so a user can see at a glance which notes an agent made, and rename the
folder if they want. Unlike Apple's `"Notes"`, it will not exist on a fresh
machine, so `createNote` creates it on demand. Section 9.4.

**A naming trap worth a docstring on each function:** `body` on `createNote` and
`appendToNote` is **markdown**, but `body` on `NoteContent` is **plaintext**.
That falls out of Section 2.4 rather than being a choice, and it will confuse
someone.

---

## 5. Safety model

Three layers, all of them existing language features. Nothing new is invented.

### 5.1 Effects

```ts
effect std::notes::create { account: string, folder: string, title: string,
                            folderCreated: boolean }
effect std::notes::append { account: string, folder: string, title: string, id: string }
effect std::notes::read   { account: string, folder: string, title: string, id: string }
effect std::notes::search { account: string, folder: string, query: string }
effect std::notes::list   { account: string, folder: string }
effect std::notes::delete { account: string, folder: string, title: string, id: string }
```

Per-operation effects rather than one blanket `std::notes`, so that a policy can
approve reads and reject deletes. A single effect would make the whole mechanism
useless here.

Payloads carry `account`, `folder`, and `title` because those are what policies
glob against:

```json
{
  "std::notes::read": [
    { "match": { "account": "iCloud", "folder": "Work" }, "action": "approve" },
    { "action": "reject" }
  ],
  "std::notes::delete": [{ "action": "reject" }]
}
```

Payload design is safety design. A payload that omitted `folder` would make
folder-scoped policies impossible to write.

**The original spec broke its own rule in the line directly above that sentence.**
`std::notes::search` was declared as `{ query: string }` with no `folder`, while
Section 4.2 gave the function a `folder` argument and called it a scope. So
`searchNotes` was scopable by PFA but not by policy, and it is the one read that
fans out across the corpus. A user writing the policy above would reasonably think
they had confined reads to Work, and `searchNotes` would have slipped past every
folder rule they could express. Caught in review. All six payloads have been
re-checked against their signatures, not just that one.

`folderCreated` on `std::notes::create` exists because the `"Agency Notes"` default
may not exist yet, so `createNote` can make a folder as a side effect. That is a
write, and a write should be visible to whoever is approving the call rather than
hidden inside another operation. Section 9.4.

**One thing to verify during implementation, not to assume.** Optional parameters
widen to `T | null` (`lib/parsers/function.test.ts:3618`), so a payload's `folder`
is `null` when the caller omits it. What a policy glob does when matched against
`null` is unknown. If `{"match": {"folder": "Work"}}` silently fails to match a
null folder and falls through to a later approve rule, that is a fail-open on
`listNotes()` with no arguments, which is the call with the widest reach. Check the
matcher, state the answer, and test it.

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

That query reads three properties and nothing else:

```applescript
on run argv
  tell application "Notes"
    set n to note id (item 1 of argv)
    return (name of n) & tab & (name of container of n) & tab & ¬
           ((password protected of n) as text)
  end tell
end run
```

`body` and `plaintext` are never touched. The unguarded step learns a title, a
folder name, and a locked flag. It never learns a single byte of note content.

The reason this is acceptable is **not** that the step is unreachable without a
gate. An earlier draft claimed exactly that, saying "the only ways to obtain a
note id are `listNotes` and `searchNotes`, and both raise interrupts". Review
showed that is too strong. Ids are stable (Section 2.2), so they outlive the call
that produced them. An id can reach a caller from the user's own message, from a
note in a file, from a previous run's transcript, or from a restored checkpoint,
none of which raise a Notes interrupt in this run.

The argument that actually survives is narrower. **An id is unguessable.** It is
an opaque `x-coredata://` URI that cannot be enumerated or constructed. So anyone
holding one already learned it somewhere, and the lookup discloses only the title
and folder that whoever handed them the id could already name. The step reveals
nothing new to a caller who has an id, and a caller without one cannot invoke it.

That distinction matters because Section 5.3's reasoning is meant to go in the
module source, where it will be read by the next person deciding whether to add a
third property to this query. "Unreachable without a gate" would license adding
anything. "Discloses only what the id-holder already knows" does not.

**This entire section is contingent on Section 9.2.** The pre-flight reads
`name of container`, and the spike could not confirm that works.

### 5.4 Retry markers

Following the split that `clipboard.agency` demonstrates:

- `createNote`, `appendToNote`, `deleteNote`: raise an interrupt, then wrap the
  effect in a `destructive { }` region. The gate sits outside the region, so a
  rejected gate leaves the tool callable, while a failure after the write starts
  removes it.
- `readNote`, `searchNotes`, `listNotes`, `listFolders`: marked `idempotent`, and
  they raise an interrupt but have **no** destructive region. Reads are safe to
  re-run but still need permission.

The original spec cited `paste()` in `clipboard.agency` for both halves of that.
Only one half was right. `paste()` does demonstrate "interrupt but no destructive
region", but it carries no `idempotent` marker at all, so it cannot be the
precedent for marking reads. Use `stdlib/git.agency`, which marks all nine of its
read functions (`export idempotent def gitStatus`, `gitLog`, `gitDiff`,
`gitBlame`, and so on), or `stdlib/index.agency`, which marks `read` and
`readBinary`.

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

### 6.1 The two permission errors

Every script is wrapped so that we choose the bound instead of inheriting
AppleScript's 120-second default:

```applescript
with timeout of 30 seconds
  ...
end timeout
```

The spike confirmed this works: with no grant in place, `with timeout of 10
seconds` stopped at about 10 seconds rather than 120 (Section 9.5). Thirty
seconds is a starting value, not a researched one. It should be a module-level
constant.

Two error codes get mapped, and they say different things (Section 2.8).

`-1743` is unambiguous, so its message is too:

> Not authorized to control Notes. Grant permission in System Settings →
> Privacy & Security → Automation.

`-1712` is ambiguous, so its message hedges:

> Notes did not respond within 30s. This usually means macOS automation
> permission was not granted. Check System Settings → Privacy & Security →
> Automation.

The "usually means" is deliberate. That code also covers a busy or wedged Notes,
and we cannot tell which from the exit status. Claiming otherwise would send
someone to fix a permission that was never the problem.

### 6.2 Platform check

Non-`darwin` fails immediately with a clear message, copying `imessage.ts`:

```ts
if (process.platform !== "darwin") {
  throw new Error("Apple Notes is only available on macOS.")
}
```

### 6.3 Locked notes fail closed, and this prevents data loss

The pre-flight lookup returns the `password protected` flag. If it is true,
`readNote`, `appendToNote`, and `deleteNote` fail closed with the message from
Section 3.7. We never attempt to unlock.

**Read Section 2.7 before touching this.** A locked note's body reads as an empty
string rather than erroring, so an append that skipped this guard would replace
the note's contents with the appended text. This check is not about producing a
nice error. It is the only thing preventing silent destruction of a locked note.

### 6.4 Append is one script, but the assertion still needs re-checking

Read, concatenate, and write all happen inside a single `osascript` invocation,
so there is no gap between processes where another writer could land.

The original spec stopped there, and review caught that it contradicted Section
5.3. The pre-flight lookup is a *separate, earlier* `osascript` invocation, and
Sections 3.4 and 6.3 hang the folder assertion and the locked check on its
results. So the real sequence is:

1. `osascript` #1: read name, container, password-protected.
2. Assert the folder matches. Check the locked flag. Raise the interrupt.
3. **A human approves. This can take arbitrarily long.**
4. `osascript` #2: read-modify-write the body.

The gap Section 6.4 claimed does not exist is the gap between steps 1 and 4, and
it spans a human approval. In that window the note can move to another folder or
be locked. So the assertion was check-then-act, and Section 6.6's unconditional
"assertion does not match → fail closed" was not something the design delivered.

The fix is cheap and it uses data already in argv. Re-assert inside the write
script, in the same `tell` block as the mutation:

```applescript
on run argv
  tell application "Notes"
    set n to note id (item 1 of argv)
    if (name of container of n) is not (item 3 of argv) then
      error "folder mismatch"
    end if
    if (password protected of n) then error "note is locked"
    set body of n to (body of n) & (item 2 of argv)
  end tell
end run
```

Now the pre-flight exists only to build the interrupt payload, which is what
Section 5.3 says it is for, and the assertion is a guarantee rather than a
best-effort. The locked re-check belongs here too, for the same reason and with
much higher stakes (Section 2.7).

This still does not make append atomic. Notes offers no transaction, so a user
typing into the note at that exact moment can lose a keystroke. The honest claim
is "meaningfully safer than two round trips", not "atomic".

Note this interacts with Section 9.2. If the container cannot be read, this
script cannot assert on it either.

### 6.5 deleteNote is recoverable

`delete` moves the note to Recently Deleted, where it stays for about 30 days.
This should be in the docstring, because the function name suggests something
more final than what happens.

### 6.6 Failure mode summary

| Condition | Result |
|---|---|
| Not macOS | Immediate failure, clear message |
| Automation permission denied or absent | `-1743` mapped to a clear "not authorized" failure |
| Consent dialog on screen, unanswered | Blocks up to the timeout, then `-1712` mapped to a hedged permission hint |
| Note is locked | Fail closed. Re-checked in the write script. Section 2.7 |
| `folder` / `account` assertion does not match | Fail closed. Re-checked in the write script. Section 6.4 |
| Note id does not exist | Failure naming the id |
| Folder does not exist on create | Created, with `folderCreated: true` in the payload. Section 9.4 |

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

A third rule, added after implementation: **URL schemes are restricted.** Only
`http`, `https`, `mailto`, `tel`, and relative paths survive. Anything else,
notably `javascript:` and `data:`, is dropped and the link renders as plain text.
An LLM writing `[click](javascript:...)` into a note is the same untrusted-input
problem Section 3.6 addresses, one layer up.

Frontmatter is omitted, matching what conventional Markdown-to-HTML renderers do
with document metadata.

**Status: implemented.** `_renderMarkdownForHtml` in `lib/stdlib/markdown.ts`,
exported as `renderForHtml` from `stdlib/markdown.agency`, with 34 unit tests in
`lib/stdlib/__tests__/markdown.test.ts`. The three security properties above were
mutation-tested: neutering the URL sanitiser fails 4 tests, passing raw HTML
through fails 2, and removing escaping fails 5. Section 9.1's answer means the
renderer needs no leading `<h1>`, so it is genuinely independent of the Notes
module, exactly as Section 11 hoped.

---

## 8. Testing

**Unit tests only. No integration tests.** Decided by the owner, for a concrete
reason: a test that reaches the real Notes.app can damage real notes when someone
runs the suite locally. There is no safe way to write an automated test that
mutates a live personal database, so we do not write one.

This is not merely a CI constraint, though it is that too. CI has no TCC grant, so
any test reaching the real app would also be a two-minute flake (Section 2.6).

### 8.1 What this rules out

- No tests in `tests/agency/` that call `createNote`, `appendToNote`, or any
  other function in this module. Those execute the real stdlib, which shells to
  `osascript`, which touches the user's real notes. An earlier draft of this spec
  proposed exactly that. It was wrong.
- No live verification step in the work breakdown.

The four questions that genuinely need the real app are handled by a one-off
manual spike (Section 9), not by anything committed or automated.

### 8.2 appleNotes.ts unit tests

Following the `imessage.test.ts` pattern exactly: mock `child_process.execFile`,
force `process.platform = "darwin"` in `beforeEach`, restore it in `afterEach`,
and assert against the generated script and argv.

Cases:

- argv construction for each function, asserting data lands in argv and not in
  the script source.
- **The injection test.** A title of `"; do shell script "rm -rf ~"; "` must
  appear as an inert argv entry. This is the most important test in the module.
- `-1743` maps to a clear "not authorized" failure.
- `-1712` maps to the hedged permission-hint failure.
- **The locked-note test.** A note whose `password protected` reads `true` must
  fail closed, and `appendToNote` must never issue a body write for it. Per
  Section 2.7 this is data-loss prevention, not cosmetics. This test exists so
  that deleting the guard fails the build.
- `folder` assertion mismatch fails closed.
- Non-darwin fails immediately.
- Unknown id produces a failure naming the id.

### 8.3 renderForHtml unit tests — done

Pure function, no mocks. 34 tests in `lib/stdlib/__tests__/markdown.test.ts`,
covering headings at each level, nested emphasis, code blocks with and without a
language, both list kinds, task-list checkboxes, links, images, block quotes,
tables with alignment, HTML-escaping of text and of table cells, raw HTML being
dropped, unsafe URL schemes being dropped, frontmatter being omitted, and junk
input being skipped rather than throwing.

The file did not exist before this work, so `renderForCli` had no tests either.
It still has none; adding them is out of scope here but worth filing.

---

## 9. The live spike, and what it measured

A one-off manual spike ran against real Notes.app on macOS 14.7.4. It was not a
test and nothing about it is committed. Every note it created went into a
throwaway folder called "Agency Spike", which it then deleted.

Three of the four questions are answered. One turned into a blocker.

### 9.1 Does setting `name` set the title? **Yes. Resolved.**

The folklore is wrong. Creating a note with `name` and the body's first line set
to different values, then reading `name` back:

```
name property reads back as: TITLE_FROM_NAME
```

So `createNote` sets `name` directly, and `renderForHtml` needs no leading
`<h1>`. This also confirms the renderer is genuinely independent of the Notes
module, which is why it could be built first.

### 9.2 Is a locked note's metadata readable? **Partly. This is the blocker.**

Mixed, and the mix is the problem:

| Property | Result |
|---|---|
| `name` | `lockme` — readable |
| `password protected` | `true` — readable |
| `body` | **empty string, no error** — see Section 2.7 |
| `container` | **error -1728, "Can't get name of container of note..."** |

The good half: `name` and `password protected` both read fine, so we can always
detect a locked note and name it in an error. Locked notes are
visible-but-unreadable, not invisible.

The blocker: **`name of container` errored, and the spike cannot say why.** The
probe was designed badly. It never read `name of container` on an *unlocked*
note, so two very different explanations both fit:

1. Locked notes hide their container. A narrow problem, affecting only the
   locked path, which already fails closed.
2. `name of container of note X of folder Y` does not work on any note. If so,
   **Section 5.3's pre-flight lookup is broken**, and with it the folder
   assertion in Section 3.4, the `folder` field in every payload in Section 5.1,
   and the account resolution in Section 3.4's repair. That is most of the
   scoping story.

Until this is settled, no part of the Notes module that depends on the pre-flight
should be implemented.

Settling it needs one read-only command against an unlocked note:

```bash
osascript -e 'tell application "Notes"
  return name of container of note "TITLE_FROM_NAME" of folder "Agency Spike"
end tell'
```

Returns `Agency Spike` → explanation 1, narrow fix. Errors with `-1728` →
explanation 2, and Section 5.3 needs rework before the plan is written.

It has to be run from a terminal the user has granted Notes automation to. A
different process gets `-1743` regardless of the answer (Section 2.8), which is
why this could not be resolved without the owner present.

### 9.3 Can `whose` search note bodies? **Yes, both ways. Resolved.**

The highest-risk unknown landed on the good side. A note with a marker in its
body but never in its title:

```
test A: notes whose body contains the marker       -> matches: 1
test B: notes whose plaintext contains the marker  -> matches: 1
test C: notes whose name contains "searchtarget"   -> matches: 1  (control)
```

`searchNotes` is viable and can search content, so it survives intact.

**Design decision that falls out of this:** search `plaintext`, not `body`. Both
work, but `body` is HTML, so searching it matches markup. A user searching for
`div` or `style` would match every note they own. `plaintext` has no markup and
matches what a person means.

### 9.4 Is the default folder safe? **Resolved, and the question changed.**

The owner chose **"Agency Notes"** as the default folder rather than `"Notes"`,
so that a user can see at a glance which notes an agent created, and rename the
folder if they like.

This dissolves the localisation problem, since the name is now ours rather than
Apple's. It introduces a new requirement: **"Agency Notes" will not exist on a
fresh machine, so `createNote` has to create it on demand.** That is a write, and
it should be visible. Rather than invent a separate `createFolder` effect, the
`std::notes::create` payload gains `folderCreated: boolean`, so a policy or a
human can see a folder being made.

The spike also confirmed a cleaner way to find the real default, if we ever want
it:

```
account: iCloud | default folder: Notes
```

`default folder of account` works, so the default is queryable rather than
guessable.

On the owner's machine there is exactly **one** account. So the multi-account
ambiguity of Section 3.4 cannot occur there today. The `account` argument is
still in the design, because the owner asked for it and because it is correct for
other people, but it is insurance rather than a fix for a live problem.

### 9.5 Does `with timeout` bound the consent wait? **Yes. Resolved.**

Added to this section on the reviewer's argument that Section 6.1 depended on an
unverified assumption, which was correct.

Owner-reported: with no grant in place, `with timeout of 10 seconds` stopped at
about 10 seconds rather than running to AppleScript's 120-second default. Section
6.1 stands as written.

Consistency check on that report: at the time it ran the grant did not yet exist,
so an instant return was impossible, and a 10-second stop can only mean the
timeout bounded it.

---

## 10. Out of scope

- **Bear and Obsidian.** Section 3.1.
- **Unlocking password-protected notes.** Section 3.7. Explicitly rejected, not
  deferred.
- **Attachments.** The sdef exposes an `attachment` class. Not in this design.
- **Fixing imessage.ts.** Filed as issue #561.
- **Moving notes between folders.** Not requested.
- **Tests that touch real Notes.app.** Section 8.

Accounts **were** on this list. They are now in scope, per Section 3.4 and the
owner's decision. Section 9.4 predicted the exclusion would not survive, and it
did not.

---

## 11. Work breakdown

Rough shape for the implementation plan, which is a separate document.

**Done.**

1. Live spike, Section 9. Three of four questions answered. 9.2 is still open and
   still blocks the Notes module.
2. `renderForHtml` in `std::markdown`, plus 34 unit tests. Section 9.1's answer
   confirmed this is independent of the Notes module, so it went first.

**Blocked on Section 9.2.** Everything below depends on the pre-flight lookup,
which is exactly what 9.2 puts in doubt.

3. `lib/stdlib/appleNotes.ts`: argv-based script construction, error mapping for
   `-1743` and `-1712`, pre-flight lookup, the locked-note guard, plus unit tests.
4. `stdlib/notes/apple.agency`: types, effects, functions, docstrings.
5. `stdlib/capabilities.agency`: the three effect sets.

**Not blocked.**

6. Docs. Module doc comments generate the stdlib reference page via `agency doc`,
   so they are written in the source rather than hand-edited. A guide page
   showing the Obsidian `std::fs` pattern is worth including here, since Section
   3.1 makes it the answer for Obsidian users.

---

## 12. Outstanding review findings

An external review raised eleven findings. These are folded in above:

| # | Finding | Where |
|---|---|---|
| 1 | argv example off by one. Verified wrong. | 3.6, fixed |
| 3 | Folder name is not an address | 3.4, account argument |
| 10 | Missing `with timeout` spike | 9.5, resolved |
| 11 | 9.1 blocks the renderer; 9.3 fallback is a cut | 9.1 and 9.3, both resolved |

These remain to be applied when the module itself is written, and are recorded
here so they are not lost:

| # | Finding | Action |
|---|---|---|
| 2 | `std::notes::search` payload omits `folder`, contradicting Section 5.1's own rule | Add `folder` and `account`. Re-check all six payloads against their signatures. |
| 4 | The folder assertion is check-then-act. The gap between the pre-flight and the write spans a human approval, so the note can move or be locked in between. | Re-assert inside the write script, in the same `tell` block as the mutation. |
| 5 | No signature declares `raises`, though Section 5.2 adds effect sets whose only purpose is `raises` clauses. `git.agency` is the precedent, not `imessage.agency`. | Add `raises <std::notes::read>` etc. to all seven. |
| 6 | Section 5.4 cites `paste()` as `idempotent`. It has no marker. The "interrupt but no destructive region" half of the citation is right; the other half is not. | Cite `git.agency` or `index.agency`, which do mark their reads. |
| 7 | Optional parameters widen to `T \| null`, so a payload's `folder` is `null` when omitted. Unknown what a policy glob does when matched against `null`. A silent non-match that falls through to a later approve rule would fail open on `listNotes()`, the call with the widest reach. | Verify the matcher's behaviour, state it, and test it. |
| 8 | Signatures return bare `Result`, with the real type in a comment. That discards the `Note` vs `NoteContent` split Section 4.1 argues for, since a comment is not a signature. | Use `Result<NoteContent>`, `Result<Note[]>`, `Result<Folder[]>`. `agency.agency` is the precedent. |
| 9 | Section 5.3's "the only ways to obtain an id are gated" is too strong. Ids are stable, so they outlive the call that produced them and can arrive from a user message, a file, or a restored checkpoint. | Reframe: an id is unguessable, so whoever holds one already learned it somewhere, and the lookup discloses only what they could already name. That claim survives. |
| 11b | Section 7 assumes dropping raw HTML silently. | Decide silent versus a diagnostic. Currently silent. |
