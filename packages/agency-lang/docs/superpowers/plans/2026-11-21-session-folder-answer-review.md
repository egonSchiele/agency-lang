# Review: Session Folder Answer plan

Plan: `docs/superpowers/plans/2026-11-21-session-folder-answer.md`.
I read it next to Perry's `docs/superpowers/plans/2026-11-21-folderless-chats.md`, which is the first user of the new answer, and checked each claim against the code in this worktree.

## Verdict

The shape is right. A folder change is one more answer to the pause, beside `rename` and `fork`, and it sets the two `let` globals that travel with the checkpoint. Most of the "what follows by itself" claims hold up. There are two problems to fix before building:

- After a compaction, the model forgets the move.
- An unnormalized path files the same folder under two names.

There is also one convention to follow: the driver already reports `forked`, so a move should be reported the same way. The other findings are smaller.

## Findings, most important first

### 1. After a compaction, the model is told only the old folder

The plan says the model learns about the move from the "The working directory changed" block on the next message. That is true for the next message, but the block does not last:

- The grounding is a system message at the head of the thread (`lib/answer.agency:125-126`). It names the old folder and holds the old folder's AGENTS.md. Compaction always keeps the head (`docs/dev/agents/agent-compaction.md`, "What is kept", item 1).
- The moved block is part of a user message (`lib/turn.agency:111`). Compaction summarizes it like any other message.
- `_blockDir` is now the new folder (`lib/projectContext.agency:85`), so the block is never sent again.

So after the first compaction, the only thing the model still sees about its folder is the head, and the head says "Current working directory: /old" with the old project's rules. A coder's move has the same gap today. But this plan makes moving the normal path: Perry's main use is a scratch chat moved into a real folder, and those chats live long enough to be compacted.

Rebuilding the grounding on a move does not fix it. `ensureSystemMessage` matches by exact text (`stdlib/thread.agency:315-322`), so a rebuilt grounding is added as a second system message after the head, and compaction summarizes that one too.

Proposed fix at the cause: remember the folder the grounding was built for. When a compaction summarizes the thread, set `_blockDir` back to that folder. If the agent's folder differs from it, the next message then carries the project block once more. That is one stored string, plus one line wherever compaction finishes (`compactAndReport` / `compactIfDue` in `lib/compaction.agency`). Add a test: move, compact, send a message, and check that the message carries `Current working directory: <new>`. The compaction run in the test needs a stub model reply, as the existing compaction tests use.

### 2. Normalize the path before storing it

The plan checks `isAbsolute(cwd)` and then stores `cwd` exactly as sent. These all pass both checks and name the same folder:

```
/Users/me/proj
/Users/me/proj/
/Users/me/x/../proj
```

What goes wrong:

- `cwdSlug` turns each one into a different directory name (`-Users-me-proj` and `-Users-me-proj-`). The core's own save folder, `projectDir()` (`lib/sessions.agency:48-49`), is built from that slug, and so is Perry's sessions folder for the chat.
- Perry groups its sidebar by the folder string, so the chat would appear under a second "proj" section.
- Perry relocates whenever `record.cwd` differs from `meta.cwd`. A "move to the same folder" sent with a trailing slash would make Perry move the chat's files to another folder.

Fix: after the absolute check, use `resolve(cwd)` from `std::path` (`stdlib/path.agency:34`). It tidies `..` and trailing slashes without following symlinks, so the temp folders on macOS (`/var` → `/private/var`) still compare equal in the tests. Use the resolved path everywhere, including in the notice. Add two cases to Task 1: `${moveTarget}/` and `${moveTarget}/x/..` both give `record.cwd === moveTarget`.

### 3. Report the move through the driver, as `forked` is reported

The plan has each front-end compare `record.cwd` across pauses on its own. The driver already has a convention for "the record changed in a way the front-end must act on": `forkedHappened` in `lib/stdlib/agentDriver/machine.ts:194-202` compares the record id before and after an answer, and reports `{ type: "forked", from, to }`. Perry uses the driver's events (`src/agent/sessionMachine.ts:121` in the Perry repo).

Add `movedHappened` next to it. It would compare `before.record.cwd` with `after.record.cwd` and report `{ type: "moved", from, to }`. That way every front-end gets moves the same way it gets forks. Perry's plan (Task 5, "In `onChange`") would then re-file the chat on that event instead of comparing `pause.record?.cwd` with `meta.cwd` itself. This adds no field to `PauseData`, so it keeps the plan's constraint. Files to add to Task 1: `machine.ts`, `machine.test.ts`, and a line in the `fork` bullet's neighborhood of `interface.ts`. This change also affects Perry's plan, so the two plans should be updated together.

### 4. A move leaves `lastActive` unchanged, which leaves Perry's de-duplication without a tie-breaker

Perry's plan has `listSessions` keep, for each id, the record with the larger `lastActive` (Perry Task 5, Review Focus 3). Here is the case that breaks. Perry saves the moved chat into the new folder and then removes the old files. Between those two steps both copies exist, and both carry the same `lastActive`, because `moveRecord` changes only `cwd`. If the removal fails or the engine stops, both copies stay on disk for good, and Perry has no rule for choosing between them.

One of the two plans has to settle this. My suggestion is to have `moveRecord` set `lastActive = now()`, since a move is something the person did to the chat. Write that in the Interfaces line for `moveRecord` and add a test for it. The other choice is a tie-break rule in Perry. Whichever you pick, state it in both plans.

### 5. The host's folder does not move, and the docs should say so

A `folder` answer changes `_agentCwd` and `_sessionFolder`. It does not change the run's host folder, which the front-end set with `nodeHost({ cwd })`. Two things still follow the host folder:

- `.` in a policy `dir` rule. It means the host's folder, and `setAgentCwd` does not move it (`docs/dev/agents/approval-policies.md:938-942`).
- `cwd()` from `std::system`.

So until the front-end resumes the run on a host for the new folder, rules like `with-writes` keep approving writes in the old folder and prompt for writes in the new one. The mismatch causes extra prompts, so it is not a security hole. But it is part of the contract: a front-end must rebind its host after a move. Perry's plan already does this (`agentFor({ cwd })`, "the next resume's program was bound with `cwd: other`"). Add one sentence to the new paragraph in "## The session's folder" and to the `folder` bullet in `interface.ts`, for example: "The core does not move the run's host folder. Resume the run on a host for the new folder, or policy rules that use `.` still mean the old one."

### 6. Drop `with approve` from the `stat` call

Step 3 says to call `stat(cwd) with approve`, and gives `loadProjectInstructions` as the precedent. But `stat` raises no effect (`stdlib/shell.agency:392-414`), and the agent already calls it without a handler (`lib/attachments.agency:53`). `loadProjectInstructions` needs `with approve` because the reads inside it raise `std::read`. `stat` raises nothing.

A `with approve` on a call that raises nothing does nothing. In this codebase it also looks like a policy bypass to anyone reviewing the core, so leave it off.

To show the move asks the front-end nothing, Task 2 can reuse the approval counter that `session-core-folders/test.js:83-88` already has, and assert that `approvalsAsked` is still `0` after the move.

### 7. Several comments still say "the folder the session started in"

After this change, the session's folder is no longer fixed at the start. The plan only adds a sentence to the doc, so these will be wrong:

- the module doc of `lib/sessionFolder.agency` ("The folder a session started in");
- `projectDir()` in `lib/sessions.agency:46-47` ("the folder for the directory the session started in");
- the first sentence of "## The session's folder" in `docs/dev/agents/session-core.md:281-285`;
- `PauseData.cwd` in `core.agency:74` ("A coder can move it"). A folder answer moves it too.

Add these to Task 1's file list and reword them.

### 8. Test details that would trip the implementer

- **Task 1:** `session-core/fixture.json` is compared as a whole JSON object, and the temp paths change on every run. Step 1's "check that `lastNotice(mover).text === …`" must go into the result as a boolean. The same applies to the missing-folder notice, which also contains a temp path. Only the relative-path text, `relative/dir`, can go into the fixture as it is.
- **Task 2:** `startIn` in `session-core-folders/test.js` returns only `say`, which always sends a message. The test needs an `answer(value)` method for the folder answer. The stub model's reply is the last user text it was sent (`test.js:43-56`), so assert on the reply, as the file's other checks do. The file does have a `fixture.json`, so the new keys go in it.

### 9. Review Focus 5 claims too much

"Moving to the current folder … leaves everything as it was" is false after a coder has moved the agent into a subfolder. Answering with the session folder sets `_agentCwd` back to it. That behavior is fine, but say "the record and the session folder stay as they were; the agent's working folder is set to it". Then add a test case for it, or drop the claim.

## Claims I checked that hold up

- The pause already carries `record: currentRecord()` (`core.agency:238`). Following `record.cwd` needs no new field.
- `.claude/commands` and the skills are read from `sessionFolder()` on every turn, and the scan the terminal keeps is stored per folder (`lib/commandPalette.agency:21-33`, `lib/claudeSkills.agency:199-211`). So they follow a move in both kinds of process.
- `withProjectContextIfMoved` runs on every message (`lib/turn.agency:111`) and compares against the agent's folder (`lib/projectContext.agency:109-115`). Task 2's expected text, `The working directory changed.` and `Current working directory: <second>`, matches what it builds.
- An answer with an unknown `kind` fails the `Answer!` check and emits `session.error` (`core.agency:367-372`), so Task 1 Step 2 fails the way the plan says.
- `notice` defaults to level `"info"` (`lib/notice.agency`).
- The core's own save folder, `projectDir()`, follows `sessionFolder()` (`lib/sessions.agency:48-49`), so setting the session folder is enough for a terminal-side save to land in the new folder.
- The places the plan names in `interface.ts` (`SettingsAnswer`, :122-134) and in `session-core.md` (the answers table and "## The session's folder") are where it says.
- The contract Perry's plan needs matches this plan: an absolute folder in, and after the move `record.cwd` names it; a refusal changes nothing and sends an `error` notice.
