# Plan review: relative module ids in `__readStatic` calls

Plan: `docs/superpowers/plans/2026-11-24-relative-static-read-ids.md`

This review checks the plan line by line against the code on main (498d267be). The architecture review in `2026-11-24-relative-static-read-ids-REVIEW.md` covers scope and the checkpoint question, and the plan already includes its correction. This file is named `-plan-review.md` because macOS treats `-review.md` and `-REVIEW.md` as the same file.

The plan is ready to build after the small fixes below. None of them changes the design.

## What I checked and found correct

1. `displayModuleId` is at `lib/backends/typescriptBuilder/sectionAssembler.ts:18`, unexported, with the body the plan quotes.
2. The call site is `lib/backends/typescriptBuilder.ts:1183-1189`. It prints `sourceModuleId` without `displayModuleId`. `typescriptBuilder.ts:172` already imports from `sectionAssembler.js`.
3. I compiled the plan's two test files with the worktree's `dist`. `main.js` printed exactly these two calls, and they were the only absolute paths in either output file:

   ```js
   __stack.locals.tools = [__readStatic(greet, "greet", "/Users/.../.agency-tmp/review-probe/bar.agency")];
   data: `${__readStatic(barStatic, "barStatic", "/Users/.../.agency-tmp/review-probe/bar.agency")} ...`
   ```

   The format matches the strings the new test expects, including the spacing. `bar.js` registered itself as `".agency-tmp/review-probe/bar.agency"`.
4. In the main checkout's build, 30 files match the plan's grep. The only other files in `dist/lib` with a `"/Users/` string are `runsExplorer/identity.js` and `compiler/buildSession.js`, and both hold made-up example paths in comments.
5. `make` will recompile every agent after this change. The build manifest's `compilerStamp` hashes every module the compile pipeline imports (`docs/dev/compiler/incremental-builds.md`), and `typescriptBuilder.ts` is one of them. Task 2 will not see stale output.
6. No generator fixture holds an absolute id. The only `__readStatic` in `tests/typescriptGenerator/` is `static.mjs`, which reads a static from its own module through `lib/ir/prettyPrint.ts:312`. That path already prints the relative module id. `make fixtures` will not change.
7. `topsortCycleErrors.test.ts:219-221` matches the trap message with an unanchored regex, `/tests\/agency\/topsort\/cycles\/runtime-trap\/main\.agency/`. A relative id still matches.
8. `displayModuleId("")` returns `""`, because `path.isAbsolute("")` is false. Review focus item 3 holds.

## Corrections

### 1. The test file has two existing tests

Task 1 Step 2 says "The three existing tests in the file pass." `lib/runtime/staticInit.crossModule.test.ts` has two `describe` blocks with one test each. Change "three" to "two".

### 2. Spell out the new block's setup

Step 1 says to use "the same `compile({}, mainAgency)` call the first block uses". The first block's `beforeAll` does four things, and the new block needs all of them:

```ts
beforeAll(() => {
  fs.mkdirSync(fixturesRoot, { recursive: true });
  fs.writeFileSync(barAgency, /* bar.agency */);
  fs.writeFileSync(mainAgency, /* main.agency */);
  resetCompilationCache();
  compile({}, mainAgency);
});
```

Also add `import { safeDeleteDirectoryWithin } from "@/utils.js";` to the file. The plan names the function but not the import.

Step 1 also says the last assertion is the one that fails today. All three assertions fail today, and vitest stops at the first. The red run will show the first `toContain` failing, with the absolute path in its diff. That is still the right red, so only the sentence needs to change.

### 3. Update `displayModuleId`'s own comment

Step 3 updates the comment at the call site. The comment on `displayModuleId` itself says it exists "for readability in the generated registry-key string literals", and its second paragraph is about register and await keys matching. Once `__readStatic` uses it, that comment is incomplete. Add one sentence saying it also prints the module named in a `__readStatic` call, and that this id is only used in an error message.

### 4. Say "the folder the compiler runs in"

The plan calls the base of the relative path "the compile folder". `displayModuleId` uses `process.cwd()`, the folder the compiler process runs in. That is a different folder from the one passed to `agency compile`. For example, `make` runs `agency compile dist/lib/agents/...` from the package root, so the printed ids start with `dist/lib/agents/`. Use "the folder the compiler runs in" in the table, in the new comment, and in the sentence Step 5 adds to `init-topsort.md`.

The same point affects one claim. The plan says no printed id contains the builder's home folder. That holds when the imported module is inside or near that folder, which is true for `make` and for a Perry build. A program compiled from `/tmp/x` that imports `/Users/me/proj/bar.agency` would print `../../Users/me/proj/bar.agency`. The plan does not need to handle this. The sentence for `init-topsort.md` should describe what the code does, for example "Generated code prints every module path relative to the folder the compiler runs in."

### 5. Add a row for `std::` imports to the table

The table of printed ids leaves out the most common case in user code: reading a value imported from the stdlib. The 30 agent files include these. For example, `dist/lib/agents/agency-agent/lib/policy.js:313` prints:

```js
__readStatic(BUILTIN_POLICIES, "BUILTIN_POLICIES", "/Users/.../stdlib/policy.agency")
```

The fix covers this case already, because it goes through the same call site. Add a row so the builder knows to expect it:

| Imported module | Printed id |
|---|---|
| A `std::` import, such as `std::policy` | `stdlib/policy.agency` inside agency-lang, or `node_modules/agency-lang/stdlib/policy.agency` in a user's project |

## Suggestions

### 6. Make Task 2's check match the goal

The goal is that the build output holds no path from the builder's home folder. Task 2 Step 2 only looks for `__readStatic` calls. A grep for the home folder itself checks the goal directly, and it would fail if some other call site printed an absolute path:

```bash
grep -rl "$HOME" dist/lib stdlib --include=*.js | wc -l
```

Expected: `0`. I ran this against the main checkout's build. It finds the same 30 agent files and nothing else.

### 7. One published file still holds the home folder

The plan's goal says a published agency-lang package will no longer contain the builder's home folder. One file outside the compiled code still does. `docs/site/agent/index.md:83` shows real agent output with `/Users/adityabhargava/.agency-agent/policy.json`. The makefile copies `docs/site/agent` to `stdlib/docs/agent`, and `package.json` publishes `./stdlib/docs/**/*.md`.

That is a hand-written doc, so it is a different fix from this plan. Either narrow the goal sentence to "compiled code", or replace that one path with `~/.agency-agent/policy.json` in the same PR. The owner can pick.
