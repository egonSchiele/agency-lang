# Re-review: `agency run --model` design, revision 2

## Recommendation

**One change required.** Revision 2 resolves the substantive findings from the
first review: provider precedence is now accurate, bare and prefixed values have
clear semantics, the resolver result reaches `applyCliFlags` through one typed
path, validation uses text models, refresh is no longer presented as persistent,
and the tests observe configuration effects rather than only parsing.

The remaining issue is in the proposed Commander parser signature. As written,
repeating `--model` can pass a resolved object where the resolver expects a
catalog array.

## 1. Required: do not pass the injectable resolver directly to Commander

The spec proposes this testable signature:

```ts
resolveModelFlag(value: string, catalogNames?: string[]): ResolvedModelFlag
```

and then installs it directly as Commander's option parser:

```ts
.option("--model <name>", description, resolveModelFlag)
```

Commander calls an option parser with `(value, previous)`. On the second
occurrence in a command such as:

```bash
agency run --model gpt-4o-mini --model claude-opus-4-8 greet.agency
```

the second argument is the first `ResolvedModelFlag`, not `string[]`. The
resolver will therefore treat a resolved object as its catalog. Depending on
its implementation, that either throws an unrelated runtime error or validates
against nonsense rather than preserving Commander's normal last-value-wins
behavior.

Keep the pure injectable resolver, but prevent Commander's accumulator argument
from entering that interface:

```ts
.option(
  "--model <name>",
  "Model for this run's LLM calls, as `model` or `provider/model`",
  (value: string) => resolveModelFlag(value),
)
```

Alternatively, make the catalog an explicit first-class dependency through a
factory:

```ts
export function modelFlagParser(catalogNames: string[] = hostedTextModelNames()) {
  return (value: string): ResolvedModelFlag =>
    resolveModelFlag(value, catalogNames);
}
```

The one-line adapter is the smaller choice unless production code needs to
construct parsers against different catalogs.

Add a CLI parser test with `--model` repeated and assert that the last value
wins. This test is important because direct unit tests of `resolveModelFlag`
cannot expose the mismatch between its second parameter and Commander's parser
contract.

## 2. Minor: put the shared data type at the configuration boundary

The spec declares `ResolvedModelFlag` in `lib/cli/modelFlag.ts`, then requires
`lib/config.ts` to import that CLI-owned type for `CliFlags`. This points the
general configuration module back toward a CLI implementation module. It also
creates a potential runtime cycle if the import is not type-only:

```text
config.ts -> cli/modelFlag.ts -> stdlib/llm.ts -> runtime modules
```

The declarative value is part of the `CliFlags` contract, so the cleaner
ownership is to declare it beside `CliFlags` in `lib/config.ts` and have
`modelFlag.ts` import it with `import type`. Then dependencies point from the
CLI adapter toward the configuration contract, and `config.ts` remains unaware
of catalog lookup and Commander.

If the type remains in `modelFlag.ts`, the plan should at minimum require
`config.ts` to use an explicit `import type` so no runtime dependency or cycle
is introduced.

## Resolved from the first review

- A bare model clears an inherited provider; a prefixed provider is explicitly
  documented as sticky under later model-only overrides.
- The resolver's `string[]` input is now consistent with its output because a
  bare value no longer claims to derive a provider.
- `RunOptions.model`, `CliFlags.model`, and `applyCliFlags` form one declarative
  path rather than a second imperative configuration merge.
- Unknown prefixed values are allowed for custom providers while empty
  provider/model components are rejected structurally.
- Validation uses `_listHostedModels()` and therefore excludes image,
  embedding, and speech models.
- The stale-catalog escape is accurately documented as `provider/model`; the
  existing non-persistent refresh command is not misrepresented.
- Tests cover immutable config mapping, preservation of neighboring client
  fields, command and shorthand wiring, failure before compilation, and both
  model and provider precedence.

With finding 1 corrected, the design is ready to turn into an implementation
plan.
