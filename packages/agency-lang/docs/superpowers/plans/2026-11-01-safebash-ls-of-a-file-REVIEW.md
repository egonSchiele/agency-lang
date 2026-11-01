# Review: `ls` of a file asks `std::ls` for its folder (ADI-275)

Plan: `docs/superpowers/plans/2026-11-01-safebash-ls-of-a-file.md`

## Verdict

Yes, this is the right solution, and it is the right size. The fail-safe argument is sound: the payload names the folder, `ls -la one.txt` prints one entry of that folder, and a policy that approves listing the folder has approved seeing every entry in it. The symlink refusal is the correct reading of the CLAUDE.md rule, and the two comparisons in `linkFree` are the right test given what the resolver returns. Nothing blocks it. Three small things below, one of them a dedupe case the plan's rule misses.

## Should fix

**The dedupe rule misses the covering case.** The plan skips a payload with the same `dir` and the same `recursive`. `ls -R . one.txt` gives `{ ., true }` and `{ ., false }`, which are two questions where the first already covers the second. Dedupe on `dir` alone and keep `recursive` true if either payload has it. Today's code has the same shape of gap for `ls -R . .`, which I checked: it asks twice with identical payloads. The new dedupe def fixes both, so the test row `ls -R . .` expecting one `std::ls` belongs beside the plan's `ls one.txt two.txt` row.

**Name the imports so they do not sit next to `baseName`.** `safeBash.agency` already has a local `baseName(text)` (the refuse wall uses it on the command word). Importing `basename` from `std::path` puts `baseName` and `basename` in the same file with different meanings. Import with aliases, for example `basename as lastSegment` and `dirname as parentOf`, or reuse `baseName` and add one small def for the parent.

**Say what the symlink rule refuses, exactly.** The background explains the refusal with a link into another folder, but the check refuses any file whose last path step is a link, including `ln -s plain.txt alias.txt; ls -l alias.txt` in one folder. That is the right behaviour (any doubt asks `std::bash`) and the message "ls of a symlink is not described" is true for it, but the dev doc should state the rule as "a file reached through a link at its last step", and give the other-folder case as the reason, so a reader does not think same-folder links are meant to pass.

## Question for the owner

**Do the folder-link case in the same PR.** The plan leaves `ls -l dirlink` out and says so honestly: its payload names the target folder while `ls -l` prints the link's own entry from the link's folder, which is the same mismatch this PR refuses for files, and the fix is the same `linkFree` call on a folder target. Leaving a known false payload in place when the fix is one line and already tested by the same fixture seems the wrong trade for PR size. If the owner agrees, `listingPayloadNamesTheRealFolder` changes from "names the real folder" to "is refused", and the dev doc sentence about `ls -l link` goes away instead of being contradicted by the paragraph after it.

## Nits

- `ls one.txt/` (trailing slash on a file) is a "Not a directory" error from ls. `std::path`'s `basename` strips the slash, so the check passes and the payload names the folder while ls prints an error. Names more than runs, so fine, but worth a row so nobody later reads it as a gap.
- `du -sh one.txt` gets `recursive: false` even though the `du` row says `always`. The plan says so and it is right (there is no walk for one file). One sentence in the `LIST_VERBS` comment will save a reader the double take.

## Verified against the code

- Listings never run in process. `tryShellFreeStep` (stdlib/safeBash.agency:1611) tries echo, grep, and read only, so `ls one.txt` runs real ls through bash and prints the one entry, as the plan says. Had a lone `ls` run the ls tool, the tool would have refused the file (`_searchTarget` with `tool: "ls"` throws for a file) and this plan would have needed another branch.
- `resolveTarget` (1325) wraps `_searchTargetIn`, which calls `host.files.root(absolute)`. The root walker in `lib/host/node/nodeFiles.ts` realpaths every component, and `_searchTarget` in grep mode returns `dirname` and `basename` of the real path. So for a linked file, `dir` is the target's folder and `file` is the target's name, which is exactly what `linkFree` compares against. The existing `listingPayloadNamesTheRealFolder` and `readPayloadNamesTheRealParent` tests confirm the follow-through for a folder link and a file link.
- The walker keeps the case the caller typed. `cat ONE.TXT` in the fixtures gives `filename: "ONE.TXT"`, so `ls ONE.TXT` on a case-insensitive disk will not be refused as a symlink.
- `resolveDirs` (1353) is only called from `listEffects` and `findEffects`, so replacing it with `resolveTargets` and moving the folder check into `listingOf` and `findEffects` touches every caller.
- `basename` and `dirname` exist in `stdlib/path.agency` (lines 36 and 46).
