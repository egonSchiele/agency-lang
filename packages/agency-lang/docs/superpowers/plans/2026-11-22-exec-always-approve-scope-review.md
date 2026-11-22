# Review: the plan for list rules and the `std::exec` scope steps

Plan: `docs/superpowers/plans/2026-11-22-exec-always-approve-scope.md`.
Spec: `docs/superpowers/specs/2026-11-22-exec-always-approve-scope-design.md`.

I reviewed the plan against the spec and against the code on this branch (based on `d24f2037f`). I also ran picomatch 4.0.4, the version installed here, on the argument shapes the plan cares about.

The plan follows the spec closely. The task order works, and the interfaces between the tasks line up. The review focus list at the top is useful. Eight things should change before building. One is a test that contradicts its own implementation. One drops the person's pick when the agent saves its policy file. Two are picomatch behaviours that break promises the spec makes. The other four are files and docs the plan does not name.

## Fix before building

### 1. A Task 1 test contradicts the implementation Task 1 describes

Task 1 says the list branches "use `matchesGlob` on each item directly". It also expects this test to propagate:

```ts
expect(checkPolicy(rule(["**", "build"]), exec(["run", "build"]), DIRS).type).toBe("propagate");
```

With each item tested as a glob, the first item compares `"run"` against the pattern `"**"`. `picomatch.isMatch("run", "**")` returns true, so the rule approves. The test fails against the code the plan describes.

The spec says `**` is special only as the last item. Away from the last place it is an ordinary glob, so it matches any one item. I suggest keeping that rule, because it needs no extra code. Change the test to expect `approve`, and add one that shows `**` in the middle still matches exactly one item:

```ts
// `**` away from the last place is an ordinary glob: one item, any text
expect(checkPolicy(rule(["**", "build"]), exec(["run", "build"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule(["**", "build"]), exec(["a", "b", "build"]), DIRS).type).toBe("propagate");
```

### 2. The agent's policy file would get a different rule from the one the person picked

`stdlib/policy.agency` keeps a list of answers waiting to be saved. Each one is a `PendingAnswer` (line 255), which holds `folder`. When the handler runs under `useRunPolicy` (line 1410, the path the agent takes), `_saveAnswersOnly` is true. `policyToSave` (lines 592–620) then loads the policy file from disk again and replays each answer against it with `answer.folder`.

Task 5 changes `AskUserResult` and `recordAnswer`, but it does not name `PendingAnswer`, the push in `recordAnswer` at line 1202, or `policyToSave`. If those keep passing a folder string, `picks.items` reaches `buildScopedMatch` as `undefined`, and the default parameter turns it into `EXACT_PREFIX`. The person picks `pnpm run …`. The in-memory policy holds `pnpm run …`, but the file gets `pnpm run build`. Nothing fails, and the next session asks again.

Add `PendingAnswer`, its push in `recordAnswer`, and `policyToSave` to Task 5's file list. Add a test in answers-only mode that checks the file on disk holds the wider rule.

### 3. picomatch drops a leading `./` from a pattern, so `./x` and `x` are not compared as written

The spec says list items "are compared as written" and that `./x` and `x` are different arguments. The plan tests one direction: the pattern `x` against the value `./x`, which does propagate. The other direction does not hold:

```
picomatch.isMatch("x", "./x")   // true
```

So an exact rule saved from `git checkout ./main`, which restores a file named `main`, also approves `git checkout main`, which switches branches.

The list branch needs its own handling of a leading `./`. When the pattern starts with `./`, the value must also start with it. Strip it from both, then test the glob. Add the test in both directions:

```ts
expect(checkPolicy(rule([escapeGlob("./x")]), exec(["x"]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule([escapeGlob("./x")]), exec(["./x"]), DIRS).type).toBe("approve");
```

### 4. A pattern longer than 65,536 characters makes picomatch throw

```
picomatch.isMatch(big, big)   // throws: Input length: 70000, exceeds maximum allowed length: 65536
```

If someone picks "this exact command" for a long `python3 -c` script, the saved pattern can pass that length. After that, every `std::exec` question that reaches the rule throws inside `checkPolicy` before it can match or ask. `std::bash` already has this problem, because `@always(command, cwd)` pins the whole line. This plan makes `std::exec` reach it too, and the spec draws attention to long inline scripts.

I suggest one rule for every effect. Give `PolicyRuleSchema` a maximum pattern length equal to picomatch's limit, so a hand-written rule that is too long fails at load with a message. Also make `buildScopedMatch` return `{}` when a pinned value is longer than the limit, which is what it already does for a missing field. Then "always approve when" is not offered for that interrupt, and "approve once" is the answer left. Add one matcher test and one `buildScopedMatch` test.

### 5. The `exec` tool's folder: name the helper, and use one variable

Task 6 says to "use the helper `exec`'s own implementation uses" and adds a fallback in case `_exec` resolves the folder inside TypeScript. It does. `_exec` calls `resolveSpawnCwd` (`lib/stdlib/shell.ts:72`), which calls `resolveDir`, which calls `resolveCwdPath` (`lib/stdlib/resolveDir.ts:10`). `resolveCwdPath` is already exported, expands `~`, and touches no file. Do not call `resolveSpawnCwd` before the question, because it reads the filesystem to check that the folder exists.

Write the step as follows. A small exported TypeScript function returns `resolveCwdPath(host, cwd)`, with an empty `cwd` meaning the run's folder. `exec` assigns the result to its own `cwd` variable before the interrupt and passes that same variable to `_exec`. Then the question and the command read one value. Resolving the folder a second time inside `_exec` gives the same folder, because the path is already absolute.

In the new test for the folder, have the handler record `intr.data.cwd` and reject. Then no process runs, and the folder `sub` does not have to exist.

### 6. Files the plan does not name

- **`tests/agency/safeBash.agency`.** It reads `p.subcommand` at lines 2978 and 3673, and it holds a rule that matches on `subcommand` at line 3013. Task 6 names only `safeBash.test.json`. The grep in Task 6 Step 1 would find these, but the file list should name them.
- **`stdlib/policy.agency`, beyond the lines the plan names.** The Agency `ScopedField` type (line 192) needs `matchPrefix?: boolean`, or an Agency override cannot use the new tag. The `ScopedRuleFields` doc example (lines 210–214) names `subcommand`. The `PolicyRule` doc comment says the prompt sets `matchDotFolders` "on the read rules it saves", which stops being true.
- **`lib/serve/policyStore.ts:51`.** `addRule` refuses any `match` value that is not a string, before it runs the schema. After Task 1, a list rule cannot be added through serve. Delete that check in Task 1. The schema check a few lines below covers it, and the comment there says serve shares one rule shape with `set()` and `load()`.
- **The test for Task 5.** The grep in Task 5 finds nothing. The tests that drive the folder step are agency-js tests: `tests/agency-js/cli-policy-handler-set/` and `tests/agency-js/cli-policy-handler/`. Put the new test beside them, and run it with `pnpm run agency test js <dir>`.

### 7. Docs the plan does not name

- `docs/dev/stdlib/safe-bash.md`, lines 1208, 1250, and 1272–1276, describe `subcommand` and say an interpreter rule should be keyed on it.
- `docs/dev/stdlib/jobs.md:255` says the rule pins `command` and `subcommand` for `std::exec`.
- `docs/dev/agents/approval-policies.md`, "Showing an interrupt from TypeScript" (around lines 550–600), documents `scopes` and `scope` with an example call to `resolvePromptOption`. Task 7 lists the other sections of that file but not this one, and it is the section Perry's author will read.
- The index line for `effect-always-tag.md` in `packages/agency-lang/CLAUDE.md` names only `@always` and `@alwaysUnder`.

### 8. `@always` on a list field would stop matching without any error

The spec says `@always` on a list field keeps its meaning and pins the whole list. Today `buildScopedMatch` writes `escapeGlob(String(list))`, so `["a", "b"]` becomes the string pattern `a\,b`. After Task 1, a string pattern against a list means "every item matches". No item is `a,b`, so the saved rule never matches.

No stdlib effect puts `@always` on a list field today. I checked every tag. A user's effect can, though. In Task 3, make the exact branch of `buildScopedMatch` save a list value as a list of escaped items, the same pattern `prefixPattern` writes for the exact choice. Add one test.

## Smaller points

- **The text beside "always approve when".** Task 3 has `describeScope` print `args starts with run build` and says the text describes the narrowest rule. The narrowest rule pins the arguments exactly, so the text should read `args = run build`. "Starts with" describes the second choice.
- **Two flags allow a combination with no meaning.** `ScopedField` with both `matchSubpaths: true` and `matchPrefix: true` cannot come from the typechecker, but `adoptAlwaysScope` accepts it from a child process. I traced what happens: the folder code reads the list as text, and the list branch then sees a string and saves no rule. Make `isScopedField` refuse both flags set, so the result does not depend on that chain, and add the case to the Task 2 test.
- **Inline object types.** `resolvePromptOption`'s `picks?: { items?: string; folder?: string }` and the return type of `picksWithoutAsking` are inline object types. `anti-patterns.md` asks for named types. `Partial<RulePicks>` covers the first.
- **`portable.ts`** lists the prompt types it exports (lines 158–164). Say that Task 4 adds `PromptStep` and `RulePicks` there, rather than "if listed".
- **The type check for `alwaysPrefixNotList`.** Say that it resolves type aliases, and say what it does for `string[] | null`.
- **The Agency `PolicyRule` type** uses the alias `InterruptDataVal` for match values. Widen the alias, or add a named type for a pattern, rather than writing `string | string[]` inline.
- **Long labels.** Choices 1 and 2 each print the whole command. For a forty-line script, the menu wraps both into dozens of lines below the body, which already shows the full command. Consider cutting the label of a long argument short with `…`.
- **The question's wording.** "Which commands should this cover?" fits `std::exec`, but the tag works for any list. While `std::exec` is the only user, a comment beside the string is enough.
- **The user guide.** Task 7 would edit `docs/site/guide/policies.md` if it is hand-written. The owner's standing rule is that a feature PR does not touch `docs/site/`. Drop that line, and mention in the PR description that the guide page does not describe list rules.
- **The owner's saved policy after the merge.** `missingPolicyRules` already offers built-in rules that a saved policy lacks. After this change, the new `agency` list rules count as missing, so the agent should offer them to the owner. The old `subcommand` rules stay in the file and never match again. Check what that offer shows before rewriting the file by hand.
- **Task 7's title.** The wider choices in Task 7's test are literal rules, so the test checks the matcher and not the prompt. The prompt-to-rule path is covered by Task 4's unit tests and Task 5's agency-js test. Say so in Task 7, or drop "end to end" from its title.
- **A command run in the home directory.** `folderChoices` returns no folders for the home directory, so the saved rule pins `cwd` to the home directory and everything below it, without dot folders. This is no broader than today's `std::exec` rule, which pins no folder. `approval-policies.md` should say it.
