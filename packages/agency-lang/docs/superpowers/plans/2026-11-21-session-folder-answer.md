# Session Folder Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A front-end can move a running session to another folder between turns, by answering the session core's pause with `{ kind: "folder", cwd }`.

**Architecture:** The folder change is one more kind of answer to the pause, beside `rename` and `model`. It sets the two folders the run keeps in its own state: `_agentCwd` (where the file and shell tools work) and `_sessionFolder` (where the user's commands, skills and saved sessions are found). It also updates the record's `cwd`. The pause gains a `folder` field holding `sessionFolder()`. A front-end follows that field, not `cwd`, which a coder also moves.

**Tech Stack:** Agency (`lib/agents/agency-agent/*.agency`), TypeScript (`lib/stdlib/agentDriver/interface.ts`), agency-js tests (`tests/agency-js/session-core*`).

**Spec:** The "Design" section below. It comes from the Perry discussion of chats without a folder. Perry's plan (`docs/superpowers/plans/2026-11-21-folderless-chats.md` in the Perry repo) is the first user of this answer.

## Design

- **Why the core:** both folders live in the run's own state (`let` globals), which travels with the checkpoint. A front-end can't change them from outside, and in Perry nothing may change a run. Front-ends already change a running session through answers to the pause (`docs/dev/agents/session-core.md`, the answers table), so this is one more answer.
- **What it changes:**
  - `setAgentCwd(cwd)` and `setSessionFolder(cwd)`.
  - The record's `cwd`.
  - It emits the notice `Moved the session to <cwd>.`.
- **What follows by itself:**
  - The next user message gets the "The working directory changed" project block (`withProjectContextIfMoved`, `lib/projectContext.agency:109-115`), which names the new folder. So the model learns about the move on the next message.
  - Skills and `.claude/commands` are read from `sessionFolder()` on every turn (`lib/claudeSkills.agency:199-211`, `lib/commandPalette.agency:21-33`), so they follow too.
  - The grounding is not rebuilt. A coder's move works the same way today.
- **Refusals,** reported as `session.notice` at level `"error"`. Nothing changes when a refusal happens.
  - `Could not move the session to <cwd>: the path is not absolute.`
  - `Could not move the session to <cwd>: it is not a folder.` This covers both a missing path and a file.
- **Moving to the folder it is already in** succeeds and gives the same notice. Front-ends don't need a special case.
- **Saving:** the core still writes no files. The front-end saves the run, and since the record now says the new `cwd`, the next save shows it. Moving the saved files to the new folder's `sessions/<slug>/` is the front-end's job.
- **The terminal** gets no `/folder` command. Its save folder is fixed when it opens a session (`lib/terminal.agency:238,250`). A session another front-end moved resumes from the new folder, because the record and files say so.

## Global Constraints

- The answer's shape is exactly `{ kind: "folder"; cwd: string }`.
- The pause field is named `folder` and holds `sessionFolder()`. The existing `cwd` field keeps holding `getAgentCwd()`.
- Notice texts are copied exactly from the Design section.
- Run the stdlib build with `make`, not `pnpm run build`, after changing `.agency` files (AGENTS.md).

## Review Focus

1. **An unsaved run** (`record: null`) is moved. The move works, and the pause's `record` stays `null`. Test in Task 2.
2. **A folder deleted after the user picked it** is refused, and `cwd`, `folder` and the record don't change. Test in Task 2.
3. **The next message after a move** carries the new folder's project block. Test in Task 3.
4. **The new folder's `.claude/commands`** are used after a move, not the old folder's. Test in Task 3.
5. **Moving to the current folder** gives the success notice and leaves everything as it was. Test in Task 2.

---

### Task 1: The pause reports the session's folder

**Files:**
- Modify: `lib/agents/agency-agent/core.agency`. Add `folder` to the `PauseData` type (near :75) and to `pauseData()` (near :237). Import `sessionFolder` from `./lib/sessionFolder.agency` (:57 already imports `setSessionFolder`).
- Modify: `lib/stdlib/agentDriver/interface.ts`. Add `folder` to `PauseData` (:72-92) and to its decoder `pauseData()` (:171-191).
- Test: `tests/agency-js/session-core/test.js`, `tests/agency-js/session-core/fixture.json`

**Interfaces:**
- Produces: `PauseData.folder: string`, equal to `sessionFolder()`. Task 2 and Perry rely on it.

- [ ] **Step 1: Write the failing test.** In `test.js`, next to the other pause-data checks, record `result.pauseFolder = { matchesStart: pauseData(session).folder === startData().session.cwd }`, using the session `startSession()` returns. In `fixture.json`, expect `"pauseFolder": { "matchesStart": true }`.
- [ ] **Step 2: Run it and check that it fails.** Run `make && AGENCY_USE_TEST_LLM_PROVIDER=1 node ./dist/scripts/agency.js test js tests/agency-js/session-core`. Expected: FAIL on `pauseFolder` (`matchesStart` is false, because `folder` is undefined).
- [ ] **Step 3: Implement it.** Add `folder: string` to `PauseData` in `core.agency` and `folder: sessionFolder()` in `pauseData()`. In `interface.ts`, add `folder: string` to `PauseData` with the doc line "The folder the session belongs to: where its commands, skills and saved files are found. `cwd` is where its tools work, which a coder moves." Have the decoder read it as a string, the same way it reads `cwd`.
- [ ] **Step 4: Run the tests and check that they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add lib/agents/agency-agent/core.agency lib/stdlib/agentDriver/interface.ts tests/agency-js/session-core
git commit -m "agent: the pause reports the session's folder"
```

### Task 2: The `folder` answer

**Files:**
- Modify: `lib/agents/agency-agent/core.agency`:
  - add `export type FolderChange = { kind: "folder"; cwd: string }`;
  - add `FolderChange` to the `Answer` union (near :227);
  - add the arm `{ kind: "folder", cwd } => { folderNotice(cwd) }` to `match(next)` (:374-494), after `capabilities`;
  - add `def folderNotice(cwd: string)` next to `renameNotice` (:272-282).
- Modify: `lib/agents/agency-agent/lib/record.agency`. Add `export def moveRecord(cwd: string)` next to `renameSession` (:75-88).
- Modify: `lib/stdlib/agentDriver/interface.ts`. Add `| { kind: "folder"; cwd: string }` to `SettingsAnswer` (:122-134), and a doc bullet: "`folder`: move the session to another folder between turns. `cwd` must be an absolute path to a folder."
- Modify: `docs/dev/agents/session-core.md`:
  - a row in the answers table (:95-111);
  - a bullet in the per-kind list (:118-194);
  - `folder` in the pause paragraph (:59-93);
  - in "## The session's folder" (:279-290), a sentence: "A `folder` answer moves both the session's folder and the agent's working folder. A front-end follows the pause's `folder`, not `cwd`."
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`

**Interfaces:**
- Consumes: `PauseData.folder` (Task 1).
- Produces: the answer `{ kind: "folder"; cwd: string }`, and `moveRecord(cwd: string)`, which sets `_current.cwd` when there is a record and does nothing when there isn't.

- [ ] **Step 1: Write the failing tests.** In `test.js`, after the `rename` block:
  - **Setup:** make two folders with `mkdtempSync` (`moveTarget`, plus a file path `notAFolder`) and start `const mover = await startSession()`.
  - **Moved:** answer `{ kind: "folder", cwd: moveTarget }`. Record `result.folder.moved = { notice: lastNotice(mover).level, cwd: pauseData(mover).cwd === moveTarget, folder: pauseData(mover).folder === moveTarget, recordCwd: pauseData(mover).record.cwd === moveTarget }`. Expect `{ "notice": "info", "cwd": true, "folder": true, "recordCwd": true }`, and the notice text `Moved the session to <moveTarget>.` (check `lastNotice(mover).text === \`Moved the session to ${moveTarget}.\``).
  - **Same folder:** answering `moveTarget` again gives level `"info"`, and `folder` is still `moveTarget`.
  - **Relative path:** answer `{ kind: "folder", cwd: "relative/dir" }`. Expect level `"error"`, the text `Could not move the session to relative/dir: the path is not absolute.`, and `folder` unchanged.
  - **Missing folder and file:** answer a path that doesn't exist, then `notAFolder`. Expect level `"error"` with `…: it is not a folder.` both times, and `folder` and `record.cwd` unchanged.
  - **Unsaved run:** start with `record: null` (as `rename.notSaved` does) and move it. Expect level `"info"`, `folder` moved, and `record` still `null`.
- [ ] **Step 2: Run them and check that they fail.** Run the Task 1 command. Expected: FAIL. With no arm yet, the answer fails the `Answer!` check and emits `session.error`, so there's no notice.
- [ ] **Step 3: Implement `moveRecord(cwd: string)` in `record.agency`** and **`folderNotice(cwd: string)` in `core.agency`.**
  - Check `isAbsolute(cwd)`.
  - Then check `stat(cwd) with approve` from `std::shell`, and refuse unless `.type == "dir"`. The core reads the user's files with `approve` elsewhere too: `loadProjectInstructions` in `lib/projectContext.agency`.
  - On success: `setAgentCwd(cwd)`, `setSessionFolder(cwd)`, `moveRecord(cwd)`, then `notice("Moved the session to ${cwd}.")`.
  - Add the answer type and the docs listed under Files.
- [ ] **Step 4: Run the tests and check that they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add lib/agents/agency-agent lib/stdlib/agentDriver/interface.ts docs/dev/agents/session-core.md tests/agency-js/session-core
git commit -m "agent: a folder answer moves a session to another folder"
```

### Task 3: What follows a move

**Files:**
- Test: `tests/agency-js/session-core-folders/test.js`, and its `fixture.json` if the test uses one

**Interfaces:**
- Consumes: the `folder` answer (Task 2), plus the existing helpers in that file: `projectWithHello`, `lastUserText`, and the test LLM client set with `__setLLMClient`.

- [ ] **Step 1: Write the test.**
  - Start a session in `first`, answer `{ kind: "folder", cwd: second }`, then send the message `/hello`.
  - Assert that the user text the model receives (`lastUserText` of the last llm() config) contains `hello from the second folder`.
  - Assert that the same text contains `The working directory changed.` and `Current working directory: ${second}`.
- [ ] **Step 2: Run it.** Run `make && AGENCY_USE_TEST_LLM_PROVIDER=1 node ./dist/scripts/agency.js test js tests/agency-js/session-core-folders`. Expected: PASS without code changes, since both behaviors come from per-turn reads. If it fails, the failure says which read is cached. Fix that read so it follows `sessionFolder()` or `getAgentCwd()`, and add a sentence about it to "## The session's folder".
- [ ] **Step 3: Commit.**

```bash
git add tests/agency-js/session-core-folders
git commit -m "test: commands and project context follow a folder move"
```
