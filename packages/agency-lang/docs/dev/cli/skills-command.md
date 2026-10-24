# `agency skills`

`agency skills` hands the skills Agency ships to any coding agent. The user guide is `docs/site/cli/skills.md`; this page covers the decisions behind it.

## Where the skills live

Each skill is `skills/<name>/SKILL.md` at the package root, with `name` and `description` in its frontmatter. The folder is in the `files` list in `package.json`, so it ships in the npm package, and `shippedSkillsDir()` in `lib/cli/skills.ts` finds it through `getPackageRoot()`, which works in the repo and in `node_modules` alike.

The two skills used to be Claude Code commands in `.claude/commands/`, which never shipped, so only people working in this repo had them. They moved here and lost their Claude-only parts (`$ARGUMENTS`, `argument-hint`, "use `/debug-logs`"). The repo's `.claude/commands/debug-run.md` and `debug-logs.md` are now stubs that run `agency skills show`, so this repo reads the skills the same way a user's agent does, and there is one copy of each.

To add a skill, add a folder with a `SKILL.md` whose `name` matches the folder. `listSkills` throws on a name that does not match or a missing description, and the "shipped skills" test in `lib/cli/skills.test.ts` lists the expected names, so update it too.

## Why install writes a stub

These skills are mostly lists of exact commands, flags, and exit codes. A copy in `~/.claude/skills/` goes stale the moment a flag is renamed, and nothing tells the user. So `install` writes only the frontmatter, which the agent needs to decide when to use the skill, and one line telling it to run `agency skills show <name>`. The instructions then always come from the installed binary. The cost is one extra command per use and `agency` on the `PATH`, which the skills' own commands need anyway. `--full` writes the whole text for an agent that cannot run `agency`.

## Safety rules in `installSkill`

- **The marker.** Every file `install` writes carries `INSTALL_MARKER`, an HTML comment. Running `install` again replaces a file with the marker and refuses one without it, so a skill the user wrote by hand under the same name is never overwritten.
- **No symlinks.** It refuses when the skill's folder or its `SKILL.md` is a symlink, and opens the file with `O_NOFOLLOW` so a link planted after that check is refused too. The target directory itself, such as `~/.claude/skills`, is the user's choice and is not checked.
- **The description is quoted.** It is written as a JSON string, which is also a valid YAML string. tarsec's `stringifyFrontmatter` would leave `a: b` unquoted, which its own parser accepts but a strict YAML parser in another agent rejects.
- **Names come from the list.** `findSkills` matches a name against the shipped skills, so a name like `../x` is "no skill named", never a path.

`runInstall` checks the target flags and every name before writing anything. If one skill's write is refused, the ones before it stay written, and the output says which.
