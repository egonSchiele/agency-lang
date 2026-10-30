# Claude Code Skills in `agency agent` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency agent` reads Claude Code skills from `~/.claude/skills` and from `.claude/skills` in the current directory and each parent up to the repository root. The model can use those skills on its own, and you can also run them as `/name` slash commands, following Claude Code's two frontmatter switches.

**Architecture:** One new `std::skills` function scans a Claude-layout skills directory once and returns both halves: the skills the model may read, and the skills the user may run as commands. A new agent module finds the directories, scans each under `with approve`, applies Claude Code's precedence, and hands the coordinator one skills tool per directory and the REPL one merged command list.

**Tech Stack:** Agency (`stdlib/skills.agency`, `lib/agents/agency-agent/`), Agency execution tests (`*.agency` + `*.test.json`).

**Spec:** No separate spec. The decisions were made in conversation with the owner on 2026-10-30 and are recorded in "Background and decisions" below. Read that section before any task.

## Background and decisions

### What exists today

`agency agent` reads skills from three places, all shipped with the agent or written by it:

- `skillsDir(__dirname + "/skills", "flat", name: "coordinator_skills") with approve` in `lib/agents/agency-agent/brains/coordinator/coordinator.agency:46`, the coordinator's notes about itself.
- `superpowersSkill` in `brains/coordinator/subagents/code.agency:52`, used only by the code subagent.
- `learned_skills` over `~/.agency-agent/skills`, built by `learnedExtras()` in `lib/learned.agency:96` and added to the coordinator's tools on every turn by `turnTools()` (`coordinator.agency:115`).

Slash commands come from one place: `projectCommands`, a `static const` holding `commandsDir("${cwd()}/.claude/commands") with approve` (`lib/commandPalette.agency:3`). `turn.agency:162` expands a typed `/name` with `expandSlash(userMsg, projectCommands)`. `mergedPalette()` (`commandPalette.agency:27`) builds the `/` picker from the same list and lays the built-in commands over it, so a file named `clear.md` cannot replace `/clear`. `agent.agency:205` passes the palette to `setSlashPalette` before any session restore.

How a skills tool works (`stdlib/skills.agency`): `skillsDir(dir, layout)` raises one `std::skills::skillsDir` interrupt for the directory, then reads every skill file with the interrupt-free `_glob` and `_read`, because the one approval covers them. It returns `read.partial(dir: dir)`, renamed, whose description lists every skill's name, description, and location. The model decides from those descriptions when to read a skill. The "standard" layout is Claude Code's: one folder per skill, each with a `SKILL.md`.

### What Claude Code does

From Claude Code's skills documentation, fetched 2026-10-30:

- Personal skills: `~/.claude/skills/<name>/SKILL.md`.
- Project skills: `.claude/skills/` in the starting directory and every parent up to the repository root.
- Nested skills (`<subdir>/.claude/skills/`) load the first time Claude reads or edits a file in that folder.
- When names collide, enterprise wins over personal, and personal wins over project. A skill wins over a `.claude/commands` file with the same name.
- Claude reads every skill's description and loads a skill when it is relevant. You can also run any skill as `/name`.
- `disable-model-invocation: true`: only you can run it, and its description is not shown to the model.
- `user-invocable: false`: only the model can use it; it is hidden from the `/` menu and `/name` does not run it.
- `argument-hint` gives the hint shown beside the command.
- When you run a skill, Claude Code puts `Base directory for this skill: <folder>` before its body, so relative links in the skill (for example `simplify-speech` linking `general-writing-tips.md`) can be followed.

### Decisions

1. **Folders:** personal (`<home>/.claude/skills`) plus project folders: `.claude/skills` in the current directory and in each parent, stopping at the first directory that contains `.git` (a folder, or a file in a git worktree). With no `.git` anywhere above, only the current directory is read. Nested folders, plugin folders, `--add-dir`, and the claude.ai account skills under `~/.claude/skills/synced/` are out of scope.
2. **Precedence:** personal first, then project folders nearest first. A skill name seen in an earlier folder hides the same name in a later one, for the model's tools and for commands alike. A skill command hides a `.claude/commands` file of the same name. Built-in commands still hide everything.
3. **Slash commands:** every skill without `user-invocable: false` becomes a `/name` command. Its body is the `SKILL.md` text without frontmatter, preceded by `Base directory for this skill: <folder>` and a blank line. `$ARGUMENTS` works as it does for `.claude/commands` files, through `expandSlash`.
4. **Model use:** every skill without `disable-model-invocation: true` is listed in a skills tool. The rule lives in `std::skills`, so `skillsDir` follows it too.
5. **Approval:** each folder's scan is approved with `with approve`, the same way the agent's bundled skills are. An outer handler that rejects the scan still wins. The scans run once, at startup, in `static const`s.
6. **Who gets the tools:** the coordinator only, beside `learned_skills`. Subagents are unchanged.

## Global Constraints

- Agency syntax: `def`, braces, parenthesized `if`/`for` conditions, `let`/`const` before use. Check against `docs/site/guide/basic-syntax.md`.
- Types with `type`, never `interface`. Objects, not `Map`. Arrays, not `Set`. No dynamic imports.
- No symlink support. A symlinked skill folder is refused by the existing file primitives; do not add code to follow it.
- Tool names: sanitized and at most 64 characters (`MAX_TOOL_NAME_LEN`).
- Frontmatter switches: `disable-model-invocation` and `user-invocable` count when the value is the boolean or the string, `true`/`"true"` and `false`/`"false"`. Any other value means the default (model may use it; user may run it).
- After any change under `stdlib/` or `lib/agents/`, build with `make` before running tests.
- Do not hand-edit `docs/site/`. `make` regenerates the stdlib pages from docstrings.
- Run only the tests named in each task, saving output to a file.

## Review Focus

1. **Agent started in the home directory.** `~/.claude/skills` is then both the personal folder and the project folder. Expect one `personal_skills` tool and each skill once.
2. **Agent started outside any git repository.** Expect only the current directory's `.claude/skills`. Parents must not be read, or a run in `~/Downloads/x` would pick up whatever is in `~` and `/`.
3. **A skill that sets both switches** (`disable-model-invocation: true` and `user-invocable: false`). Expect it to appear nowhere, without an error.
4. **A project skill named like a built-in command** (`.claude/skills/clear/SKILL.md`). Expect `/clear` to still clear the screen. The model can still read the skill.
5. **Prompt size.** Every listed skill's description goes to the model on every call. In this repo the project folder holds the nine `agency-*-docs` skills. Expect the coordinator's tool descriptions to grow by the size of those listings, and no more. Report the size in the PR.

Each of these has a test in the task that owns the code.

---

### Task 1: `scanClaudeSkills` and the frontmatter switches in `std::skills`

**Files:**
- Modify: `stdlib/skills.agency` (new types and function near `scanSkillsSubdirs`; the switch helper used by `scanEntries` at line 283)
- Create: `tests/agency/skills-claude.agency`, `tests/agency/skills-claude.test.json`
- Create fixture: `tests/agency/skills-claude-fixture/` with these skills, each a folder holding `SKILL.md`:
  - `normal`: `name: normal`, `description: A normal skill.`, `argument-hint: <file>`, body `Run on $ARGUMENTS.`
  - `manual-only`: `description: Manual only.`, `disable-model-invocation: true`, body `Manual body.`
  - `model-only`: `description: Model only.`, `user-invocable: false`, body `Model body.`
  - `neither`: both switches set (`true` and `false`), body `Hidden.`
  - `quoted`: `disable-model-invocation: "true"`, body `Quoted.`
  - `renamed`: `name: other-name`, `description: Renamed.`, body `Renamed body.`
  - `bare`: no frontmatter, body `Bare body.`

**Interfaces:**
- Produces, exported from `std::skills`:
  ```
  export type SkillCommand = {
    name: string;
    description: string;
    argHint: string;
    body: string
  }

  export type ClaudeSkillsScan = {
    dir: string;
    entries: SkillEntry[];
    commands: SkillCommand[]
  }

  export def scanClaudeSkills(dir: string): Result<ClaudeSkillsScan>
  ```
  `dir` in the result is the real directory (`_realDir`). `entries` are the model-usable skills in the standard layout; `commands` are the user-runnable ones. A `SkillCommand` has the same fields `commandsDir` records have, so `expandSlash` takes either.
- `skillsDir(dir, "standard")` stops listing skills with `disable-model-invocation: true`.

- [ ] **Step 1: Write the fixture and the failing tests.** Each node returns a boolean, and each test.json entry expects `"true"` with `exact`. Load the scan with `scanClaudeSkills(__dirname + "/skills-claude-fixture") with approve`, then unwrap it.
  - `entriesAreModelUsableSkills`: the sorted entry names equal `["bare", "model-only", "normal", "other-name"]`. `manual-only` and `neither` are absent. `quoted` is absent, because the string `"true"` counts.
  - `commandsAreUserRunnableSkills`: the sorted command names equal `["bare", "manual-only", "normal", "other-name", "quoted"]`.
  - `commandBodyNamesItsFolder`: the `normal` command's body equals `"Base directory for this skill: " + scan.dir + "/normal\n\nRun on $ARGUMENTS."`.
  - `commandCarriesArgumentHint`: the `normal` command's `argHint` is `"<file>"` and its `description` is `"A normal skill."`. The `bare` command's `description` and `argHint` are both `""`.
  - `commandExpandsWithArguments`: `expandSlash("/normal notes.md", scan.commands)` ends with `"Run on notes.md."`.
  - `missingDirectoryIsAFailure`: `scanClaudeSkills(__dirname + "/no-such-folder") with approve` is a failure.
  - `skillsDirHidesManualOnlySkills`: `skillsDir(fixture, "standard") with approve` has a description that does not contain `<name>manual-only</name>` and does contain `<name>normal</name>`.

- [ ] **Step 2: Build and run the tests; confirm they fail.**
  Run: `make > <scratch>/make.log 2>&1; pnpm run agency test tests/agency/skills-claude.agency > <scratch>/t1.log 2>&1`
  Expected: failure, because `scanClaudeSkills` is not defined.

- [ ] **Step 3: Implement.** In `stdlib/skills.agency`:
  - A private `frontmatterFlag(data: any, key: string, fallback: boolean): boolean`. It returns `true` for `true` or `"true"`, `false` for `false` or `"false"`, and `fallback` otherwise.
  - `scanEntries` drops a standard-layout entry when `frontmatterFlag(data, "disable-model-invocation", false)` is true. This is the one place the model-use rule lives.
  - `scanClaudeSkills`:
    1. Resolve `dir` with `_realDir`, returning the failure.
    2. Raise `std::skills::skillsDir` with `{ dir: real, layout: "standard" }` and the same message `skillsDir` uses, so an existing always-rule for a folder covers it.
    3. Build `entries` with `scanEntries(real, ".", "standard", false, MAX_SKILL_FILES)`.
    4. Build `commands` from a `_glob` of `*/SKILL.md` and one `_read` each. Keep a skill unless `frontmatterFlag(data, "user-invocable", true)` is false. The name is frontmatter `name`, or else the folder name. `description` and `argHint` (from `argument-hint`) default to `""`. The body is `"Base directory for this skill: ${real}/${folder}\n\n"` followed by `stripFm(raw)`.
  - Write a docstring for `scanClaudeSkills` and both types. They become the stdlib reference page.

- [ ] **Step 4: Run the tests; confirm they pass, and that the existing `skills-dir` and `commands-dir` tests still pass.**
  Run: `make > <scratch>/make.log 2>&1; for t in skills-claude skills-dir commands-dir; do pnpm run agency test tests/agency/$t.agency > <scratch>/$t.log 2>&1; echo $t=$?; done`
  Expected: all three exit 0.

- [ ] **Step 5: Commit** `stdlib/skills.agency`, the fixture, both test files, and the regenerated `docs/site/stdlib/skills.md`.

### Task 2: Find, scan, and merge the skill folders in the agent

**Files:**
- Create: `lib/agents/agency-agent/lib/claudeSkills.agency`
- Create: `lib/agents/agency-agent/tests/claudeSkills.agency`, `lib/agents/agency-agent/tests/claudeSkills.test.json`

**Interfaces:**
- Consumes: `scanClaudeSkills`, `ClaudeSkillsScan`, `SkillCommand`, and `skillsToolFromEntries(dir, entries, name)` from `std::skills`.
- Produces:
  ```
  export type SkillSource = {
    label: "personal" | "project";
    scan: ClaudeSkillsScan
  }

  export def projectSkillDirs(start: string, ceiling: string = "/"): string[]
  export def claudeSkillDirs(start: string, home: string): string[]
  export def mergeSkillSources(sources: SkillSource[]): SkillSource[]
  export def skillToolsFor(sources: SkillSource[]): any[]
  export def skillCommandsFor(sources: SkillSource[]): SkillCommand[]
  export def claudeSkillTools(): any[]
  export def claudeSkillCommands(): SkillCommand[]
  ```

The functions, in order:

- `projectSkillDirs(start, ceiling)`: the existing `.claude/skills` folders from `start` upward, nearest first. The walk stops at the first directory that has `.git`. It also stops after `ceiling`, or at the filesystem root (where `path.dirname(d) == d`). If no `.git` was found by then, it returns only `start`'s folder, if that exists. Production always passes the default `"/"`. The parameter exists so a test can build a tree with no `.git` above it, even though the test folder itself sits inside this repository. Use `exists` from `std::shell`, which raises no interrupt.
- `claudeSkillDirs(start, home)`: `<home>/.claude/skills` first if it exists, then `projectSkillDirs(start)`. Duplicates are allowed here; merging removes them.
- `mergeSkillSources`: pure. It keeps the first source for each `scan.dir`, drops any entry whose name an earlier source already listed, and drops any command whose name an earlier source already listed.
- `skillToolsFor`: one tool per source that still has entries. The tool is built with `skillsToolFromEntries(scan.dir, entries, name)`. The personal source is named `personal_skills`. The project sources are named `project_skills`, `project_skills_2`, `project_skills_3`, in order.
- `skillCommandsFor`: every source's commands, in source order.
- A private `loadSkillSources(start: string, home: string): SkillSource[]` scans each folder from `claudeSkillDirs` with `scanClaudeSkills(dir) with approve`. It skips a failure. The label is `"personal"` for the home folder, otherwise `"project"`. It returns `mergeSkillSources` of the result.
- `static const SKILL_SOURCES = loadSkillSources(cwd(), os.homedir())`. `claudeSkillTools()` and `claudeSkillCommands()` read it.

- [ ] **Step 1: Write the failing tests.** Build the tree at runtime under `__dirname + "/test-output/claude-skills"`, which `.gitignore` already covers. Git refuses to commit a path named `.git`, so the `.git` marker cannot be a fixture. Remove the tree at the start and the end of each node with `remove(dir) with approve`. In the tree:
  - `home/.claude/skills/shared/SKILL.md` and `home/.claude/skills/mine/SKILL.md`
  - `repo/.git/` (a directory)
  - `repo/.claude/skills/shared/SKILL.md` and `repo/.claude/skills/rootonly/SKILL.md`
  - `repo/sub/.claude/skills/near/SKILL.md`
  - `repo/sub/work/` (no skills)
  - `loose/.claude/skills/x/SKILL.md` (no `.git` above it inside the tree)

  Nodes, each returning a boolean checked against `"true"`:
  - `walksUpToTheRepoRoot`: `projectSkillDirs(repo + "/sub/work", tree)` equals `[repo + "/sub/.claude/skills", repo + "/.claude/skills"]`, where `tree` is the root of the temporary tree.
  - `outsideARepoReadsOnlyTheStart`: `projectSkillDirs(loose, tree)` equals `[loose + "/.claude/skills"]`. This covers Review Focus 2. Without the `tree` ceiling, the walk would reach this repository's own `.git`.
  - `walkStopsAtTheCeiling`: put `tree + "/.claude/skills/above/SKILL.md"` in the tree, and check that `projectSkillDirs(loose, tree)` still does not include `tree + "/.claude/skills"`. With no `.git` found, only the start folder counts.
  - `personalFolderComesFirst`: `claudeSkillDirs(repo + "/sub/work", home)[0]` equals `home + "/.claude/skills"`.
  - `personalWinsOnASharedName`: after loading the sources for `repo/sub/work` with `home`, the merged entries hold `shared` once, from the personal source.
  - `homeAsProjectIsReadOnce`: `mergeSkillSources` of two sources with the same `scan.dir` returns one. This covers Review Focus 1.
  - `toolNamesAreStable`: `skillToolsFor` over personal plus two project sources returns tools named `personal_skills`, `project_skills`, `project_skills_2`.
  - `sourceWithNoEntriesGetsNoTool`: a project source whose entries were all hidden yields no tool.

  Make `loadSkillSources` reachable from the test, either by exporting it or through a small exported wrapper, and note which in the PR.

- [ ] **Step 2: Build and run; confirm they fail.**
  Run: `make > <scratch>/make.log 2>&1; pnpm run agency test lib/agents/agency-agent/tests/claudeSkills.agency > <scratch>/t2.log 2>&1`
  Expected: failure on the missing module.

- [ ] **Step 3: Implement `lib/agents/agency-agent/lib/claudeSkills.agency`** with the signatures above. Add a short module doc comment that says which folders it reads and points at the dev doc from Task 4.

- [ ] **Step 4: Run; confirm they pass.** Same command. Expected: exit 0.

- [ ] **Step 5: Commit.**

### Task 3: Wire skills into the coordinator, the slash commands, and the prompt

**Files:**
- Modify: `lib/agents/agency-agent/lib/commandPalette.agency`
- Modify: `lib/agents/agency-agent/lib/turn.agency:162`
- Modify: `lib/agents/agency-agent/brains/coordinator/coordinator.agency:115` (`turnTools`)
- Modify: `lib/agents/agency-agent/brains/coordinator/prompts/main-large.md` and `main-small.md`, in the paragraph that introduces `learned_skills` (`main-large.md:131`, `main-small.md:62`)
- Test: `lib/agents/agency-agent/tests/commandPalette.agency` (create if absent) with its `.test.json`

**Interfaces:**
- Consumes: `claudeSkillTools()`, `claudeSkillCommands()` from Task 2.
- Produces: `export def slashCommands(): any[]` in `commandPalette.agency`, returning `[...claudeSkillCommands(), ...projectCommands]`. Both `turn.agency` and `mergedPalette()` use it.

- [ ] **Step 1: Write the failing tests.** Build the palette from fixed command lists through a pure helper, so no real folder is read. Add `export def paletteFrom(commands: any[]): Record<string, string>` and make `mergedPalette()` call `paletteFrom(slashCommands())`.
  - `skillHidesCommandFile`: `paletteFrom([{ name: "deploy", description: "skill", argHint: "", body: "" }, { name: "deploy", description: "file", argHint: "", body: "" }])["/deploy"]` equals `"skill"`.
  - `builtinHidesSkill`: `paletteFrom([{ name: "clear", description: "skill", argHint: "", body: "" }])["/clear"]` equals `builtinPalette()["/clear"]`. This covers Review Focus 4.
  - `expandUsesFirstMatch`: `expandSlash("/deploy", [skillDeploy, fileDeploy])` returns the skill's body.

- [ ] **Step 2: Build and run; confirm they fail.**
  Run: `make > <scratch>/make.log 2>&1; pnpm run agency test lib/agents/agency-agent/tests/commandPalette.agency > <scratch>/t3.log 2>&1`

- [ ] **Step 3: Implement.**
  - `paletteFrom` keeps the first label for a name. Its loop must not let a later entry overwrite an earlier one, which is what the current `mergedPalette` loop does. Built-ins are still laid over the result last.
  - `turn.agency:162` calls `expandSlash(userMsg, slashCommands())`.
  - `turnTools` adds `...claudeSkillTools()` right after `...learnedExtras()`.
  - In both prompts, add two or three sentences beside the `learned_skills` paragraph: `personal_skills` holds the user's own Claude Code skills from `~/.claude/skills`; `project_skills` (and `project_skills_2` and so on) hold the project's from `.claude/skills`; read the matching skill when a request fits its description. Without this, the model has the tools and does not use them.

- [ ] **Step 4: Run the new test and the existing agent tests that touch these files.**
  Run: `make > <scratch>/make.log 2>&1; for t in lib/agents/agency-agent/tests/commandPalette.agency lib/agents/agency-agent/brains/coordinator/tests/agentTurn.agency lib/agents/agency-agent/tests/learned.agency; do pnpm run agency test $t > <scratch>/$(basename $t).log 2>&1; echo $t=$?; done`
  Expected: all exit 0.

- [ ] **Step 5: Check it by hand, with no model call.** From `packages/agency-lang`, start the built agent with a throwaway agent home: `AGENCY_AGENT_HOME=<scratch>/agent-home node ./dist/scripts/agency.js agent`. Press `/` and confirm the picker lists your personal skills (`simplify-speech`, `review-pr`) and this repo's `agency-agent-docs`, and that `/clear` is still the built-in. Then exit with Ctrl+D without sending a turn.

- [ ] **Step 6: Measure Review Focus 5.** Print the total length of the descriptions of the tools `claudeSkillTools()` returns when the agent starts in `packages/agency-lang`, for example from a temporary node in the test file that you delete afterwards. Put the number in the PR description.

- [ ] **Step 7: Commit.**

### Task 4: Dev doc and index

**Files:**
- Create: `docs/dev/agents/claude-skills.md`
- Modify: `CLAUDE.md` (Agents section of the doc index) and `.claude/skills/agency-agent-docs/SKILL.md`. The second file is tracked inside an ignored folder, so stage it with `git add -u`.

- [ ] **Step 1: Write the doc.** Cover only the mechanism and the rules: the folders and the `.git` stop, precedence, the two switches and where each rule lives (`scanEntries`, `scanClaudeSkills`), the base-directory line, the tool names, `with approve` at startup, coordinator only, and what is not read (nested, plugins, `--add-dir`, `synced/`). No history and no test narration.

- [ ] **Step 2: Add the index line** to both files, worded the same.

- [ ] **Step 3: Commit.**

## Self-review notes

- Every decision maps to a task: folders and the stop rule (Task 2), precedence (Tasks 2 and 3), commands and the base-directory line (Task 1 body, Task 3 wiring), model-use switch (Task 1), approval (Task 2 `with approve`), coordinator only (Task 3).
- Names used across tasks: `scanClaudeSkills`, `ClaudeSkillsScan`, `SkillCommand` (Task 1); `SkillSource`, `projectSkillDirs`, `claudeSkillDirs`, `mergeSkillSources`, `skillToolsFor`, `skillCommandsFor`, `claudeSkillTools`, `claudeSkillCommands` (Task 2); `slashCommands`, `paletteFrom` (Task 3).
