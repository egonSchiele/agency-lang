# Review: `agency run --model` implementation plan

## Recommendation

**Changes requested.** The production architecture is good: a pure resolver
produces a declarative `ResolvedModelFlag`, `applyCliFlags` remains the single
configuration mapping boundary, and existing compilation/runtime machinery does
the imperative work. The plan does not scatter model/provider precedence logic
through the CLI.

The test plan is not ready, however. Task 7 invokes the flag on a command that
does not receive it, Task 6 tests only one shallow spread rather than the
documented precedence path, and Task 4 constructs Commander's argv incorrectly.
Several proposed test files and codegen cases also duplicate existing suites.

## 1. Blocker: Task 7 uses `agency compile --model`, but the plan adds the flag only to `run`

Task 4 adds `--model` through `addRunOptions`, which is shared by `run` and the
hidden shorthand command. The standalone `compile` command has its own option
list and its action forwards only its existing flags to `applyCliFlags`.

These Task 7 commands will therefore fail with “unknown option”:

```bash
agency compile --model claude-opus-4-8 greet.agency
agency compile --model openrouter/anthropic/claude-sonnet-4 greet.agency
```

Adding the flag to `compile` would expand the feature beyond the goal and the
spec. Do not do that merely to make the tests pass.

**Correction:** exercise the two supported surfaces and inspect the files they
compile:

1. Run `agency run --model claude-opus-4-8 greet.agency`, then read `greet.js`
   and assert the new model is present and no literal provider is emitted.
2. Run the shorthand with the prefixed value,
   `agency --model openrouter/anthropic/claude-sonnet-4 greet.agency`, then read
   `greet.js` and assert both model and provider.

These two calls replace the two unsupported compile calls and the two later
execution-only calls. They prove supported command wiring, successful
execution, and generated configuration without adding four redundant runs.

## 2. Blocker: Task 6 does not test the precedence behavior promised by the spec

Task 6 calls `RuntimeContext.getSmoltalkConfig()` directly. That proves only
this existing spread:

```ts
{ ...this.smoltalkDefaults, ...config }
```

It does **not** exercise:

- branch defaults written by `setModel` / `_setLlmOptions`;
- the `stackSmolDefaults` plus per-call merge in `runPrompt`;
- per-call model/provider precedence;
- the final configuration delivered to an LLM client.

The plan's self-review acknowledges this reduction but gives the wrong reason.
`RecordingClient` in `lib/runtime/agencyLlm.test.ts` already records every final
`PromptConfig`, including both `model` and `provider`. That suite already uses
the client to verify provider flow. There is no need to settle for testing an
internal spread.

**Correction:** replace Task 6 with final-client precedence tests in the
existing `lib/runtime/agencyLlm.test.ts`. Let `makeCtx` accept baked smoltalk
defaults, install `RecordingClient`, apply branch defaults through
`_setLlmOptions`, make the prompt call, and assert the recorded pair. Cover all
four rules from the spec:

| baked defaults | branch defaults | per-call options | final result |
| --- | --- | --- | --- |
| `{ model: A }` | `{ model: B }` | none | model B, no provider |
| `{ model: A, provider: p }` | `{ model: B }` | none | model B, provider p |
| `{ model: A, provider: p }` | none | `{ model: B }` | model B, provider p |
| `{ model: A, provider: p }` | none | `{ model: B, provider: q }` | model B, provider q |

Use the runtime prompt path that accepts provider-shaped per-call config. The TS
`agency.llm` convenience facade does not expose every generated Agency option,
but `runPrompt` does and is the merge being specified.

This change also removes the proposed `lib/runtime/modelPrecedence.test.ts`.

## 3. High: Task 4 gives Commander the wrong argv shape

The helper proposes:

```ts
program.parse(["node", "agency", ...words], { from: "user" });
```

These are two different parsing modes mixed together. With `from: "user"`,
Commander treats **every** array element as a user argument; it does not remove
the executable and script entries. Existing tests correctly use either:

```ts
program.parseAsync(["run", ...], { from: "user" });
```

or a full `['node', 'agency', ...]` array with the default Node argv mode.
The proposed form may send `node` through the hidden default command instead of
testing `run` at all.

**Correction:** make `runOptionsFor` async and use:

```ts
await program.parseAsync(words, { from: "user" });
```

Update callers to await it, and use `await expect(...).rejects` for invalid
model parsing. Keep the repeated-flag case; it correctly proves that the
one-argument adapter is load-bearing.

## 4. High: Task 5 claims to test `applyCliFlags`, but bypasses it and duplicates existing tests

The codegen helper takes a ready-made `AgencyConfig` and passes it directly to
`TypeScriptBuilder`. It never invokes `applyCliFlags`, so Task 5 does not
“consume the `applyCliFlags` mapping” or prove the flag reaches generated code.
Task 2 tests mapping, and the corrected Task 7 should test the cross-boundary
path.

Two of Task 5's three cases already exist in
`smoltalkDefaults.codegen.test.ts`:

- `omits provider when defaultProvider is unset`
- `bakes provider when defaultProvider is set`

The proposed `not.toContain("provider:")` is also less precise than the
existing anchored regex because generated output contains unrelated provider
tokens.

**Correction:** add only the missing assertion that `client.defaultModel` is
baked. Leave the existing provider cases unchanged and correct Task 5's stated
interface: it pins existing codegen behavior; it does not test CLI mapping.

## 5. Medium: put tests in the existing behavior-owning suites

The plan creates several narrowly named test files beside suites that already
own the exact behavior and helpers:

- Append the `applyCliFlags` cases to `lib/config.test.ts`, in its existing
  `describe("applyCliFlags")` block. Do not create
  `lib/config.modelFlag.test.ts`.
- Append the Commander wiring cases to `scripts/agency.test.ts`, which already
  owns `createProgram` and CLI parsing. Do not create
  `scripts/agency.modelFlag.test.ts`.
- Put final-client precedence cases in `lib/runtime/agencyLlm.test.ts`. Do not
  create `lib/runtime/modelPrecedence.test.ts`.

The new `lib/cli/modelFlag.test.ts` is justified because `modelFlag.ts` is a new
pure module. A test beside the newly shared `levenshtein.ts` is also reasonable.

While moving the config cases, remove the unnecessary casts in the proposed
fixtures:

```ts
return { client: { ... } } as unknown as AgencyConfig;
applyCliFlags({} as AgencyConfig, ...);
```

Those objects already satisfy `AgencyConfig`. Casting through `unknown` can
hide a bad fixture instead of asking TypeScript to verify it.

## 6. Medium: add the new flag's positional-boundary regression test

The design explicitly promises that a `--model` appearing after the filename
belongs to the Agency program and is not parsed or validated by the CLI:

```bash
agency run greet.agency --model gpt-4o-mini
```

Task 4 bypasses `runCli` and its `splitCommandLine` preprocessing. Task 7 uses
`--model` only before the filename. Existing generic tests use `--max-cost`, but
they do not prove that the newly registered option is included in the derived
run-option metadata.

**Correction:** add one real-binary case to Task 7 with `--model` after the
filename. Assert that:

- output contains `Warning: --model went to your program`;
- the program's argument parser receives and rejects the unknown flag;
- Agency does not emit an “Unknown model” validation error.

One explicit `run` case is enough because existing boundary tests already pin
generic shorthand parity.

## 7. Medium: make the default-catalog resolver test deterministic

Task 3 says injected catalogs keep unit tests independent of whichever models
ship this month, then adds two tests tied to the current smoltalk snapshot:
`gpt-image-1` must exist as non-text and `gpt-4o-mini` must exist as text.
Filtering itself belongs to `_listHostedModels` and is already tested with a
mock catalog in `lib/stdlib/llm.test.ts`; `modelFlag.ts` consumes its normalized
result.

**Correction:** mock `_listHostedModels()` in the resolver suite with stable
hosted text names and use that to prove the resolver's default path calls the
adapter. Keep one separate, name-agnostic catalog integration test only if the
existing hosted-catalog integration test does not already cover the wiring. Do
not make this feature's unit tests depend on external catalog membership.

## Anti-pattern assessment

The planned **production code** avoids the important anti-patterns:

- `ResolvedModelFlag` and `resolveModelFlag` form a small declarative interface
  over slash parsing, catalog validation, and error construction.
- `applyCliFlags` remains the sole declarative flag-to-config mapping instead of
  creating a second imperative merge path in `runWithOptions`.
- The existing Levenshtein implementation is moved and reused rather than
  copied.
- The type lives at the configuration boundary, avoiding a config-to-CLI
  dependency and runtime cycle.

The **test plan** does contain unnecessary duplication and leaky seam tests:
Task 5 repeats existing provider assertions, Task 6 tests an internal spread
instead of the user-visible final client configuration, and three new test
files split behavior away from existing owning suites. The corrections above
remove those problems without changing the production design.

## Smallest corrected task structure

1. Share Levenshtein and retain its focused tests.
2. Add the declarative config type/mapping; extend `config.test.ts`.
3. Add the pure resolver and its focused, deterministic tests.
4. Wire the one-argument Commander adapter; extend `agency.test.ts` with the
   correct argv mode and repeated-value case.
5. Add only the missing default-model codegen assertion.
6. Extend `agencyLlm.test.ts` with the four final-client precedence cases.
7. Test supported `run` and shorthand surfaces end to end, inspect generated
   output, verify failure-before-compilation, and verify the post-filename
   boundary.
8. Add the developer documentation.

After these changes, the plan will test the behavior it claims while keeping
the declarative production boundary intact and avoiding unnecessary files and
duplicate assertions.
