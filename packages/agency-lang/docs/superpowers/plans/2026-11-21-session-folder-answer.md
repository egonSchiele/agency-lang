# Session Folder Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A front-end can move a running session to another folder between turns, by answering the session core's pause with `{ kind: "folder", cwd }`.

**Architecture:**
- The folder change is one more kind of answer to the pause, beside `rename` and `fork`.
- It sets the two folders the run keeps in its own state:
  - `_agentCwd`, where the file and shell tools work;
  - `_sessionFolder`, where the user's commands, skills and saved sessions are found.
- It also sets the record's `cwd` and `lastActive`.
- The driver reports the move to the front-end as `{ type: "moved", from, to }`, the same way it reports `forked`.
- The model is told about the move on the next message, and told again after any compaction.

**Tech Stack:** Agency (`lib/agents/agency-agent/*.agency`), TypeScript (`lib/stdlib/agentDriver/*.ts`, vitest), agency-js tests (`tests/agency-js/session-core*`).

**Spec:** The "Design" section below. It comes from the Perry discussion of chats without a folder, its architecture review, and the review in `2026-11-21-session-folder-answer-review.md`. Perry's plan (`docs/superpowers/plans/2026-11-21-folderless-chats.md` in the Perry repo) is the first user of this answer.

## Design

- **Why the core:** both folders live in the run's own state (`let` globals), which travels with the checkpoint. A front-end can't change them from outside, and in Perry nothing may change a run. Front-ends already change a running session through answers to the pause (`docs/dev/agents/session-core.md`, the answers table), so this is one more answer.
- **The path is normalized:** after the absolute check, `cwd` becomes `resolve(cwd)` from `std::path` (`stdlib/path.agency:34`). That tidies `..` and trailing slashes and doesn't follow symlinks. The resolved path is used everywhere, the notice included. Without this, `/p` and `/p/` would file one folder under two slugs.
- **What a move changes:**
  - `setAgentCwd(path)` and `setSessionFolder(path)`.
  - The record's `cwd`, and its `lastActive`, set to `now()`. A move is something the person did to the chat, and front-ends that keep the newer copy of a record need the moved copy to be newer.
  - It emits the notice `Moved the session to <path>.`.
- **How a front-end learns of it:** the driver reports `{ type: "moved", from, to }` when `record.cwd` differs across an answer. It sits next to `forkedHappened` in `lib/stdlib/agentDriver/machine.ts`. `PauseData` gets no new field.
- **What the front-end must do:** move the saved files, and resume the run on a host for the new folder. The core does not move the host's folder. Until the front-end rebinds it, `.` in policy rules and `cwd()` still mean the old folder (`docs/dev/agents/approval-policies.md:938-942`).
- **What the model sees:**
  - The next user message gets the "The working directory changed" project block (`withProjectContextIfMoved`, `lib/projectContext.agency:109-115`), which names the new folder.
  - That block is a user message, and compaction summarizes it. The grounding at the head names the folder the session started in, and compaction keeps it (`docs/dev/agents/agent-compaction.md`, "What is kept").
  - So `projectContext.agency` remembers the folder the grounding was built for (`_groundingDir`). After a compaction, `_blockDir` goes back to it, and the next message carries the block again if the agent's folder differs. A coder's move gets the same fix.
- **What follows by itself:** skills and `.claude/commands` are read from `sessionFolder()` on every turn (`lib/claudeSkills.agency:199-211`, `lib/commandPalette.agency:21-33`).
- **Refusals,** reported as `session.notice` at level `"error"`. Nothing changes when a refusal happens.
  - `Could not move the session to <cwd>: the path is not absolute.` (the path as sent)
  - `Could not move the session to <path>: it is not a folder.` (the resolved path) This covers both a missing path and a file.
- **Moving to the session's current folder** succeeds with the same notice. The record and the session folder stay as they were, and the agent's working folder is set to it, undoing a coder's move into a subfolder.
- **No approval:** `stat` raises no effect (`stdlib/shell.agency:392-414`; the agent calls it bare in `lib/attachments.agency:53`), so the move asks the front-end nothing. Don't wrap it in `with approve`.
- **Saving:** the core still writes no files. The front-end saves the run, and the next save carries the new record.
- **The terminal** gets no `/folder` command. Its save folder is fixed when it opens a session (`lib/terminal.agency:238,250`). A session another front-end moved resumes from the new folder, because the record and files say so.

## Global Constraints

- The answer's shape is exactly `{ kind: "folder"; cwd: string }`.
- The driver's report is exactly `{ type: "moved"; from: string; to: string }`, where `from` and `to` are `record.cwd` before and after the answer.
- `PauseData` gets no new field.
- Notice texts are copied exactly from the Design section.
- Run the stdlib build with `make`, not `pnpm run build`, after changing `.agency` files (AGENTS.md).
- `session-core/fixture.json` and `session-core-folders/fixture.json` are compared as whole objects, and temp paths change every run. Anything that contains a temp path goes into the result as a boolean.

## Review Focus

1. **A path with a trailing slash or `..`** is stored resolved, so it doesn't make a second folder. Test in Task 1.
2. **After a move and a compaction**, the next message still tells the model the new folder. Test in Task 3.
3. **A folder deleted after the user picked it** is refused, and `cwd` and `record.cwd` don't change. Test in Task 1.
4. **An unsaved run** (`record: null`) is moved. The move works, and the driver reports no `moved`, since there's no record. Tests in Tasks 1 and 2.
5. **The move asks for no approval.** Test in Task 4.

---

### Task 1: The `folder` answer

**Files:**
- Modify: `lib/agents/agency-agent/core.agency`:
  - add `export type FolderChange = { kind: "folder"; cwd: string }`;
  - add `FolderChange` to the `Answer` union (near :227);
  - add the arm `{ kind: "folder", cwd } => { folderNotice(cwd) }` to `match(next)` (:374-494), after `capabilities`;
  - add `def folderNotice(cwd: string)` next to `renameNotice` (:272-282);
  - reword the `PauseData.cwd` comment (:74) to say a coder or a folder answer moves it.
- Modify: `lib/agents/agency-agent/lib/record.agency`. Add `export def moveRecord(cwd: string)` next to `renameSession` (:75-88).
- Modify: `lib/agents/agency-agent/lib/sessionFolder.agency`. Reword the module doc from "The folder a session started in" to "the session's folder: where it started, or where a folder answer moved it".
- Modify: `lib/agents/agency-agent/lib/sessions.agency:46-47`. Reword `projectDir()`'s doc the same way.
- Modify: `lib/stdlib/agentDriver/interface.ts`. Add `| { kind: "folder"; cwd: string }` to `SettingsAnswer` (:122-134), and a doc bullet: "`folder`: move the session to another folder between turns. `cwd` must be an absolute path to a folder. The driver reports `moved`. The core does not move the run's host folder: resume the run on a host for the new folder, or policy rules that use `.` still mean the old one."
- Modify: `docs/dev/agents/session-core.md`:
  - a row in the answers table (:95-111);
  - a bullet in the per-kind list (:118-194), with the host-folder sentence;
  - in "## The session's folder" (:279-290), reword the first sentence ("started in") and add: "A `folder` answer moves both the session's folder and the agent's working folder, and sets the record's `cwd`. A front-end follows the driver's `moved`, not the pause's `cwd`, which a coder also moves."
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`

**Interfaces:**
- Produces:
  - the answer `{ kind: "folder"; cwd: string }`;
  - `moveRecord(cwd: string)`, which sets `_current.cwd = cwd` and `_current.lastActive = now()` when there is a record, and does nothing when there isn't;
  - after a move, `pauseData().record.cwd` and `pauseData().cwd` are both the resolved folder.

- [ ] **Step 1: Write the failing tests.** In `test.js`, after the `rename` block:
  - **Setup:** make a folder with `mkdtempSync` (`moveTarget`) and a file path (`notAFolder`), and start `const mover = await startSession()`.
  - **Moved:** note `lastActive` before. Answer `{ kind: "folder", cwd: moveTarget }`. Record `result.folder.moved = { level, text: lastNotice(mover).text === \`Moved the session to ${moveTarget}.\`, cwd: pauseData(mover).cwd === moveTarget, recordCwd: pauseData(mover).record.cwd === moveTarget, lastActiveMoved: pauseData(mover).record.lastActive > before }`. Expect `"info"` and `true` for the rest.
  - **Normalized:** answering `${moveTarget}/` and then `${moveTarget}/x/..` each leaves `record.cwd === moveTarget`, as booleans.
  - **Same folder:** answering `moveTarget` again gives level `"info"`, and `record.cwd` is still `moveTarget`.
  - **Relative path:** answer `{ kind: "folder", cwd: "relative/dir" }`. Expect level `"error"`, the text `Could not move the session to relative/dir: the path is not absolute.` (no temp path, so it can go in the fixture as it is), and `record.cwd` unchanged (as a boolean).
  - **Missing folder and file:** answer a path that doesn't exist, then `notAFolder`. Expect level `"error"`, a text that ends `: it is not a folder.` (as a boolean), and `cwd` and `record.cwd` unchanged.
  - **Unsaved run:** start with `record: null` (as `rename.notSaved` does) and move it. Expect level `"info"`, `cwd` moved, and `record` still `null`.
- [ ] **Step 2: Run them and check that they fail.** Run `make && AGENCY_USE_TEST_LLM_PROVIDER=1 node ./dist/scripts/agency.js test js tests/agency-js/session-core`. Expected: FAIL. With no arm yet, the answer fails the `Answer!` check and emits `session.error`, so there's no notice.
- [ ] **Step 3: Implement `moveRecord(cwd: string)` and `folderNotice(cwd: string)`.**
  - `folderNotice` refuses unless `isAbsolute(cwd)`.
  - Then it computes `const path = resolve(cwd)` and refuses unless `stat(path).type == "dir"`, with no handler.
  - On success: `setAgentCwd(path)`, `setSessionFolder(path)`, `moveRecord(path)`, then `notice("Moved the session to ${path}.")`.
  - Make the doc and comment changes listed under Files.
- [ ] **Step 4: Run the tests and check that they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add lib/agents/agency-agent lib/stdlib/agentDriver/interface.ts docs/dev/agents/session-core.md tests/agency-js/session-core
git commit -m "agent: a folder answer moves a session to another folder"
```

### Task 2: The driver reports `moved`

**Files:**
- Modify: `lib/stdlib/agentDriver/machine.ts`. Add `movedHappened` next to `forkedHappened` (:194-202), and add it to `answerFinished`'s `happened` list (:212).
- Modify: the `Happened` type, wherever `{ type: "forked"; from; to }` is declared (`machine.ts` or `interface.ts`). Add `{ type: "moved"; from: string; to: string }` with the doc line "The session moved to another folder (`record.cwd` changed across an answer). Move its saved files, and resume it on a host for `to`."
- Test: `lib/stdlib/agentDriver/machine.test.ts`

**Interfaces:**
- Consumes: `record.cwd` in the pause data (Task 1).
- Produces: `{ type: "moved"; from: string; to: string }` among a `DriverStep`'s `happened`, after `answered`.

- [ ] **Step 1: Write the failing tests.** In `machine.test.ts`, next to the `forked` tests, drive an answer whose pauses carry `record.cwd`:
  - `"/a"` → `"/b"` reports `{ type: "moved", from: "/a", to: "/b" }`;
  - the same `record.cwd` reports nothing;
  - a `null` record before or after reports nothing;
  - a fork into a new id with the same `cwd` reports `forked` only.
- [ ] **Step 2: Run them and check that they fail.** Run `pnpm exec vitest run lib/stdlib/agentDriver/machine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `movedHappened(before: PauseData | null, after: PauseData | null): Happened[]`.** It follows `forkedHappened`'s shape.
- [ ] **Step 4: Run the tests and check that they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add lib/stdlib/agentDriver
git commit -m "driver: report moved when a session's folder changes"
```

### Task 3: The model hears about the move again after a compaction

**Files:**
- Modify: `lib/agents/agency-agent/lib/projectContext.agency`:
  - add `let _groundingDir = ""`, set to `dir` in `projectContextText` the first time it runs (while `_groundingDir == ""`);
  - add `export def projectBlockSummarized()`, which sets `_blockDir = _groundingDir`.
- Modify: `lib/agents/agency-agent/lib/compaction.agency`. Call `projectBlockSummarized()` in `compactConversation` (:173) once the summary has replaced the older messages.
- Modify: `docs/dev/agents/agent-compaction.md`. One sentence: "After a compaction, a session whose folder moved gets the project block again on its next message, since the head still names the folder it started in."
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`

**Interfaces:**
- Consumes: the `folder` answer (Task 1), and the `compact` answer the core already has.
- Produces: `projectBlockSummarized()`.

- [ ] **Step 1: Write the failing test.**
  - Start a session in folder A and move it to B.
  - Send a message, then `{ kind: "compact", keep: "" }`, then a second message.
  - Using the test's stub model client (as the existing `compact` tests in `test.js` do), record whether the second message's user text contains `Current working directory: ${B}`, as a boolean.
  - Expected: `true`.
- [ ] **Step 2: Run it and check that it fails.** Run the Task 1 command. Expected: FAIL (`false`). The block went out once and was summarized.
- [ ] **Step 3: Implement it** as listed under Files.
- [ ] **Step 4: Run the tests and check that they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add lib/agents/agency-agent/lib docs/dev/agents/agent-compaction.md tests/agency-js/session-core
git commit -m "agent: send the project block again after a compaction when the folder moved"
```

### Task 4: Commands and project context follow a move, and nothing is asked

**Files:**
- Test: `tests/agency-js/session-core-folders/test.js`, `fixture.json`

**Interfaces:**
- Consumes: the `folder` answer (Task 1), plus that file's helpers: `projectWithHello`, `startIn`, the stub model (it replies with the last user text it was sent, `test.js:43-56`), and the approval counter (`test.js:83-88`).

- [ ] **Step 1: Write the test.**
  - Give `startIn`'s returned object an `answer(value)` method beside `say`, for non-message answers.
  - Start a session in `first`, `answer({ kind: "folder", cwd: second })`, then `say("/hello")`.
  - In `fixture.json`, record and expect:
    - the reply contains `hello from the second folder`;
    - the reply contains `The working directory changed.`;
    - the reply contains `Current working directory: ${second}` (as a boolean);
    - `approvalsAsked` is still `0`.
- [ ] **Step 2: Run it.** Run `make && AGENCY_USE_TEST_LLM_PROVIDER=1 node ./dist/scripts/agency.js test js tests/agency-js/session-core-folders`. Expected: PASS without code changes, since both behaviors come from per-turn reads. If it fails, the failure says which read is cached. Fix that read so it follows `sessionFolder()` or `getAgentCwd()`, and add a sentence about it to "## The session's folder".
- [ ] **Step 3: Commit.**

```bash
git add tests/agency-js/session-core-folders
git commit -m "test: commands and project context follow a folder move, with no approval"
```
