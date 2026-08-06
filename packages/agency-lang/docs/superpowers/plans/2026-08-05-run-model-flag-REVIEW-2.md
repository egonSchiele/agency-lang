# Re-review: `agency run --model` implementation plan, revision 2

## Recommendation

**One substantive change required.** The revision resolves nearly all findings
from the first review: it uses only supported commands, fixes Commander's argv
mode, removes duplicate test files and provider assertions, tests the final
client configuration, adds the positional-boundary case, and makes the resolver
catalog fixture deterministic.

Task 6 still substitutes a branch-level provider override for the spec's
per-call provider override. Those pass through different merge layers, so the
substitution leaves one documented behavior untested.

## 1. Required: the fourth precedence case must set the provider per call

The spec requires this case:

| baked flag value | Agency call | expected pair |
| --- | --- | --- |
| `p/A` | `llm({ model: "B", provider: "q" })` | provider `q`, model B |

Task 6 instead does this:

```ts
_setLlmOptions({ model: "branch-model", provider: "anthropic" });
return agency.llm("hi");
```

That proves a **branch default** replaces the baked provider. It does not prove
that a **per-call option** replaces a provider from either lower layer. The two
values enter `runPrompt` through different objects:

```ts
const clientConfig = ctx.getSmoltalkConfig({
  ...stackSmolDefaults,
  ...restClientConfig,
});
```

The proposed test would still pass if `restClientConfig.provider` stopped
overriding `stackSmolDefaults.provider`, which is exactly the regression the
fourth spec case is meant to detect.

The plan correctly notes that the TypeScript `agency.llm` facade does not expose
a per-call provider. The answer is not to replace the case with a branch
override; test the generated-code seam directly through the existing exported
`runPrompt` function.

**Correction:** import `runPrompt` from `./prompt.js` and make the fourth case:

```ts
const pair = await effectivePair(
  { model: "baked-model", provider: "openrouter" },
  () =>
    runPrompt({
      prompt: "hi",
      messages: agency.thread.current(),
      clientConfig: {
        model: "call-model",
        provider: "anthropic",
      },
    }),
);
expect(pair).toEqual({
  model: "call-model",
  provider: "anthropic",
});
```

`effectivePair` already invokes the callback inside `agency.withTestContext`, so
`agency.thread.current()` resolves the same active test thread. This reaches
the real per-call `restClientConfig` merge and the existing `RecordingClient`
observes its final result. Do not expand the `agency.llm` TypeScript API merely
for this test.

Update the Task 6 background and self-review language as well: after this
change, the fourth case genuinely tests per-call `{ model, provider }` rather
than only the `setLlmOptions({ model, provider })` escape.

## 2. Medium: Commander wiring tests should not depend on current catalog names

Task 3 correctly removes catalog-snapshot coupling from the resolver unit tests,
but Task 4 reintroduces it by requiring `gpt-4o-mini` and
`claude-opus-4-8` to remain in the real catalog. Its instruction to replace the
names when retired confirms the test has a maintenance failure mode unrelated
to what it owns.

The Commander suite is responsible for:

- option registration;
- turning parser output into `opts.model`;
- the one-argument adapter;
- last-value-wins behavior when the flag repeats.

Catalog membership belongs to the resolver and real-binary integration tests.

**Correction:** mock `_listHostedModels()` for `scripts/agency.test.ts` with two
stable text names and use those bare names in the wiring cases. Keep the
repeated values bare: the second bare resolution is what makes the adapter test
load-bearing. If mocking the stdlib module globally would interfere with other
tests in this large suite, export a narrowly scoped program dependency for the
model parser or use the real adapter's first two returned names dynamically;
do not hard-code monthly catalog entries.

This is not a blocker because the current names make the tests function today,
but deterministic ownership would make the plan internally consistent.

## Resolved from the first review

- Task 7 now drives only `run` and the shorthand; it no longer invents
  `compile --model` support.
- The integration cases inspect output from the actual supported commands and
  test successful execution at the same time.
- Task 4 now passes user argv correctly with `parseAsync(words, { from:
  "user" })`.
- Config, Commander, and runtime tests now extend their existing owning suites
  rather than creating three unnecessary files.
- Task 5 adds only the missing model assertion and leaves the two existing
  provider codegen tests alone.
- Task 6 observes the final `PromptConfig` through the existing
  `RecordingClient` rather than testing `getSmoltalkConfig` in isolation.
- Task 7 proves an invalid bare value fails before compilation.
- Task 7 covers `--model` after the filename and proves it is forwarded rather
  than validated by Agency.
- Resolver default-catalog tests use a stable `_listHostedModels` mock rather
  than current external catalog membership.
- The production design remains a clean declarative resolver and config
  mapping over existing imperative compilation/runtime machinery.

After replacing Task 6's fourth case, the plan covers the promised precedence
semantics and is ready to implement. Finding 2 can be fixed at the same time
with a small test-fixture adjustment.
