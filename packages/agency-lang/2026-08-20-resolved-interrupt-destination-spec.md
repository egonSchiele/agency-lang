# Spec: file interrupts report the resolved destination

## Background

Every file operation in the standard library asks for permission before it
runs. The mechanism is an interrupt. For example, `write` raises:

```agency
return interrupt std::write("Are you sure you want to write to this file?", {
  dir: dir,
  filename: filename,
  content: content,
  mode: mode
})
```

A policy judges that interrupt by matching glob patterns against its
fields. A typical rule approves writes inside one directory:

```json
"std::write": [
  { "match": { "dir": "{.,./**}" }, "action": "approve" }
]
```

In an interactive session a human judges it instead, by reading the same
fields off the screen.

## The problem

The interrupt reports `dir` and `filename` exactly as the caller passed
them. But the write does not happen at `dir` + `filename` as spelled. After
approval, `_write` routes the name through `resolvePath`, which expands `~`
to the home directory and lets an absolute or `..`-containing filename
ignore `dir` entirely. So the fields the judge saw can disagree with the
place the file lands.

Concrete example, found during review of PR #874. The agent's working
directory is `/tmp/workdir`, and a model-chosen filename arrives:

```json
{ "dir": "/tmp/workdir", "filename": "~/payload.agency" }
```

A cwd-scoped policy rule looks at `dir`, sees `/tmp/workdir`, and approves.
The file is then created at `/Users/adityabhargava/payload.agency`. The
permission question lied about the destination. A human reviewer skimming
an approval prompt is fooled the same way: "writing `~/payload.agency` in
`/tmp/workdir`" reads as safe.

The same lie is available to every field-carrying file interrupt, and for
reads it is just as serious: a policy that approves reads under the project
directory will approve `{ dir: ".", filename: "~/.ssh/id_rsa" }`.

PR #874 first tried to fix this for one caller with bespoke containment
checks. Three review rounds showed that path checks bolted on next to the
write cannot hold the invariant. The durable fix is to make the interrupt
itself tell the truth, once, for every file operation.

## The invariant

**A file interrupt's `dir` and `filename` fields name the place the
operation will actually touch.**

After this change, the example above raises:

```json
{ "dir": "/Users/adityabhargava", "filename": "payload.agency" }
```

The cwd-scoped rule no longer matches, so the headless run rejects the
write and the agent is told why. No caller needs its own containment
check. The policy, which already exists and already owns this decision,
judges honest data.

## Design

### One resolver, called before every raise

Add one TS helper and expose it to Agency code through the existing
stdlib-lib bridge:

```ts
/** The destination a file operation will actually touch: `~` expanded,
 *  the filename resolved against dir (absolute filenames win, as in
 *  resolvePath), and symlinked parent directories that exist on disk
 *  resolved to their real location. Returned split into the parent
 *  directory and the final name, ready for an interrupt payload. */
export async function resolvedDestination(
  dir: string,
  filename: string,
): Promise<{ dir: string; filename: string }> {
  const full = await resolvePath(dir, filename);       // expandPath + path.resolve
  const real = await realpathOrLexicalAncestor(full);  // shared with assertContained
  return { dir: path.dirname(real), filename: path.basename(real) };
}
```

Each raise site calls it just before the interrupt:

```agency
const dest = _resolvedDestination(dir, filename)
return interrupt std::write("Are you sure you want to write to this file?", {
  dir: dest.dir,
  filename: dest.filename,
  content: content,
  mode: mode
})
destructive {
  return try _write(dest.dir, dest.filename, content, mode)
}
```

Note the second half: the operation itself runs on the resolved fields the
judge approved, not on the original spelling. Approving `X` and then
writing to `resolve(X)` would reopen the gap this spec closes.

### Why `realpathOrLexicalAncestor` is part of resolution

`~` and `..` are spelling tricks; `path.resolve` plus `expandPath` handles
those. Symlinked parents are a disk trick: if `workdir/sub` is a symlink
to `/outside`, then `workdir/sub/x.txt` is really `/outside/x.txt`. The
helper `realpathOrLexicalAncestor` already exists in `assertContained.ts`:
it resolves the deepest ancestor that exists on disk and re-appends the
rest, so a not-yet-existing file still resolves through its real parent.
Reusing it means the payload shows `/outside/x.txt`, and a dir-scoped rule
correctly declines to match.

One consequence is worth stating: when the final component itself is a
symlink that exists, realpath resolves through it, so the payload names
the link target. That is the destination a write would touch, which is
exactly what the judge should see.

### Payload shape does not change

The fields stay `dir` and `filename`. Existing policies keep working
unchanged, because agent tools already absolutize `dir` before raising;
this change only makes `dir` truthful in the cases where it lied. The
approval UI needs no changes either, and gets better output for free: the
human now reads the real destination.

### Affected raise sites

Every stdlib interrupt that carries a file destination:

| Site | Effect | Fields to resolve |
|---|---|---|
| `stdlib/index.agency:183` | `std::read` | dir + filename |
| `stdlib/index.agency:211` | `std::write` | dir + filename |
| `stdlib/index.agency:242` | `std::writeBinary` | dir + filename |
| `stdlib/index.agency:268` | `std::readBinary` | dir + filename |
| `stdlib/fs.agency:63` | `std::edit` | dir + filename |
| `stdlib/fs.agency:88` | `std::applyPatch` | dir + filename |
| `stdlib/fs.agency:108` | `std::mkdir` | dir |
| `stdlib/fs.agency:130` | `std::copy` | from AND to |
| `stdlib/fs.agency:153` | `std::move` | from AND to |
| `stdlib/fs.agency:174` | `std::remove` | target |
| `stdlib/safeBash/actions.agency` | `std::write` (the write arm) | dir + filename |

`copy` and `move` carry two destinations; both get resolved, because a
policy may reasonably approve the source and refuse the target. `ls`,
`grep`, and `glob` take only a directory, which agent tools already
absolutize; they join the same resolver for consistency but have no
filename half.

### The threat model, written down

This change makes the permission question truthful at the moment it is
asked. It does not defend against a hostile program on the same machine
that swaps a directory for a symlink between approval and execution.
Closing that race requires an operating-system feature Node does not
expose on any platform we support. A local program with that access
already owns the account and gains nothing by going through our agent.
This boundary goes in `docs/dev/agents/approval-policies.md` so the next reviewer
finds a stated decision instead of an oversight.

## Interactions

- **The `.` policy feature** from this PR composes cleanly: a `dir: "{.,./**}"`
  rule resolves to the launch directory, and now judges destinations that
  are also fully resolved. Like matches like.
- **Non-agent callers** that pass relative dirs today see their interrupt
  payloads become absolute. Policies written against relative spellings
  (other than `.`, which now resolves) were already unable to match agent
  traffic, so the practical impact is nil; the compatibility note in the
  PR description should say it anyway.
- **Statelog**: payloads are logged as raised. Logged paths become
  absolute, which also makes traces easier to read.
- **Value redaction** is field-based and unaffected.

## Testing

- Unit tests on `resolvedDestination`: `~` expansion, absolute filename
  beating `dir`, `..` traversal, symlinked existing parent, symlinked
  final component, not-yet-existing file under a real parent.
- One test per raise site asserting the payload fields equal the resolved
  destination (the existing interrupt-payload test patterns in
  `tests/agency/` cover the mechanism; add the `~` case to one write test
  and one read test).
- An agency execution test: a policy scoped to the workdir rejects
  `write("~/escape.txt")` in a headless run, and the failure message
  reaches the caller.
- A regression test for the operation half: the bytes land at the resolved
  path the interrupt reported, byte-for-byte identical behavior for plain
  relative names.

## Out of scope

- Symlink race conditions after approval, per the threat model above.
- `allowedPaths`-style containment parameters on write; removed in
  `714587658` and not coming back.
- The `agency test` / `std::agency test()` work; separate spec.

## Rollout

One PR, after this spec is reviewed. The change is mechanical per site,
with the resolver and its tests landing first.
