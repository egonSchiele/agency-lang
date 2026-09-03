# `std::grep` and `.gitignore`

`grep` skips whatever the `.gitignore` files under the search directory
would ignore. This doc records why, what the matcher covers, and how the
agent gets the setting without being able to change it.

## Why

In an `agency agent` session on 2026-09-03 (trace `mL0SvY`), the
coordinator grepped `lib/agents/agency-agent` for model names. Most of
the hits came from `agent.js` and `brain.js`, compiled output that
`.gitignore` already excludes with `**/*.js`. The stale default baked
into those files sent the model chasing a value that was not in any
source file, and two rounds went to sorting real hits from generated
ones. The tool had every piece of information it needed to skip them.

## What is covered

The matcher is `lib/stdlib/gitignore.ts`. It reads a `.gitignore` in
each directory the walk enters and keeps the files on the path from the
root down, outermost first. For one entry, every rule of every file on
that path is checked in order and the last match wins, which is how git
resolves the same question. A nested file therefore refines its parent:
`keep/.gitignore` containing `!*.js` un-ignores `keep/c.js` even though
the root ignores `*.js`.

Rules understood:

- comments (`#`) and blank lines are skipped
- `!pattern` negates
- a trailing `/` names directories only, and still covers the files
  under such a directory
- a slash anywhere else anchors the pattern to the directory holding the
  `.gitignore`; a pattern with no slash matches a name at any depth

Not read: `.git/info/exclude` and the global excludes file. Both live
outside the tree being searched, and the cases that motivated this are
all in-tree.

An ignored directory is not descended, so a walk over a big `dist/`
never pays for it. The hard-coded skip list (`node_modules`, `.git`,
`dist`, `build`, and so on) still applies whether or not the flag is on.

## How the agent gets it

`grep` in `stdlib/shell.agency` has a `respectGitignore` parameter,
true by default, so a script author can pass `false` to search build
output on purpose. The agent toolkits lock it instead:

```
grep.partial(useAgentCwd: true, respectGitignore: true)
```

Partial application removes a bound parameter from the tool schema and
its description (`AgencyFunction.partial` in
`lib/runtime/agencyFunction.ts`), so the model does not know the
parameter exists and cannot turn the filter off the first time a build
artifact looks relevant. The setting does not travel in the `std::grep`
interrupt data: it changes which files are searched, not what a person
approving the call would want to know.

## Tests

- `lib/stdlib/gitignore.test.ts` covers the rule table: depth, anchoring,
  directories-only, negation, nested files.
- `lib/stdlib/shell.test.ts` (`_grep honours .gitignore`) runs the walk
  over a temp tree with a root and a nested `.gitignore`, and checks that
  `respectGitignore: false` searches everything.
