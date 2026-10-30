# Claude Code Skills in `agency agent` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency agent` reads Claude Code skills from `~/.claude/skills` and from `.claude/skills` in the current directory and each parent up to the repository root. The model can use those skills on its own, and you can also run them as `/name` slash commands, following Claude Code's two frontmatter switches.

**Architecture:** One new `std::skills` function scans a Claude-layout skills folder once and returns three things: every skill name in it, the skills the model may read, and the skills the user may run as commands. A new agent module finds the folders, scans each under `with approve`, applies Claude Code's precedence by name, and hands the coordinator one skills tool per folder and the REPL one merged command list. The recommended policy gains a read rule for the personal folder and the launch directory's project folder, so the model can read those skills without a prompt.

**Tech Stack:** Agency (`stdlib/skills.agency`, `lib/agents/agency-agent/`), TypeScript (`lib/runtime/policy.ts`, `lib/runtime/policyDirs.ts`, `lib/runtime/builtinPolicies.ts`, `lib/stdlib/gitignore.ts`), Agency execution tests (`*.agency` + `*.test.json`), vitest.

**Spec:** No separate spec. The decisions were made in conversation with the owner on 2026-10-30 and are recorded in "Background and decisions" below. Review: `docs/superpowers/plans/2026-10-30-claude-skills-in-agency-agent-REVIEW.md`; every finding is folded in here.

## Background and decisions

### What exists today

`agency agent` reads skills from three places, all shipped with the agent or written by it:

- `skillsDir(__dirname + "/skills", "flat", name: "coordinator_skills") with approve` in `lib/agents/agency-agent/brains/coordinator/coordinator.agency:46`, the coordinator's notes about itself.
- `superpowersSkill` in `brains/coordinator/subagents/code.agency:52`, used only by the code subagent.
- `learned_skills` over `~/.agency-agent/skills`, built by `learnedExtras()` in `lib/learned.agency:96` and added to the coordinator's tools on every turn by `turnTools()` (`coordinator.agency:115`).

Slash commands come from one place: `projectCommands`, a `static const` holding `commandsDir("${cwd()}/.claude/commands") with approve` (`lib/commandPalette.agency:3`). `turn.agency:162` expands a typed `/name` with `expandSlash(userMsg, projectCommands)`. `mergedPalette()` (`commandPalette.agency:27`) builds the `/` picker from the same list and lays the built-in commands over it, so a file named `clear.md` cannot replace `/clear`. `agent.agency:205` passes the palette to `setSlashPalette` before any session restore.

How a skills tool works (`stdlib/skills.agency`): `skillsDir(dir, layout)` raises one `std::skills::skillsDir` interrupt for the folder, then reads every skill file with the interrupt-free `_glob` and `_read`, because the one approval covers them. It returns `read.partial(dir: dir)`, renamed, whose description lists every skill's name, description, and location. The model decides from those descriptions when to read a skill. The "standard" layout is Claude Code's: one folder per skill, each with a `SKILL.md`.

Reading a skill through that tool is an ordinary `read`, so it raises `std::read` with the skill folder as `dir` (`stdlib/index.agency:224`), and the user's agent policy answers it. The recommended policy approves reads in three places only (`lib/runtime/builtinPolicies.ts:60-65`): the launch directory (`{.,./**}`), the Agency install, and the agent home's `skills`, `tools`, and `memory`. `**` does not descend into a folder whose name starts with a dot (`lib/runtime/policy.ts:118-126`), so `./.claude/skills` is not covered by `./**`. The two existing skill tools work because their folders are under the install and the agent home.

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

1. **Folders:** personal (`<home>/.claude/skills`) plus project folders: `.claude/skills` in the current directory and in each parent, up to the folder that holds `.git` (a folder, or a file in a git worktree). With no repository, only the current directory is read. Nested folders, plugin folders, `--add-dir`, and the claude.ai account skills under `~/.claude/skills/synced/` are out of scope.
2. **Precedence:** personal first, then project folders nearest first. The winner is decided by name, before either switch applies. If the winning skill is manual-only, the model sees nothing by that name, and a lower folder's same-named skill does not take its place. The same goes the other way for a model-only winner and commands. A skill command hides a `.claude/commands` file of the same name. Built-in commands still hide everything.
3. **Slash commands:** every skill without `user-invocable: false` becomes a `/name` command. Its body is the `SKILL.md` text without frontmatter, preceded by `Base directory for this skill: <folder>` and a blank line. `$ARGUMENTS` works as it does for `.claude/commands` files, through `expandSlash`.
4. **Model use:** every skill without `disable-model-invocation: true` is listed in a skills tool. The rule lives in `std::skills`, so `skillsDir` follows it too.
5. **Approval of the scans:** each folder's scan is approved with `with approve`, the same way `projectCommands` already scans `.claude/commands`. The scans run in a `static const`, during global initialization. Since #987 the root run policy is installed before that (`installRunPolicyHandler` in `initFreshExecCtx`, `lib/runtime/node.ts:135-160`), so `agency run --policy ... agent.agency` or `--reject std::skills::skillsDir` can still reject a scan, and the rules of handlers make that rejection win over the inner `with approve`. `agency agent` itself passes no root policy: the launcher hands the child only its budget (`withRootCarriers(process.env, { budget })`, `lib/cli/runBundledAgent.ts:266`), and the user's agent policy is a handler that `runSession` installs around each turn (`lib/turn.agency:127`), after the statics have run. So nothing in `~/.agency-agent/policy.json` or the agent's `--policy` flag can stop these scans. This is the owner's decision; the dev doc says it plainly.
6. **Approval of the reads:** the recommended policy approves reads under `<home>/.claude/skills` and `./.claude/skills`, the same way it approves the agent home's `skills` folder. That needs a new `<home>` placeholder. Project folders in parent directories are not covered, so reading one of those skills prompts in an interactive session and is rejected in a one-shot run. A user's saved `policy.json` gets the new rule through `/policy`; saved policies are not migrated.
7. **Who gets the tools:** the coordinator only, beside `learned_skills`. Subagents are unchanged.

## Global Constraints

- Agency syntax: `def`, braces, parenthesized `if`/`for` conditions, `let`/`const` before use. Check against `docs/site/guide/basic-syntax.md`.
- Types with `type`, never `interface`. Objects, not `Map`. Arrays, not `Set`. No dynamic imports.
- No symlink support. Do not add code to follow a symlinked skill folder.
- Tool names: sanitized and at most 64 characters (`MAX_TOOL_NAME_LEN`).
- Frontmatter switches: `disable-model-invocation` and `user-invocable` are read the way Claude Code reads its boolean fields: `true`/`false`, `yes`/`no`, `on`/`off`, and `1`/`0`, as YAML booleans or strings, in any letter case. Any other value means the default (model may use it; user may run it).
- `static const` values are deeply immutable and shared by every run in the process (`docs/site/guide/global-vs-static.md`). Nothing that reads `SKILL_SOURCES` may change it: build new arrays, never sort or push in place.
- A function that calls a TypeScript helper which touches the file system directly carries `@capabilities(fileRead)` (`docs/site/guide/capabilities.md`). A function that reaches files only through tagged stdlib functions needs no tag.
- After any change under `stdlib/` or `lib/agents/`, build with `make` before running Agency tests. After a TypeScript-only change, `pnpm run build` is enough.
- Run every agent test with `HOME=<scratch>/home`, an empty scratch folder. `AGENCY_AGENT_HOME` is redirected by the agent test harness (`lib/config.agency:6-12`), but `HOME` is not, so without this the tests read the developer's own `~/.claude/skills`.
- Do not hand-edit `docs/site/`. `make` regenerates the stdlib pages from docstrings.
- Run only the tests named in each task, saving output to a file.

## Review Focus

1. **Agent started in the home directory.** `~/.claude/skills` is then both the personal folder and the project folder. Expect one `personal_skills` tool and each skill once.
2. **Agent started outside any git repository.** Expect only the current directory's `.claude/skills`. Parents must not be read, or a run in `~/Downloads/x` would pick up whatever is in `~` and `/`.
3. **A higher folder's skill turned off for one half.** A manual-only personal `deploy` and a plain project `deploy`: expect no `deploy` entry for the model and one `deploy` command, from the personal folder.
4. **A project skill named like a built-in command** (`.claude/skills/clear/SKILL.md`). Expect `/clear` to still clear the screen. The model can still read the skill.
5. **Prompt size.** Every listed skill's description goes to the model on every call. On the owner's machine that is seven personal skills plus the nine `agency-*-docs` skills in this repo, about 3,600 characters of descriptions before the XML. Measure both folders together and report the number. If it is large, try `skillsToolFromEntries`'s `brief` mode, which drops the XML.

Each of these has a test or a measurement in the task that owns the code.

---

### Task 1: `scanClaudeSkills`, the frontmatter switches, and the repository walk

**Files:**
- Modify: `stdlib/skills.agency` (new types and function near `scanSkillsSubdirs`; the switch helpers used by `scanEntries` at line 283; `commandsDir` at line 838 and `expandSlash` at line 897 move onto the shared command type)
- Modify: `lib/stdlib/gitignore.ts` (export a run-free wrapper over `repositoryAncestors`)
- Create: `tests/agency/skills-claude.agency`, `tests/agency/skills-claude.test.json`
- Create fixture: `tests/agency/skills-claude-fixture/` with these skills, each a folder holding `SKILL.md`:
  - `normal`: `name: normal`, `description: A normal skill.`, `argument-hint: <file>`, body `Run on $ARGUMENTS.`
  - `manual-only`: `description: Manual only.`, `disable-model-invocation: true`, body `Manual body.`
  - `model-only`: `description: Model only.`, `user-invocable: false`, body `Model body.`
  - `neither`: both switches set (`true` and `false`), body `Hidden.`
  - `quoted`: `disable-model-invocation: "true"`, body `Quoted.`
  - `word`: `description: Word flag.`, `user-invocable: No`, body `Word body.`
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
    names: string[];
    entries: SkillEntry[];
    commands: SkillCommand[]
  }

  export def scanClaudeSkills(dir: string): Result<ClaudeSkillsScan>
  ```
  `dir` is the real folder (`_realDir`). `names` is every skill name found, before either switch applies; precedence is decided on it. `entries` are the model-usable skills; `commands` are the user-runnable ones.
- `commandsDir` now returns `SkillCommand[]`, and `expandSlash` takes `SkillCommand[]`. Both build and read the same record, so the two command sources cannot drift apart.
- `skillsDir(dir, "standard")` stops listing skills with `disable-model-invocation: true`.
- From `lib/stdlib/gitignore.ts`: `export async function _repositoryAncestors(dir: string): Promise<string[] | null>`.

- [ ] **Step 1: Write the fixture and the failing tests.** Each node returns a boolean, and each test.json entry expects `"true"` with `exact`. Load the scan with `scanClaudeSkills(__dirname + "/skills-claude-fixture") with approve`, then unwrap it.
  - `namesAreEverySkill`: the sorted `names` equal `["bare", "manual-only", "model-only", "neither", "normal", "other-name", "quoted", "word"]`.
  - `entriesAreModelUsableSkills`: the sorted entry names equal `["bare", "model-only", "normal", "other-name", "word"]`. `manual-only` and `neither` are absent. `quoted` is absent, because the string `"true"` counts.
  - `commandsAreUserRunnableSkills`: the sorted command names equal `["bare", "manual-only", "normal", "other-name", "quoted"]`. `word` is absent, because `No` counts as false in any letter case. Together with the line above, `neither` appears in neither list (Review Focus 3's single-folder half).
  - `commandBodyNamesItsFolder`: the `normal` command's body equals `"Base directory for this skill: " + scan.dir + "/normal\n\nRun on $ARGUMENTS."`.
  - `commandCarriesArgumentHint`: the `normal` command's `argHint` is `"<file>"` and its `description` is `"A normal skill."`. The `bare` command's `description` and `argHint` are both `""`.
  - `commandExpandsWithArguments`: `expandSlash("/normal notes.md", scan.commands)` ends with `"Run on notes.md."`.
  - `missingDirectoryIsAFailure`: `scanClaudeSkills(__dirname + "/no-such-folder") with approve` is a failure.
  - `skillsDirHidesManualOnlySkills`: `skillsDir(fixture, "standard") with approve` has a description that does not contain `<name>manual-only</name>` and does contain `<name>normal</name>`.

- [ ] **Step 2: Build and run the tests; confirm they fail.**
  Run: `make > <scratch>/make.log 2>&1; pnpm run agency test tests/agency/skills-claude.agency > <scratch>/t1.log 2>&1`
  Expected: failure, because `scanClaudeSkills` is not defined.

- [ ] **Step 3: Implement.** In `stdlib/skills.agency`:
  - A private `frontmatterFlagToBool(data: any, key: string, fallback: boolean): boolean`. It returns `true` for `true`, `yes`, `on`, or `1`, and `false` for `false`, `no`, `off`, or `0`, whether the value is a YAML boolean, a number, or a string in any letter case. Anything else returns `fallback`.
  - The two rules, each as one named private predicate over the parsed frontmatter. Every caller asks these; nothing else reads the two keys.
    - `modelInvocable(data: any): boolean` is `!frontmatterFlagToBool(data, "disable-model-invocation", false)`.
    - `userInvocable(data: any): boolean` is `frontmatterFlagToBool(data, "user-invocable", true)`.
  - `scanEntries` drops a standard-layout entry when `modelInvocable(data)` is false. That makes `skillsDir` follow the rule too.
  - A private `commandRecord(name: string, data: any, body: string): SkillCommand`. It holds the defaults `commandsDir` applies today: `description` and `argHint` (from `argument-hint`) become `""` when missing. Move `commandsDir`'s record building onto it, change `commandsDir`'s return type to `SkillCommand[]`, and change `expandSlash`'s `commands` parameter to `SkillCommand[]`.
  - `scanClaudeSkills`, tagged `@capabilities(fileRead)` like `skillsDir`, because it calls `_glob` and `_read` directly:
    1. Resolve `dir` with `_realDir`, returning the failure.
    2. Raise `std::skills::skillsDir` with `{ dir: real, layout: "standard" }` and the same message `skillsDir` uses, so an existing always-rule for a folder covers it.
    3. `_glob` `*/SKILL.md` once, up to `MAX_SKILL_FILES`, and `_read` each file once. Parse its frontmatter with the same tolerance `scanEntries` has (`catch {}`).
    4. From each file, take its name (frontmatter `name`, or else the folder name, as in `standardEntry`) and add it to `names`. When `modelInvocable(data)`, add `standardEntry(path, data)` to `entries`. When `userInvocable(data)`, add `commandRecord(name, data, body)` to `commands`, where `body` is `"Base directory for this skill: ${real}/${folder}\n\n"` followed by `stripFm(raw)`.
  - Docstrings for `scanClaudeSkills` and both types, which become the stdlib reference page. The `scanClaudeSkills` docstring says it raises only `std::skills::skillsDir`, even though it also produces commands, so a rule that rejects `std::skills::commandsDir` for a folder does not stop that folder's skill commands.

- [ ] **Step 4: Expose the repository walk.** `lib/stdlib/gitignore.ts:94` already has `repositoryAncestors(host, dir)`. It returns the folders above `dir` up to the one holding `.git`, outermost first. It returns `[]` when `dir` is itself the repository root, and `null` when there is no repository. Add an exported `_repositoryAncestors(dir: string): Promise<string[] | null>` beside it. On its first line it reads `currentHost()` and passes that to `repositoryAncestors`. Task 2 calls this; do not write a second walk.

- [ ] **Step 5: Run the tests; confirm they pass, and that the existing `skills-dir` and `commands-dir` tests still pass.**
  Run: `make > <scratch>/make.log 2>&1; for t in skills-claude skills-dir commands-dir; do pnpm run agency test tests/agency/$t.agency > <scratch>/$t.log 2>&1; echo $t=$?; done; pnpm run typecheck > <scratch>/tc.log 2>&1; echo typecheck=$?`
  Expected: all exit 0. `commands-dir` passing unchanged is the check that moving its record building onto `commandRecord` changed nothing.

- [ ] **Step 6: Commit** `stdlib/skills.agency`, `lib/stdlib/gitignore.ts`, the fixture, both test files, and the regenerated `docs/site/stdlib/skills.md`.

### Task 2: Find, scan, and merge the skill folders in the agent

**Files:**
- Create: `lib/agents/agency-agent/lib/claudeSkills.agency`
- Create: `lib/agents/agency-agent/tests/claudeSkills.agency`, `lib/agents/agency-agent/tests/claudeSkills.test.json`

**Interfaces:**
- Consumes: `scanClaudeSkills`, `ClaudeSkillsScan`, `SkillCommand`, and `skillsToolFromEntries(dir, entries, name)` from `std::skills`; `_repositoryAncestors` from `agency-lang/stdlib-lib/gitignore.js` (Task 1).
- Produces:
  ```
  export type SkillLabel = "personal" | "project"

  export type SkillDir = {
    label: SkillLabel;
    dir: string
  }

  export type SkillSource = {
    label: SkillLabel;
    scan: ClaudeSkillsScan
  }

  export def projectFolders(start: string, ancestors: string[] | null): string[]
  export def claudeSkillDirs(start: string, home: string): SkillDir[]
  export def mergeSkillSources(sources: SkillSource[]): SkillSource[]
  export def skillToolsFor(sources: SkillSource[]): any[]
  export def skillCommandsFor(sources: SkillSource[]): SkillCommand[]
  export def claudeSkillTools(): any[]
  export def claudeSkillCommands(): SkillCommand[]
  ```
  `loadSkillSources(start: string, home: string): SkillSource[]` stays private. The test reaches it with `import test { loadSkillSources } from "../lib/claudeSkills.agency"`, the convention `brains/coordinator/tests/agentTurn.agency` uses.

The functions, in order:

- `projectFolders(start, ancestors)`: pure. It returns the folders whose `.claude/skills` count, nearest first: `start`, then `ancestors` reversed. With `ancestors == null` (no repository), it returns `[start]`. This is the one place the "no repository, only the start folder" rule lives.
- `claudeSkillDirs(start, home)`: the candidate folders, labeled, in precedence order. First `{ label: "personal", dir: home + "/.claude/skills" }`, then one `{ label: "project", ... }` for each folder from `projectFolders(start, _repositoryAncestors(start))`, with `/.claude/skills` added. It keeps only folders that exist (`exists` from `std::shell`, which raises no interrupt). It is tagged `@capabilities(fileRead)`, because it calls the TypeScript helper `_repositoryAncestors` directly. The label is set here, where the folder's origin is known; nothing later works it out again.
- `mergeSkillSources`: pure, and it builds new sources and lists rather than editing the scans it is given. It keeps the first source for each `scan.dir`. It then walks the sources in order with the list of names claimed so far. A source keeps only the entries and commands whose name is not yet claimed, then adds all of its own `scan.names` to the claimed list. Claiming by `names`, not by the filtered lists, is what makes a manual-only personal skill hide a plain project skill of the same name from the model (Decision 2).
- `skillToolsFor`: one tool per source that still has entries. The tool is built with `skillsToolFromEntries(scan.dir, entries, name)`. The personal source is named `personal_skills`. The project sources are named `project_skills`, `project_skills_2`, `project_skills_3`, in order.
- `skillCommandsFor`: every source's commands, in source order.
- `loadSkillSources(start, home)`: for each `SkillDir`, `scanClaudeSkills(dir) with approve`, keeping the label. It skips a failure and returns `mergeSkillSources` of the rest.
- `static const SKILL_SOURCES = loadSkillSources(cwd(), os.homedir())`. `claudeSkillTools()` returns `skillToolsFor(SKILL_SOURCES)`, and `claudeSkillCommands()` returns `skillCommandsFor(SKILL_SOURCES)`.

- [ ] **Step 1: Write the failing tests.** Build a tree at runtime under the literal path `__dirname + "/test-output/claude-skills"`, which `.gitignore` already covers. Do not build the path from `cwd()` or from other paths. Git refuses to commit a path named `.git`, so the `.git` marker cannot be a fixture. Remove the tree at the start and the end of each node that uses it with `remove(tree, allowedPaths: [__dirname + "/test-output"]) with approve`. In the tree:
  - `home/.claude/skills/shared/SKILL.md` and `home/.claude/skills/mine/SKILL.md`
  - `repo/.git/` (a directory)
  - `repo/.claude/skills/shared/SKILL.md` and `repo/.claude/skills/rootonly/SKILL.md`
  - `repo/sub/.claude/skills/near/SKILL.md`
  - `repo/sub/work/` (no skills)

  Nodes, each returning a boolean checked against `"true"`:
  - `projectFoldersNearestFirst`: `projectFolders("/r/s/w", ["/r", "/r/s"])` equals `["/r/s/w", "/r/s", "/r"]`.
  - `outsideARepoReadsOnlyTheStart`: `projectFolders("/a/b", null)` equals `["/a/b"]`. This covers Review Focus 2.
  - `atTheRepoRootReadsOnlyIt`: `projectFolders("/r", [])` equals `["/r"]`.
  - `walksUpToTheRepoRoot`: the `project` entries of `claudeSkillDirs(repo + "/sub/work", home)` have the dirs `[repo + "/sub/.claude/skills", repo + "/.claude/skills"]`. `repo/sub/work` has no skills folder, so it is left out.
  - `personalFolderComesFirst`: `claudeSkillDirs(repo + "/sub/work", home)[0]` equals `{ label: "personal", dir: home + "/.claude/skills" }`.
  - `personalWinsOnASharedName`: in `loadSkillSources(repo + "/sub/work", home)`, the entry `shared` appears once, in the personal source.
  - `manualOnlyWinnerHidesTheEntry`: `mergeSkillSources` of a personal source with `names: ["deploy"]`, no entries, and one `deploy` command, then a project source with `names: ["deploy"]`, a `deploy` entry, and a `deploy` command. Expect no `deploy` entry in any source and exactly one `deploy` command, in the personal source. This covers Review Focus 3.
  - `modelOnlyWinnerHidesTheCommand`: the mirror case. A personal source with `names: ["deploy"]`, a `deploy` entry, and no commands, then a project source with a `deploy` entry and a `deploy` command. Expect no `deploy` command anywhere.
  - `outerRejectStopsTheScans`: `handle { loadSkillSources(repo + "/sub/work", home) } with reject` returns `[]`. The inner `with approve` does not get past an outer handler that rejects, so a root policy that rejects `std::skills::skillsDir` stops the scans.
  - `homeAsProjectIsReadOnce`: `mergeSkillSources` of two sources with the same `scan.dir` returns one. This covers Review Focus 1.
  - `toolNamesAreStable`: `skillToolsFor` over personal plus two project sources returns tools named `personal_skills`, `project_skills`, `project_skills_2`.
  - `sourceWithNoEntriesGetsNoTool`: a project source whose entries were all hidden yields no tool.

  The `projectFolders` nodes and the merge nodes use made-up paths and touch no files.

- [ ] **Step 2: Build and run; confirm they fail.**
  Run: `make > <scratch>/make.log 2>&1; HOME=<scratch>/home pnpm run agency test lib/agents/agency-agent/tests/claudeSkills.agency > <scratch>/t2.log 2>&1`
  Expected: failure on the missing module.

- [ ] **Step 3: Implement `lib/agents/agency-agent/lib/claudeSkills.agency`** with the signatures above. Add a short module doc comment that says which folders it reads and points at the dev doc from Task 5.

- [ ] **Step 4: Run; confirm they pass.** Same command. Expected: exit 0.

- [ ] **Step 5: Commit.**

### Task 3: Read rules for the skill folders

**Files:**
- Modify: `lib/runtime/policy.ts` (the `PolicyDirs` type at line 107, a `<home>` placeholder beside `<agent-home>` at line 163, and the substitution in the matcher at line 211)
- Modify: `lib/runtime/policyDirs.ts:24` (`resolvePolicyDirs`, plus a test helper beside `expandAgentHomeDir` at line 64)
- Modify: `lib/runtime/builtinPolicies.ts:60` (`readScopeRules`)
- Test: `lib/runtime/policy.test.ts` (a `<home>` block beside `describe("<agent-home> dir patterns")` at line 627), `lib/runtime/builtinPolicies.test.ts` (the pinned rule list at line 21 and the approved-folder checks at lines 78-96), `lib/agents/agency-agent/tests/readPolicy.agency` with its `.test.json`

**Interfaces:**
- Produces: `export const HOME_PLACEHOLDER = "<home>"`, `export function substituteHome(pattern: string, home: string): string`, and `export function substitutePlaceholders(pattern: string, dirs: PolicyDirs): string` in `policy.ts`; `PolicyDirs.home: string`; `export function expandHomeDir(pattern: string, home?: () => string): string` in `policyDirs.ts`, shaped like `expandAgentHomeDir`.

- [ ] **Step 1: Write the failing tests.**
  - `policy.test.ts`, in a `describe("<home> dir patterns")` block modeled on the `<agent-home>` one: `expandHomeDir("<home>/.claude/skills/**", () => "/Users/a")` equals `"/Users/a/.claude/skills/**"`. A home containing a glob character (`() => "/opt/v*1"`) comes out escaped, as the `<agent-home>` block checks at line 664. A policy whose rule is `{ dir: "<home>/.claude/skills/**" }` approves a `std::read` whose `dir` is under the resolved home, and leaves one under `<home>/other` undecided.
  - `builtinPolicies.test.ts`: add the new rule to the pinned list at line 21. In the approved-folder checks, add `<home>/.claude/skills/review-pr` and `./.claude/skills/normal` to the approved cases, and add `<home>` and `<home>/.ssh` to the not-approved cases.
  - `readPolicy.agency`, beside `readsInsideCwd`: `std::read` with `dir: "${cwd()}/.claude/skills/normal"` is approved. `std::read` with `dir` set to `os.homedir() + "/.claude/skills/normal"` is approved. `std::read` with `dir` set to `path.dirname(cwd()) + "/.claude/skills/normal"` is left undecided, matching `readsOutsideCwd`.

- [ ] **Step 2: Run them; confirm they fail.**
  Run: `npx vitest run lib/runtime/policy.test.ts lib/runtime/builtinPolicies.test.ts > <scratch>/t3-ts.log 2>&1; make > <scratch>/make.log 2>&1; HOME=<scratch>/home pnpm run agency test lib/agents/agency-agent/tests/readPolicy.agency > <scratch>/t3-agency.log 2>&1`

- [ ] **Step 3: Implement.**
  - `policy.ts`: add `home` to `PolicyDirs` and `HOME_PLACEHOLDER` with `substituteHome`, escaped like `substituteAgentHome`. The matcher at line 211 now applies three substitutions. Replace the nested calls with one helper, `substitutePlaceholders(pattern: string, dirs: PolicyDirs): string`, that applies each placeholder in turn. A fourth placeholder is then one more line in that helper.
  - `policyDirs.ts`: `resolvePolicyDirs` sets `home: host.system.realDir(host.system.homeDir())`. `expandHomeDir` defaults `home` to that same value from `defaultHost()`.
  - `builtinPolicies.ts`: a `CLAUDE_SKILL_READ_DIRS` constant holding the four patterns, and one approve rule over it in `readScopeRules`. The comment says what it covers: the personal folder and the launch directory's project folder, not parent project folders. It also says why this does not reopen the "home as a whole" concern in the comment above it: the rule covers only `.claude/skills`, and `**` does not descend into dot folders such as a `.git` inside it.

- [ ] **Step 4: Run; confirm they pass.** Same commands, plus `npx vitest run lib/runtime/policyDirs.test.ts` and `pnpm run typecheck`. Expected: all pass.

- [ ] **Step 5: Commit.**

### Task 4: Wire skills into the coordinator, the slash commands, and the prompt

**Files:**
- Modify: `lib/agents/agency-agent/lib/commandPalette.agency`
- Modify: `lib/agents/agency-agent/lib/turn.agency:162`
- Modify: `lib/agents/agency-agent/brains/coordinator/coordinator.agency:115` (`turnTools`)
- Modify: `lib/agents/agency-agent/brains/coordinator/prompts/main-large.md` and `main-small.md`, in the paragraph that introduces `learned_skills` (`main-large.md:131`, `main-small.md:62`)
- Test: `lib/agents/agency-agent/tests/commandPalette.agency` (create if absent) with its `.test.json`

**Interfaces:**
- Consumes: `claudeSkillTools()`, `claudeSkillCommands()` from Task 2.
- Produces: `export def slashCommands(): SkillCommand[]` in `commandPalette.agency`, returning `[...claudeSkillCommands(), ...projectCommands]`, and `export def paletteFrom(commands: SkillCommand[]): Record<string, string>`. `turn.agency` and `mergedPalette()` both use `slashCommands()`.

- [ ] **Step 1: Write the failing tests.** Build the palette from fixed command lists through `paletteFrom`, so no real folder is read.
  - `skillHidesCommandFile`: `paletteFrom([{ name: "deploy", description: "skill", argHint: "", body: "" }, { name: "deploy", description: "file", argHint: "", body: "" }])["/deploy"]` equals `"skill"`.
  - `builtinHidesSkill`: `paletteFrom([{ name: "clear", description: "skill", argHint: "", body: "" }])["/clear"]` equals `builtinPalette()["/clear"]`. This covers Review Focus 4.
  - `expandUsesFirstMatch`: `expandSlash("/deploy", [skillDeploy, fileDeploy])` returns the skill's body.

- [ ] **Step 2: Build and run; confirm they fail.**
  Run: `make > <scratch>/make.log 2>&1; HOME=<scratch>/home pnpm run agency test lib/agents/agency-agent/tests/commandPalette.agency > <scratch>/t4.log 2>&1`

- [ ] **Step 3: Implement.**
  - `paletteFrom` keeps the first label for a name. Its loop must not let a later entry overwrite an earlier one, which is what the current `mergedPalette` loop does. Built-ins are laid over the result last. `mergedPalette()` becomes `paletteFrom(slashCommands())`.
  - `turn.agency:162` calls `expandSlash(userMsg, slashCommands())`.
  - `turnTools` adds `...claudeSkillTools()` right after `...learnedExtras()`.
  - In both prompts, add two or three sentences beside the `learned_skills` paragraph: `personal_skills` holds the user's own Claude Code skills from `~/.claude/skills`; `project_skills` (and `project_skills_2` and so on) hold the project's from `.claude/skills`; read the matching skill when a request fits its description. Without this, the model has the tools and does not use them.

- [ ] **Step 4: Run the new test and the existing agent tests that touch these files.** `toolWiring.agency` is the one that catches duplicate tool names in `turnTools`, and this task adds tools to that list.
  Run: `make > <scratch>/make.log 2>&1; for t in lib/agents/agency-agent/tests/commandPalette.agency lib/agents/agency-agent/tests/turn.agency lib/agents/agency-agent/brains/coordinator/tests/agentTurn.agency lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency lib/agents/agency-agent/tests/learned.agency; do HOME=<scratch>/home pnpm run agency test $t > <scratch>/$(basename $t).log 2>&1; echo $t=$?; done`
  Expected: all exit 0.

- [ ] **Step 5: Check it by hand.** From `packages/agency-lang`, start the built agent with a throwaway agent home and the recommended policy, and your real `HOME`, so your own skills load: `AGENCY_AGENT_HOME=<scratch>/agent-home node ./dist/scripts/agency.js agent`.
  - Press `/` and confirm the picker lists your personal skills (`simplify-speech`, `review-pr`) and this repo's `agency-agent-docs`, and that `/clear` is still the built-in.
  - Send one turn that a personal skill covers, for example "Explain what a handoff function is, and speak simply." Confirm the model reads `simplify-speech` through `personal_skills`, and that the read does not prompt. This turn makes one model call, about a dollar at the current prompt size. It is the only check that the read rule from Task 3 and the prompt sentences work together.
  - Exit with Ctrl+D.

- [ ] **Step 6: Measure Review Focus 5.** Print the total length of the descriptions of the tools `claudeSkillTools()` returns when the agent starts in `packages/agency-lang` with your real `HOME`. Use a temporary node in the test file, and delete it before committing. Put the number in the PR description. If it is over about 6,000 characters, try `brief: true` in `skillToolsFor` and report both numbers.

- [ ] **Step 7: Commit.**

### Task 5: Dev docs and index

**Files:**
- Create: `docs/dev/agents/claude-skills.md`
- Modify: `docs/dev/agents/agent-brains.md:128-130`
- Modify: `docs/dev/agents/approval-policies.md` (the `<home>` placeholder and the new read rule)
- Modify: `CLAUDE.md` (Agents section of the doc index) and `.claude/skills/agency-agent-docs/SKILL.md`. The second file is tracked inside an ignored folder, so stage it with `git add -u`.

- [ ] **Step 1: Write `claude-skills.md`.** Cover only the mechanism and the rules, with no history and no test narration:
  - The folders and where the walk stops (`repositoryAncestors`), and the no-repository rule in `projectFolders`.
  - Precedence by `names`, with the manual-only example from Review Focus 3.
  - The two switches and where each rule lives (`modelInvocable`, `userInvocable`), and the base-directory line.
  - The tool names, and coordinator only.
  - Approval of the scans: `with approve` in a `static const`, before the agent policy is installed, so nothing in the user's policy can stop them. A `.claude/commands` file does nothing until the user types its name, but a skill's description reaches the model on every call. So a cloned repository's `.claude/skills` reaches the model as soon as the agent starts in it.
  - Approval of the reads: the recommended policy covers `<home>/.claude/skills` and `./.claude/skills`. A skill in a parent project folder prompts on read, and fails in a one-shot run. A saved `policy.json` gets the rule through `/policy`. A manual-only skill's linked files are read with the generic `read` tool and follow the same rules.
  - Statics are not part of a checkpoint. A session resumed with `--resume` runs in a new process, which scans the folders again, so its tools and commands are the folders as they are now.
  - What is not read: nested folders, plugins, `--add-dir`, `synced/`.

- [ ] **Step 2: Update `agent-brains.md:128-130`.** The rule there allows one kind of effectful brain static, bundled file reads. Add the second kind this work introduces: the scans of the user's skill and command folders (`projectCommands` already did this for `.claude/commands`). Say that these run before the policy exists, and point at `claude-skills.md`.

- [ ] **Step 3: Update `approval-policies.md`** with the `<home>` placeholder beside `<agent-home>` and the new read rule.

- [ ] **Step 4: Add the index line** for `claude-skills.md` to `CLAUDE.md` and the skill file, worded the same.

- [ ] **Step 5: Commit.**

## Self-review notes

- Every decision maps to a task: folders and the stop rule (Tasks 1 and 2), precedence by name (Task 2) and for commands (Task 4), the base-directory line (Task 1), the model-use switch (Task 1), scan approval (Task 2) and read approval (Task 3), coordinator only (Task 4).
- Names used across tasks: `scanClaudeSkills`, `ClaudeSkillsScan`, `SkillCommand`, `_repositoryAncestors` (Task 1); `SkillLabel`, `SkillDir`, `SkillSource`, `projectFolders`, `claudeSkillDirs`, `mergeSkillSources`, `skillToolsFor`, `skillCommandsFor`, `claudeSkillTools`, `claudeSkillCommands`, and the private `loadSkillSources` (Task 2); `HOME_PLACEHOLDER`, `substituteHome`, `substitutePlaceholders`, `PolicyDirs.home`, `expandHomeDir` (Task 3); `slashCommands`, `paletteFrom` (Task 4).
- Where each rule lives, once: the two frontmatter switches in `modelInvocable` and `userInvocable`; command fields and defaults in `commandRecord`; the repository walk in `repositoryAncestors`; "no repository means only the start folder" in `projectFolders`; precedence in `mergeSkillSources` (by `names`) and in the order of `slashCommands()`; the placeholders in `substitutePlaceholders`.
