# Review 2: `ls` of a file asks `std::ls` for its folder (ADI-275)

Plan: `docs/superpowers/plans/2026-11-01-safebash-ls-of-a-file.md`, at f6a5f62b5.

## Verdict

The fold-in is correct: the dedupe is now by folder with `recursive` kept if either path walks, the imports are aliased, the symlink rule is stated as "the last step is a link", and the folder-link case is in. One thing should change before execution. The folder-link refusal, as now written, costs more approvals than the plan says, and the common case is inside the launch directory, not `/etc`.

## Should fix: the blanket folder-link refusal regresses `ls node_modules/<pkg>`

pnpm's `node_modules` is made of symlinks. This checkout's top-level `node_modules` has 23 entries that are links. So `ls node_modules/react`, which a coding agent types often, is a folder link at the last step.

| Line | Today | Under the revised plan |
|---|---|---|
| `ls node_modules/react` | `std::ls` for the real folder under `.pnpm`, inside the launch dir, approved by `recommended` with no prompt | `std::bash`, "ls of a symlink is not described", a prompt |
| `ls -R node_modules/react` | same, no prompt | same prompt |

That is the wrong direction for a round whose goal is fewer approvals, and the payload in the "today" column is true. I probed each program with a folder link as its operand (bash 3.2 ls, BSD du and find on macOS):

| Command | What the program does with a folder link operand |
|---|---|
| `ls dirlink`, `ls -R dirlink`, `ls -a dirlink` | follows it and lists the target. The payload naming the target is true. |
| `ls -l dirlink`, `ls -d dirlink`, `ls -F dirlink` | prints the link's own entry. Mismatch. |
| `du dirlink`, `find dirlink -name x` | do not follow it. `du` prints the link's size, `find` finds nothing. Mismatch. |
| `ls -l dirlink/`, `du dirlink/`, `find dirlink/ -name x` | a trailing slash makes all three follow it. The payload is true. |

POSIX says the same for `ls`: a link to a directory given as an operand is followed unless `-F`, `-d`, or `-l` is given. GNU and BSD both follow this.

So the rule that keeps every true payload and refuses every false one is:

- A **file** whose last step is a link is refused, as the plan says. `ls -l link.txt` prints the link entry, and plain `ls link.txt` prints the name as written while the payload names the target's folder, so there is no flag under which the file payload is true.
- A **folder** whose last step is a link is refused for `du`, `tree`, and `find`, and for `ls` when the split's `plain` has `l`, `d`, or `F`. Plain `ls dirlink` and `ls -R dirlink` keep today's behaviour and today's true payload.
- Optional: a written path ending in `/` is followed by every one of the four programs, so it may pass for all of them. This is a second clause and the first one already saves the common case, so leave it out unless the owner wants it; just say in the doc that a trailing slash is still refused, in the safe direction.

What this changes in the plan:

- `linkFree` needs to know the verb and, for `ls`, the plain flags, or `listingOf` applies the flag rule after `resolveTargets` has computed "is a link" once. I would have `resolveTargets` return the link fact on each target (one more boolean field on `PathTarget`, or a parallel result) and let `listingOf` and `findEffects` decide, so the file-system check stays in one place and the per-verb rule sits beside the row that owns the verb. The `FileArgument` row could grow a third value for this, but a flag-dependent rule does not fit a one-word row, so a small def `followsFolderLink(verb, split)` is clearer.
- `listingPayloadNamesTheRealFolder` stays as it is, because `ls link` for a folder link still names the real folder and that payload is true. Add `ls -l link` beside it, expecting the refusal, and keep the rename for a new node rather than repurposing the old one.
- The fixture node gains rows for `ls dirlink` (a `std::ls` naming `outside`) and `du dirlink` (refused), so both halves of the rule are pinned.
- `listingOutsideTheLaunchDirIsUndecided` keeps `ls /etc`: plain `ls` follows the link, so the payload names `/private/etc` and the policy check still returns `"propagate"`. `findOutsideTheLaunchDirIsUndecided` does need the `/usr` change, because `find /etc` is refused under the new rule. Say why the two nodes differ.
- The dev doc's macOS sentence becomes: `ls -l /etc` and `du /tmp` ask through `std::bash`, while `ls /etc` still asks through `std::ls`.

## Verified in the revision

- The two-list `mergeListings` rule is right and the `ls -R . .` row with one payload is a true improvement over today, which I confirmed asks twice.
- The `.`, `..`, and empty last-segment skip is needed: `std::path`'s `basename` of `..` is `..`, which no real path's last segment ever is, so without the skip every `ls ..` would be refused.
- `requireFolder` as the one home of "of a file is not a listing" is a good consolidation; `findEffects` and the `refuse` rows read the same sentence.
- The aliased import precedent the plan cites (`reviewAgent as generalReviewAgent`) is the right kind of example.
- For a cwd that is itself under a symlink (a project in `/tmp`, which is `/private/tmp` on macOS), `ls src` passes the check: the written parent `.` realpaths to the real cwd, and the real parent of `target.dir` is the same folder. Only the link itself is refused, never a path beneath it.
