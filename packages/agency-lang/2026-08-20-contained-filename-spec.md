# Spec: contain single-file operations within their directory

## Summary

Some standard-library tools accept a directory and a filename separately. The
interrupt reports those two values before the implementation combines them.
Today, `resolvePath` lets an absolute filename, a leading `~`, or `..` escape
the directory. A symlink below the directory can escape it too.

This spec adds one shared preparation function for these tools. The function
canonicalizes the directory, normalizes the filename, and rejects any stable
destination outside the directory. The wrapper puts the prepared values in the
interrupt and uses the same values during execution.

This is a narrow containment fix. It does not attempt to make every
path-bearing interrupt in the standard library report a canonical destination.

## Problem

The motivating case has a fixed working directory and a model-chosen filename:

```json
{ "dir": "/tmp/workdir", "filename": "~/payload.agency" }
```

The interrupt reports `/tmp/workdir`, so a workdir-scoped policy may approve
the operation. After approval, `resolvePath` expands `~` and writes the file in
the home directory.

The same escape is possible with an absolute filename or upward traversal:

```text
filename = "/outside/payload.agency"
filename = "../../outside/payload.agency"
```

A lexical containment check does not cover symlinks:

```text
/tmp/workdir/link -> /outside
filename = "link/payload.agency"
```

The fix must reject all four stable escape forms before asking for approval.

## Security contract

For the tools in scope:

> The resolved file operand must remain inside the resolved `dir` operand.
> The interrupt and the implementation must use the same prepared `dir` and
> `filename` values.

This contract authorizes a root directory, not every filesystem entry that an
operation may inspect. A symlink may be followed when its target remains
inside that root.

The contract does not claim that the payload names the final target of an
in-directory symlink. It only guarantees containment. This distinction keeps
the fix small and avoids imposing one leaf-symlink policy on unrelated
operations.

Containment applies where `dir` and `filename` come from different trust
levels: the harness supplies `dir`, an untrusted source supplies `filename`.
Where one source supplies both, containment would be vacuous; those wrappers
instead report the resolved parent of the target as `dir` (see the safeBash
section).

The migration rule for every caller this change breaks is a design
principle, not a workaround: **the destination belongs in `dir`, because
`dir` is the field the judge reads.** A caller that wants
`/tmp/report.txt` writes `write("report.txt", dir: "/tmp")`. Nothing is
lost. The interrupt then reports `/tmp` truthfully, and the policy or the
human judges the real destination.

## Scope

The change covers the single-file wrappers that already carry separate `dir`
and `filename` fields:

| Wrapper | Effect | Operation |
|---|---|---|
| `stdlib/index.agency:read` | `std::read` | read text |
| `stdlib/index.agency:write` | `std::write` | write text |
| `stdlib/index.agency:readBinary` | `std::readBinary` | read bytes |
| `stdlib/index.agency:writeBinary` | `std::writeBinary` | write bytes |
| `stdlib/fs.agency:edit` | `std::edit` | preview and edit text |
| `stdlib/agency.agency:typecheckFile` | `std::read` | read Agency source |
| `stdlib/agency.agency:writeAST` | `std::write` | write Agency source |
| `stdlib/agency.agency:loadTemplate` | `std::read` | read a template |
| `stdlib/agency.agency:formatFile` | `std::write` | rewrite Agency source |
| safeBash write plan | `std::write` | redirected echo write |

The non-raising TypeScript implementations remain unrestricted. They are
internal primitives, and existing direct TypeScript callers keep the current
`resolvePath` behavior. The Agency wrappers own the approval boundary and
therefore own this check.

## Out of scope

- `applyPatch`, `mkdir`, `copy`, `move`, and `remove`, which do not have the
  trusted-directory-plus-filename shape.
- Directory tools such as `ls`, `grep`, and `glob`.
- Speech, skills, memory, Git, subprocess, and system effects.
- A global guarantee that every path-bearing interrupt is canonical.
- Containment parameters for arbitrary shell command strings.
- Filesystem changes made by another process between preparation and
  execution.

These operations may deserve separate audits. They do not block this focused
fix.

## Design

### One shared preparation function

The pattern has prior art in this repository: `runFile`'s `_compileFile`
already realpaths both `dir` and target and refuses a target outside `dir`
(pinned by `tests/agency/subprocess/run-file-rejects-escape.agency`). This
spec gives that idea one shared, tested owner.

Add the function beside `resolvePath`:

```ts
export type ContainedPath = {
  dir: string;
  filename: string;
};

export type FileOperation = "read" | "write";

export async function prepareContainedPath(
  dir: string,
  filename: string,
  operation: FileOperation,
): Promise<ContainedPath>;
```

`operation` is required and closed rather than an optional free-form verb. It
does not change path resolution; it selects the user-facing rejection wording
without permitting invalid operations or silently defaulting a read to a write
message.

Before the numbered path steps, reject an empty or whitespace-only `dir`.
Otherwise `resolveDir("")` would silently reinterpret a malformed scoped
request as the process working directory.

`prepareContainedPath` performs these steps:

1. Expand and absolutize `dir` with the same rules as `resolveDir`.
2. Resolve `dir` with `fs.realpath`. The directory must exist. This matches the
   scoped operations, which cannot create their `dir` operand themselves.
3. Expand `filename` with `expandPath`.
4. Reject an absolute expanded filename. This includes a leading `~`, because
   expansion turns it into an absolute path.
5. Resolve the filename lexically against the real directory.
6. Reject the lexical result unless it is inside the real directory.
7. Resolve the target through existing symlinks. If the leaf does not exist,
   resolve its nearest existing ancestor and append the missing tail.
8. Reject the resolved target unless it is inside the real directory.
9. Reject a dangling symlink in any existing component **on the target
   path**. This is a walk of the target's components only, never a scan of
   the tree under `dir`.
10. Return the real directory and the normalized relative filename.

Missing intermediate directories are contained, not dangling:
`write("sub/new/file.txt", dir: root)` with `sub/` absent prepares
successfully — step 7 resolves through the nearest existing ancestor and
step 8 judges the lexical remainder under it. Whether the write then
creates the intermediates is unchanged by this spec.

The result deliberately retains an in-directory symlink in `filename` rather
than replacing it with its target. Execution therefore preserves existing API
behavior while the resolved-target check proves that the stable symlink cannot
escape the directory.

The helper uses the repository's existing path containment primitive. It does
not add another string-prefix implementation. Containment must continue to use
`path.relative` and the existing Windows case-folding behavior.

`assertContained.ts` already has a nearest-existing-ancestor walk, but that
walk deliberately treats every `realpath` failure as a lexical fallback. This
contract instead distinguishes a genuinely missing component (`ENOENT`) from
permission, I/O, `ENOTDIR`, and symlink-loop failures, all of which fail
closed. The implementation must document this semantic difference rather than
silently cloning the older helper. The new strict walk has one owner and is
reused by both contained-file preparation and safeBash redirect resolution.

### Dangling symlinks fail closed

A dangling symlink has a known textual target, but handling every relative
link chain correctly would turn this containment fix into the broader path
planning project. The smaller rule is:

> If `lstat` finds a symlink and `realpath` cannot resolve it, preparation
> fails before the interrupt.

This changes writes through dangling symlinks from “create the link target” to
an error. It avoids approving a destination that the containment helper did
not prove safe.

### Wrappers prepare before interrupting

Each scoped wrapper prepares once, then uses the result in both places:

```agency
const path = _prepareContainedPath(dir, filename, "write")
return interrupt std::write("Are you sure you want to write to this file?", {
  dir: path.dir,
  filename: path.filename,
  content: content,
  mode: mode
})
destructive {
  return try _write(path.dir, path.filename, content, mode)
}
```

Read wrappers follow the same pattern without a `destructive` block.

`edit` must prepare before `_previewEdit`. The preview, interrupt, and
`_multiedit` call all use the prepared values. This prevents the preview and
the eventual write from referring to different spellings.

The preparation error occurs before the interrupt. A handler cannot approve an
escape because no escape request reaches a handler.

### safeBash reports the resolved parent instead of containing

safeBash is the "one source supplies both" case from the security contract:
the whole command, redirect target included, is untrusted, so there is no
trusted `dir` to contain within. Containing against the plan's cwd would
break ordinary shell usage — `echo x > /tmp/notes.txt` would fail at
preparation with no handler ever asked, even interactively.

Instead, safeBash's write-plan constructor resolves the redirect target
(same expansion and symlink rules as preparation steps 3 and 7, minus the
containment rejections) and stores `dir` = the target's resolved parent,
`filename` = its final name, in **both** the effect payload and the
`WriteExec`. Containment is trivially satisfied; the payload is truthful
where it matters: a policy scoped to the workdir does not match `/tmp`,
and an interactive approver reads the real destination. `runWrite`
continues to use the non-raising `_write` primitive.

The safeBash callers use one declarative Agency helper:

```agency
def prepareRedirectWrite(
  redirect: Redirect,
  cwd: string,
  content: string,
): Result<WritePayload>
```

That helper owns redirect validation, literal-word extraction, quote-aware
tilde semantics, path resolution, write mode, and conversion of bridge errors
to `Result`. `writePlan` and `redirectEffect` ask it for a planned write; they
do not reproduce those steps or pass an unexplained `expandHome` boolean
through their own interfaces. The TypeScript bridge may use a closed
`"expand" | "literal"` tilde mode internally because that is the path-layer
decision the Agency helper has already made.

For a shell-free redirect, construct one `WritePayload`, derive the
`std::write` effect from it, and derive `WriteExec` from that same value. The
approval and execution representations must agree by construction rather than
by manually copying four fields in two object literals. Bash-backed redirects
use the same `prepareRedirectWrite` helper to construct their write effect.

The plan test must assert that the payload and `WriteExec` contain
identical prepared values, and that `echo x > /tmp/f` raises `std::write`
with `dir` = `/tmp`'s real path.

### Canonical directory in policies

The interrupt reports the real directory. This closes the equivalent escape
where the caller supplies a symlink as `dir`:

```text
/tmp/workdir/link -> /outside
dir = "/tmp/workdir/link"
filename = "payload.agency"
```

The payload reports `/outside`, so a policy limited to `/tmp/workdir` does not
approve it.

Policies use `.` to mean the launch directory. Update
`resolveDotDirPattern` so it realpaths the launch directory before inserting it
into a `dir` pattern. A `{.,./**}` policy and a canonical interrupt then use
the same path identity when the process starts from a symlinked checkout.

## Errors

Preparation reports one of these failures:

- the directory is empty or does not exist;
- the filename is absolute after expansion;
- the lexical filename escapes the directory;
- the resolved symlink target escapes the directory; or
- an existing path component is a dangling symlink.

Messages name the rejected filename and directory but do not expose unrelated
filesystem contents.

The escape rejections teach the migration rule, because the models driving
agent tools will keep producing absolute filenames and must learn the right
retry from the error itself:

```text
write refused: filename "/tmp/report.txt" is outside dir "/work". To write
somewhere else, pass that directory in dir: write("report.txt", dir: "/tmp").
```

The file-tool docstrings gain the same one sentence, so the rule is visible
before the first mistake, not only after it.

## Compatibility

This is an intentional behavior change for scoped Agency wrappers:

- Absolute filenames no longer override `dir`.
- A leading `~` in `filename` no longer selects the home directory.
- `..` may normalize within `dir`, but it may not escape `dir`.
- Symlinks that resolve outside `dir` are rejected.
- Dangling symlinks are rejected.
- The interrupt's `dir` is canonical and its `filename` is normalized.

Normal nested filenames continue to work:

```text
dir = "/work"
filename = "src/lib/file.ts"
```

Existing symlinks whose targets remain inside `/work` also continue to work.
Direct TypeScript callers of `resolvePath`, `_read`, `_write`, and related
primitives retain their current behavior.

Policies that hard-code a symlinked absolute directory must migrate to its
real path. Policies based on `.` continue to work because policy expansion is
canonicalized with the interrupt.

### Caller inventory

An audit of `stdlib/`, `lib/agents/`, and `tests/` for callers that pass an
absolute, `~`-led, or upward-traversing filename through a scoped wrapper
found four, all migrated in this change:

1. `lib/agents/agency-agent/brains/coordinator/subagents/code.agency:79,102`
   — `promptFile("../prompts/code.md")` and `("../prompts/oneShot.md")`.
   The coordinator loads its own prompts through the scoped `read` with an
   upward-traversing filename, and `promptFile` swallows read failures, so
   the breakage would be silent empty prompts. Migrates to the rule:
   `read("code.md", dir: __dirname + "/../prompts")`.
2. `tests/agency/dirname-paths/helper.agency:14` — `readUpward` exists to
   pin the OLD contract (upward reads work). The test flips: it now pins
   the new contract by asserting the upward read is rejected, and a
   sibling case asserts the dir-based spelling succeeds.
3. `tests/agency/stdlib-destructive.agency:9` —
   `write("/nonexistent-dir-xyz/f.txt", "hi")` asserts on the failure
   shape, which changes from ENOENT to the preparation rejection. The
   assertion updates.
4. `stdlib/safeBash` write plan — covered by its own section; absolute
   redirect targets keep working via parent-as-dir.

The docstrings that become false and must change in the same commit as the
behavior: `read`, `write`, `readBinary`, `writeBinary` in
`stdlib/index.agency`, `edit` in `stdlib/fs.agency`, and `resolvePath`
(`lib/stdlib/resolvePath.ts`), whose text currently promises "upward
traversal and absolute filenames are allowed."

### Superseded work

This spec supersedes `2026-08-20-resolved-interrupt-destination-spec.md`
(v3, branch `adit/resolved-destination`). Two pieces carry over verbatim:
the canonicalized `.` expansion in `resolveDotDirPattern`, and the safeBash
payload/`WriteExec` parity test. The v3 reviews' remaining findings —
`applyPatch`'s `{ patch }`-only payload, `copy`/`move`/`remove`,
`ls`/`grep`/`glob` leaf symlinks, and the wider path-bearing-effect audit
(`filepath`, `outputFile`, `cwd`, Git `paths`) — are the tracked
known-exposure list behind this spec's out-of-scope section.

## Tests

### Helper unit tests

- relative nested filename inside `dir`;
- `.` and `..` that normalize inside `dir`;
- absolute filename rejection;
- leading-`~` filename rejection;
- `..` escape rejection;
- symlinked `dir` returns its real path;
- existing parent symlink with an in-directory target;
- existing parent symlink with an outside target;
- existing final symlink with an in-directory target;
- existing final symlink with an outside target;
- dangling parent and final symlink rejection;
- missing leaf below an existing real parent;
- a multi-link in-directory symlink chain;
- a symlink loop and `ENOTDIR` fail closed;
- a mocked non-`ENOENT` filesystem error fails closed;
- exact read and write teaching wording;
- Windows case-insensitive containment where applicable.

Every temporary filesystem fixture uses a unique `mkdtemp` root and is removed
in `afterEach`/`finally`. Fixed writable paths such as `/tmp/report.txt` are not
test fixtures: a failed safety assertion must not overwrite an unrelated file.

### Wrapper tests

- Each of `read`, `write`, `readBinary`, `writeBinary`, and `edit` has a
  contained success case and an escape-rejection case. A recording handler
  asserts that a symlinked `dir` is realpathed and `a/../f` is normalized in
  the interrupt payload; successful execution observes the same destination.
- `edit`'s recorded payload contains the prepared path and the expected
  `before`/`after`, while the final file proves the edit executed there.
- Each of the four `stdlib/agency.agency` wrappers rejects a `~` escape before
  its handler and has a contained success smoke test (existing focused tests
  may supply the success half when named in the implementation plan).
- safeBash stores identical prepared values in its effect and `WriteExec`.

### Migration tests

- Both coordinator prompts load through the dir-based spelling. A test-only
  import of `promptFile` checks `code.md` and `oneShot.md` independently; one
  nonempty aggregate prompt cannot hide failure of the other.
- `readUpward` in `dirname-paths` asserts rejection; its dir-based sibling
  asserts success.
- A model-style `write("/abs/x")` produces the teaching error message,
  verbatim match on the "pass that directory in dir" sentence.
- preparation of `write("sub/new/file.txt", dir: root)` with `sub/` absent
  succeeds, then the unchanged `_write` fails after entering its destructive
  block because it does not create parent directories.
- safeBash: `echo x > /tmp/f` raises `std::write` with `dir` = `/tmp`'s
  real path (using an isolated temporary equivalent in executable tests); a
  workdir-scoped policy rejects it; approving it writes the file. Shell-free
  and Bash-backed redirects, quoted and unquoted `~`, final symlinks, dangling
  links, and broad-fallback behavior are pinned separately.

### End-to-end security tests

- A workdir-scoped run rejects `write("~/escape.txt")` before raising and
  creates no file.
- Absolute and `..` escapes create no file.
- A symlink below the workdir that points outside is rejected.
- A symlink supplied as `dir` appears as its real directory in the interrupt,
  so a workdir-scoped policy does not approve an outside target.
- A symlink whose target remains inside the workdir succeeds.
- A symlinked launch directory still matches a `{.,./**}` policy through
  `checkPolicy`, not only through a direct `resolveDotDirPattern` assertion.

Run targeted unit and Agency execution tests. Do not run the full Agency test
suite locally.

## Rollout

Implement this in one focused PR:

1. Add `prepareContainedPath` and its unit tests.
2. Convert the scoped wrappers and safeBash plan construction.
3. Canonicalize `.` expansion for `dir` policy patterns.
4. Add the targeted wrapper, policy, and end-to-end tests.
5. Document the filename containment rule in the affected stdlib API docs and
   `docs/dev/approval-policies.md`.

Track any broader audit of path-bearing effects separately. This PR is complete
when model-controlled filenames cannot escape their prepared directory through
absolute paths, `~`, `..`, or stable symlinks.
