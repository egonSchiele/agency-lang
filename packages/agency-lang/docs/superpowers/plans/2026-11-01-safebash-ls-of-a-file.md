# `ls` of a file asks `std::ls` for its folder (ADI-275)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ls -la package.json`, `ls -1 one.txt two.txt`, and `du -sh one.txt` ask `std::ls` for the folder that holds the file, so `recommended` approves them under the launch directory with no prompt. Today a file given to `ls` or `du` makes the line broad.

**Architecture:** One change in how a listing turns its paths into payloads. Today `resolveDirs` refuses any path that is not a folder. After this plan, `listEffects` resolves each path with the shared `resolveTarget`. A folder is listed as today. A file is listed as its folder with `recursive: false`, when the verb's row allows it. `find` keeps refusing a file. A file reached through a symlink is refused, so the payload never names a folder that the listing doesn't read.

**Tech Stack:** Agency (`stdlib/safeBash.agency`), the Agency test runner, `make`.

**Spec:** `docs/dev/stdlib/safe-bash.md`, "Listings". Ticket ADI-275.

## Background for the implementer

Read `docs/dev/stdlib/safe-bash.md`, "Listings", whole. Then read these in `stdlib/safeBash.agency`:
- `ListVerb`, `LIST_VERBS`, and `listEffects`;
- `resolveTarget`, `resolveDirPath`, and `resolveDirs`;
- `findEffects` and `PathTarget`.

Also read `_searchTarget` and `_searchTargetIn` in `lib/stdlib/shell.ts`.

What the resolver returns: `resolveTarget(text, word, cwd)` calls `_searchTargetIn`. That resolves the path against safeBash's working directory and follows every symlink in it (`host.files.root` realpaths the whole path). It returns `{ dir, file, argument }`:
- `file` is `null` for a folder, and otherwise the real file's name;
- `dir` is the real folder, or the real file's parent folder;
- `argument` is the path as written, with `~` expanded when bash would expand it.

A missing path or a special file is a failure.

Why a file can ask for its folder: the `std::ls` payload names a folder, and `ls -la one.txt` prints one entry of that folder. So the question names more than runs, which fails safe. A policy that approves listing the folder approves listing every entry in it, and one entry is among them.

Why a symlinked file is refused: `ls -l link.txt` prints the link's own entry from the link's folder, including the path it points to. But the resolver follows the link, so `dir` would name the target's folder. Those can be two different folders. Say `/tmp/x.txt` links into the project. The payload would name the project folder, `recommended` would approve it, and `ls` would read an entry in `/tmp`. So the plan refuses a file whose path involves a symlink at the last step, the way `CLAUDE.md` asks: refuse symlinks instead of adding machinery for them.

The check uses only the resolver, with no new TypeScript. A path's last step is a symlink exactly when one of these holds:
- the real file's name differs from the last segment of the path as written;
- the real folder of the written path's parent differs from `dir`.

A symlink earlier in the path is fine. `ls linkdir/one.txt` reads the entry through `linkdir`, which is the folder the payload names after both paths are realpathed.

Which verbs take a file:

| Verb | Given a file, the program prints | Rule |
|---|---|---|
| `ls` | that one entry | ask for the folder |
| `du` | that one file's size | ask for the folder |
| `tree` | the name and an error about opening it as a folder | refuse, as today |
| `find` | the file, if it matches the expression | refuse, as today; `std::glob` searches a folder |

## Global Constraints

- Never force-push or amend. Commit messages and PR bodies go in a file and are passed with `-F`.
- Run `make` after any `.agency` edit, and commit the regenerated `docs/site/stdlib/safeBash.md`. Never hand-edit `docs/site`.
- Save test output to a file and read it. Run `pnpm run agency test tests/agency/safeBash.agency` and `pnpm vitest run lib/stdlibCapabilities.test.ts`, not the whole suite.
- Dev docs state the mechanism and the rule, with no history or dates.
- Agency syntax:
  - no lambdas;
  - `!=` on a tag doesn't narrow, so use `is`;
  - an `isFailure` guard doesn't narrow a `Result` over a union;
  - a literal union used as a field type needs a name (`type X = "a" | "b"`), or the checker widens it to `string` when the value comes out of a `Record`. `ListWalk` exists for this reason.
- `.claude/skills/agency-stdlib-docs/SKILL.md` is tracked but gitignored. `git add -f` it in a command of its own.
- Use objects, arrays, and types. Never maps, sets, or interfaces.

## Review Focus

1. **`ls -l link.txt`, where `link.txt` points at a file in another folder.** Expected: `std::bash`, with "ls of a symlink is not described". The payload must not name the target's folder while `ls` reads the link's. There's a test with a fixture folder of its own.
2. **`ls -R one.txt`.** Expected: `std::ls { dir: <its folder>, recursive: false }`. `-R` on a file prints the one entry, so the payload doesn't claim a walk.
3. **`ls one.txt two.txt`, both in the same folder.** Expected: one `std::ls`, not two identical questions in a row.
4. **`find one.txt -name x` and `tree one.txt`.** Expected: unchanged, "find of a file is not a listing" and "tree of a file is not a listing".
5. **`ls one.txt ..`.** Expected: two `std::ls` effects, one per folder.

---

### Task 1: A file given to `ls` or `du` asks for its folder

**Files:**
- Modify: `stdlib/safeBash.agency` (`ListVerb`, `LIST_VERBS`, new `FileArgument`, `listEffects`, `resolveDirs` becoming `resolveTargets`, `resolveDirPath`, new `listingOf`, new `linkFree`, `findEffects`)
- Modify: `tests/agency/safeBash.agency`, `tests/agency/safeBash.test.json`

**Interfaces:**

```agency
/** What a listing verb does with a path that names a file: list the
 * folder that holds it, or refuse. */
export type FileArgument = "folder" | "refuse"
```

`ListVerb` gains `files: FileArgument`. The values: `ls: "folder"`, `du: "folder"`, `tree: "refuse"`. The table's comment gets one sentence per verb from the background table.

```agency
@capabilities(fileRead)
def resolveTargets(verb: string, words: Word[], cwd: string): Result<PathTarget[]>
```

This is today's `resolveDirs` loop with the folder check taken out. Each word must be literal (failing with "the ${verb} path is not literal"), and each is resolved with `resolveTarget`. `resolveDirPath` and `resolveDirs` are deleted. `findEffects` calls `resolveTargets`, then refuses a target whose `file` isn't null, with `"find of a file is not a listing"`, the same message as today. It keeps its `dir` values.

```agency
@capabilities(fileRead)
def listingOf(verb: string, spec: ListVerb, target: PathTarget, walk: boolean, cwd: string): Result<LsPayload>
```

`listingOf` decides one path's payload:
- A folder (`target.file == null`) gives `{ dir: target.dir, recursive: walk, maxResults: 0 }`, as today.
- A file under a `refuse` row fails with `"${verb} of a file is not a listing"`.
- A file under a `folder` row runs `linkFree(verb, target, cwd)` first. Then it gives `{ dir: target.dir, recursive: false, maxResults: 0 }`.

```agency
@capabilities(fileRead)
def linkFree(verb: string, target: PathTarget, cwd: string): Result
```

`linkFree` fails with `"${verb} of a symlink is not described"` in either of these cases:
- `basename(target.argument)` differs from `target.file`;
- the real folder of `dirname(target.argument)` differs from `target.dir`.

Resolve the parent with `try _searchTargetIn(parent, cwd, "literal")`. `argument` already has its `~` expanded, so the literal mode is right; `readGrep`'s `"."` lookup is the precedent. Import `basename` and `dirname` from `std::path`. A parent that fails to resolve is a failure too, because any doubt asks `std::bash`.

`listEffects` loops over `resolveTargets(...)` in order, through `listingOf`. It skips a payload equal to one already collected: same `dir` and same `recursive`. Write that check as a small def with a for loop over the collected list, not a set. Then it adds the redirects. `walk` is the existing rule: the row says `always`, or `R` is in the split's `plain`.

- [ ] **Step 1: Write the failing tests**

In `listingsAskStdLs`, the row `ls one.txt` changes from `U("ls of a file is not a listing")` to `[["std::ls"],null]`. Add these rows:

```agency
    grepNames("ls -la one.txt"),
    grepNames("ls one.txt two.txt"),
    grepNames("ls one.txt .."),
    grepNames("du -sh one.txt"),
    grepNames("tree one.txt"),
```

Expected:
- `ls -la one.txt`: `[["std::ls"],null]`
- `ls one.txt two.txt`: `[["std::ls"],null]` (one question for the shared folder)
- `ls one.txt ..`: `[["std::ls","std::ls"],null]`
- `du -sh one.txt`: `[["std::ls"],null]`
- `tree one.txt`: `U("tree of a file is not a listing")`

`findAsksStdGlob`'s row `find one.txt -name x` keeps `U("find of a file is not a listing")`.

In `lsPayloadFields`, add `lsPayloads("ls -R one.txt")` and `lsPayloads("du one.txt")`, each expecting `[[true,false]]`. The `dir` is `FIXTURES`, and `recursive` is false even though `-R` is given, and even though `du` always walks a folder.

A symlink node in a fixture folder of its own. Copy `listingPayloadNamesTheRealFolder`: `remove`, `mkdir`, then build the files with `bash` under `with approve`, then `remove` again.

```agency
static const LS_FILE_LINK_FIXTURE = __dirname + "/stdlib/__safebash_ls_file_link__"

node listingOfALinkedFileIsRefused() {
  remove(LS_FILE_LINK_FIXTURE) with approve
  mkdir(LS_FILE_LINK_FIXTURE) with approve
  bash("mkdir inside outside && echo hi > outside/target.txt && echo hi > inside/plain.txt && ln -s ../outside/target.txt inside/link.txt", cwd: LS_FILE_LINK_FIXTURE) with approve
  const inside = LS_FILE_LINK_FIXTURE + "/inside"
  const linked = planFor("ls -l link.txt", inside).broadReason
  let plainDir = ""
  for (effect in planFor("ls -l plain.txt", inside).effects) {
    if (effect.name == "std::ls") {
      plainDir = effect.payload.dir
    }
  }
  remove(LS_FILE_LINK_FIXTURE) with approve
  return [linked, plainDir == inside]
}
```

Expected: `[{"kind":"unrecognized","detail":"ls of a symlink is not described"}, true]`.

End to end: `listingOfAFileAsksOneQuestion` runs `safeBash("ls -la one.txt", cwd: FIXTURES)` with one approve handler for "Are you sure you want to list this directory?" in the `.test.json`. It returns whether the output contains `one.txt`. Expected: `true`. A `std::bash` prompt would fail the run on an unmatched interrupt.

- [ ] **Step 2: Run to verify they fail**

Run the agency test into `$SCRATCH/t1.txt`. Expected:
- the new `ls` and `du` rows say "ls of a file is not a listing" (or the `du` version of it);
- the payload rows are empty;
- the symlink node returns the same broad reason, because today every file is refused;
- the end-to-end node fails on an unmatched `std::bash` interrupt.

- [ ] **Step 3: Implement**

The interfaces above. Then run `make`, the agency test, and `pnpm vitest run lib/stdlibCapabilities.test.ts`. Expected: all pass. `linkFree` and `listingOf` reach `_searchTargetIn`, so both carry `@capabilities(fileRead)`.

- [ ] **Step 4: Commit**

Message: `safeBash: ls or du of a file asks std::ls for its folder`.

---

### Task 2: Docs, checks, PR

- [ ] **Step 1: `docs/dev/stdlib/safe-bash.md`, "Listings"**
  - Replace the sentence "A file (`ls one.txt`), a missing path, or a glob word makes the command unrecognized" with the new rule: a file given to `ls` or `du` asks `std::ls` for its folder, not recursive, and one question per folder. Add the fail-safe reason: the folder holds the one entry that is printed. Add the symlink refusal and why.
  - Add the per-verb table from the background to the `LIST_VERBS` part of the section.
  - The section already says `ls -l link` of a folder link "lists the link itself and does not go into the folder, while the payload names the folder the link points to". The new symlink paragraph should say that the file case is refused because the link and its target can sit in different folders. Leave the folder-link sentence as it is. It's out of scope here; see Step 4.

- [ ] **Step 2: Index line**

In `CLAUDE.md` and `.claude/skills/agency-stdlib-docs/SKILL.md`, the `safe-bash.md` line's listings clause gains "a file given to `ls` or `du` asks for its folder". Add the skill file with `git add -f`, in a command of its own.

- [ ] **Step 3: Checks**

Run each of these, save the output to a file, and confirm it's green:
- `pnpm run typecheck`
- `pnpm run lint:structure`
- `pnpm vitest run lib/stdlibCapabilities.test.ts`
- the safeBash agency test
- `make`, with no drift in `docs/site`

- [ ] **Step 4: Commit and PR**

Push, and open the PR with the body in a file:
- A before/after table for `ls -la package.json`, `ls one.txt two.txt`, `ls -R one.txt`, `du -sh one.txt`, `tree one.txt`, and `ls -l link.txt`.
- Where to look: `listingOf`, `linkFree`, and the `files` field of `LIST_VERBS`.
- Left out: a folder given through a symlink (`ls -l dirlink`). Its payload names the target folder while `ls -l` prints the link's own entry from the link's folder. That's the same mismatch this PR refuses for files. The dev doc accepted it as naming more than runs, but the two can be different folders. It's a one-line change to `listingOf` if the owner wants it, and it's not done here, so the PR stays the size of its ticket.

Link ADI-275 and end with the attribution line. The owner merges.
