# Contained files: one module for every file operation

Suppose an agent asks to read files in `~/project` and you approve. Inside `~/project` there is a symlink named `secrets` that points at `~/.ssh`. If `read("secrets/id_rsa", "~/project")` follows the link, it reads your SSH key under an approval that named `~/project`. The same hole exists for a linked directory, and for every operation that lists, probes, creates, copies, moves, or deletes.

Before this module, containment was opt-in. About thirty primitives took an optional `allowedPaths` list, and an empty list meant no check. Six functions each did their own realpath walk. A call site that forgot the argument compiled and ran. Every new feature that read files after one approval forgot a site, and a reviewer found it.

`lib/stdlib/contained.ts` replaces all of that. Every file operation the standard library performs on a path an Agency program chose goes through it. A lint rule keeps it that way.

## The property

Under an approval that names directory D, no byte is read from or written to any path outside D, and the interrupt payload spells D the way the operation resolves it.

## Two rules

**The caller's own spelling resolves once.** `/tmp` on macOS is a symlink to `/private/tmp`. Some users spell every path through a linked home directory. `root(dir)` realpaths the approved directory once, following those links, and the interrupt payload carries the real spelling. A policy that matches on `dir` sees the same string the operation uses.

**Anything below the root is refused.** A symlink at any component strictly below the root is refused, whatever it points at. There is no "follow it if the target is inside". The approver named a directory. They did not name where a link inside it leads. `ls`, `glob`, and `grep` leave linked entries out. `exists` and `stat` report them as missing. Every other operation fails.

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

- `root(dir): Root` realpaths an approved directory once. A dangling link or a loop in the spelling throws. A directory that does not exist yet keeps a lexical tail under its nearest real ancestor.
- `resolveUnder(root, target): string` joins a relative target and refuses an absolute path, a `~` path, an upward escape, and any symlink below the root. `""` and `"."` mean the root.
- `wholePath(p): Located` splits a whole path into `{ root, target }`.
- `readText`, `readBytes` open the file without following a final link, require a regular file, realpath after the open and require it inside the root, and require the descriptor's `(dev, ino)` to match what is on disk.
- `writeText`, `writeBytes` take a `mode` of `overwrite`, `append`, or `create-only`, an optional `fileMode`, and validate the descriptor the same way before any byte is written. Overwrite writes a sibling temporary file and renames it over the target, so a failed write leaves the old file whole. The file's mode bits are kept. The inode changes on every overwrite.
- `list(root, target)` returns one level with symlinked entries left out.
- `stat(root, target)` returns `null` for a missing entry and for a symlink below the root.
- `mkdir`, `remove`, `copy`, `move` never dereference. `copy` keeps links inside a copied tree as links.
- `_realDir(dir)` and `_realTarget(p)` give the Agency wrappers the real spelling for an interrupt payload.

The `allowedPaths` parameter on public functions such as `gitAdd`, `say`, `mkdir`, and `statelog.evalRecord` is a different thing. It is a guardrail the program's author sets on itself, implemented by `assertContained`, and it still works the same way. Only the underscore primitives lost it, because for them it doubled as the containment switch.

## The lint fence

`eslint.config.js` forbids importing `fs` or `fs/promises` anywhere under `lib/stdlib`, except in files listed in `FS_IMPORTERS` with a one-line reason each. A new module that reaches for `fs` fails `pnpm run lint:structure` until it either goes through `contained.ts` or is added to the list with a reason.

The rule for a new module is one question: where did this path come from?

1. The agent or user chose it. Call `contained.ts` with the approved directory as root.
2. It is a fixed file Agency owns, such as settings under the agent home. Call `contained.ts` with the agent home as root. Several of these are still on the allow-list and are the follow-up below.
3. Neither. Import `fs`, add the file to `FS_IMPORTERS`, and say why.

The deliberate exceptions today:

- `gitignore.ts` reads `.gitignore` files from a walk root up to the filesystem root. Those ancestors sit above the approved directory. The text becomes ignore rules and is never returned to the caller.
- `shell.ts` probes `PATH` entries for `which` and checks the working directory for `exec`. No approval names either.
- `utils.ts` reads `/proc/version` once to tell WSL from Linux.
- `speech.ts` commits a text-to-speech output by staging and hard-linking.
- `cli.ts`, `agentSessions.ts`, `oauth.ts`, `localModelManifest.ts` read and write fixed files under the agent home.
- `localModels.ts`, `llm.ts`, `mcp.ts`, `skills.ts` take a path the user chose and have no containment yet.

## The symlink battery

`lib/stdlib/contained.symlinks.test.ts` is table-driven. `contained.ts` exports `PRIMITIVES`, the name of every operation, and `HELPERS`, the name of every other export. A test asserts the module exports nothing else, so an operation added without a registry entry fails.

For every primitive the battery builds one fixture and runs six refusal cases: a linked file pointing outside, a linked directory pointing outside, a path under that linked directory, a linked directory pointing inside, a new name under it, and a dangling link. Each case first proves through plain `fs` that the link is reachable, so a case cannot pass because the fixture was never built. Each case then checks that nothing appeared outside the root or under the in-root link target.

The positive control spells the root through a link and runs the operation normally. A module that refused everything could not pass it.

The read and write seams run a directory swap between the open and the validation, and a swap that is undone again after the open. A FIFO at the target is refused without blocking.

When a case is added or a refusal is loosened, remove the refusal, watch the rows go red, and restore it. Disabling the symlink check turns 25 rows red. Disabling the `(dev, ino)` comparison turns one row red.

## Where the pieces are

- `lib/stdlib/contained.ts`: the module. `lib/stdlib/contained.test.ts` covers the helpers and write modes.
- `lib/stdlib/prepareContainedPath.ts`: the wrapper-facing preparation for `read`, `write`, `edit`, and their binary twins, now built on `root` and `resolveUnder`. `resolveRedirectTarget` for `safeBash` uses `root` to find where a redirect lands.
- `lib/stdlib/assertContained.ts`: the `allowedPaths` guardrail, now built on `root`.
- `lib/stdlib/builtins.ts`, `fs.ts`, `shell.ts`, `agency.ts`, `template.ts`, `spill.ts`, `policy.ts`, `git.ts`, `speech.ts`, `system.ts`: the migrated callers.
- `stdlib/index.agency`, `fs.agency`, `shell.agency`, `skills.agency`, `toolbox.agency`: the wrappers, which canonicalize their payload directory with `_realDir` or `_realTarget` before raising.
- `eslint.config.js`: `FS_IMPORTERS` and the `no-restricted-imports` block.

## Things that are easy to miss

- `_ls`, `_glob`, and `_grep` take the approved directory first and where in it to start second. Results stay relative to the second argument. `scanSkillsSubdirs` passes the root and the subdirectory separately so a linked subdirectory is refused rather than becoming its own root.
- `stat` returning `null` for a link is a hidden entry, not an error. The Agency `StatInfo` and `LsEntry` types keep `"symlink"` in their unions, but no code produces it any more.
- A standalone `exists(p)` or `stat(p)` with no `dir` passes `p` as the root and `"."` as the target, so it follows the caller's spelling.
- The payloads for `ls`, `glob`, `grep`, `mkdir`, `copy`, `move`, `remove`, `skillsDir`, `commandsDir`, and `scanSkillsSubdirs` now carry the real spelling, the way `read` and `write` did before. A policy written against `/tmp/...` on macOS matches `/private/tmp/...`, which the built-in rules already do through `resolveDotDirPattern`.
- Node has no `openat`. A directory swapped to a link between the parent check and a create can leave an empty file at the link's target. The descriptor checks stop any byte from being written into it. The full answer is process containment, roadmap items C5, C6, and H in `docs/dev/security/roadmap.md`.

## Follow-ups

- Group 2 of the survey: `readSkill`, `readProjectMcpConfig` and the two MCP config writers, the `std::local` model cache functions, and `loadModelData` take a user path with no containment. Each is a small change and a behavior change.
- The TypeScript modules still on the allow-list for fixed files under the agent home.
- `registerProviderModule` runs a JavaScript file from any path with no interrupt. Filed as #1021.
- PR #1014 rebases onto this module. Its four open review threads close by construction or shrink to a line each.
