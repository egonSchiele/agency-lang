# Review: `agency run --model` design

## Recommendation

**Changes requested.** The flag and the `provider/model` spelling are useful,
and the proposed pure resolver is the right general boundary. The spec is not
implementation-ready yet, however. It needs explicit provider-precedence
semantics, a typed path from the resolver into `applyCliFlags`, and a correction
to the claim that `agency models refresh` updates the catalog used by later CLI
runs.

## 1. Blocker: model precedence does not imply provider precedence

The spec treats `{ model, provider }` as one selection and concludes that
`setModel()` and per-call `model` options automatically win over the CLI flag.
The runtime does not merge them atomically; it merges fields independently:

- `setModel(name)` writes only `{ model: name }`.
- `_setLlmOptions` preserves every key the caller omits.
- `runPrompt` shallow-spreads branch defaults and per-call options over the
  baked smoltalk defaults.
- `getSmoltalkConfig` is another shallow spread.

Therefore a lower-precedence provider survives a higher-precedence model-only
override. Two cases need a defined result:

1. `agency.json` says `defaultProvider: "openrouter"`, then the user runs
   `--model gpt-4o-mini`. If the flag changes only `defaultModel`, the request
   still goes through OpenRouter rather than allowing smoltalk to infer OpenAI.
2. The user runs `--model openrouter/foo`, then Agency code calls
   `setModel("claude-opus-4-8")`. The effective pair is still
   `openrouter + claude-opus-4-8`; the model does not independently select the
   Anthropic provider.

Revise the spec to distinguish an inferred provider from an explicit one:

```ts
export type ResolvedModelFlag = {
  model: string;
  explicitProvider?: string;
};
```

Recommended semantics:

- A bare model sets `client.defaultModel` and **removes an inherited
  `client.defaultProvider`**, allowing smoltalk to infer the provider.
- `provider/model` sets both fields.
- An explicit CLI provider remains sticky under a later model-only override.
  Agency code that wants to switch providers must use
  `setLlmOptions({ model, provider })`, and a per-call override must likewise
  pass both fields.

That is the smallest change consistent with the existing rule that
`setLlmOptions` changes only fields the caller supplies. If the desired rule is
instead that every higher-precedence model-only value clears a lower provider,
the feature also requires a runtime merge change in `runPrompt`; it is not a
compile-time CLI-only change.

The precedence test must record and assert both the model and provider. A test
that observes only the model will pass while requests are routed through the
wrong provider.

## 2. Blocker: the resolver interface cannot produce its declared result

The proposed function accepts only model names:

```ts
resolveModelFlag(value: string, catalogNames?: string[]): ResolvedModel
```

but `ResolvedModel` may contain a provider, and the resolution table says a bare
model derives that provider from the catalog. A `string[]` contains no provider
information, so this contract cannot implement the table.

More importantly, the dataflow into configuration is unspecified and currently
contradictory:

- `CliFlags` is said to gain `model?: string`.
- `resolveModelFlag` returns an object.
- resolution happens in the CLI action.
- `applyCliFlags` is said to map the resolved value.
- today `runWithOptions` passes Commander's raw `RunOptions` directly to
  `applyCliFlags`.

Choose one complete typed flow. A clean option is to use Commander's option
parser:

```ts
export type CliFlags = {
  // existing fields
  model?: ResolvedModelFlag;
};

cmd.option(
  "--model <model>",
  "...",
  resolveModelFlag,
);
```

Then both `run` and the shorthand naturally pass the resolved value through the
shared `runWithOptions` path to `applyCliFlags`. Resolver failures should become
`InvalidArgumentError`s so Commander owns formatting and exit status.

With the recommended provider semantics above, the resolver only needs to
validate a bare name and can return no provider for it. If the design still
wants to return the catalog-derived provider, replace `catalogNames` with
entries such as `{ name, provider }[]`.

## 3. Blocker: `agency models refresh` is not an escape for a new bare model

The spec says users can refresh the catalog and then use a newly released model
as a bare name. That is not how the current command works:

- `modelsRefresh` fetches data and prints JSON to stdout.
- It does not register or persist the result.
- A saved file is loaded only when explicitly supplied to `agency models list`,
  and only for that process.
- `std::llm.loadModelData()` runs inside an Agency program, after this CLI
  validation would already have rejected the flag.

Use the small-scope behavior: remove refresh as an escape and say that a model
missing from the baked catalog must be written as `provider/model`.

If refreshed bare names are a requirement, this becomes a larger feature. The
spec must define where refresh persists model data, how every later CLI process
loads it before parsing `--model`, schema/version handling, precedence over the
baked catalog, and a cross-process test.

## 4. High: validate only text models and validate prefix structure

The default catalog must not be raw `getAllModels()`. Smoltalk's union also
contains non-text models. Agency already owns the correct hosted-text adapter in
`lib/stdlib/llm.ts`: `_listHostedModels()` filters `model.type === "text"` and
normalizes the fields. Reuse that source rather than duplicating its filtering
and naming rules in `modelFlag.ts`.

Also distinguish structural validation from catalog validation. Unknown
prefixed values should be accepted for custom providers, but malformed values
should still fail before compilation:

- `/model` — empty provider
- `provider/` — empty model
- `/` — both empty

“A prefixed name is never validated” should mean its provider and model are not
checked against the catalog, not that empty components are valid.

## 5. High: strengthen the tests around configuration effects

The proposed integration assertion that generated JavaScript contains a model
string does not prove provider behavior, preservation of neighboring config, or
failure before compilation.

Add focused `applyCliFlags` tests:

- A bare model replaces the old model and removes an inherited
  `defaultProvider`.
- A prefixed model replaces both model and provider.
- Other `client` fields, especially `providerModules`, survive.
- The input configuration is not mutated.

Add resolver tests:

- A bare known model resolves without an explicit provider.
- Prefix parsing preserves everything after the first slash.
- Unknown custom providers are accepted.
- Empty provider/model components fail.
- The default validation source excludes non-text models.

Strengthen CLI integration coverage:

- Start with an `agency.json` containing a conflicting `defaultProvider`, then
  prove a bare model clears it.
- For a prefixed model, assert both generated model and provider.
- Exercise both `run` and the shorthand.
- For an unknown bare model, assert non-zero status, the intended stderr text,
  no Node stack trace, and no generated output file. The last assertion proves
  validation happened before compilation.

Finally, make the runtime precedence fixture observe `{ model, provider }` for:

- bare CLI model plus `setModel`
- prefixed CLI model plus `setModel`
- per-call model only
- per-call `{ model, provider }`

## 6. Clarify the memory statement

The statement that the flag changes memory extraction is correct for the model:
`memory.model` falls back to the top-level smoltalk default. Provider behavior
must follow the decision in finding 1, however. Update this section after that
decision so it does not imply that changing a model necessarily changes or
re-derives the provider.

## What is already strong

- One shared `addRunOptions` declaration correctly gives the flag to `run` and
  the shorthand without duplicate command wiring.
- First-slash splitting correctly preserves OpenRouter model identifiers.
- Accepting unknown, structurally valid prefixed values is necessary for custom
  provider modules.
- Moving the existing Levenshtein implementation avoids duplicating it.
- Keeping configuration mapping in `applyCliFlags` is the correct declarative
  boundary, once the resolved flag type and provider semantics are explicit.
