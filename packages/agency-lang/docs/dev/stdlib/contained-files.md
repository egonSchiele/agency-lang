# Contained files: one module for every file operation

Suppose an agent asks to read files in `~/project` and you approve. Inside `~/project` there is a symlink named `secrets` that points at `~/.ssh`. If `read("secrets/id_rsa", "~/project")` follows the link, it reads your SSH key under an approval that named `~/project`. The same hole exists for a linked directory, and for every operation that lists, probes, creates, copies, moves, or deletes.

`lib/stdlib/contained.ts` closes it in one place. Every file operation the standard library performs on a path an Agency program chose goes through it, and a lint rule keeps it that way. Containment is not something a call site opts into.

## The property

Under an approval that names directory D, no byte is read from or written to any path outside D, and the interrupt payload spells D the way the operation resolves it.

## Two rules

**The caller's own spelling resolves once.** `/tmp` on macOS is a symlink to `/private/tmp`. Some users spell every path through a linked home directory. `root(dir)` realpaths the approved directory once, following those links, and the interrupt payload carries the real spelling. A policy that matches on `dir` sees the same string the operation uses.

**Anything below the root is refused.** A symlink at any component strictly below the root is refused, whatever it points at. The approver named a directory. They did not name where a link inside it leads. `ls`, `glob`, and `grep` leave linked entries out. `exists` and `stat` report them as missing. Every other operation fails.

## How strong the guarantee is

Reads, writes, and `copy` move bytes only through a descriptor that is validated after it is open: it must be a regular file, its real path must sit inside the root, and its identity must match what is on disk. A directory swapped to a link while the operation runs cannot redirect them.

`list`, `stat`, `mkdir`, `remove`, and `move` act on a pathname that was checked a moment earlier. Node has no `openat`, so a swap between the check and the action is not closed in this module. A `remove` can be aimed at a directory that was swapped for a link after its check. Process containment, roadmap items C5, C6, and H in `docs/dev/security/roadmap.md`, is the answer for that window. The same applies to paths handed to another program, such as the output file of `say` or `screencapture`.

## Before the interrupt and after it

A wrapper resolves the caller's spelling with `root()` before it raises, and puts the real path in the payload. That is the directory the approver sees. After approval the primitive must use exactly that directory, so it calls `fixedRoot()` on the string it was handed. `fixedRoot` follows nothing: every existing component must be a real directory, and a symlink anywhere in the spelling is refused. Without it, a directory renamed and replaced by a link while the prompt was pending would be resolved again after approval, and the link's target would become the root.

```ts
// in the wrapper, before the interrupt
const real = _realDir(dir);           // root(dir).real
// ... interrupt std::ls(..., { dir: real })
// in the primitive, after approval
const approved = fixedRoot(real);     // refuses if real now contains a link
```

`wholePath` and `fixedPath` are the same pair for whole paths. `stat` and `exists` raise no interrupt, so they resolve the caller's spelling with `root()`. `applyPatch` resolves each patched path after approval, because its payload carries the patch text and no canonical path.

## Two shapes of operation

A **dir plus relative target** operation has the approved directory as its root. `read`, `write`, `edit`, `ls`, `glob`, `grep`, `exists`, `stat`, the sandbox functions in `std::agency`, and the scan reads in `std::skills` and `std::toolbox` are this shape. The primitive takes the root first and the relative target second:

```ts
readText(root("/home/me/project"), "notes/today.md")
```

A **whole path** operation names the whole path in its interrupt. `mkdir(dir)`, `remove(target)`, `copy(src, dest)`, `move(src, dest)`, an output file for `say`, `record`, or `screenshot`, and a policy file write are this shape. `wholePath(p)` splits the path into a real parent and one final name that is never followed:

```ts
const located = wholePath("/home/me/project/build");
// located.root.real is "/home/me/project", located.target is "build"
remove(located.root, located.target);
```

If `build` were a symlink, `remove` would refuse it rather than follow it or delete the link.

A **standalone probe** such as `exists("/home/me/project/build")`, with no `dir`, follows the caller's spelling completely. A probe of a path the caller spelled out is a probe of the root itself.

## The API

- `root(dir): Root` realpaths a caller's spelling once, before the interrupt. A dangling link or a loop in the spelling throws. A directory that does not exist yet keeps a lexical tail under its nearest real ancestor.
- `fixedRoot(real): Root` takes the spelling an approver saw, after the interrupt, and refuses a symlink anywhere in it.
- `resolveUnder(root, target): string` joins a relative target and refuses an absolute path, a `~` path, an upward escape, and any symlink below the root. `""` and `"."` mean the root.
- `wholePath(p): Located` splits a whole path into `{ root, target }` before the interrupt. `fixedPath(p)` does the same after it.
- `readText`, `readBytes` open the file without following a final link, require a regular file, realpath after the open and require it inside the root, and require the descriptor's `(dev, ino)` to match what is on disk. `readStream` does the same validation and returns a stream over that descriptor, for a file too large to buffer, such as a downloaded model being hashed.
- `writeText`, `writeBytes` take a `mode` of `overwrite`, `append`, or `create-only`, an optional `fileMode`, and validate the descriptor the same way before any byte is written. Overwrite writes a sibling temporary file and renames it over the target, so a failed write leaves the old file whole. The file's mode bits are kept. The inode changes on every overwrite.
- `list(root, target)` returns one level with symlinked entries left out.
- `stat(root, target)` returns `null` for a missing entry and for a symlink below the root.
- `mkdir`, `remove`, `move` never dereference. `copy` reads and writes every file through validated descriptors and refuses a source tree that contains a link anywhere.
- `_realDir(dir)` and `_realTarget(p)` give the Agency wrappers the real spelling for an interrupt payload.

The `allowedPaths` parameter on public functions such as `gitAdd`, `say`, `mkdir`, and `statelog.evalRecord` is a different thing. It is a guardrail the program's author sets on itself, implemented by `assertContained`, and it still works the same way. Only the underscore primitives lost it, because for them it doubled as the containment switch.

## The lint fence

`eslint.config.js` forbids importing `fs` or `fs/promises` anywhere under `lib/stdlib`, except in files listed in `FS_IMPORTERS` with a one-line reason each. A new module that reaches for `fs` fails `pnpm run lint:structure` until it either goes through `contained.ts` or is added to the list with a reason.

The rule for a new module is one question: where did this path come from?

1. The agent or user chose it. Call `contained.ts` with the approved directory as root.
2. It is a fixed file Agency owns, such as settings under the agent home. Call `contained.ts` with the agent home as root.
3. Neither. Import `fs`, add the file to `FS_IMPORTERS`, and say why.

The files on the allow-list today, and why:

- `gitignore.ts` reads `.gitignore` files from a walk root up to the filesystem root. Those ancestors sit above the approved directory. The text becomes ignore rules and is never returned to the caller.
- `shell.ts` probes `PATH` entries for `which` and checks the working directory for `exec`. No approval names either.
- `utils.ts` reads `/proc/version` once to tell WSL from Linux.
- `speech.ts` commits a text-to-speech output by staging and hard-linking.
- `cli.ts`, `agentSessions.ts`, `oauth.ts`, `localModelManifest.ts` read and write fixed files under the agent home.

## The symlink battery

`lib/stdlib/contained.symlinks.test.ts` is table-driven. `contained.ts` exports `PRIMITIVES`, the name of every operation, and `HELPERS`, the name of every other export. A test asserts the module exports nothing else, so an operation added without a registry entry fails.

For every primitive the battery builds one fixture and runs six refusal cases: a linked file pointing outside, a linked directory pointing outside, a path under that linked directory, a linked directory pointing inside, a new name under it, and a dangling link. Each case first proves through plain `fs` that the link is reachable, so a case cannot pass because the fixture was never built. Each case then checks that nothing appeared outside the root or under the in-root link target.

The positive control spells the root through a link and runs the operation normally. A module that refused everything could not pass it.

The read and write seams run a directory swap between the open and the validation, and a swap that is undone again after the open. A FIFO at the target is refused without blocking.

## Where the pieces are

- `lib/stdlib/contained.ts`: the module. `lib/stdlib/contained.test.ts` covers the helpers and write modes.
- `lib/stdlib/prepareContainedPath.ts`: the wrapper-facing preparation for `read`, `write`, `edit`, and their binary twins, now built on `root` and `resolveUnder`. `resolveRedirectTarget` for `safeBash` uses `root` to find where a redirect lands.
- `lib/stdlib/assertContained.ts`: the `allowedPaths` guardrail, now built on `root`.
- `lib/stdlib/builtins.ts`, `fs.ts`, `shell.ts`, `agency.ts`, `template.ts`, `spill.ts`, `policy.ts`, `git.ts`, `speech.ts`, `system.ts`, `mcp.ts`, `llm.ts`, `localModels.ts`: the migrated callers.
- `stdlib/index.agency`, `fs.agency`, `shell.agency`, `skills.agency`, `toolbox.agency`, `llm.agency`: the wrappers, which canonicalize their payload directory with `_realDir` or `_realTarget` before raising.
- `eslint.config.js`: `FS_IMPORTERS` and the `no-restricted-imports` block.

## Things that are easy to miss

- `_ls`, `_glob`, and `_grep` take the approved directory first and where in it to start second. Results stay relative to the second argument. `scanSkillsSubdirs` passes the root and the subdirectory separately so a linked subdirectory is refused rather than becoming its own root.
- `stat` returning `null` for a link is a hidden entry, not an error. The Agency `StatInfo` and `LsEntry` types keep `"symlink"` in their unions, but no code produces it any more.
- A standalone `exists(p)` or `stat(p)` with no `dir` passes `p` as the root and `"."` as the target, so it follows the caller's spelling.
- A TypeScript function that runs both after an Agency interrupt and from the CLI takes a `locate` argument, the way `_loadModelData` does. The Agency wrapper leaves the default, `fixedPath`, because the approver saw the real spelling. The CLI passes `wholePath`, because no approval happened and the user's own spelling may run through a link.
- The payloads for `ls`, `glob`, `grep`, `mkdir`, `copy`, `move`, `remove`, `skillsDir`, `commandsDir`, and `scanSkillsSubdirs` now carry the real spelling, the way `read` and `write` did before. A policy written against `/tmp/...` on macOS matches `/private/tmp/...`, which the built-in rules already do through `resolveDotDirPattern`.
