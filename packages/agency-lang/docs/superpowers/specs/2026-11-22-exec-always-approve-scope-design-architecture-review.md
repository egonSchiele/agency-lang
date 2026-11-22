# Architecture review: "always approve when" asks how much of the command it covers

Date: 2026-11-22. This reviews the spec beside it, `2026-11-22-exec-always-approve-scope-design.md`.

**Verdict:** the goal is right and the design reaches it. One part of the design is unsafe as written and must change: where the list of arguments sits in a saved rule. One part should move to a second pull request: the folder question. With both taken, the first pull request is about two days and changes no shape a front-end uses.

## What the change touches

Three things that people outside this package depend on:

| Surface | Who depends on it | Change in the spec |
| --- | --- | --- |
| The policy file format | every saved `policy.json`, hand-written policies, and every Agency version that reads them | a `match` value may be a list |
| The effect tags | the language: typechecker, codegen, the registry, and the scope sent between processes | a third tag, `@alwaysPrefix` |
| What `promptOptions` returns and `resolvePromptOption` accepts | front-ends written in TypeScript, such as Perry | one list of choices becomes a list of steps |

That is a lot of surface for one effect. Findings 1 and 2 remove two of the three from the first pull request.

## Findings

### 1. A list inside `match` breaks every older Agency that reads the same file. Move it out.

The spec puts the list in `match` and says an older Agency "fails to validate" it, and that this "only happens after a downgrade". Both halves need correcting.

The rule schema is `match: z.record(z.string(), z.string())`. A list there fails validation, and a policy file that fails validation is ignored whole.

It does not take a downgrade. Perry pins its own copy of agency-lang and shares the agent home's `policy.json` with the `agency agent` CLI. Perry's own test says so: "engines over one home share `policy.json`". So the first time the new CLI saves one `std::exec` rule, the older copy inside Perry would stop reading the whole policy. Every prompt would come back there, and its policy store refuses to save new rules until the file is fixed.

There is a precedent for doing this safely. The schema drops rule keys it does not know, which is how `matchDotFolders` was added: an older version ignores the key and the rule matches fewer interrupts, never more.

A list in a new key beside `match` would be dropped the same way. That alone is the unsafe direction: the older version would see only `command` and `cwd`, and approve every command of that program. So the rule should also keep `subcommand` in `match`:

```json
{
  "match": { "command": "pnpm", "subcommand": "run", "cwd": "{/Users/me/proj,/Users/me/proj/**}" },
  "matchArgs": ["run", "agency", "**"],
  "action": "approve"
}
```

- **A new Agency** applies `match` and `matchArgs`, so the rule covers `pnpm run agency …` in that folder.
- **An older Agency** drops `matchArgs` and applies `match`, so the rule covers `pnpm run …` in that folder. That is today's rule with a folder added. It is broader than the person chose and no broader than what they have now.

The spec's claim "a new rule is never broader than today's" then holds on every version. The name `matchArgs` is a placeholder; a key that names the field, such as `matchList: { args: [...] }`, would serve other effects later.

### 2. Build the folder question second

The folder question is the only part that changes the shape front-ends use, and it is a third of the work. Its gain over pinning the launch directory without asking is small: the choice to approve a command in one sub-folder only.

I recommend two pull requests:

1. **First:** the command question, and the folder pinned without asking (the launch directory and below when the command ran inside it, and the command's own folder otherwise). The command choices fit the one list of choices an option already has (`PromptOption.scopes`), so front-ends need no change. This closes the hole the review named.
2. **Second, if still wanted:** the folder question, with the change to steps.

The owner asked for the folder choice, so this is a recommendation about order and not about whether to build it.

### 3. The new tag has one user

`@alwaysPrefix` would be a language feature used by one effect. I looked for others. Three more tagged effects have a list in their payload: `std::git::add` and `std::git::restore` (`paths`), and `std::applyPatch` (`files`). For those, the start of the list is not the meaningful thing to pin, so the tag would not fit them.

It is still the right mechanism. The alternative is a branch in the prompt code for `std::exec`, which is the kind of special case this codebase avoids. The cost should be stated: a third tag to document and to carry through the typechecker, codegen, the registry, and the scope a child process forwards to its parent.

One simplification: the registry's `ScopedField` is `{ field, matchSubpaths }`. Add one optional flag to it. Do not add a second type for list fields.

### 4. "Exactly this" for a long inline script saves a rule that never matches again

`python3 -c '<forty lines>'`, answered with the first choice, saves the whole script in the policy file. It will not be run again with the same text. The policy already has six rules like this for `std::bash`, each pinned to one exact line.

This is harmless and it is the safe default. The spec should say that for a one-off command the right answer is "approve once", and the prompt's detail text for the first choice should make that plain, for example "this exact command".

### 5. Reuse

- The command choices are `PromptScope` values (`id`, `label`, `note`). No new type.
- The check that a pick was one of the choices offered already exists for folders (`folderFor`). Generalize it; do not write a second one.
- `escapeGlob` and `stripControlChars` are the existing functions for the two jobs the spec names.

### 6. What gets tied together

- **`matchDotFolders` and a rule that is not a read.** The doc ties that flag to effects that only read, and the spec would set it on a `std::exec` rule. The reason given holds: the folder is where a program starts. The doc sentence has to change with it, so the next person does not read the flag as "this rule is read-only".
- **The `exec` tool's payload and the folder a rule pins.** Once the tool reports the real folder, a hand-written rule that matched an empty `cwd` stops matching. I found none in the built-in policies. It should be in the changelog.

## The 80/20 question

The cheapest fix for the named hole is the review's own suggestion: a list of interpreters that never get the narrow question. It is an hour of work. It fixes `python3 -c` and nothing else, and the same problem exists for any program whose second word decides what it does: `aws s3 …` approves `aws s3 rm`, and `curl -s …` approves a request to anywhere. A list cannot keep up with that, so the spec's approach is the right one.

A second cheap form is to pin the folder only, which is the part the owner described. It stops a rule from one project applying in another, and it leaves `python3 -c` as it is.

Neither replaces the spec. The first pull request in finding 2 is the 80/20 version of the spec itself.

## Effort and impact

| Part | Days | Needed for the hole | In the first pull request |
| --- | --- | --- | --- |
| The matcher's list form, as a sibling key | 0.5 | yes | yes |
| The tag | 0.5 | yes | yes |
| The command choices and the rule they save | 0.5 | yes | yes |
| The folder pinned without asking, and the `exec` tool's folder | 0.25 | no, but cheap | yes |
| The folder question and the step shape | 1 | no | no |
| Docs and the end-to-end test | 0.25 | | yes |

## Proportion

- **Dev docs:** about a page across two existing docs. In proportion: this changes what an approval means.
- **User docs:** one paragraph in the policy guide for the new rule key.
- **Tests:** unit tests for the matcher and the choices, and one end-to-end test. No effect on CI time.
