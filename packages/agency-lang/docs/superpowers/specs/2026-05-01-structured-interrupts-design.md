# Structured Interrupts V1 — Design Spec

## Problem

Agency's interrupt system is powerful but unstructured. Interrupts carry arbitrary data (`any`), making it hard for handlers to distinguish between interrupt types without string matching. There's no standard way to write permission policies, and no way to know what interrupts a piece of code might throw.

## Goals (V1)

1. Give every interrupt a standard shape: `type`, `message`, `data`
2. Add a compiler-injected `origin` field for security
3. Provide a standard library permission checker (`std::policy`)
4. Keep interrupts easy to create — no declarations or ceremony required

## Non-Goals (V1)

- Declared effect/interrupt types
- Permission schemas (which fields are matchable, match strategies)
- Compiler tracking of which interrupts a function can throw
- Exhaustiveness checking on handlers
- Match strategies other than glob

---

## 1. Interrupt Syntax

### Typed interrupt

The type is a namespace identifier (not a string), followed by message and optional data:

```ts
interrupt std::read("Are you sure you want to read this file?", { relPath: "foo.md", absPath: "/home/user/foo.md" })
```

### Assignment form

```ts
const answer = interrupt std::question("What file should I use?", { default: "foo.md" })
```

### Bare interrupt (backward compatible)

```ts
interrupt("Are you sure?")
```

Desugars to type `"unknown"`, data `{}`.

### User-defined types

Users can use any namespace for their interrupt types:

```ts
interrupt myapp::deploy("Deploy to production?", { env: "prod", version: "1.2.3" })
```

---

## 2. Runtime Interrupt Object

At runtime, every interrupt has this shape:

```json
{
  "type": "std::read",
  "message": "Are you sure you want to read this file?",
  "data": { "relPath": "foo.md", "absPath": "/home/user/foo.md" },
  "origin": "std::fs",
  "interruptId": "abc123",
  "runId": "run-456"
}
```

### Fields

- **`type`** — The identifier from the interrupt call, stored as a string at runtime. E.g. `"std::read"`, `"myapp::deploy"`, `"unknown"` (for bare interrupts).
- **`message`** — Human-readable description of what the interrupt is asking.
- **`data`** — Arbitrary structured data. Typed as `any` in V1.
- **`origin`** — Compiler-injected, unforgeable. The module that threw the interrupt. Uses the same namespace convention as imports: `"std::fs"` for stdlib, `"pkg::my-package"` for packages, `"./path/to/file"` for local files.
- **`interruptId`** — Unique ID for this interrupt instance (nanoid, same as today).
- **`runId`** — Unique ID for the agent run (same as today).

### Origin security

- The `origin` field is injected by the compiler. The interrupt author cannot set or forge it.
- Any code can use any interrupt type (e.g. a third-party package can throw `std::read`). The `origin` field distinguishes where the interrupt actually came from.
- Policy rules can match on `origin` to restrict auto-approval to trusted sources.

---

## 3. Handler Changes (Breaking)

Handler parameter now always has the structured shape `{ type, message, data, origin }`.

### Before

```ts
handle {
  read("foo.md")
} with (data) {
  // data was whatever the interrupt passed — a string, object, anything
  if (data == "Are you sure?") {
    return approve()
  }
}
```

### After

```ts
handle {
  read("foo.md")
} with (interrupt) {
  // interrupt.type, interrupt.message, interrupt.data, interrupt.origin
  if (interrupt.type == std::read) {
    return approve()
  }
}
```

Existing handlers that accessed raw data fields (e.g. `data.filename`) need to update to `interrupt.data.filename`.

### Matching on type

`std::read` in handler conditions is an identifier, not a string. The compiler resolves it to a string comparison at runtime.

---

## 4. Standard Library: `std::policy`

A new stdlib module providing policy-based interrupt evaluation. This is a library, not a language feature — users opt in.

### API

```ts
import { checkPolicy } from "std::policy"
```

- **`checkPolicy(policy, interrupt)`** — Takes a plain JSON policy object and an interrupt object. Returns `approve()`, `deny()`, or `propagate()`.
- **`validatePolicy(policy)`** (optional) — Returns a `Result` indicating whether the policy object is well-formed.

### Usage in Agency (inside a handler)

```ts
import { checkPolicy } from "std::policy"

handle {
  agent()
} with (interrupt) {
  const policy = loadPolicyFromSomewhere()
  return checkPolicy(policy, interrupt)
}
```

### Usage from TypeScript

```ts
import { checkPolicy } from "agency-lang/policy";

const policy = await db.getPermissions(userId);

const result = await main("input", {
  callbacks: {
    onInterrupt: (interrupt) => {
      return checkPolicy(policy, interrupt);
    }
  }
});
```

---

## 5. Policy Format

Policies are plain JSON objects keyed by interrupt type. Each type maps to an ordered array of rules.

### Example

```json
{
  "std::bash": [
    { "match": { "command": "ls *" }, "action": "allow" },
    { "match": { "command": "rm *", "absPath": "/tmp/*" }, "action": "allow" },
    { "match": { "command": "rm *" }, "action": "deny" },
    { "action": "propagate" }
  ],
  "std::read": [
    { "match": { "origin": "std::*", "relPath": "src/**" }, "action": "allow" },
    { "action": "propagate" }
  ],
  "std::http.fetch": [
    { "match": { "url": "https://api.mycompany.com/*" }, "action": "allow" },
    { "action": "deny" }
  ]
}
```

### Evaluation rules

1. Look up rules by `interrupt.type`. If no rules exist for this type, **propagate** (ask the user). This is the safe default.
2. Walk the rules array in order. **First match wins.**
3. For each rule with a `match` object: glob-match every field in `match` against the corresponding field in `interrupt.data` (or `interrupt.origin` for the `origin` key). All fields must match (AND logic).
4. A rule with no `match` object is a catch-all for that type.
5. Fields in the interrupt data not mentioned in `match` are ignored.
6. All matching is glob-based (V1).

### Actions

- **`allow`** — auto-approve the interrupt
- **`deny`** — auto-reject the interrupt
- **`propagate`** — pass to the user for a decision

---

## 6. Stdlib Interrupt Updates

All existing stdlib interrupts migrate from string-type to identifier-type syntax. Path-bearing interrupts include both `relPath` and `absPath` fields so policy writers can match on either.

### Path normalization

Interrupt authors are responsible for resolving paths before including them in interrupt data:

```ts
def read(filename: string) {
  const absPath = resolvePath(filename)
  return interrupt std::read("Are you sure you want to read this file?", { relPath: filename, absPath: absPath })
  return try _read(filename)
}
```

### Full interrupt inventory

| Module | Function | Type | Data Fields |
|--------|----------|------|-------------|
| `std::fs` | `read` | `std::read` | `relPath`, `absPath` |
| `std::fs` | `write` | `std::write` | `relPath`, `absPath`, `content` |
| `std::fs` | `edit` | `std::edit` | `relPath`, `absPath`, `oldText`, `newText`, `replaceAll` |
| `std::fs` | `multiedit` | `std::multiedit` | `relPath`, `absPath`, `edits` |
| `std::fs` | `applyPatch` | `std::applyPatch` | `patch` |
| `std::fs` | `mkdir` | `std::mkdir` | `relPath`, `absPath` |
| `std::fs` | `copy` | `std::copy` | `srcRelPath`, `srcAbsPath`, `destRelPath`, `destAbsPath` |
| `std::fs` | `move` | `std::move` | `srcRelPath`, `srcAbsPath`, `destRelPath`, `destAbsPath` |
| `std::fs` | `remove` | `std::remove` | `relPath`, `absPath` |
| `std::fs` | `readImage` | `std::readImage` | `relPath`, `absPath` |
| `std::shell` | `bash` | `std::bash` | `command`, `cwd`, `timeout`, `stdin` |
| `std::shell` | `ls` | `std::ls` | `relPath`, `absPath`, `recursive` |
| `std::shell` | `grep` | `std::grep` | `pattern`, `relPath`, `absPath`, `flags`, `maxResults` |
| `std::shell` | `glob` | `std::glob` | `pattern`, `relPath`, `absPath`, `maxResults` |
| `std::http` | `fetch` | `std::http.fetch` | `url` |
| `std::http` | `fetchJSON` | `std::http.fetchJSON` | `url` |
| `std::http` | `webfetch` | `std::http.webfetch` | `url` |
| `std::system` | `setEnv` | `std::system.setEnv` | `name`, `value` |
| `std::agent` | `question` | `std::question` | `message`, `prompt` |
| `std::agent` | `notify` | `std::notify` | `title`, `body` |

---

## 7. Implementation Notes

### Parser changes

- Parse `interrupt <namespace-identifier>(args)` as a new AST node variant alongside the existing `interrupt(args)` form.
- The namespace identifier uses the same `::` separator as imports (`std::read`, `pkg::my-tool::deploy`, `myapp::deploy`).
- In handler conditions, `std::read` etc. are parsed as identifiers and compiled to string comparisons.

### Builder changes

- The interrupt creation in generated code changes to include `type`, `message`, `data`, and `origin` fields.
- `origin` is determined at compile time from the module being compiled and injected as a string literal.
- Bare `interrupt("msg")` desugars to `type: "unknown"`, `message: "msg"`, `data: {}`.

### Runtime changes

- The `Interrupt<T>` type gains `type: string`, `message: string`, and `origin: string` fields alongside the existing `data: T`.
- `interruptWithHandlers()` passes the full structured object to handlers.
- Handler functions receive `{ type, message, data, origin }` instead of raw data.

### Standard library additions

- New file: `stdlib/policy.agency` (or TypeScript implementation)
- Exports: `checkPolicy(policy, interrupt)`, optionally `validatePolicy(policy)`
- Glob matching implementation (can use an existing library like `minimatch` or `picomatch`)

---

## 8. Future Work (Post-V1)

These are natural extensions enabled by the structured format:

- **Declared interrupt types**: `effect std::read { relPath: string, absPath: string }` — full type safety on interrupt data
- **Permission schemas**: per-interrupt-type declaration of which fields are matchable and how
- **Compiler effect tracking**: function signatures include which interrupt types they can throw
- **Exhaustiveness checking**: warn when a handler doesn't cover all possible interrupt types
- **Match strategies beyond glob**: exact, contains, regex, numeric comparisons
- **Policy composition**: merging multiple policy objects with precedence rules
- **Time-based rules**: "allow for the next hour" with expiration
