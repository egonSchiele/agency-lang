# `agency skills`

`agency skills` hands the skills Agency ships to any coding agent. The user guide is `docs/site/cli/skills.md`. The code is `lib/cli/skills.ts`.

## Where the skills live

Each skill is `skills/<name>/SKILL.md` at the package root, with `name` and `description` in its frontmatter. The folder is in the `files` list in `package.json`, so it ships in the npm package.

To add a skill, add a folder with a `SKILL.md` whose `name` matches the folder. `listSkills` throws when the name does not match or the description is missing. Update the expected names in the "shipped skills" test in `lib/cli/skills.test.ts` too.

The repo's `.claude/commands/debug-run.md` and `debug-logs.md` read `skills/<name>/SKILL.md` directly, not through `agency skills show`. In a checkout, `agency` is usually not on the PATH, and a global `agency` from npm would print its own release's text, not this checkout's.

## Why install writes a stub

The skills are mostly exact commands, flags, and exit codes. A copy in `~/.claude/skills/` goes stale the moment a flag is renamed, and nothing tells the user. So `install` writes only the frontmatter, which the agent reads to decide when to use the skill, and a line telling it to run `agency skills show <name>`. `--full` writes the whole text for an agent that cannot run `agency`.

## Rules `install` keeps

- **The marker prefix never changes.** Every file `install` writes carries a comment starting with `INSTALL_MARKER_PREFIX`. `install` replaces a file that has the prefix and refuses one without it, so a skill the user wrote by hand is never overwritten. Files written by older versions are recognized by the prefix alone, so the text after it can change but the prefix cannot.
- **All or nothing.** `runInstall` checks every named skill's target before writing any of them, and reports every refusal at once.
- **No symlinks.** It refuses when the skill's folder or its `SKILL.md` is a symlink, and opens the file with `O_NOFOLLOW` so a link planted after that check is refused too. The target directory itself, such as `~/.claude/skills`, is the user's choice and is not checked.
- **The description is quoted.** It is written as a JSON string, which is also a valid YAML string. Do not switch to tarsec's `stringifyFrontmatter`: it leaves a value like `a: b` unquoted, which tarsec's parser accepts but a strict YAML parser in another agent rejects.
