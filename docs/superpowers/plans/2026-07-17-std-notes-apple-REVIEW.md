# Review: std::notes/apple implementation plan

Date: 2026-07-17
Reviewing: `/Users/adityabhargava/agency-notes-92/docs/superpowers/plans/2026-07-17-std-notes-apple.md`
Method: read the plan, then ran its assumptions against the real toolchain — parsed its
Agency snippets, executed a Result-narrowing probe, and diffed `origin/main` to check its
upstream dependency. Findings marked **verified** were executed; **argued** were not.

---

## Summary

The plan is strong where it matters most. Task ordering is right, the runner is correctly
isolated as the only `osascript` call site, and the two mutation steps (5 in Task 1, 5 in
Task 4) are the right instinct — they encode the lesson from #562 that a green suite
proves nothing. The safety comments are unusually good: the "unguessable id" docstring in
Task 2 and the locked-guard warnings are written to survive a future refactor, which is
exactly what they need to do.

But **the plan does not compile as written**, and I verified this rather than suspecting
it. Two blockers, both mechanical, both currently spread across the canonical code blocks
an executing agent will copy verbatim:

1. `if...then...else` as an argument value does not parse. Five occurrences. Task 5 fails at Step 2.
2. `!exists` on a narrowed `Result` is always `false`. The `folderCreated` safety signal is always wrong, in the fail-open direction, and the typechecker does not catch it.

Neither is deep. Both need fixing before an agent executes this, because both live in
code the plan instructs someone to write down verbatim.

The good news: the upstream dependency is clean. **PR #562 merged** (`cf74ec0ed`), and all
three security findings from that review were fixed before it landed — I checked
`origin/main` directly. `TABLE_ALIGNMENTS` is now an allowlist, `start` and heading level
go through `Number.isInteger`, `escapeHtml` coerces non-strings, and `sanitizeHtmlUrl`
rejects protocol-relative URLs with the reasoning in a comment. So `createNote`'s
markdown→HTML path is safe to build on, and Task 5 can rely on it.

---

## Blocker 1 — `if...then...else` as an argument value does not parse. **Verified.**

The plan writes this five times (lines 1364, 1383, 1401, 1416, 1444):

```ts
folder: if folder == null then "" else folder,
```

I ran both forms through the real parser:

```
if-then-else as ARG value   → FAILS TO PARSE
if-then-else as CONST value → PARSES
```

So every interrupt payload in Task 5 fails at Step 2's `pnpm run ast` gate. That gate will
catch it — the plan is not silently broken — but an agent will hit five parse failures
with no fix in hand and start improvising inside the security-critical module.

What makes this worth calling out rather than shrugging at: **the plan already knows.**
Line 1463 says "If `if ... then ... else` as an argument value fails, hoist it to a
`const` first — `if` expressions are only allowed as a `const`/`let` value or a `return`."
That is the correct diagnosis and the correct fix, written as a contingency for something
that is not a contingency. It is certain. It should be in the code, not in a footnote
under it.

Fix — hoist in each of the five functions:

```ts
export def appendToNote(id: string, body: string, folder?: string): Result<Note> raises <std::notes::append> {
  const html = toHtml(body)
  if (isFailure(html)) {
    return html
  }
  const folderLabel = if folder == null then "" else folder

  return interrupt std::notes::append("Append to a note in the Notes app?", {
    account: "",
    folder: folderLabel,
    title: "",
    id: id
  })
  ...
```

Worth a note in Global Constraints too, since it's a general Agency rule an agent will hit
again, and it pairs with the existing memory that Agency has no `? :` ternary at all.

---

## Blocker 2 — `!exists` is always `false`, and it silently breaks a safety payload. **Verified.**

Task 5's `createNote`:

```ts
const exists = try _folderExists(folder)
if (isFailure(exists)) {
  return exists
}
...
folderCreated: !exists
```

A narrowed `Result` is still the wrapper object. I probed the runtime:

```
bare exists:   { __type: 'resultType', success: true, value: true }
negated bare:  false
```

`!exists` negates an object, so it is **always `false`**, whether the folder exists or not.
It must be `!exists.value`.

Three things make this worse than an ordinary typo:

**The plan contradicts itself two lines later.** Line 1345 writes `html.value` after the
identical `isFailure(html)` narrowing. So the plan uses both conventions in one function,
and only one of them is right. That inconsistency is the tell.

**The typechecker does not catch it.** I ran `pnpm run diagnostics` on the pattern and it
reported nothing. This ships green.

**It fails open in a safety payload.** The plan's own comment at line 1082 says
`folderCreated` exists "so a human or policy sees the folder being made." That signal is
now permanently `false` — permanently "nothing new is being created" — on the one
operation that silently creates a folder in the user's Notes. A policy written as
`{"match": {"folderCreated": true}, "action": "reject"}` would never fire. The human
approving the interrupt is told the safe thing regardless of the truth.

Fix: `folderCreated: !exists.value`, and add a Task 5 test pinning it — the payload for a
create into a missing folder must carry `folderCreated: true`. Right now nothing in the
plan would notice.

Worth a scan of Task 5 for other bare-Result uses; these two were the ones I found by
reading, not by an exhaustive check.

---

## Finding 3 — The read path kept the TOCTOU the write path was fixed to remove. **Argued.**

Task 4 correctly fixes the check-then-act gap flagged in the spec review, and the reasoning
at line 931 is right: address the note *through* the folder (`note id X of folder Y`) so
the lookup failing *is* the assertion failing, and the check cannot drift from the access
across the human approval.

Task 3's `_readNote` does not do this. It uses `assertFolder(p, folder)` — read the
container, compare strings — and then reads with an **unscoped** `note id (item 1 of argv)`.
So the window the write path just closed is still open on the read path: between the
pre-flight and the read sits an interrupt and a human approval, and the note can move
folders in it.

The plan half-acknowledges this at line 750: "This is the read-path assertion. The write
path uses a scoped lookup instead, which is stronger." It says which is stronger without
saying why read gets the weaker one.

That matters because reading is the operation the folder scoping was *invented* for. The
spec's motivating example is `readNote.partial(folder: "Work")` confining an agent to Work
notes, and the guide (Task 6, line 1605) tells users "the model may pass any id it likes.
Anything outside Work fails closed." Under a scoped write and an unscoped read, that
sentence is true for `appendToNote` and not quite true for `readNote`.

`READ_SCRIPT` can take the same treatment as `APPEND_SCOPED_SCRIPT` — two shapes, scoped
and unscoped — at no extra cost. If there's a reason not to, the asymmetry should be
argued in the plan rather than left as an observation.

---

## Finding 4 — The `account: ""` gap is well-flagged but under-tested. **Argued.**

The Self-Review is honest about this, and I want to credit it: it names the gap, names the
consequence ("folder scoping is still advisory on a multi-account machine — the exact
thing spec §3.4 argued had to be fixed"), and says not to let it merge silently. That is
the right disclosure.

Two things would make it stick better than a paragraph at the bottom of the plan:

- **Every payload hardcodes `account: ""`** while `_preflightNote` actually resolves the
  real account. So the data exists and is thrown away at the boundary. Passing the real
  account through on the paths that have it (`append`, `read`, `delete`, all of which
  pre-flight) costs nothing and shrinks the gap to just `create`/`list`/`search`.
- The guide (Task 6) states the confinement claim unconditionally. If account scoping is
  advisory in v1, the guide should say so, or it becomes the document people trust.

---

## Finding 5 — `FIELD_DELIM` is a raw control byte in source. **Verified. Not a bug.**

I checked the actual bytes, because a `""`-looking literal in a plan usually means the
character got eaten somewhere:

```
export const FIELD_DELIM = "<0x01>";
   hex:  22 01 22   →  quote, U+0001, quote
```

So it is correct as written — a real U+0001. The choice itself is right, and the reasoning
(line 220: titles can legally contain tabs) is a good catch most people would miss.

But a raw, invisible control byte in a TypeScript source file is fragile in a way the
escape isn't: it's invisible in every editor, it survives copy-paste unreliably, and the
test at line 191 asserts `toBe("<0x01>")` with a *second* raw byte — so if either byte is
mangled in transit, the test mangles with it and still passes. Write both as `""`.
Same value, same test, no invisible state.

---

## Finding 6 — Smaller things

- **Task 2 Step 5 fixes a typo Task 2 Step 3 deliberately introduces.** Line 462 writes
  `errors -1712... no: -1728` into a comment, then a whole step exists to clean it up.
  Just write the comment correctly in Step 3 and delete Step 5. As written, an agent
  copying the block faithfully lands a visibly confused comment in the security-critical
  file, and the fix depends on a later step nobody skips.
- **Test counts drift.** Task 2 says "PASS, 17 tests"; counting its own blocks gives 18
  (7 preflight + 2 assertNotLocked on top of Task 1's 9). Task 3's "29" is consistent with
  18, so the 17 is the typo. Task 4's "40" doesn't reconcile with 29 + 10 = 39 either.
  Minor, but these are pass/fail gates — an agent that trusts them will chase a phantom.
- **Task 7 expects "markdown 46 tests"**; #562 merged with 34. Whatever the real number,
  it isn't 46.
- **Task 5 Step 5 contradicts itself**: "Create `/tmp/notes-check.agency` in the repo (NOT
  in /tmp — Agency needs node_modules)" then `cp /tmp/notes-check.agency ./`. Write it
  directly into the repo and drop the `/tmp` round trip.
- **`listFolders` raises `std::notes::list`**, sharing an effect with `listNotes`. Those
  disclose different things — folder names and counts vs. note titles — so a policy can't
  approve one and reject the other. Probably fine for v1, but it's a payload-design
  decision the spec's own §5.1 rule ("payload design is safety design") would want stated.
- **`import { parse, renderForHtml } from "std::markdown"` inside a stdlib module** — worth
  a glance for the auto-import/prelude cycle gotcha before Task 5 Step 4, since `make` is
  where that would surface.

---

## What's good

- **Task 1's isolation of `runNotesScript` as the only `osascript` call site** is the
  single best structural decision here. Every injection guarantee reduces to one function.
- **The mutation steps** (Task 1 Step 5, Task 4 Step 5) are the right response to #562, and
  Task 4's is aimed at exactly the right target: the locked guard is the one line whose
  removal silently destroys user data.
- **The Task 2 docstring** telling a future reader *not* to write "unreachable without a
  gate" and explaining why the weaker claim would license widening the query — that is
  writing for the person who comes back in six months.
- **Global Constraints** as a section is the right shape: each entry is a finding that cost
  a spike, not a style preference, and each cites its spec section.
- **The Self-Review's honesty** about findings 7 and 11b and the `account` gap. A plan that
  says "this workaround is a guess, not a fix" (line 1780) is more useful than one that
  claims completeness.

---

## Recommendation

Fix blockers 1 and 2 before anyone executes this — both are small, both are in code the
plan tells an agent to write verbatim, and blocker 2 is the kind that ships green and
quiet.

Finding 3 (the unscoped read) is worth deciding now rather than after the module exists,
since it's the difference between the guide's confinement claim being true and being
nearly true.

Everything else is cleanup. The plan's structure, ordering, and safety instincts are sound,
and the upstream `renderForHtml` dependency is in good shape — the #562 fixes all landed.
Once 1, 2, and 3 are settled I'd hand this to an executing agent without further changes.

The `account` gap remains the one thing that needs *your* call rather than a fix: v1 ships
folder scoping as advisory on a multi-account machine, and the spec argued that had to be
real. You have one account, so it's latent — but the guide shouldn't promise what the code
doesn't deliver.
