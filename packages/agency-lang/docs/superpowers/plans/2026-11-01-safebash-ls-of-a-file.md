# `ls` of a file asks `std::ls` for its folder (ADI-275)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ls -la package.json`, `ls -1 one.txt two.txt`, and `du -sh one.txt` ask `std::ls` for the folder that holds the file, so `recommended` approves them under the launch directory with no prompt. Today a file given to `ls` or `du` makes the line broad.

**Architecture:** One change in how a listing turns its paths into payloads. Today `resolveDirs` refuses any path that is not a folder. After this plan, `listEffects` resolves each path with the shared `resolveTarget`. A folder is listed as today. A file is listed as its folder with `recursive: false`, when the verb's row allows it. `find` keeps refusing a file. A path whose last step is a symlink is refused, whether it names a file or a folder, for `ls`, `du`, `tree`, and `find` alike. That way the payload never names a folder the program doesn't read.

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

Why a path whose last step is a symlink is refused:
- `ls -l link.txt` prints the link's own entry from the link's folder, including the path it points to. But the resolver follows the link, so `dir` names the target's folder. Those can be two different folders. Say `/tmp/x.txt` links into the project. The payload would name the project folder, `recommended` would approve it, and `ls` would read an entry in `/tmp`.
- A folder link has the same mismatch. `ls -l dirlink`, `ls -d dirlink`, `du dirlink`, and `find dirlink` all print the link's own entry without following it, while the payload names the target folder.

So the plan refuses every path whose last step is a link, the way `CLAUDE.md` asks: refuse symlinks instead of adding machinery for them. That includes a link to a file in the same folder (`ln -s plain.txt alias.txt; ls -l alias.txt`), because any doubt asks `std::bash`. It also refuses `ls dirlink` without `-l`, which follows the link and lists the target, so its payload would have been true. That costs a little, in the safe direction. On macOS it also refuses `ls /etc` and `ls /tmp`, because those are links to `/private/etc` and `/private/tmp`. Both are outside the launch directory, so they asked a person anyway, through `std::ls`. Now they ask through `std::bash`.

The check uses only the resolver, with no new TypeScript. Name the real path's last segment and parent: for a file they're `file` and `dir`, and for a folder they're the last segment of `dir` and its parent. The written path's last step is a link exactly when one of these holds:
- the real last segment differs from the last segment of the path as written;
- the real folder of the written path's parent differs from the real parent.

The check is skipped when the written path's last segment is `.`, `..`, or empty (`/`). Those can't be links, and `.` is what a listing with no path lists. A symlink earlier in the path is fine. `ls linkdir/one.txt` reads the entry through `linkdir`, which is the folder the payload names after both paths are realpathed.

Which verbs take a file:

| Verb | Given a file, the program prints | Rule |
|---|---|---|
| `ls` | that one entry | ask for the folder |
| `du` | that one file's size | ask for the folder |
| `tree` | the name and an error about opening it as a folder | refuse, as today |
| `find` | the file, if it matches the expression | refuse, as today; `std::glob` searches a folder |

`du` of a file gets `recursive: false` even though the `du` row says `always`. There's no walk for one file. Say so in the `LIST_VERBS` comment.

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

1. **`ls -l link.txt`, where `link.txt` points at a file in another folder, and `ls -l dirlink` for a folder link.** Expected: `std::bash`, with "ls of a symlink is not described". The payload must not name the target's folder while `ls` reads the link's. There's a test with a fixture folder of its own.
2. **`ls -R one.txt`.** Expected: `std::ls { dir: <its folder>, recursive: false }`. `-R` on a file prints the one entry, so the payload doesn't claim a walk.
3. **`ls one.txt two.txt`, both in the same folder, and `ls -R . one.txt`.** Expected: one `std::ls` each. A second question about a folder already asked about adds nothing. When either path walks the tree, the one payload says `recursive: true`. Today's code asks twice for `ls -R . .`, and the new rule fixes that too.
4. **`find one.txt -name x` and `tree one.txt`.** Expected: unchanged, "find of a file is not a listing" and "tree of a file is not a listing".
5. **`ls one.txt ..`.** Expected: two `std::ls` effects, one per folder.

---

### Task 1: A file given to `ls` or `du` asks for its folder

**Files:**
- Modify: `stdlib/safeBash.agency` (`ListVerb`, `LIST_VERBS`, new `FileArgument`, `listEffects`, `resolveDirs` becoming `resolveTargets`, `resolveDirPath` becoming `requireFolder`, new `listingOf`, new `linkFree`, new `mergeListings`, `findEffects`, and an aliased `std::path` import)
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

This is today's `resolveDirs` loop with the folder check taken out and the link check put in. Each word must be literal (failing with "the ${verb} path is not literal"), each is resolved with `resolveTarget`, and each target goes through `linkFree`. `resolveDirs` is deleted. Only the listings and `find` call `resolveTargets`, so the link rule is in one place and covers all four verbs. The read verbs keep calling `resolveTarget` directly: `cat link.txt` reads the target's bytes, which is what its `std::read` payload names.

```agency
def requireFolder(verb: string, target: PathTarget): Result<string>
```

`requireFolder` replaces `resolveDirPath`'s folder check. It returns `target.dir` for a folder, and fails with `"${verb} of a file is not a listing"` for a file. It's the one place that refusal is written. `findEffects` maps its targets through it, and so does `listingOf` for a row that refuses files. Without it, the same check and message would be written twice.

```agency
def listingOf(verb: string, spec: ListVerb, target: PathTarget, walk: boolean): Result<LsPayload>
```

`listingOf` decides one path's payload:
- A folder (`target.file == null`) gives `{ dir: target.dir, recursive: walk, maxResults: 0 }`, as today.
- A file under a `refuse` row goes through `requireFolder`, which fails with its message.
- A file under a `folder` row gives `{ dir: target.dir, recursive: false, maxResults: 0 }`. `resolveTargets` has already run the link check.

`listingOf` no longer needs `cwd`, so drop that parameter.

```agency
@capabilities(fileRead)
def linkFree(verb: string, target: PathTarget, cwd: string): Result
```

`linkFree` follows the background's rule. It returns success at once when `lastSegment(target.argument)` is `.`, `..`, or empty. Otherwise it fails with `"${verb} of a symlink is not described"` in either of these cases:
- `lastSegment(target.argument)` differs from the real last segment (`target.file` for a file, and `lastSegment(target.dir)` for a folder);
- the real folder of `parentOf(target.argument)` differs from the real parent (`target.dir` for a file, and `parentOf(target.dir)` for a folder).

Write "the real last segment" and "the real parent" as two small defs, so `linkFree` reads as the two comparisons.

Resolve the written parent with `try _searchTargetIn(parent, cwd, "literal")`. `argument` already has its `~` expanded, so the literal mode is right; `readGrep`'s `"."` lookup is the precedent. A parent that fails to resolve is a failure too, because any doubt asks `std::bash`.

Import the path helpers under names that say what they mean here: `import { basename as lastSegment, dirname as parentOf } from "std::path"`. `safeBash.agency` already has a local `baseName(text)` that the refuse wall uses on the command word, so a plain `basename` beside it would be two names that differ by one letter and mean different things. Aliased imports are already in use (`import { reviewAgent as generalReviewAgent }` in `lib/agents/`).

```agency
def mergeListings(payloads: LsPayload[]): LsPayload[]
```

`mergeListings` keeps one payload per `dir`, in order of first appearance. When two payloads share a `dir`, the kept one is recursive if either was, because a walk of the folder covers a look at one entry of it. It's a for loop over the input that builds a new list; no set, and no record changed in place. `listEffects` maps `resolveTargets(...)` through `listingOf`, then calls `mergeListings`, then adds the redirects. `walk` is the existing rule: the row says `always`, or `R` is in the split's `plain`.

- [ ] **Step 1: Write the failing tests**

In `listingsAskStdLs`, the row `ls one.txt` changes from `U("ls of a file is not a listing")` to `[["std::ls"],null]`. Add these rows:

```agency
    grepNames("ls -la one.txt"),
    grepNames("ls one.txt two.txt"),
    grepNames("ls one.txt .."),
    grepNames("du -sh one.txt"),
    grepNames("tree one.txt"),
    grepNames("ls -R . ."),
    grepNames("ls one.txt/"),
```

Expected:
- `ls -la one.txt`: `[["std::ls"],null]`
- `ls one.txt two.txt`: `[["std::ls"],null]` (one question for the shared folder)
- `ls one.txt ..`: `[["std::ls","std::ls"],null]`
- `du -sh one.txt`: `[["std::ls"],null]`
- `tree one.txt`: `U("tree of a file is not a listing")`
- `ls -R . .`: `[["std::ls"],null]` (today it asks twice)
- `ls one.txt/`: pin the first run's value, with a comment in the row saying why it's what it is. `ls` prints "Not a directory" for this. Either a failure from the resolver or a `std::ls` for the folder is fine, because both are safe: the second names more than runs. The row is there so nobody later reads it as a gap.

`findAsksStdGlob`'s row `find one.txt -name x` keeps `U("find of a file is not a listing")`.

In `lsPayloadFields`, add `lsPayloads("ls -R one.txt")` and `lsPayloads("du one.txt")`, each expecting `[[true,false]]`. The `dir` is `FIXTURES`, and `recursive` is false even though `-R` is given, and even though `du` always walks a folder. Also add `lsPayloads("ls -R . one.txt")`, expecting `[[true,true]]`: one payload, recursive because `.` is walked.

A symlink node in a fixture folder of its own. Copy `listingPayloadNamesTheRealFolder`: `remove`, `mkdir`, then build the files with `bash` under `with approve`, then `remove` again.

```agency
static const LS_FILE_LINK_FIXTURE = __dirname + "/stdlib/__safebash_ls_file_link__"

node listingOfALinkedFileIsRefused() {
  remove(LS_FILE_LINK_FIXTURE) with approve
  mkdir(LS_FILE_LINK_FIXTURE) with approve
  bash("mkdir inside outside && echo hi > outside/target.txt && echo hi > inside/plain.txt && ln -s ../outside/target.txt inside/link.txt && ln -s plain.txt inside/alias.txt && ln -s ../outside inside/dirlink", cwd: LS_FILE_LINK_FIXTURE) with approve
  const inside = LS_FILE_LINK_FIXTURE + "/inside"
  const linked = planFor("ls -l link.txt", inside).broadReason
  const aliased = planFor("ls -l alias.txt", inside).broadReason
  const dirLinked = planFor("ls -l dirlink", inside).broadReason
  const foundLinked = planFor("find dirlink -name x", inside).broadReason
  let plainDir = ""
  for (effect in planFor("ls -l plain.txt", inside).effects) {
    if (effect.name == "std::ls") {
      plainDir = effect.payload.dir
    }
  }
  remove(LS_FILE_LINK_FIXTURE) with approve
  return [linked, aliased, dirLinked, foundLinked, plainDir == inside]
}
```

Expected, with `S(v)` for `{"kind":"unrecognized","detail":"<v> of a symlink is not described"}`: `[S(ls), S(ls), S(ls), S(find), true]`. The `alias.txt` row is a link to a file in the same folder, so it shows the rule is about the last step being a link, not about the folders differing.

**Existing rows that change.**
- `listingPayloadNamesTheRealFolder` (from ADI-246) runs `ls link` for a folder link and expects the payload to name the real folder. That case is now refused. Change the node to expect the refusal, and rename it `listingOfALinkedFolderIsRefused`. Its fixture already holds the folder link, so the node is a few lines.
- `listingOutsideTheLaunchDirIsUndecided` plans `ls /etc`, and `findOutsideTheLaunchDirIsUndecided` plans `find /etc -name hosts`. On macOS `/etc` is a link to `/private/etc`, so both lines are now refused, and each node would return its "NO ... EFFECT" text. Change both paths to `/usr`, which isn't a link on macOS or Linux, and keep their expected `"propagate"`. Use `find /usr -name ls` for the find row.

`linkFree` calls `_searchTargetIn` directly, not `resolveTarget`. `resolveTarget` takes the `Word` to decide whether `~` expands, and `linkFree` works from `argument`, which is already expanded. `readGrep` makes the same direct call for `"."`, so this matches existing code.

End to end: `listingOfAFileAsksOneQuestion` runs `safeBash("ls -la one.txt", cwd: FIXTURES)` with one approve handler for "Are you sure you want to list this directory?" in the `.test.json`. It returns whether the output contains `one.txt`. Expected: `true`. A `std::bash` prompt would fail the run on an unmatched interrupt.

- [ ] **Step 2: Run to verify they fail**

Run the agency test into `$SCRATCH/t1.txt`. Expected:
- the new `ls` and `du` rows say "ls of a file is not a listing" (or the `du` version of it);
- the payload rows are empty;
- the symlink node returns today's reasons: "ls of a file is not a listing" for the file links, and an `std::ls` for the folder link;
- `listingOfALinkedFolderIsRefused` gets today's `std::ls` payload;
- the end-to-end node fails on an unmatched `std::bash` interrupt.

- [ ] **Step 3: Implement**

The interfaces above. Then run `make`, the agency test, and `pnpm vitest run lib/stdlibCapabilities.test.ts`. Expected: all pass. `linkFree` and `resolveTargets` reach `_searchTargetIn`, so both carry `@capabilities(fileRead)`. `listingOf`, `requireFolder`, and `mergeListings` touch no files and need no tag.

- [ ] **Step 4: Commit**

Message: `safeBash: ls or du of a file asks std::ls for its folder, and a linked path is refused`.

---

### Task 2: Docs, checks, PR

- [ ] **Step 1: `docs/dev/stdlib/safe-bash.md`, "Listings"**
  - Replace the sentence "A file (`ls one.txt`), a missing path, or a glob word makes the command unrecognized" with the new rule: a file given to `ls` or `du` asks `std::ls` for its folder, not recursive, and one question per folder, recursive if any path to it walks. Add the fail-safe reason: the folder holds the one entry that is printed.
  - Add the per-verb table from the background to the `LIST_VERBS` part of the section.
  - State the link rule as "a path whose last step is a link is refused, file or folder, for every listing verb and `find`". Give the reason, with the other-folder case as the example, and say that same-folder links and `ls dirlink` without `-l` are refused too, on purpose. Mention the macOS `/etc` and `/tmp` consequence in one sentence.
  - Delete the sentence that says `ls -l link` of a folder link "lists the link itself and does not go into the folder, while the payload names the folder the link points to". The new rule replaces it.

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
- A before/after table for `ls -la package.json`, `ls one.txt two.txt`, `ls -R one.txt`, `ls -R . .`, `du -sh one.txt`, `tree one.txt`, `ls -l link.txt`, `ls -l dirlink`, and `ls /etc` on macOS.
- Where to look: `listingOf`, `linkFree` (called from `resolveTargets`), `mergeListings`, and the `files` field of `LIST_VERBS`.
- The tests that changed: `listingOfALinkedFolderIsRefused` (was `listingPayloadNamesTheRealFolder`), and `/etc` to `/usr` in the two "outside the launch directory" nodes.

Link ADI-275 and end with the attribution line. The owner merges.
