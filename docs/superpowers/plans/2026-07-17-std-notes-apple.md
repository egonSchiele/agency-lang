# std::notes/apple Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `std::notes/apple` stdlib module letting Agency agents create, append to, read, search, list, and delete Apple Notes, gated by interrupts and scopable by folder and account.

**Architecture:** An Agency module (`stdlib/notes/apple.agency`) holds the types, effects, interrupt gates, and markdown-to-HTML conversion. A TypeScript helper (`lib/stdlib/appleNotes.ts`) does nothing but talk to Notes.app: it builds AppleScript with data passed as `argv`, runs it through `osascript`, maps errors, and parses results. All of the safety reasoning lives in the `.agency` file where a reader can see it; the `.ts` file is a driver.

**Tech Stack:** TypeScript, `child_process.execFile`, AppleScript via `osascript`, vitest, Agency stdlib conventions.

**Design spec:** `/Users/adityabhargava/agency-notes-92/docs/superpowers/specs/2026-07-16-std-notes-apple-notes-design.md` (the copy in this worktree, so Task 6's spec edits land on the branch)

Read the spec before starting. This plan implements it and does not re-argue it. Where a step looks arbitrary, the spec section is cited and explains why.

---

## Global Constraints

These apply to every task. They are not style preferences; most of them are findings that cost a live spike to establish.

- **macOS only.** Every entry point checks `process.platform !== "darwin"` and throws immediately. Precedent: `lib/stdlib/imessage.ts:21`.
- **Never interpolate data into AppleScript source.** Titles, bodies, queries, and folder names are model-authored and may have been influenced by a page the model read. Pass them as `argv`. Spec §3.6.
- **No `-` separator before argv.** `osascript -e SCRIPT a b`, NOT `osascript -e SCRIPT - a b`. The `-` is passed through as `item 1 of argv` and shifts every real argument. Verified on macOS 14.7.4. Spec §3.6.
- **Never chain a property read through `container`.** `name of container of n` errors `-1728` on every note. Use `set c to container of n` then `name of c`. Spec §9.2.
- **Search `plaintext`, never `body`.** `body` is HTML, so searching it matches markup: a user searching `div` would match every note they own. Spec §9.3.
- **Unit tests only. No integration tests.** Owner decision. A test that reaches real Notes.app can destroy real notes when someone runs the suite locally. No tests in `tests/agency/` for this module — those execute the real stdlib and would shell to `osascript` for real. Spec §8.
- **Every script wraps its body in `with timeout of 30 seconds`.** Otherwise it inherits AppleScript's 120-second default. Spec §6.1.
- **Timeout constant:** `NOTES_TIMEOUT_SECONDS = 30`, module-level, in `appleNotes.ts`.
- **Payload fields are always strings, never null.** An omitted optional `folder` reaches the payload as `""`. Measured, not stylistic — see "Why empty strings, not null" below.
- **Field delimiter for multi-field returns:** `ASCII character 1`, written in TS source as the `\u0001` escape — never as a raw byte, which is invisible in an editor and survives copy-paste unreliably. Not tab — note titles can legally contain tabs.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/agency-lang/lib/stdlib/appleNotes.ts` | Create. Talks to Notes.app. Script construction, `osascript` invocation, error mapping, result parsing. No policy, no gating. |
| `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts` | Create. Unit tests, `execFile` mocked. |
| `packages/agency-lang/stdlib/notes/apple.agency` | Create. Types, effects, interrupt gates, markdown conversion, docstrings. |
| `packages/agency-lang/stdlib/capabilities.agency` | Modify. Add `NotesRead`, `NotesWrite`, `Notes` effect sets. |
| `packages/agency-lang/docs/site/guide/apple-notes.md` | Create. Guide page, incl. the Obsidian `std::fs` answer (spec §3.1). |

No registry to update: `agency doc stdlib` recurses, and `stdlib/messaging/` proves nested modules are auto-discovered. Nested `.agency` imports flat `.ts` unchanged (`stdlib/messaging/sms.agency:1`).

---

## Why empty strings, not null, in payloads

Review finding #7 worried that an omitted `folder` reaching a policy as `null`
could fail open. It cannot — but not for the reason the finding guessed, so the
measurement is recorded here rather than left to a future reader to redo.

`stdlib/policy.agency:72`: a rule passes only if *every key in `match` is present
in the interrupt's `data` and its value matches the glob*. Patterns are picomatch
globs. Measured:

| Pattern | Value | Result |
|---|---|---|
| `"Work"` | `""` | `false` |
| `"*"` | `""` | **`false`** |
| `"**"` | `""` | `false` |
| `"*"` | `"Work"` | `true` |
| `"Work"` | `null` | **THROWS** — `Expected input to be a string` |

Two consequences:

1. **`""` is safe.** An empty folder matches *nothing*, not even a catch-all
   `"*"`. So `{"match": {"folder": "*"}, "action": "approve"}` does not approve a
   `listNotes()` with no folder; it falls through to the next rule. The fail-open
   finding #7 feared cannot occur.
2. **`null` would crash the policy check**, not fail open, because picomatch
   throws on a non-string.

So passing `""` is load-bearing rather than a stylistic default. Never let a
`null` reach a payload field a policy can match on. Task 5 pins consequence 1
with a test.

---

## Two v1 limits, measured and deliberate

Both are recorded here so the code and the spec agree. Neither is a guess; a
live probe settled each.

### Nested folders are not addressable by path

Notes folders nest, and the owner's account has them: `Archived` contains
`2010s`, `2017`, and `2019`.

Three measured facts shape what v1 does:

1. **`folders` flattens.** A bare `repeat with f in folders` returns 14 folders
   on the owner's machine, with `Archived` and its three children side by side
   and nothing marking the difference. So a naive `listFolders` reports `2017`
   as a peer of `Recently Deleted`, which is false.
2. **A nested folder resolves by bare name.** `folder "2017"` resolves from the
   top level. So name addressing is *ambiguous* rather than broken: two folders
   sharing a name in different parents resolve arbitrarily.
3. **`/` is legal in a folder name.** Verified by creating one. So `/` cannot be
   a path separator without escaping, and paths are a real design job rather
   than a string join.

**v1 therefore returns only top-level folders from `listFolders`** (Task 3),
using the `class of c is account` test. That is honest and limited rather than
flat and wrong. Nested folders remain reachable by bare name, ambiguously, which
is the pre-existing Notes behaviour rather than something we invent.

Do not add path support in this plan.

### The `account` argument is not implemented

Spec §4.2 gives every function an optional `account`. This plan delivers
`account` as an **output** field on `Note` and in every payload, but not as an
input filter. So folder scoping stays advisory on a multi-account machine, which
is what spec §3.4 argued had to be fixed.

The owner has exactly one account (§9.4), so this is latent rather than live.
It must be recorded in the spec as a v1 limit, not left as a promise the code
does not keep.

### But the account BUG is fixed here

Distinct from the missing argument, and not optional. Deriving the account with
one hop up from the note's folder is **wrong for any nested folder**:
`container of folder "2017"` is `Archived`, not `iCloud`. Measured. Left alone,
every note under `Archived` would carry `"Archived"` in its `account` payload
field, and a policy matching `{"account": "iCloud"}` would silently stop
matching.

Task 2 fixes it with a bounded upward walk, verified to reach `iCloud` from
`Archived/2017` in 2 hops.

---

## Task 1: The script runner and error mapping

Everything else calls this. It is the only place `osascript` is invoked.

**Files:**
- Create: `packages/agency-lang/lib/stdlib/appleNotes.ts`
- Test: `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `runNotesScript(script: string, args: string[]): Promise<string>` — internal, not exported from the module's public surface but exported for tests.
  - `NOTES_TIMEOUT_SECONDS: number`
  - `withTimeout(body: string): string` — wraps an AppleScript body in a timeout block.
  - `FIELD_DELIM: string`

- [ ] **Step 1: Write the failing tests**

Create `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: "", stderr: "" });
    },
  ),
}));

import { execFile } from "child_process";
import { runNotesScript, withTimeout, FIELD_DELIM } from "../appleNotes.js";

type MockFn = ReturnType<typeof vi.fn>;

/** Make the mocked execFile fail with the given stderr, as osascript does. */
function mockFailure(stderr: string): void {
  (execFile as unknown as MockFn).mockImplementationOnce(
    (_c: string, _a: string[], cb: (e: unknown) => void) => {
      cb({ stderr, code: 1 });
    },
  );
}

/** Make the mocked execFile succeed with the given stdout. */
function mockStdout(stdout: string): void {
  (execFile as unknown as MockFn).mockImplementationOnce(
    (
      _c: string,
      _a: string[],
      cb: (e: null, r: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: "" });
    },
  );
}

describe("runNotesScript", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("rejects immediately on a non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    await expect(runNotesScript("script", [])).rejects.toThrow(
      "Apple Notes is only available on macOS",
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("passes args straight through to argv with NO '-' separator", async () => {
    mockStdout("ok");
    await runNotesScript("SCRIPT", ["alpha", "beta"]);
    const [cmd, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(cmd).toBe("osascript");
    // The `-` is NOT a separator: osascript passes it through as argv item 1
    // and shifts every real argument. Spec section 3.6.
    expect(args).toEqual(["-e", "SCRIPT", "alpha", "beta"]);
  });

  it("keeps a hostile title inert in argv rather than in the script", async () => {
    mockStdout("ok");
    const hostile = '"; do shell script "rm -rf ~"; "';
    await runNotesScript("SCRIPT", [hostile]);
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).toBe("SCRIPT");
    expect(args[2]).toBe(hostile);
    expect(args[1]).not.toContain("do shell script");
  });

  it("maps -1743 to a clear not-authorized error", async () => {
    // Two awaited calls below, and mockFailure queues with
    // mockImplementationOnce — so queue it twice. vi.clearAllMocks() does NOT
    // clear the factory's default success implementation, so a second call
    // with nothing queued would RESOLVE and the assertion would fail.
    mockFailure("execution error: Not authorized to send Apple events to Notes. (-1743)");
    mockFailure("execution error: Not authorized to send Apple events to Notes. (-1743)");
    await expect(runNotesScript("s", [])).rejects.toThrow(/Not authorized to control Notes/);
    await expect(runNotesScript("s", [])).rejects.toThrow(/Privacy & Security/);
  });

  it("maps -1712 to a hedged timeout error", async () => {
    mockFailure("execution error: Notes got an error: AppleEvent timed out. (-1712)");
    // -1712 cannot distinguish "consent dialog unanswered" from "Notes wedged",
    // so the message must hedge. Spec section 2.8.
    await expect(runNotesScript("s", [])).rejects.toThrow(/usually means/);
  });

  it("surfaces an unrecognised stderr rather than swallowing it", async () => {
    mockFailure("execution error: something else entirely (-9999)");
    await expect(runNotesScript("s", [])).rejects.toThrow(/something else entirely/);
  });

  it("trims stdout", async () => {
    mockStdout("  value  \n");
    await expect(runNotesScript("s", [])).resolves.toBe("value");
  });
});

describe("withTimeout", () => {
  it("wraps the body so the 120s AppleScript default is not inherited", () => {
    const out = withTimeout("tell application \"Notes\"\nend tell");
    expect(out).toContain("with timeout of 30 seconds");
    expect(out).toContain("end timeout");
    expect(out).toContain("on run argv");
    expect(out).toContain("end run");
  });
});

describe("FIELD_DELIM", () => {
  it("is a control character, because titles can contain tabs", () => {
    expect(FIELD_DELIM).toBe("\u0001");
    expect(FIELD_DELIM).not.toBe("\t");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: FAIL — `Failed to resolve import "../appleNotes.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/agency-lang/lib/stdlib/appleNotes.ts`:

```ts
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Our own bound on the wait. Without it, AppleScript's 120-second default
 *  applies, which is indistinguishable from a hang for an agent tool call.
 *  A spike confirmed `with timeout` does shorten the TCC consent wait. */
export const NOTES_TIMEOUT_SECONDS = 30;

/** Separator for multi-field script returns. Not a tab: note titles can
 *  legally contain tabs, and a title with one would corrupt the parse.
 *  Written as an escape, never a raw byte: a raw U+0001 is invisible in
 *  every editor and survives copy-paste unreliably. */
export const FIELD_DELIM = "\u0001";

/** Wrap an AppleScript body in the argv handler and our own timeout. */
export function withTimeout(body: string): string {
  return `on run argv
  with timeout of ${NOTES_TIMEOUT_SECONDS} seconds
${body}
  end timeout
end run`;
}

/** Run an AppleScript against Notes, passing data as argv.
 *
 *  Data NEVER goes into the script source. Titles and bodies are
 *  model-authored, and the model may have been influenced by a page it read,
 *  so interpolating them would be an injection path. argv values are not
 *  parsed as AppleScript. */
export async function runNotesScript(script: string, args: string[]): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Apple Notes is only available on macOS.");
  }

  try {
    // No "-" before args: osascript passes it through as argv item 1 and
    // shifts every real argument by one.
    const { stdout } = await execFileAsync("osascript", ["-e", script, ...args]);
    return stdout.trim();
  } catch (error: unknown) {
    const err = error as { stderr?: string; code?: number };
    const stderr = err.stderr?.trim() ?? "";

    // -1743 is unambiguous: no grant, or it was denied, and no dialog pending.
    if (stderr.includes("-1743")) {
      throw new Error(
        "Not authorized to control Notes. Grant permission in " +
          "System Settings → Privacy & Security → Automation.",
      );
    }

    // -1712 is ambiguous: it covers an unanswered consent dialog, a busy
    // Notes, and a wedged Notes. The message hedges on purpose — claiming
    // otherwise sends people to fix a permission that was never the problem.
    if (stderr.includes("-1712")) {
      throw new Error(
        `Notes did not respond within ${NOTES_TIMEOUT_SECONDS}s. This usually ` +
          "means macOS automation permission was not granted. Check " +
          "System Settings → Privacy & Security → Automation.",
      );
    }

    throw new Error(`Notes command failed: ${stderr || `exit code ${err.code ?? "unknown"}`}`);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the injection test is load-bearing**

Temporarily break the argv contract by interpolating instead:

```ts
// in runNotesScript, temporarily:
const { stdout } = await execFileAsync("osascript", ["-e", script + args.join(" ")]);
```

Run the tests. Expected: the "keeps a hostile title inert" and "passes args straight through" tests FAIL. Then revert.

This matters because a green suite proves nothing on its own — the review of #562 found five real bugs under a fully green suite.

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/stdlib/appleNotes.ts packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts
git commit -m "Add the Apple Notes script runner and error mapping

Data goes to osascript as argv, never interpolated into script source:
titles and bodies are model-authored. No '-' separator, which would land
as argv item 1 and shift every real argument.

Maps both permission errors. -1743 is unambiguous so its message is
direct; -1712 covers an unanswered dialog, a busy Notes, and a wedged
Notes, so it hedges."
```

---

## Task 2: The pre-flight lookup and the locked-note guard

The security core. Everything that touches an existing note goes through this.

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/appleNotes.ts`
- Test: `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts`

**Interfaces:**
- Consumes: `runNotesScript`, `withTimeout`, `FIELD_DELIM` from Task 1.
- Produces:
  - `ACCOUNT_WALK: string` — an AppleScript snippet, reused by Tasks 3 and 4.
  - `type NotePreflight = { id: string; title: string; folder: string; account: string; locked: boolean }`
  - `_preflightNote(id: string): Promise<NotePreflight>`
  - `assertNotLocked(p: NotePreflight): void`

**Why this exists (spec §5.3):** the interrupt payload must carry `folder`, `title`, and `account`, because those are what policy globs match on. So we must read them before raising the interrupt, which means this one query is not itself gated. That is acceptable, but the reasoning is narrow and belongs in the source: **an id is unguessable.** It is an opaque `x-coredata://` URI that cannot be enumerated or constructed, so whoever holds one already learned it somewhere, and this lookup discloses only the title and folder they could already name. Do not write "unreachable without a gate" — that claim is false (ids are stable and survive checkpoints) and it would license adding a fourth property to this query.

The consumer of this query is Task 5's `preflight` helper, which calls it before raising each append/read/delete interrupt and builds the payload from its result. If that call is ever removed, this query loses its reason to exist ungated — the two must stay together.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts`:

```ts
import { _preflightNote, assertNotLocked } from "../appleNotes.js";

describe("_preflightNote", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("never chains a property read through container", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    const script = args[1];
    // `name of container of n` errors -1728 on EVERY note, locked or not.
    // Spec section 9.2. This test exists so a "tidying" refactor cannot
    // silently reintroduce the chained form.
    expect(script).not.toContain("name of container of n");
    expect(script).toContain("set c to container of n");
  });

  it("walks up to the account rather than assuming one hop", async () => {
    mockStdout(["Q3", "2017", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    const script = args[1];
    // A folder's container is its PARENT FOLDER when nested, not the account.
    // Measured: `container of folder "2017"` is "Archived", not "iCloud". One
    // hop would put a folder name in the account field, and a policy matching
    // {"account": "iCloud"} would silently stop matching.
    expect(script).toContain("class of a) is account");
    expect(script).toContain("set a to container of a");
  });

  it("fails closed if the account walk does not reach an account", async () => {
    mockStdout(["Q3", "2017", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    // The walk is bounded. If it never lands on an account, error rather than
    // returning a folder name as the account.
    expect(args[1]).toContain("Could not resolve the account");
  });

  it("reads only title, folder, account and the locked flag — never the body", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    const script = args[1];
    // This query is not interrupt-gated, so it must never touch content.
    expect(script).not.toContain("body of");
    expect(script).not.toContain("plaintext of");
  });

  it("passes the id as argv, not in the script", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    await _preflightNote("x-coredata://note/1");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[2]).toBe("x-coredata://note/1");
    expect(args[1]).not.toContain("x-coredata://note/1");
  });

  it("parses the delimited fields", async () => {
    mockStdout(["Q3 Planning", "Work", "iCloud", "false"].join(FIELD_DELIM));
    const p = await _preflightNote("x-coredata://note/1");
    expect(p).toEqual({
      id: "x-coredata://note/1",
      title: "Q3 Planning",
      folder: "Work",
      account: "iCloud",
      locked: false,
    });
  });

  it("parses a title containing a tab, which the delimiter must survive", async () => {
    mockStdout(["a\tb", "Work", "iCloud", "false"].join(FIELD_DELIM));
    const p = await _preflightNote("x-coredata://note/1");
    expect(p.title).toBe("a\tb");
    expect(p.folder).toBe("Work");
  });

  it("reads the locked flag as true", async () => {
    mockStdout(["Secret", "Work", "iCloud", "true"].join(FIELD_DELIM));
    const p = await _preflightNote("x-coredata://note/1");
    expect(p.locked).toBe(true);
  });

  it("fails on a malformed reply rather than guessing", async () => {
    mockStdout("only one field");
    await expect(_preflightNote("x-coredata://note/1")).rejects.toThrow(/unexpected reply/i);
  });
});

describe("assertNotLocked", () => {
  const base = {
    id: "x-coredata://note/1",
    title: "Q3 Planning",
    folder: "Work",
    account: "iCloud",
  };

  it("passes an unlocked note through", () => {
    expect(() => assertNotLocked({ ...base, locked: false })).not.toThrow();
  });

  // THIS IS DATA-LOSS PREVENTION, NOT A NICE ERROR MESSAGE.
  // A locked note's body reads as an EMPTY STRING rather than erroring, so an
  // append that skipped this guard would run `set body of n to "" & newText`
  // and replace the note's contents with the appended text. Spec section 2.7.
  // If this test is failing, do not delete it. The guard is why locked notes
  // survive.
  it("refuses a locked note and names it", () => {
    expect(() => assertNotLocked({ ...base, locked: true })).toThrow(/Q3 Planning/);
    expect(() => assertNotLocked({ ...base, locked: true })).toThrow(/locked/i);
    expect(() => assertNotLocked({ ...base, locked: true })).toThrow(/Unlock it in Notes\.app/);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: FAIL — `_preflightNote` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/agency-lang/lib/stdlib/appleNotes.ts`:

```ts
/** A note's metadata, read before the interrupt so the payload can carry it. */
export type NotePreflight = {
  id: string;
  title: string;
  folder: string;
  account: string;
  locked: boolean;
};

/** Walk from a folder (`c`) up to its account, leaving it in `a`.
 *
 *  A folder's container is its PARENT FOLDER when nested, not the account.
 *  Measured: `container of folder "2017"` is `Archived`, not `iCloud`. One hop
 *  up is wrong for any nested folder, and wrong silently — the account field
 *  would hold a folder name and every {"account": "iCloud"} policy would quietly
 *  stop matching.
 *
 *  Bounded, and fails closed rather than returning a folder as an account.
 *  Verified to reach iCloud from Archived/2017 in 2 hops. */
export const ACCOUNT_WALK = `      set a to container of c
      set acctFound to false
      repeat 10 times
        if (class of a) is account then
          set acctFound to true
          exit repeat
        end if
        set a to container of a
      end repeat
      if not acctFound then error "Could not resolve the account for this note."`;

// `set c to container of n` is split on purpose. `name of container of n` in one
// expression errors -1728 on EVERY note, locked or unlocked. The property is
// fine; chaining a read through it is not. Spec section 9.2.
const PREFLIGHT_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv)
      set c to container of n
${ACCOUNT_WALK}
      set d to (ASCII character 1)
      return (name of n) & d & (name of c) & d & (name of a) & d & ¬
             ((password protected of n) as text)
    end tell`);

/** Read a note's metadata: title, folder, account, locked flag.
 *
 *  This query is NOT interrupt-gated, because the interrupt payload needs its
 *  results in order to exist. That is acceptable for a narrow reason worth
 *  keeping precise: a note id is unguessable. It is an opaque x-coredata://
 *  URI that cannot be enumerated or constructed, so anyone holding one already
 *  learned it somewhere, and this discloses only the title and folder that
 *  whoever handed them the id could already name.
 *
 *  It is NOT true that an id can only come from a gated call — ids are stable
 *  and can arrive from a user message, a file, or a restored checkpoint. Do not
 *  widen this query on the strength of that weaker claim. It reads three
 *  properties and no content, and it should stay that way. */
export async function _preflightNote(id: string): Promise<NotePreflight> {
  const raw = await runNotesScript(PREFLIGHT_SCRIPT, [id]);
  const parts = raw.split(FIELD_DELIM);
  if (parts.length !== 4) {
    throw new Error(`Notes returned an unexpected reply for note ${id}.`);
  }
  return {
    id,
    title: parts[0],
    folder: parts[1],
    account: parts[2],
    locked: parts[3].trim() === "true",
  };
}

/** Refuse a locked note.
 *
 *  This is DATA-LOSS PREVENTION, not a friendlier error. A locked note's body
 *  reads as an empty string rather than erroring, so an append that skipped
 *  this guard would run `set body of n to "" & newText` and replace the note's
 *  contents with the appended text. Spec section 2.7.
 *
 *  Never skip this, never reorder it after a body read, and never remove it as
 *  apparently-dead code. */
export function assertNotLocked(p: NotePreflight): void {
  if (p.locked) {
    throw new Error(`Note "${p.title}" is locked. Unlock it in Notes.app and retry.`);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: PASS, 20 tests.

- [ ] **Step 5: Prove the locked guard is load-bearing**

Temporarily change `assertNotLocked` to a no-op:

```ts
export function assertNotLocked(_p: NotePreflight): void {
  return;
}
```

Run the tests. Expected: "refuses a locked note and names it" FAILS. Restore.

This guard is the only thing standing between a locked note and destruction
(spec §2.7). If a refactor deletes it, that test must be what stops the build.

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/stdlib/appleNotes.ts packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts
git commit -m "Add the Notes pre-flight lookup and the locked-note guard

The pre-flight reads title, folder, account and the locked flag, and no
content. It is not interrupt-gated because the payload needs its results
to exist; that is acceptable because an id is unguessable, not because
ids only come from gated calls.

The container access is split. Chaining a read through container errors
-1728 on every note.

The locked guard is data-loss prevention: a locked note's body reads as
an empty string, so an append past this guard would replace the note's
contents with the appended text."
```

---

## Task 3: The read operations

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/appleNotes.ts`
- Test: `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts`

**Interfaces:**
- Consumes: `runNotesScript`, `withTimeout`, `FIELD_DELIM`, `_preflightNote`, `assertNotLocked`.
- Produces:
  - `type NoteMeta = { id: string; title: string; folder: string; account: string; modified: string; passwordProtected: boolean }`
  - `type NoteContentTs = { id: string; title: string; folder: string; account: string; body: string; modified: string }`
  - `type FolderMeta = { id: string; name: string; noteCount: number }`
  - `_readNote(id: string, folder?: string): Promise<NoteContentTs>`
  - `_listNotes(folder?: string): Promise<NoteMeta[]>`
  - `_searchNotes(query: string, folder?: string): Promise<NoteMeta[]>`
  - `_listFolders(): Promise<FolderMeta[]>`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
import { _readNote, _listNotes, _searchNotes, _listFolders } from "../appleNotes.js";

describe("_readNote", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns plaintext, not HTML", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM)); // preflight
    mockStdout(["plain body text", "2026-07-17"].join(FIELD_DELIM)); // read
    const n = await _readNote("x-coredata://note/1");
    expect(n.body).toBe("plain body text");
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    // body is HTML and would waste tokens and read badly. Spec section 2.4.
    expect(args[1]).toContain("plaintext of");
    expect(args[1]).not.toContain("body of");
  });

  it("refuses a locked note before reading anything", async () => {
    mockStdout(["Secret", "Work", "iCloud", "true"].join(FIELD_DELIM));
    await expect(_readNote("x-coredata://note/1")).rejects.toThrow(/locked/i);
    // Only the preflight ran. No content read was attempted.
    expect((execFile as unknown as MockFn).mock.calls.length).toBe(1);
  });

  it("fails closed when the folder assertion does not match", async () => {
    // Two calls, so queue the preflight reply twice — the mock is queue-once,
    // and the second call would otherwise read the factory default ("") and
    // fail on parsing instead of on the folder.
    mockStdout(["Q3", "Personal", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["Q3", "Personal", "iCloud", "false"].join(FIELD_DELIM));
    await expect(_readNote("x-coredata://note/1", "Work")).rejects.toThrow(/Work/);
    await expect(_readNote("x-coredata://note/1", "Work")).rejects.toThrow(/Personal/);
  });

  it("passes the assertion when the folder matches", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["body", "2026-07-17"].join(FIELD_DELIM));
    await expect(_readNote("x-coredata://note/1", "Work")).resolves.toMatchObject({
      folder: "Work",
    });
  });

  it("uses a scoped lookup for the read when a folder is given", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["body", "2026-07-17"].join(FIELD_DELIM));
    await _readNote("x-coredata://note/1", "Work");
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    // Same treatment as the write path (spec section 6.4): a note that moved
    // folders during the approval fails to resolve instead of being read.
    expect(args[1]).toContain("of folder (item 2 of argv)");
    expect(args[3]).toBe("Work");
  });
});

describe("_listNotes", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("lists all notes when no folder is given", async () => {
    const row = ["id1", "One", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM);
    mockStdout(row);
    const notes = await _listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("One");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).not.toContain("of folder");
  });

  it("scopes to the folder when one is given, passed as argv", async () => {
    mockStdout("");
    await _listNotes("Work");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).toContain("notes of folder (item 1 of argv)");
    expect(args[2]).toBe("Work");
  });

  it("returns an empty array rather than throwing when there are none", async () => {
    mockStdout("");
    await expect(_listNotes()).resolves.toEqual([]);
  });
});

describe("_searchNotes", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("searches plaintext, never body", async () => {
    mockStdout("");
    await _searchNotes("budget");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    // body is HTML: searching it matches markup, so `div` would match every
    // note the user owns. Spec section 9.3.
    expect(args[1]).toContain("plaintext contains");
    expect(args[1]).not.toContain("body contains");
  });

  it("passes the query as argv, not in the script", async () => {
    mockStdout("");
    await _searchNotes('"; do shell script "x"; "');
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).not.toContain("do shell script");
    expect(args[2]).toBe('"; do shell script "x"; "');
  });

  it("returns an empty array for no matches rather than throwing", async () => {
    mockStdout("");
    await expect(_searchNotes("nothing")).resolves.toEqual([]);
  });

  it("parses multiple rows", async () => {
    const row1 = ["id1", "One", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM);
    const row2 = ["id2", "Two", "Work", "iCloud", "2026-07-16", "false"].join(FIELD_DELIM);
    mockStdout(`${row1}\n${row2}`);
    const notes = await _searchNotes("x");
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("One");
    expect(notes[1].id).toBe("id2");
  });

  it("never returns a body", async () => {
    const row = ["id1", "One", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM);
    mockStdout(row);
    const notes = await _searchNotes("x");
    expect(notes[0]).not.toHaveProperty("body");
  });
});

describe("_listFolders", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns folders with their note counts", async () => {
    const row1 = ["fid1", "Work", "12"].join(FIELD_DELIM);
    const row2 = ["fid2", "Recently Deleted", "3"].join(FIELD_DELIM);
    mockStdout(`${row1}\n${row2}`);
    const folders = await _listFolders();
    expect(folders).toEqual([
      { id: "fid1", name: "Work", noteCount: 12 },
      // "Recently Deleted" is a real folder and is returned. deleteNote moves
      // notes into it. Spec section 9.2.
      { id: "fid2", name: "Recently Deleted", noteCount: 3 },
    ]);
  });

  it("asks Notes for top-level folders only", async () => {
    mockStdout("");
    await _listFolders();
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    // A bare `repeat with f in folders` flattens the hierarchy: it returns
    // "Archived" and its children "2010s"/"2017"/"2019" side by side with
    // nothing marking the difference, so "2017" reads as a peer of "Recently
    // Deleted". That is false, and an agent would act on it. Filtering to
    // folders whose container is an account is honest and limited instead.
    expect(args[1]).toContain("(class of c) is account");
  });

  it("returns an empty array rather than throwing when there are none", async () => {
    mockStdout("");
    await expect(_listFolders()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: FAIL — `_readNote` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/agency-lang/lib/stdlib/appleNotes.ts`:

```ts
/** Note metadata. Deliberately carries no body. */
export type NoteMeta = {
  id: string;
  title: string;
  folder: string;
  account: string;
  modified: string;
  passwordProtected: boolean;
};

/** A note including its content, as plaintext. */
export type NoteContentTs = {
  id: string;
  title: string;
  folder: string;
  account: string;
  body: string;
  modified: string;
};

/** A folder. `noteCount` is derived, not a property. */
export type FolderMeta = {
  id: string;
  name: string;
  noteCount: number;
};

/** Assert a note is in the folder the caller named. Fails closed.
 *
 *  This compare is the fail-fast check with the readable error message. It is
 *  NOT the authoritative assertion: on both the read and write paths the
 *  actual access addresses the note THROUGH the folder (`note id X of folder
 *  Y`), so the lookup failing is the assertion failing, and the check cannot
 *  drift from the access across the human approval that sits between the
 *  pre-flight and the access. */
function assertFolder(p: NotePreflight, folder?: string): void {
  if (folder != null && p.folder !== folder) {
    throw new Error(
      `Note "${p.title}" is in folder "${p.folder}", not "${folder}". Refusing.`,
    );
  }
}

// Reads `plaintext`, never `body`. body is HTML: it would waste tokens and read
// badly for a model. Spec section 2.4.
//
// Two shapes, like the write path (spec section 6.4): when the caller asserted
// a folder, the read addresses the note THROUGH it, so a note that moved
// folders during the human approval fails to resolve instead of being read.
// An unscoped read would leave open on the read path the exact window the
// write path closes — and reading is the operation folder confinement was
// invented for.
const READ_UNSCOPED_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv)
      set d to (ASCII character 1)
      return (plaintext of n) & d & ((modification date of n) as text)
    end tell`);

const READ_SCOPED_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv) of folder (item 2 of argv)
      set d to (ASCII character 1)
      return (plaintext of n) & d & ((modification date of n) as text)
    end tell`);

export async function _readNote(id: string, folder?: string): Promise<NoteContentTs> {
  const p = await _preflightNote(id);
  assertFolder(p, folder);
  assertNotLocked(p);

  const raw = folder == null
    ? await runNotesScript(READ_UNSCOPED_SCRIPT, [id])
    : await runNotesScript(READ_SCOPED_SCRIPT, [id, folder]);
  const parts = raw.split(FIELD_DELIM);
  if (parts.length !== 2) {
    throw new Error(`Notes returned an unexpected reply for note ${id}.`);
  }
  return {
    id,
    title: p.title,
    folder: p.folder,
    account: p.account,
    body: parts[0],
    modified: parts[1],
  };
}

/** Parse the delimited note rows a list/search script returns. */
function parseNoteRows(raw: string): NoteMeta[] {
  if (raw.length === 0) return [];
  return raw.split("\n").filter((l) => l.length > 0).map((line) => {
    const f = line.split(FIELD_DELIM);
    if (f.length !== 6) {
      throw new Error("Notes returned an unexpected row while listing notes.");
    }
    return {
      id: f[0],
      title: f[1],
      folder: f[2],
      account: f[3],
      modified: f[4],
      passwordProtected: f[5].trim() === "true",
    };
  });
}

// The container access is split here too (spec 9.2), and the account is walked
// rather than assumed to be one hop up.
const NOTE_ROW = `set c to container of n
${ACCOUNT_WALK}
        set out to out & (id of n) & d & (name of n) & d & (name of c) & d & ¬
                  (name of a) & d & ((modification date of n) as text) & d & ¬
                  ((password protected of n) as text) & linefeed`;

const LIST_ALL_SCRIPT = withTimeout(`    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with n in notes
        ${NOTE_ROW}
      end repeat
      return out
    end tell`);

const LIST_IN_FOLDER_SCRIPT = withTimeout(`    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with n in (notes of folder (item 1 of argv))
        ${NOTE_ROW}
      end repeat
      return out
    end tell`);

export async function _listNotes(folder?: string): Promise<NoteMeta[]> {
  const raw = folder == null
    ? await runNotesScript(LIST_ALL_SCRIPT, [])
    : await runNotesScript(LIST_IN_FOLDER_SCRIPT, [folder]);
  return parseNoteRows(raw);
}

// `plaintext contains`, never `body contains`. body is HTML, so searching it
// matches markup: a user searching "div" would match every note they own.
// Spec section 9.3.
const SEARCH_ALL_SCRIPT = withTimeout(`    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with n in (notes whose plaintext contains (item 1 of argv))
        ${NOTE_ROW}
      end repeat
      return out
    end tell`);

const SEARCH_IN_FOLDER_SCRIPT = withTimeout(`    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with n in (notes of folder (item 2 of argv) whose plaintext contains (item 1 of argv))
        ${NOTE_ROW}
      end repeat
      return out
    end tell`);

export async function _searchNotes(query: string, folder?: string): Promise<NoteMeta[]> {
  const raw = folder == null
    ? await runNotesScript(SEARCH_ALL_SCRIPT, [query])
    : await runNotesScript(SEARCH_IN_FOLDER_SCRIPT, [query, folder]);
  return parseNoteRows(raw);
}

// TOP-LEVEL FOLDERS ONLY, on purpose.
//
// A bare `repeat with f in folders` FLATTENS the hierarchy: on a machine with
// an "Archived" folder containing "2010s", "2017" and "2019", it returns all
// four side by side with nothing marking the difference. Reporting "2017" as a
// peer of "Recently Deleted" is simply false, and an agent would act on it.
//
// So filter to folders whose container is an account. That is honest and
// limited rather than flat and wrong. Nested folders stay reachable by bare
// name (`folder "2017"` does resolve), ambiguously — which is Notes' own
// behaviour, not something we introduce. Path support is out of scope for v1;
// see the plan's "Two v1 limits".
//
// noteCount is derived with `count of notes`, because folder has no such
// property. That is a query per folder, so listFolders pays for it.
const LIST_FOLDERS_SCRIPT = withTimeout(`    tell application "Notes"
      set d to (ASCII character 1)
      set out to ""
      repeat with f in folders
        set c to container of f
        if (class of c) is account then
          set out to out & (id of f) & d & (name of f) & d & ¬
                    ((count of notes of f) as text) & linefeed
        end if
      end repeat
      return out
    end tell`);

export async function _listFolders(): Promise<FolderMeta[]> {
  const raw = await runNotesScript(LIST_FOLDERS_SCRIPT, []);
  if (raw.length === 0) return [];
  return raw.split("\n").filter((l) => l.length > 0).map((line) => {
    const f = line.split(FIELD_DELIM);
    if (f.length !== 3) {
      throw new Error("Notes returned an unexpected row while listing folders.");
    }
    return { id: f[0], name: f[1], noteCount: Number(f[2]) };
  });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: PASS, 36 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/lib/stdlib/appleNotes.ts packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts
git commit -m "Add the Notes read operations

readNote returns plaintext, not body: body is HTML and would waste
tokens. searchNotes filters on plaintext for the same reason, plus a
sharper one — searching HTML matches markup, so a query for 'div' would
match every note the user owns.

List and search return metadata only. No body crosses that boundary, and
a test pins it."
```

---

## Task 4: The write operations

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/appleNotes.ts`
- Test: `packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `_folderExists(folder: string): Promise<boolean>`
  - `_createNote(title: string, html: string, folder: string): Promise<NoteMeta>`
  - `_appendToNote(id: string, html: string, folder?: string): Promise<NoteMeta>`
  - `_deleteNote(id: string, folder?: string): Promise<null>`

**The assertion in the write path is different from the read path, on purpose (spec §6.4).** The read path reads the container and compares. The write path instead addresses the note *through* the folder: `note id X of folder Y`. If the note is not in Y, the lookup fails. This collapses the check and the access into one operation, so they cannot drift apart across the human approval that sits between the pre-flight and the write. Verified to fail closed on the wrong folder.

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
import { _folderExists, _createNote, _appendToNote, _deleteNote } from "../appleNotes.js";

describe("_folderExists", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("passes the folder as argv and parses a true reply", async () => {
    mockStdout("true");
    await expect(_folderExists("Agency Notes")).resolves.toBe(true);
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).toContain("exists folder (item 1 of argv)");
    expect(args[2]).toBe("Agency Notes");
  });

  it("parses a false reply", async () => {
    mockStdout("false");
    await expect(_folderExists("No Such Folder")).resolves.toBe(false);
  });
});

describe("_createNote", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("passes title, html and folder as argv, never in the script", async () => {
    mockStdout(["nid", "T", "Agency Notes", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    await _createNote('"; do shell script "x"; "', "<p>b</p>", "Agency Notes");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    expect(args[1]).not.toContain("do shell script");
    expect(args[2]).toBe('"; do shell script "x"; "');
    expect(args[3]).toBe("<p>b</p>");
    expect(args[4]).toBe("Agency Notes");
  });

  it("creates the folder if it is missing", async () => {
    mockStdout(["nid", "T", "Agency Notes", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    await _createNote("T", "<p>b</p>", "Agency Notes");
    const [, args] = (execFile as unknown as MockFn).mock.calls[0];
    // "Agency Notes" will not exist on a fresh machine. Spec section 9.4.
    expect(args[1]).toContain("make new folder");
  });

  it("returns the new note's metadata including its id", async () => {
    mockStdout(["nid", "T", "Agency Notes", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    const n = await _createNote("T", "<p>b</p>", "Agency Notes");
    // Returning the id means create-then-append needs no search.
    expect(n.id).toBe("nid");
    expect(n.title).toBe("T");
  });
});

describe("_appendToNote", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // See spec section 2.7. A locked note's body reads as "", so this append
  // would REPLACE the note's contents. Do not delete this test.
  it("refuses a locked note and never issues a write", async () => {
    mockStdout(["Secret", "Work", "iCloud", "true"].join(FIELD_DELIM));
    await expect(_appendToNote("x-coredata://note/1", "<p>x</p>")).rejects.toThrow(/locked/i);
    expect((execFile as unknown as MockFn).mock.calls.length).toBe(1);
  });

  it("re-checks the locked flag inside the write script", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["nid", "Q3", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    await _appendToNote("x-coredata://note/1", "<p>x</p>");
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    // The pre-flight check is separated from the write by a human approval,
    // so it is check-then-act. The write script re-checks. Spec section 6.4.
    expect(args[1]).toContain("password protected");
  });

  it("uses a scoped lookup as the assertion when a folder is given", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["nid", "Q3", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    await _appendToNote("x-coredata://note/1", "<p>x</p>", "Work");
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    // The scoped lookup IS the assertion: it fails if the note is not in the
    // folder, so the check cannot drift from the access. Spec section 6.4.
    expect(args[1]).toContain("of folder (item 3 of argv)");
  });

  it("uses an unscoped lookup when no folder is given", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["nid", "Q3", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    await _appendToNote("x-coredata://note/1", "<p>x</p>");
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    expect(args[1]).not.toContain("of folder (item 3 of argv)");
  });

  it("appends rather than replacing", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout(["nid", "Q3", "Work", "iCloud", "2026-07-17", "false"].join(FIELD_DELIM));
    await _appendToNote("x-coredata://note/1", "<p>x</p>");
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    expect(args[1]).toContain("(body of n) &");
  });
});

describe("_deleteNote", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("refuses a locked note", async () => {
    mockStdout(["Secret", "Work", "iCloud", "true"].join(FIELD_DELIM));
    await expect(_deleteNote("x-coredata://note/1")).rejects.toThrow(/locked/i);
    expect((execFile as unknown as MockFn).mock.calls.length).toBe(1);
  });

  it("deletes an unlocked note", async () => {
    mockStdout(["Q3", "Work", "iCloud", "false"].join(FIELD_DELIM));
    mockStdout("");
    await expect(_deleteNote("x-coredata://note/1")).resolves.toBeNull();
    const [, args] = (execFile as unknown as MockFn).mock.calls[1];
    expect(args[1]).toContain("delete n");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: FAIL — `_createNote` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/agency-lang/lib/stdlib/appleNotes.ts`:

```ts
const FOLDER_EXISTS_SCRIPT = withTimeout(`    tell application "Notes"
      return (exists folder (item 1 of argv)) as text
    end tell`);

export async function _folderExists(folder: string): Promise<boolean> {
  const raw = await runNotesScript(FOLDER_EXISTS_SCRIPT, [folder]);
  return raw.trim() === "true";
}

// "Agency Notes" is our own default and will not exist on a fresh machine, so
// create it on demand. Spec section 9.4. The interrupt payload carries
// folderCreated so a human or policy sees the folder being made.
const CREATE_SCRIPT = withTimeout(`    tell application "Notes"
      if not (exists folder (item 3 of argv)) then
        make new folder with properties {name:(item 3 of argv)}
      end if
      set f to folder (item 3 of argv)
      set n to make new note at f with properties {name:(item 1 of argv), body:(item 2 of argv)}
      set c to container of n
${ACCOUNT_WALK}
      set d to (ASCII character 1)
      return (id of n) & d & (name of n) & d & (name of c) & d & (name of a) & d & ¬
             ((modification date of n) as text) & d & ((password protected of n) as text)
    end tell`);

/** Create a note. `html` is HTML, already rendered — this layer does not know
 *  about markdown. The Agency module does the conversion. */
export async function _createNote(
  title: string,
  html: string,
  folder: string,
): Promise<NoteMeta> {
  const raw = await runNotesScript(CREATE_SCRIPT, [title, html, folder]);
  const rows = parseNoteRows(raw);
  if (rows.length !== 1) {
    throw new Error("Notes returned an unexpected reply while creating a note.");
  }
  return rows[0];
}

// Two shapes: scoped and unscoped. The scoped one addresses the note THROUGH
// the folder, so the lookup failing IS the assertion failing. That is stronger
// than read-then-compare, because the reference that gets mutated is the same
// one that had to resolve inside the asserted folder — the check cannot drift
// from the access across the human approval that precedes this. Spec 6.4.
const APPEND_BODY = `      if (password protected of n) then error "note is locked"
      set body of n to (body of n) & (item 2 of argv)
      set c to container of n
${ACCOUNT_WALK}
      set d to (ASCII character 1)
      return (id of n) & d & (name of n) & d & (name of c) & d & (name of a) & d & ¬
             ((modification date of n) as text) & d & ((password protected of n) as text)`;

const APPEND_SCOPED_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv) of folder (item 3 of argv)
${APPEND_BODY}
    end tell`);

const APPEND_UNSCOPED_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv)
${APPEND_BODY}
    end tell`);

/** Append to a note. `html` is HTML, already rendered.
 *
 *  The locked check happens twice on purpose: once in the pre-flight so the
 *  error is raised before the interrupt, and once inside the write script
 *  because a human approval sits between them and the note can be locked in
 *  that window. Spec section 2.7 explains why a missed check destroys data. */
export async function _appendToNote(
  id: string,
  html: string,
  folder?: string,
): Promise<NoteMeta> {
  const p = await _preflightNote(id);
  assertFolder(p, folder);
  assertNotLocked(p);

  const raw = folder == null
    ? await runNotesScript(APPEND_UNSCOPED_SCRIPT, [id, html])
    : await runNotesScript(APPEND_SCOPED_SCRIPT, [id, html, folder]);

  const rows = parseNoteRows(raw);
  if (rows.length !== 1) {
    throw new Error(`Notes returned an unexpected reply while appending to note ${id}.`);
  }
  return rows[0];
}

const DELETE_SCOPED_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv) of folder (item 2 of argv)
      if (password protected of n) then error "note is locked"
      delete n
    end tell`);

const DELETE_UNSCOPED_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv)
      if (password protected of n) then error "note is locked"
      delete n
    end tell`);

/** Delete a note. It moves to Recently Deleted, where it stays ~30 days. */
export async function _deleteNote(id: string, folder?: string): Promise<null> {
  const p = await _preflightNote(id);
  assertFolder(p, folder);
  assertNotLocked(p);

  if (folder == null) {
    await runNotesScript(DELETE_UNSCOPED_SCRIPT, [id]);
  } else {
    await runNotesScript(DELETE_SCOPED_SCRIPT, [id, folder]);
  }
  return null;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts
```
Expected: PASS, 48 tests.

- [ ] **Step 5: Prove the locked guard is load-bearing**

Temporarily delete the `assertNotLocked(p);` line from `_appendToNote`. Run the tests.
Expected: "refuses a locked note and never issues a write" FAILS. Restore the line.

This guard is the only thing preventing a locked note from being destroyed. If a future refactor removes it, this test must be what stops the build.

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/stdlib/appleNotes.ts packages/agency-lang/lib/stdlib/__tests__/appleNotes.test.ts
git commit -m "Add the Notes write operations

The write path asserts the folder by addressing the note THROUGH it
(note id X of folder Y) rather than reading the container and comparing.
The lookup failing is the assertion failing, so the check cannot drift
from the access across the human approval that precedes the write.

The locked check runs twice: in the pre-flight so the error precedes the
interrupt, and inside the write script because the note can be locked
during the approval. A missed check replaces the note's contents."
```

---

## Task 5: The Agency module

**Files:**
- Create: `packages/agency-lang/stdlib/notes/apple.agency`
- Modify: `packages/agency-lang/stdlib/capabilities.agency`

**Interfaces:**
- Consumes: every `_`-prefixed function from Tasks 1–4, plus `parse` and `renderForHtml` from `std::markdown`.
- Produces: the public `std::notes/apple` surface.

**The append/read/delete payloads are built from the pre-flight.** This is the
whole point of Task 2's ungated `_preflightNote` query, so it must not be
dropped in a refactor: the caller hands these functions an opaque
`x-coredata://` id and nothing else, so without a pre-flight the interrupt
payload could only carry that id and empty strings. A human approving a delete
would see nothing identifying the note, and a policy like
`{"match": {"folder": "Work"}, "action": "approve"}` could never match, because
the payload's `folder` would be `""` — which matches no glob, not even `"*"`
(see "Why empty strings, not null"). So `appendToNote`, `readNote`, and
`deleteNote` each call the `preflight` helper below before raising their
interrupt, and the payload carries the note's real `title`, `folder`, and
`account`. The helper also refuses a folder-assertion mismatch *before* the
interrupt, which keeps the payload honest: the folder a human approves is the
note's real folder, never an asserted folder the note is not actually in. The
TypeScript layer re-asserts the folder and the locked flag after approval; the
helper is for payload truth and fail-fast, not the safety guard.

**Syntax rules (from CLAUDE.md — verify against `docs/site/guide/basic-syntax.md` if unsure):** functions are `def` with braces; `if` needs parens and braces; variables need `let`/`const`. Do not write Python-style colons.

- [ ] **Step 1: Write the module**

Create `packages/agency-lang/stdlib/notes/apple.agency`:

```ts
import {
  _createNote,
  _appendToNote,
  _readNote,
  _searchNotes,
  _listNotes,
  _listFolders,
  _deleteNote,
  _folderExists,
  _preflightNote,
} from "agency-lang/stdlib-lib/appleNotes.js"
import { parse, renderForHtml } from "std::markdown"

/** @module
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
*/

/** A folder in Notes. `noteCount` is derived, not stored. */
export type Folder = {
  id: string
  name: string
  noteCount: number
}

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

effect std::notes::create { account: string, folder: string, title: string, folderCreated: boolean }
effect std::notes::append { account: string, folder: string, title: string, id: string }
effect std::notes::read   { account: string, folder: string, title: string, id: string }
effect std::notes::search { account: string, folder: string, query: string }
effect std::notes::list   { account: string, folder: string }
effect std::notes::delete { account: string, folder: string, title: string, id: string }

/** Convert markdown to the HTML that Notes requires on write. */
def toHtml(body: string): Result<string> {
  const parsed = parse(body)
  if (!parsed.success) {
    return failure("Could not parse the note body as Markdown: ${parsed.error}")
  }
  return success(renderForHtml(parsed.blocks))
}

/** What the pre-flight lookup returns. Re-declared natively because record
    types imported from TypeScript are opaque to the typechecker. */
type Preflight = {
  id: string
  title: string
  folder: string
  account: string
  locked: boolean
}

/** Look the note up before raising the interrupt, so the payload can carry its
    real title, folder, and account — the fields a policy glob matches on and a
    human reads before approving. Without this, the payload would hold an opaque
    id and empty strings, and no policy could ever match an append, read, or
    delete.

    Refusing a folder-assertion mismatch here, before the interrupt, keeps the
    payload honest: the folder shown to the approver is always the note's real
    folder. The TypeScript layer re-asserts the folder (by scoped lookup on
    writes) and the locked flag after the approval — that re-check is the
    safety guard; this one exists for payload truth and a fail-fast error. */
def preflight(id: string, folder: string | null): Result<Preflight> {
  const p = try _preflightNote(id)
  if (isFailure(p)) {
    return p
  }
  if (folder != null && p.value.folder != folder) {
    return failure("Note ${p.value.title} is in folder ${p.value.folder}, not ${folder}. Refusing.")
  }
  return p
}

export def createNote(title: string, body: string, folder: string = "Agency Notes"): Result<Note> raises <std::notes::create> {
  """
  Create a note in the Notes app and return it, including its new id.

  @param title - The note's title
  @param body - The note's content, as Markdown
  @param folder - The folder to create it in. Created if it does not exist.
  """
  const html = toHtml(body)
  if (isFailure(html)) {
    return html
  }

  const exists = try _folderExists(folder)
  if (isFailure(exists)) {
    return exists
  }

  // exists is the Result from `try`, so negate the VALUE. `!exists` would
  // negate the always-truthy success object and folderCreated would silently
  // always read false. Precedent for .value after an isFailure guard:
  // stdlib/agency.agency (compileResult.value).
  return interrupt std::notes::create("Create a note in the Notes app?", {
    account: "",
    folder: folder,
    title: title,
    folderCreated: !exists.value
  })

  destructive {
    return try _createNote(title, html.value, folder)
  }
}

export def appendToNote(id: string, body: string, folder?: string): Result<Note> raises <std::notes::append> {
  """
  Append Markdown to an existing note. Get the id from listNotes or searchNotes.

  @param id - The note's id
  @param body - The content to append, as Markdown
  @param folder - If given, the call fails unless the note is in this folder
  """
  const html = toHtml(body)
  if (isFailure(html)) {
    return html
  }

  const p = preflight(id, folder)
  if (isFailure(p)) {
    return p
  }

  return interrupt std::notes::append("Append to a note in the Notes app?", {
    account: p.value.account,
    folder: p.value.folder,
    title: p.value.title,
    id: id
  })

  destructive {
    return try _appendToNote(id, html.value, folder)
  }
}

export idempotent def readNote(id: string, folder?: string): Result<NoteContent> raises <std::notes::read> {
  """
  Read a note's contents as plain text. Get the id from listNotes or searchNotes.

  @param id - The note's id
  @param folder - If given, the call fails unless the note is in this folder
  """
  const p = preflight(id, folder)
  if (isFailure(p)) {
    return p
  }

  return interrupt std::notes::read("Read a note from the Notes app?", {
    account: p.value.account,
    folder: p.value.folder,
    title: p.value.title,
    id: id
  })

  return try _readNote(id, folder)
}

export idempotent def searchNotes(query: string, folder?: string): Result<Note[]> raises <std::notes::search> {
  """
  Search notes by their text and return matching notes' metadata, without their
  contents.

  @param query - The text to search for
  @param folder - If given, only search this folder
  """
  const payloadFolder = if folder == null then "" else folder

  return interrupt std::notes::search("Search the notes in the Notes app?", {
    account: "",
    folder: payloadFolder,
    query: query
  })

  return try _searchNotes(query, folder)
}

export idempotent def listNotes(folder?: string): Result<Note[]> raises <std::notes::list> {
  """
  List notes' metadata, without their contents.

  @param folder - If given, only list this folder
  """
  const payloadFolder = if folder == null then "" else folder

  return interrupt std::notes::list("List the notes in the Notes app?", {
    account: "",
    folder: payloadFolder
  })

  return try _listNotes(folder)
}

export idempotent def listFolders(): Result<Folder[]> raises <std::notes::list> {
  """
  List the folders in the Notes app, with a count of the notes in each.
  """
  return interrupt std::notes::list("List the folders in the Notes app?", {
    account: "",
    folder: ""
  })

  return try _listFolders()
}

export def deleteNote(id: string, folder?: string): Result<null> raises <std::notes::delete> {
  """
  Delete a note. It moves to the Recently Deleted folder, where it stays for
  about 30 days.

  @param id - The note's id
  @param folder - If given, the call fails unless the note is in this folder
  """
  const p = preflight(id, folder)
  if (isFailure(p)) {
    return p
  }

  return interrupt std::notes::delete("Delete a note from the Notes app?", {
    account: p.value.account,
    folder: p.value.folder,
    title: p.value.title,
    id: id
  })

  destructive {
    return try _deleteNote(id, folder)
  }
}
```

- [ ] **Step 1b: Pin the empty-string payload behaviour with a test**

Create `packages/agency-lang/lib/stdlib/__tests__/notesPolicy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import picomatch from "picomatch";

// std::notes/apple passes "" for an omitted optional `folder`, never null.
// This test exists so nobody "tidies" that into null, and so the reasoning
// survives: an empty folder must match NOTHING, so a catch-all {"folder": "*"}
// approve rule cannot approve a listNotes() with no folder.
describe("policy globs against an omitted folder", () => {
  it("an empty folder does not match a specific glob", () => {
    expect(picomatch.isMatch("", "Work")).toBe(false);
  });

  it("an empty folder does not match a catch-all glob", () => {
    // The load-bearing one. If this ever becomes true, listNotes() with no
    // folder — the widest-reaching call in the module — starts matching any
    // {"folder": "*"} approve rule, and the payload design needs rethinking.
    expect(picomatch.isMatch("", "*")).toBe(false);
    expect(picomatch.isMatch("", "**")).toBe(false);
  });

  it("a real folder still matches", () => {
    expect(picomatch.isMatch("Work", "*")).toBe(true);
    expect(picomatch.isMatch("Work", "Work")).toBe(true);
  });

  it("null throws, which is why payloads never carry it", () => {
    expect(() => picomatch.isMatch(null as unknown as string, "Work")).toThrow();
  });
});
```

Run:
```bash
cd packages/agency-lang && npx vitest run lib/stdlib/__tests__/notesPolicy.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 2: Verify it parses**

Run:
```bash
cd packages/agency-lang && pnpm run ast stdlib/notes/apple.agency > /dev/null && echo PARSES
```
Expected: `PARSES`.

If it fails, check `docs/site/guide/basic-syntax.md`. Known parser gotchas from the memory file: `!(...)` on a paren-expression fails to parse, and `thread` is a keyword. Every `if ... then ... else` expression in the module is already hoisted to a `const` (`payloadFolder`) rather than written inline in an object literal, because `if` expressions are only reliably allowed as a `const`/`let` value or a `return` — do not inline them back while tidying.

- [ ] **Step 3: Add the capability sets**

Modify `packages/agency-lang/stdlib/capabilities.agency`, appending after the `Memory` set:

```ts
/** Read-only Notes access: reading, searching, and listing. */
export effectSet NotesRead = <std::notes::read, std::notes::search, std::notes::list>

/** Notes mutation: creating, appending, and deleting. */
export effectSet NotesWrite = <std::notes::create, std::notes::append, std::notes::delete>

/** All Notes access, reads and writes. */
export effectSet Notes = <NotesRead, NotesWrite>
```

- [ ] **Step 4: Build**

Run:
```bash
cd packages/agency-lang && make
```
Expected: exit 0. `make` is required for any stdlib change.

- [ ] **Step 5: Verify the tool schema narrows under partial application**

Create `notes-check.agency` directly in `packages/agency-lang/` (not in /tmp — Agency files only run where node_modules is available):

```ts
import { createNote } from "std::notes/apple"

node main() {
  const inbox = createNote.partial(folder: "Agency Inbox").rename("addToInbox")
  print("partial applied ok")
}
```

Run:
```bash
cd packages/agency-lang && pnpm run agency notes-check.agency; rm -f notes-check.agency
```
Expected: `partial applied ok`. This exercises compilation and PFA without touching Notes.app.

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/stdlib/notes/apple.agency packages/agency-lang/stdlib/capabilities.agency packages/agency-lang/docs/site/stdlib/
git commit -m "Add the std::notes/apple module and its capability sets

Per-operation effects rather than one blanket std::notes, so a policy can
approve reads and reject deletes. Payloads carry account, folder and
title because those are what policy globs match on. For append, read and
delete the payload is built from the ungated pre-flight lookup, so the
approver sees the note's real title and folder rather than an opaque id,
and a folder-scoped policy can match a call that passed only an id.

Notes are addressed by id, since duplicate titles are legal. The optional
folder argument constrains rather than addresses, so partial application
confines an agent to one folder in a way the model cannot see."
```

---

## Task 6: Documentation

**Files:**
- Create: `packages/agency-lang/docs/site/guide/apple-notes.md`

The stdlib reference page is generated from the module's doc comments by `agency doc`, so it needs no hand-editing. This task adds the guide page, which the spec (§3.1) says is also where Obsidian users get their answer.

- [ ] **Step 1: Write the guide page**

Create `packages/agency-lang/docs/site/guide/apple-notes.md`:

```markdown
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
```

- [ ] **Step 2: Write the two v1 limits into the spec**

Edit `/Users/adityabhargava/agency-notes-92/docs/superpowers/specs/2026-07-16-std-notes-apple-notes-design.md`:

1. Add a "v1 limits" note recording both deliberate limits from this plan's
   "Two v1 limits" section: nested folder paths are unsupported (`listFolders`
   returns top-level folders only), and `account` is an output field, not an
   input filter. The spec currently promises an `account` argument (§4.2); it
   must stop promising what the code does not build.
2. The spec header still says "awaiting owner review" — that is stale (the
   review happened and its findings are folded in). Fix it while in the file.

This step exists because a spec that overpromises is how the next person
reintroduces the gap. It must land in the same PR as the module.

- [ ] **Step 3: Build so the guide is staged into the stdlib**

Run:
```bash
cd packages/agency-lang && make
```
Expected: exit 0. `make` copies `docs/site/guide` into `stdlib/docs/guide` for `std::skills::docsSkill`.

- [ ] **Step 4: Verify the generated stdlib reference page exists**

Run:
```bash
cd packages/agency-lang && ls docs/site/stdlib/notes/ && grep -c "createNote" docs/site/stdlib/notes/apple.md
```
Expected: `apple.md` listed, and a non-zero count. `agency doc` recurses, so no registry needed.

- [ ] **Step 5: Commit**

```bash
git add packages/agency-lang/docs/site/guide/apple-notes.md packages/agency-lang/stdlib/docs/ packages/agency-lang/docs/site/stdlib/ docs/superpowers/specs/2026-07-16-std-notes-apple-notes-design.md
git commit -m "Document std::notes/apple

Adds the guide page. The stdlib reference page is generated from the
module's doc comments.

The guide also answers the Obsidian question, since a vault is Markdown
files on disk and std::fs already covers it — which is why there is no
std::notes/obsidian."
```

---

## Task 7: Full verification

**Files:** none. This task runs checks and fixes what they surface.

- [ ] **Step 1: Run the full local check**

Run:
```bash
cd packages/agency-lang && make && npx tsc --noEmit -p tsconfig.json && pnpm run lint:structure && npx vitest run lib/stdlib/__tests__/appleNotes.test.ts lib/stdlib/__tests__/markdown.test.ts 2>&1 | tail -20
```
Expected: all exit 0; appleNotes 48 tests pass, and the markdown suite passes (verify the count empirically — do not chase a number written here).

Save the output to a file rather than rerunning — the suites here are slow:
```bash
... 2>&1 | tee /tmp/notes-verify.txt
```

- [ ] **Step 2: Audit the diff against the anti-patterns doc**

Read `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`, then re-read your own diff against them. Look specifically for: free functions that should be methods, cross-object field-reaching, and imperative code where declarative would read better. This is a required step, not a suggestion.

- [ ] **Step 3: Confirm no test can reach real Notes.app**

Run:
```bash
cd packages/agency-lang && grep -rn "osascript" lib/stdlib/__tests__/appleNotes.test.ts | grep -v "toBe\|toEqual\|expect" || echo "NONE — good"
ls tests/agency/notes* 2>/dev/null && echo "PROBLEM: agency tests for notes exist" || echo "NONE — good"
```
Expected: both report good. Every test mocks `execFile`; nothing shells out. A test that reached Notes.app could destroy real notes when someone runs the suite locally.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues surfaced by the verification pass"
```

---

## Self-Review

Checked against the spec:

| Spec section | Task |
|---|---|
| §3.6 argv, no `-` separator | 1 (tested) |
| §2.8 both error codes | 1 (tested) |
| §6.1 `with timeout` | 1 |
| §5.3 pre-flight, split container, payloads built from it | 2, 5 (tested) |
| §2.7 locked = data loss | 2, 4 (tested, mutation-verified) |
| §2.4 read plaintext, write HTML | 3, 5 (tested) |
| §9.3 search plaintext not body | 3 (tested) |
| §6.4 scoped-lookup assertion | 4 (tested) |
| §9.4 create folder on demand | 4, 5 (tested) |
| §4.2 signatures, typed Results, `raises` | 5 |
| §5.1 six effects, payloads incl. `account` | 5 |
| §5.2 three capability sets | 5 |
| §5.4 `idempotent` on reads | 5 |
| §3.1 Obsidian answer | 6 |
| §8 unit tests only | 7 (verified) |

**Review findings from spec §12, applied:**

| # | Where |
|---|---|
| 2 | Task 5 — `search` payload has `folder` and `account` |
| 4 | Task 4 — scoped lookup, plus locked re-check in the write script |
| 5 | Task 5 — `raises` on all seven |
| 6 | Task 5 — `idempotent` on reads, per `git.agency` |
| 8 | Task 5 — `Result<Note>`, `Result<Note[]>`, `Result<NoteContent>` |
| 9 | Task 2 — the "unguessable id" argument in the docstring, not "unreachable" |

| 7 | Resolved by measurement, not worked around. See "Why empty strings, not null". `""` matches nothing including `"*"`, so the feared fail-open cannot occur; `null` would throw. Task 5 step 1b pins it. |

**One finding from §12 remains open, and is not blocking:**

- **Finding 11b.** Whether `renderForHtml` should drop raw HTML silently or emit a diagnostic. Currently silent.

**Two deliberate v1 limits**, both measured, both documented above under "Two v1 limits":

- **Nested folder paths are unsupported.** `listFolders` returns top-level folders only, which is honest rather than the flat-and-wrong alternative. Nested folders stay reachable by bare name, ambiguously — Notes' own behaviour.
- **The `account` argument is not implemented.** `account` is an output field, not an input filter, so folder scoping stays advisory on a multi-account machine. The owner has one account, so this is latent. Task 6 Step 2 writes both limits into the spec, so the spec stops promising what the code does not build.

**The account BUG, as distinct from the missing argument, is fixed** in Task 2's `ACCOUNT_WALK`. One hop up from a note's folder lands on `Archived`, not `iCloud`, for anything nested. That was wrong and silently so.

---

## Plan review round 1 (2026-07-17), findings applied

An external review of this plan checked its claims against the codebase. What
it verified as correct: the `return interrupt` + `destructive` idiom
(`stdlib/messaging/imessage.agency:33-43`), the double-return read idiom
(`gitStatus`, `stdlib/git.agency:154-155`), the `effectSet` syntax, the
`"agency-lang/stdlib-lib/*.js"` import path, the `ParseResult` shape
(`stdlib/markdown.agency:223-228`), optional `?` params (confirmed via
`pnpm run ast`), and the picomatch measurements (re-run: `isMatch("", "*")` is
`false`, `null` throws). Six findings needed fixes, all folded in above:

1. **The append/read/delete interrupt payloads were hollow** — `title: ""` and
   `account: ""` hardcoded, `_preflightNote` never called before the interrupt.
   That defeated spec §5.3 and Task 2's own rationale: a human approving a
   delete saw only an opaque id, and a folder policy could never match a call
   that passed only an id. Fixed in Task 5 with the `preflight` helper, which
   also refuses a folder-assertion mismatch before the interrupt so the payload
   folder is always the note's real folder.
2. **`folderCreated: !exists` negated the Result object, not the boolean** —
   always-truthy success object, so the flag would silently always read false.
   Fixed to `!exists.value`.
3. **Two tests queued one mock but made two calls** (the -1743 test and
   `_readNote`'s folder-assertion test). `vi.clearAllMocks()` does not clear
   the factory default, so the second call resolved and the assertion failed.
   Fixed by queueing per call.
4. **`_listNotes` and `_folderExists` had no tests**, and the expected test
   counts in Tasks 2–4 were wrong. Tests added; counts now 20 / 35 / 47.
5. **The spec edit the self-review demanded had no step.** Now Task 6 Step 2.
6. **Inline `if ... then ... else` in object literals** was a known parse risk
   used five times. The pre-flight fix removed three; the rest are hoisted to
   `const payloadFolder`. Also fixed the self-contradictory /tmp wording in
   Task 5 Step 5, and documented in the guide that an `account` match never
   applies to the calls that send `account` as `""`.

## Plan review round 2 (2026-07-17), findings applied

A second, independent review (`2026-07-17-std-notes-apple-REVIEW.md`, written
against the pre-round-1 plan) verified its two blockers — inline
`if/then/else` does not parse, and `!exists` is always false — both already
fixed in round 1. Two of its further findings were adopted:

1. **The read path kept the TOCTOU the write path closes** (its Finding 3).
   `_readNote` asserted the folder by compare, then read with an unscoped
   `note id X` — so a note that moved folders during the human approval was
   still read. Reading is the operation folder confinement was invented for,
   and the guide's "anything outside Work fails closed" claim has to be true
   for reads too. Fixed: `_readNote` now has scoped and unscoped script shapes
   like `_appendToNote`, with a test. `assertFolder` stays as the fail-fast
   readable error; its comment now says the scoped lookup is the authoritative
   assertion on both paths. Counts now 36 / 48.
2. **`FIELD_DELIM` was a raw invisible control byte in source** (its Finding
   5). If the byte is mangled in transit, the test's own expected value
   mangles with it and still passes. Both are now the `\u0001` escape.

Its Finding 4 (thread the real account through payloads that pre-flight) was
already covered by round 1's payload fix. Its remaining notes — `listFolders`
sharing `std::notes::list` with `listNotes`, and `renderForHtml`'s silent
raw-HTML drop (spec finding 11b) — stay open as accepted v1 decisions.
