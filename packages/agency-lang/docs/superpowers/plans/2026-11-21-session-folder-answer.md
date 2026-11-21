# Session Folder Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A front-end can move a running session to another folder between turns, by answering the session core's pause with `{ kind: "folder", cwd }`.

**Architecture:** The folder change is one more kind of answer to the pause, beside `rename` and `model`. It sets the two folders the run keeps in its own state: `_agentCwd` (where the file and shell tools work) and `_sessionFolder` (where the user's commands, skills and saved sessions are found). It also sets the record's `cwd`. A front-end sees the move in the pause's `record.cwd`, which already sets where a session's files are kept. It does not watch `cwd`, which a coder also moves.

**Tech Stack:** Agency (`lib/agents/agency-agent/*.agency`), TypeScript (`lib/stdlib/agentDriver/interface.ts`), agency-js tests (`tests/agency-js/session-core*`).

**Spec:** The "Design" section below. It comes from the Perry discussion of chats without a folder. Perry's plan (`docs/superpowers/plans/2026-11-21-folderless-chats.md` in the Perry repo) is the first user of this answer.

## Design

- **Why the core:** both folders live in the run's own state (`let` globals), which travels with the checkpoint. A front-end can't change them from outside, and in Perry nothing may change a run. Front-ends already change a running session through answers to the pause (`docs/dev/agents/session-core.md`, the answers table), so this is one more answer.
- **What it changes:**
  - `setAgentCwd(cwd)` and `setSessionFolder(cwd)`.
  - The record's `cwd`.
  - It emits the notice `Moved the session to <cwd>.`.
- **How a front-end sees it:** through `record.cwd`, already in the pause (`record: currentRecord()`, `core.agency:237`). The pause gets no new field. A run with no record (`record: null`) can still be moved, but there's nothing to follow; no front-end saves such a run.
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
- `PauseData` gets no new field.
- Notice texts are copied exactly from the Design section.
- Run the stdlib build with `make`, not `pnpm run build`, after changing `.agency` files (AGENTS.md).

## Review Focus

1. **An unsaved run** (`record: null`) is moved. The move works, and the pause's `record` stays `null`. Test in Task 1.
2. **A folder deleted after the user picked it** is refused, and `cwd` and `record.cwd` don't change. Test in Task 1.
3. **The next message after a move** carries the new folder's project block. Test in Task 2.
4. **The new folder's `.claude/commands`** are used after a move, not the old folder's. Test in Task 2.
5. **Moving to the current folder** gives the success notice and leaves everything as it was. Test in Task 1.

---

### Task 1: The `folder` answer

**Files:**
- Modify: `lib/agents/agency-agent/core.agency`:
  - add `export type FolderChange = { kind: "folder"; cwd: string }`;
  - add `FolderChange` to the `Answer` union (near :227);
  - add the arm `{ kind: "folder", cwd } => { folderNotice(cwd) }` to `match(next)` (:374-494), after `capabilities`;
  - add `def folderNotice(cwd: string)` next to `renameNotice` (:272-282).
- Modify: `lib/agents/agency-agent/lib/record.agency`. Add `export def moveRecord(cwd: string)` next to `renameSession` (:75-88).
- Modify: `lib/stdlib/agentDriver/interface.ts`. Add `| { kind: "folder"; cwd: string }` to `SettingsAnswer` (:122-134), and a doc bullet: "`folder`: move the session to another folder between turns. `cwd` must be an absolute path to a folder. The pause's `record.cwd` shows the move."
- Modify: `docs/dev/agents/session-core.md`:
  - a row in the answers table (:95-111);
  - a bullet in the per-kind list (:118-194);
  - in "## The session's folder" (:279-290), a sentence: "A `folder` answer moves both the session's folder and the agent's working folder, and sets the record's `cwd`. A front-end follows `record.cwd`, not the pause's `cwd`, which a coder also moves."
- Test: `tests/agency-js/session-core/test.js`, `fixture.json`

**Interfaces:**
- Produces:
  - the answer `{ kind: "folder"; cwd: string }`;
  - `moveRecord(cwd: string)`, which sets `_current.cwd` when there is a record and does nothing when there isn't;
  - after a move, `pauseData().record.cwd` and `pauseData().cwd` are both the new folder.

- [ ] **Step 1: Write the failing tests.** In `test.js`, after the `rename` block:
  - **Setup:** make a folder with `mkdtempSync` (`moveTarget`) and a file path (`notAFolder`), and start `const mover = await startSession()`.
  - **Moved:** answer `{ kind: "folder", cwd: moveTarget }`. Record `result.folder.moved = { notice: lastNotice(mover).level, cwd: pauseData(mover).cwd === moveTarget, recordCwd: pauseData(mover).record.cwd === moveTarget }`. Expect `{ "notice": "info", "cwd": true, "recordCwd": true }`, and check `lastNotice(mover).text === \`Moved the session to ${moveTarget}.\``.
  - **Same folder:** answering `moveTarget` again gives level `"info"`, and `record.cwd` is still `moveTarget`.
  - **Relative path:** answer `{ kind: "folder", cwd: "relative/dir" }`. Expect level `"error"`, the text `Could not move the session to relative/dir: the path is not absolute.`, and `record.cwd` unchanged.
  - **Missing folder and file:** answer a path that doesn't exist, then `notAFolder`. Expect level `"error"` with `…: it is not a folder.` both times, and `cwd` and `record.cwd` unchanged.
  - **Unsaved run:** start with `record: null` (as `rename.notSaved` does) and move it. Expect level `"info"`, `cwd` moved, and `record` still `null`.
- [ ] **Step 2: Run them and check that they fail.** Run `make && AGENCY_USE_TEST_LLM_PROVIDER=1 node ./dist/scripts/agency.js test js tests/agency-js/session-core`. Expected: FAIL. With no arm yet, the answer fails the `Answer!` check and emits `session.error`, so there's no notice.
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

### Task 2: What follows a move

**Files:**
- Test: `tests/agency-js/session-core-folders/test.js`, and its `fixture.json` if the test uses one

**Interfaces:**
- Consumes: the `folder` answer (Task 1), plus the existing helpers in that file: `projectWithHello`, `lastUserText`, and the test LLM client set with `__setLLMClient`.

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
