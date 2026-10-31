# `std::grep`: flags and the named search parameters

`std::grep` does not run the `grep` program. It walks the directory itself
and tests each line against a JavaScript `RegExp`. That keeps the path
containment rules (`allowedPaths`, the refusal to follow a symlinked root,
the skip list for `node_modules` and friends) in our code, and it behaves the
same on every platform. The cost is that a model calling the tool thinks in
`grep` flags, and JavaScript regexes know only a handful of letters.

A `flags` string handed straight to the `RegExp` constructor fails on
`"n"` with a message about the constructor, which tells the model nothing
about what to send instead.

## How a call becomes a search

`lib/stdlib/grepQuery.ts` owns the translation. `compileGrepQuery` takes the
raw `flags` string plus the named parameters and returns a `GrepPlan`: one
compiled regex and two output switches. A rule table decides what each
letter means:

| Letters | Rule | What happens |
|---|---|---|
| `i m s u` | `regexFlag` | passed to the `RegExp` |
| `n r R g E P` | `alreadyOn` | accepted and dropped; the tool already searches recursively and returns line numbers |
| `w l v` | `useParameter` | rejected, naming `wholeWord`, `filesOnly`, or `invert` |
| anything else | | rejected, listing the accepted letters |

The rejection text is the tool's failure result, so the model's next call
is informed rather than a guess.

The named parameters on `grep` in `stdlib/shell.agency`:

- `ignoreCase` adds `i`.
- `wholeWord` wraps the pattern as `\b(?:pattern)\b`.
- `filesOnly` returns one path per file with a match instead of lines.
- `invert` returns the lines that do not match.

All four ride in the `std::grep` interrupt data, next to `flags`, so a
policy or a person approving the call sees the whole request. Translation
happens after the interrupt, in `_grep`, so what a policy matches on is
always what the caller sent.

## The path: a directory or one file

`grep` takes `path`, which may be a directory or a single file. `dir` is a
[parameter alias](../language/parameter-aliases.md), so a model that says
`dir` is forgiven. An alias is forgiven only for a model's tool call and a
served call, so Agency source that names the argument writes `path:`.

`_searchTarget` in `lib/stdlib/shell.ts` is the one place that decides
what a path is. `ls`, `grep`, and `glob` call it before their interrupt,
so a bad path fails before anyone is asked to approve a search of it:

| The path is | `grep` | `ls` and `glob` |
|---|---|---|
| a directory | search it | list or glob it |
| a file | search that file alone | a failure that says to call `read` (ls) or pass the parent directory (glob) |
| missing | a failure naming the path and suggesting `ls` on its parent | the same |

Every failure message is written for the model that reads it as a tool
result: it names the real path and says what to do instead.

Running the check before the interrupt means the model learns whether a
path is a file, a directory, or missing before any policy, person, or
`allowedPaths` sees the call. `ls("~/.ssh/id_rsa")` answers "is a file"
under a policy that would reject the listing. This is deliberate: `read`
already reveals whether a directory exists before its interrupt
(`locateSync` in `lib/host/node/nodeFiles.ts`), and the check is what
turns a confusing failure into a message the model can act on. What it
reveals is the kind of a path and nothing of its contents.

For a file, the interrupt payload keeps `dir` as the file's parent
directory and adds `file`, its name. A policy rule on `dir` then matches a
file search the same way it matches a search of the directory the file is
in. For a directory search, `file` is `null`, and a rule that names `file`
does not match it: `matchesRule` in `lib/runtime/policy.ts` treats a null
field like a missing one. `_grep` reads the file named outright whatever
`.gitignore` says, the way `grep` searches a file named on its command
line.

## `.gitignore`

`grep` skips what the `.gitignore` files under (and above, up to the
repository root) the search directory ignore, so compiled output does not
crowd out source. The matcher is `lib/stdlib/gitignore.ts`: comments,
negation, directory-only rules, anchoring, nested files refining their
parents; not `.git/info/exclude` or the global excludes. The
`respectGitignore` parameter is true by default, and the agent toolkits
lock it with partial application so the model cannot turn it off.

## A bash grep through safeBash

safeBash runs a lone bash `grep` through this tool's search instead of
the grep program, when its flags and pattern translate exactly.
`lib/stdlib/grepDialect.ts` holds that translation and grep's output
format. A grep pattern goes into `pattern` only when every character
means the same thing to grep and to a JavaScript regex, so the rule
table above is not involved. See `docs/dev/stdlib/safe-bash.md`, "grep".

## Tests

- `lib/stdlib/grepQuery.test.ts` covers the rule table and messages.
- `tests/agency/stdlib/grep-flags.agency` runs the tool end to end over the
  shared `grep-fixtures` directory: a grep-style flag succeeds, a flag with a
  parameter fails with the parameter's name, and each parameter changes the
  output.
- `tests/agency/stdlib/search-paths.agency` covers the path table above for
  all three tools, the `file` field in the interrupt payload, and a model
  calling `grep` with `dir`. The `_searchTarget` and single-file `_grep`
  cases in `lib/stdlib/shell.test.ts` cover the messages.
- `lib/stdlib/gitignore.test.ts` and the `_grep honours .gitignore` cases
  in `lib/stdlib/shell.test.ts` cover the ignore rules and the walk.
