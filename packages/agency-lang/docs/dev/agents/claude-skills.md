# Claude Code skills in `agency agent`

`agency agent` reads the user's Claude Code skills and offers them two ways. The model sees a list of them and reads one when a request fits its description. The user can also run one as `/name`.

## Where the skills come from

`lib/agents/agency-agent/lib/claudeSkills.agency` builds the list once, at startup, in a `static const`.

- **Folders, in precedence order.** `claudeSkillDirs` returns `~/.claude/skills` first, then `.claude/skills` in the launch directory and in each parent, nearest first. The walk stops at the folder that holds `.git` (`repositoryAncestors` in `lib/stdlib/gitignore.ts`, reached from Agency through `_repositoryAncestors`). Outside a repository only the launch directory counts; that rule lives in `projectFolders`. Folders that do not exist are left out.
- **One scan per folder.** `scanClaudeSkills` in `std::skills` reads each `*/SKILL.md` once. It returns every skill name in `names`, the model-usable skills in `entries`, and the user-runnable ones in `commands`.
- **Precedence by name.** `mergeSkillSources` walks the folders in order. A name an earlier folder holds hides that name in every later folder, for both the entries and the commands. Names are claimed from `names`, before the frontmatter switches apply. So if `~/.claude/skills/deploy` is manual-only, the model sees no `deploy` at all, even when the project has a plain `deploy`. A folder that appears twice, such as `~/.claude/skills` when the agent starts in `~`, is read once.
- **What the coordinator gets.** One skills tool per folder that lists any skill: `personal_skills`, then `project_skills`, `project_skills_2`, and so on (`skillToolsFor`). Only the coordinator gets them, from `turnTools`; subagents do not. The coordinator prompts name the tools, because a model given a tool it is never told about does not use it.
- **Slash commands.** `slashCommands()` in `lib/commandPalette.agency` is the skill commands followed by the `.claude/commands` files. `expandSlash` and the `/` palette both take the first command with a name, so a skill hides a command file of the same name. The built-in commands are laid over the palette last, so `/clear` is always the built-in.

## What a skill's frontmatter changes

All of this is in `stdlib/skills.agency`.

- **`disable-model-invocation: true`** keeps the skill out of the model's list (`modelInvocable`). `skillsDir` follows the same rule.
- **`user-invocable: false`** keeps it from running as `/name` (`userInvocable`).
- Both switches accept Claude Code's spellings: `true`/`false`, `yes`/`no`, `on`/`off`, and `1`/`0`, in any letter case (`frontmatterFlagToBool`).
- **The description** (`skillDescription`) is `description`, or else the first non-empty line of the body. `when_to_use` is added after it, and the result is cut at 1,536 characters, Claude Code's limit for the list. `skillsDir` keeps its own descriptions.
- **A command's body** starts with `Base directory for this skill: <folder>` and a blank line, so relative links in the skill can be followed. `${CLAUDE_SKILL_DIR}` in the body becomes that folder. `$ARGUMENTS` works through `expandSlash`, as for command files. A skill the model reads through its skills tool is read as written.
- **Refused names.** A name or folder name Claude Code refuses is skipped and claims nothing: control, zero-width, bidirectional-control, private-use, and unusual blank characters, `<` or `>`, leading or trailing spaces, or two spaces in a row. So are the reserved folder `synced` and the names `anthropic-skills` and `anthropic-skills:*` (`_refusedSkillName` in `lib/stdlib/skills.ts`).

Any other frontmatter field is ignored, as Claude Code ignores fields it does not know. These are not supported: positional arguments (`$ARGUMENTS[N]`, `$0`, `arguments`), shell injection (`` !`command` ``), `allowed-tools` and `disallowed-tools`, `model` and `effort`, `context: fork` with `agent` and `background`, `hooks`, and `paths`. The folders are not watched: a skill added during a session appears at the next start. Nested `.claude/skills` folders below the launch directory, plugin skills, `--add-dir`, and the claude.ai skills under `~/.claude/skills/synced/` are not read.

## Approvals

- **The scans.** Each folder's scan raises `std::skills::skillsDir`, and `loadSkillSources` approves it with `with approve`. The scans run during global initialization. `agency agent` passes no root policy to its child process (`withRootCarriers(process.env, { budget })` in `lib/cli/runBundledAgent.ts`), and the agent policy is a handler `runSession` installs around each turn (`lib/turn.agency`), after the statics have run. So nothing in `~/.agency-agent/policy.json` or the agent's `--policy` flag can stop these scans. A root policy can: since #987 it is installed before global initialization, so `agency run --policy ... agent.agency` or `--reject std::skills::skillsDir` rejects a scan, and the rejection wins over the inner `with approve`. A rejected scan leaves its folder out.
- **The reads.** Reading a skill through its tool is an ordinary `read`. The recommended policy approves reads under `<home>/.claude/skills` and `./.claude/skills` (`docs/dev/agents/approval-policies.md`). A skill in a parent folder's `.claude/skills` prompts when read, and is rejected in a one-shot run. A saved `policy.json` gets the new rule through `/policy`. A file a manual-only skill links to is read with the generic `read` tool, under the same rules.
- **What reaches the model.** A `.claude/commands` file does nothing until the user types its name. A skill's description goes to the model on every call. So a cloned repository's `.claude/skills` reaches the model as soon as the agent starts in it.

## Resuming a session

Statics are not part of a checkpoint. A session resumed with `--resume` runs in a new process, which scans the folders again, so it gets the folders' current skills.
