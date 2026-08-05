# `agency run --model` — design

Adds a `--model` flag to `agency run` and to the bare `agency <file>` shorthand,
which sets the default model for that run.

Revision 2. Changes from revision 1 are listed at the end.

## Background

### What you can do today, and what you cannot

`agency agent` already lets you pick a model on the command line. It has four
flags for it — `--model`, `--fastmodel`, `--slowmodel`, and `--provider` —
because the agent runs several kinds of work and wants a different model for
each: ordinary turns use one, deep-reasoning subagents use another.

`agency run` has none of this. If you want your program to use a different
model, your only options are to edit `agency.json`, or to change the Agency
source and recompile. Neither is convenient when you are comparing two models
against the same program, which is the main thing people want this for.

### Model and provider are two separate settings

This is the fact the whole design turns on, so it comes first.

A request to a language model needs two pieces of information: which model, and
which provider to reach it through. In agency these live in two configuration
fields, `client.defaultModel` and `client.defaultProvider`, and they are carried
separately all the way down to the request.

They are also **merged separately**. Every layer that can override a model does
so with a shallow object spread, meaning it replaces only the keys it actually
sets:

- `lib/runtime/state/context.ts:763` — `{ ...this.smoltalkDefaults, ...config }`
- `lib/runtime/prompt.ts:1026` — `{ ...stackSmolDefaults, ...restClientConfig }`

And `setModel(name)` in `stdlib/llm.agency` writes only `{ model: name }`.

Put together: **a provider set by a lower layer survives a higher layer that
changes only the model.** If `agency.json` says the provider is `openrouter` and
Agency code then calls `setModel("claude-opus-4-8")`, the request still goes to
OpenRouter, now asking it for a model named `claude-opus-4-8`.

That is not a bug — it is what "set only what I named" means — but it means this
design cannot treat model-and-provider as a single value that higher layers
replace wholesale. Section "Provider semantics" below defines what the flag does
about it.

### How a model gets chosen today

Three layers, documented at `lib/runtime/prompt.ts:1010`:

```
baked agency.json  <  setModel() / setLlmOptions()  <  llm({ model: ... })
```

Reading from the left:

1. **The baked default.** When agency compiles your program it writes a smoltalk
   client configuration into the generated JavaScript
   (`lib/backends/typescriptBuilder.ts:4413`), including
   `model: cfg.client?.defaultModel || "gpt-4o-mini"`. A provider is written
   **only if one is configured** — the codegen comment says it leaves it unset
   otherwise "so smoltalk's normal model→provider registry lookup still
   applies".
2. **Run-wide defaults from Agency code.** `setModel("claude-opus-4-8")` stores
   a value on the active branch's `llmDefaults`, applying to every later `llm()`
   call in that branch.
3. **Per-call options.** `llm(prompt, { model: "gpt-4o-mini" })` wins over
   everything.

Because the CLI flag feeds layer 1 — the lowest — the requirement that "a model
set explicitly in Agency code still wins" needs no new code for the *model*. The
provider needs the rule in "Provider semantics".

### How a CLI flag becomes configuration

`lib/config.ts:655` documents three configuration sources and where each applies:

1. `agency.json`, found by walking up from the current directory.
2. **CLI flags**, mapped onto configuration by `applyCliFlags`. That comment
   says this is "the ONLY place that defines what each flag means in config
   terms". The result is baked into the generated program at compile time.
3. `AGENCY_CONFIG_OVERRIDES`, a JSON blob in the environment, applied at
   runtime. Its stated job is to reach a process whose configuration was already
   baked and cannot be re-derived from source — precompiled agents and
   `agency pack` bundles.

`--model` belongs in source 2. Source 3 exists for already-compiled programs,
which is not this case.

### Why baking at compile time costs nothing

Baking configuration into generated code raises an obvious worry: if the
compiler caches its output, changing `--model` would either be ignored or force
a full rebuild.

Neither happens. `agency run` passes an import strategy to `compile()`, and
`resolveFreshness` in `lib/compiler/buildSession.ts:104` returns `"always"`
whenever an import strategy is supplied. `agency run` therefore never consults
the build manifest and recompiles every time, with or without this flag. I
confirmed this by measuring: running the same two-file program twice rewrites
the imported module's `.js` both times.

For `agency compile`, which does use the manifest, the cache key is
`deriveConfigKey(config)` — `JSON.stringify` of the whole configuration
(`lib/compiler/buildManifest.ts:131`). A changed model changes the key and
correctly invalidates. Nothing needs adding for either path.

### What names models actually have

Smoltalk's `getAllModels()` returns 68 entries, but **only 56 are text models**.
The rest are 7 image models, 4 embedding models, and 1 speech-to-text model.
Validating a chat model against the unfiltered list would accept `gpt-image-1`,
which then fails at the first call.

Agency already owns the right adapter: `_listHostedModels()` in
`lib/stdlib/llm.ts:104` filters `model.type === "text"` and normalizes the
fields. That is the source this design uses.

Two facts about those 56 text models shape the design, both measured:

- **No text model name contains a slash.** So a slash in the flag value is free
  to mean something.
- **No text model name appears under more than one provider.** The breakdown is
  `openai` 24, `google` 15, `anthropic` 12, `openai-responses` 5. So looking a
  bare name up gives exactly one provider, with no ambiguity.

Beyond the catalog, smoltalk ships clients for `openrouter`, `deepinfra`,
`litellm`, `openai-compat`, `ollama`, `replicate`, and `modal`, none with
catalog entries. And users can register **entirely new providers**:
`client.providerModules` (`lib/config.ts:174`) lists JavaScript files loaded at
startup, each exporting `register({ registerProvider })`. Those names are
created by imperative code at runtime, so the CLI cannot know them when it
parses the flag.

That last point decides the validation rule.

## The flag

```
--model <name>    Model for this run's LLM calls, as `model` or `provider/model`
```

It is added to `addRunOptions`, the helper `run` and the hidden default command
already share, so the shorthand gets it from the same line:

```bash
agency run --model claude-opus-4-8 greet.agency
agency --model claude-opus-4-8 greet.agency
```

Both follow the position rule shipped in #805 and #808: agency's flags go before
the filename, everything after belongs to the program. Writing
`agency run greet.agency --model x` forwards `--model x` to the program and
prints the standard warning. That behaviour is inherited, not added here.

## Reading the value

Split on the **first** slash only. If there is a slash, everything before it is
the provider and everything after it is the model name.

| you write | provider | model name |
| --- | --- | --- |
| `gpt-4o-mini` | none set; smoltalk infers `openai` | `gpt-4o-mini` |
| `anthropic/claude-opus-4-8` | `anthropic` | `claude-opus-4-8` |
| `openrouter/anthropic/claude-sonnet-4` | `openrouter` | `anthropic/claude-sonnet-4` |
| `my-company/my-tune` | `my-company` | `my-tune` |

Splitting on the first slash only is what makes the third row work. OpenRouter's
model identifiers contain a slash natively — `anthropic/claude-sonnet-4` is the
whole model name as far as OpenRouter is concerned — so the prefix form is how
you say which layer you mean.

The fourth row is what custom providers force. There is no list of "real"
provider names to check against, because a provider module can register any name
at startup. A slash means a provider was given, and agency takes the user at
their word.

**The one thing this cannot express** is a bare OpenRouter-style name. Typing
`--model anthropic/claude-sonnet-4` when you meant OpenRouter's model of that
name gives you provider `anthropic`. Writing
`openrouter/anthropic/claude-sonnet-4` says it unambiguously. This is a
deliberate trade: the alternative was a second `--provider` flag, and one flag
that reads left to right beats two flags with a precedence rule between them.

## Provider semantics

The resolved flag distinguishes a provider the user *stated* from one that is
merely *inferred*:

```ts
export type ResolvedModelFlag = {
  model: string;
  /** Set only when the user wrote `provider/model`. */
  explicitProvider?: string;
};
```

Three rules follow.

**A bare model sets the model and clears any inherited provider.**
`applyCliFlags` sets `client.defaultModel` and **deletes**
`client.defaultProvider`. With no provider configured, the codegen emits none,
and smoltalk infers the provider from the model name. This is what "derive the
provider if we can" means in practice.

*Consequence worth knowing.* If your `agency.json` sets
`defaultProvider: "litellm"` to route everything through a proxy, then
`--model gpt-4o-mini` will **not** use that proxy — it clears the provider and
goes to OpenAI directly. To keep the proxy, name it: `--model litellm/gpt-4o-mini`.
This is the intended reading of "just the model name, derive the provider", but
it is a real behaviour change for anyone relying on a configured provider, so it
is called out here rather than left to be discovered.

**`provider/model` sets both fields.** `client.defaultProvider` and
`client.defaultModel` are both written.

**An explicit provider is sticky.** Because layers merge field by field, a
provider set by the flag survives a later `setModel("other")` in Agency code.
The pair becomes `that provider + the new model`. Agency code that wants to
change provider too must say so: `setLlmOptions({ model, provider })`, or a
per-call `llm(prompt, { model, provider })`.

This is the smallest rule consistent with how `setLlmOptions` already behaves —
it changes only the fields the caller supplies. Making a model-only override
clear a lower-layer provider would require changing the runtime merge in
`runPrompt`, which is a larger change than a CLI flag and is not proposed here.

## Validation

Two kinds, and they are different.

**Structural validation applies to every value.** These fail regardless of
provider, because they cannot mean anything:

| value | why it fails |
| --- | --- |
| `` (empty) | no model named |
| `/model` | empty provider |
| `provider/` | empty model |
| `/` | both empty |

**Catalog validation applies only to a bare name.** A bare name is the only case
where agency must derive the provider itself, and the text catalog is the only
thing it can derive from. If the name is not there, agency stops before doing
any work:

```
$ agency run --model gpt-4o-minii greet.agency
error: option '--model <name>' argument 'gpt-4o-minii' is invalid.
  Unknown model "gpt-4o-minii". Did you mean "gpt-4o-mini"?
  For a model from another provider, write provider/model —
  e.g. openrouter/gpt-4o-minii
  Run `agency models list` to see the catalog.
```

**A prefixed name is never checked against the catalog.** Agency sets provider
and model verbatim and lets the LLM call be the judge. A custom provider
registered by a provider module is indistinguishable, at flag-parse time, from a
typo, so guessing would reject legitimate configurations.

The failure this prevents is real: without validation a typo starts the run,
compiles the program, executes everything up to the first `llm()` call, and only
then fails. For an agent that can be minutes of work and real spend.

The cost is that a hosted model released after the catalog snapshot is rejected
when typed bare. **The escape is the prefix form**, `openai/the-new-model`, and
the error names it. Note that `agency models refresh` is *not* an escape: it
prints JSON to stdout and persists nothing (`lib/cli/hostedModels.ts:71`), so it
cannot affect a later CLI process's validation. Making refreshed data visible to
CLI validation would need a persistence location, a load step before flag
parsing, schema versioning, and precedence against the baked catalog — a
separate feature, not this one.

### Suggestions

The "did you mean" line uses Levenshtein edit distance against the text catalog
names, suggesting the closest match when its distance is at most 3 and omitting
the line otherwise. `lib/eval/grading/graders/builtinGraders.ts:106` already
holds a dependency-free implementation; it moves to `lib/levenshtein.ts` and
both callers import it, rather than a second copy being written.

## What this changes and what it does not

**Changes.** `client.defaultModel` always; `client.defaultProvider` set when a
prefix was given, deleted when it was not. That is the whole configuration
footprint.

**Does not change.** `setModel()` and `llm({ model })` keep winning for the
model. No `--fastmodel`, `--slowmodel`, or `--provider` flag is added; those stay
specific to `agency agent`, which needs several model slots because it runs
several kinds of work. `agency run` runs one program.

**A knock-on effect.** Memory extraction resolves its model as `memory.model`
first, falling back to the top-level default
(`lib/runtime/memory/manager.ts:560`). So `--model` also changes the model used
for memory extraction and compaction. Memory has no provider field of its own,
so it reaches the provider through the same client configuration as everything
else — which means a bare `--model` also moves memory extraction onto the
inferred provider, and a prefixed one onto the named provider. This is intended:
the flag sets the run's default model, and memory extraction is part of the run.

## Structure

Three pieces, each with one job.

**`lib/cli/modelFlag.ts`** — parsing and validation, as a pure function:

```ts
export type ResolvedModelFlag = {
  model: string;
  explicitProvider?: string;
};

/** Commander option parser. Throws InvalidArgumentError with a user-facing
 *  message for a structurally invalid value, or a bare name that is not a
 *  known text model. `catalogNames` defaults to the names from
 *  `_listHostedModels()`. */
export function resolveModelFlag(
  value: string,
  catalogNames?: string[],
): ResolvedModelFlag;
```

`catalogNames` is a plain `string[]` because a bare name no longer needs to
produce a provider — it clears the provider and lets smoltalk infer. The
parameter is defaulted so tests supply their own list instead of depending on
which models happen to ship this month.

**`lib/levenshtein.ts`** — the edit-distance function moved out of
`builtinGraders.ts`, unchanged.

**`applyCliFlags` in `lib/config.ts`** — maps `ResolvedModelFlag` onto
`client.defaultModel` and `client.defaultProvider`, per the three rules above.
This keeps the promise the file already makes: one place defines what a flag
means in configuration terms.

### Dataflow

The resolver is wired as Commander's own option parser, the way
`parsePositiveInt` already is for `--max-tool-call-rounds`:

```ts
.option(
  "--model <name>",
  "Model for this run's LLM calls, as `model` or `provider/model`",
  resolveModelFlag,
)
```

So by the time the action runs, `RunOptions.model` is already a
`ResolvedModelFlag`, and `runWithOptions` passes it to `applyCliFlags` through
the path it already uses for every other flag. `CliFlags` gains
`model?: ResolvedModelFlag`.

Nothing new is needed in the action, and both `run` and the shorthand inherit
the flag from `addRunOptions`.

### Errors

Failures are `InvalidArgumentError`s thrown by the parser, so Commander owns the
formatting, the `error:` prefix, and the exit status — the same treatment every
other bad flag value gets today. `applyCliFlags` raises nothing: it stays a pure
mapping, and is called on paths that must not exit.

## Testing

**`lib/cli/modelFlag.test.ts`**

- one case per row of the resolution table
- `openrouter/anthropic/claude-sonnet-4` keeps the second slash in the model name
- a bare known name resolves with no `explicitProvider`
- a bare unknown name throws, and the message names the closest catalog entry
- a bare unknown name with no near match throws without a "did you mean" line
- a prefixed unknown name and unknown provider do **not** throw — the
  custom-provider guarantee, and the case most likely to be broken by a later
  "improvement"
- every structural case fails: ``, `/model`, `provider/`, `/`
- the default catalog excludes non-text models: `gpt-image-1` is rejected as a
  bare name

**`lib/config.test.ts`** (or the existing `applyCliFlags` tests)

- a bare model replaces `defaultModel` and **deletes** an inherited
  `defaultProvider`
- a prefixed model sets both fields
- other `client` fields survive, `providerModules` especially
- the input configuration object is not mutated

**`tests/integration/cli/test.mjs`** — the flag reaching a real run. The suite
makes no LLM calls, so assertions are on the compiled output:

- with an `agency.json` containing a conflicting `defaultProvider`, a bare
  `--model` produces generated JavaScript with the new model and **no** provider
- a prefixed `--model` produces both the model and the provider
- the same through the shorthand, proving both commands share the flag
- an unknown bare name exits non-zero, prints the intended stderr text, shows no
  Node stack trace, and **writes no output file** — that last assertion is what
  proves validation happened before compilation rather than after

**An Agency execution test for precedence** — the guarantee users rely on when
they set a model in source, which nothing else in the suite would notice
breaking. It must observe **both** model and provider, since a test watching
only the model would pass while requests went to the wrong provider. Four cases:

| flag | code | expected pair |
| --- | --- | --- |
| bare `--model A` | `setModel("B")` | provider inferred from B, model B |
| `p/A` | `setModel("B")` | provider `p`, model B (sticky) |
| `p/A` | `llm({ model: "B" })` | provider `p`, model B |
| `p/A` | `llm({ model: "B", provider: "q" })` | provider `q`, model B |

## Out of scope

- `--fastmodel` / `--slowmodel` / `--provider` for `agency run`.
- Local models. `--local` and `--local-model` stay agent-only. A local model
  reached through a provider module works today via the prefix form.
- Persisting `agency models refresh` output so refreshed names pass validation.
- `agency test`, `agency eval`, and `agency serve`.
- The two `agency agent` command-line gaps found while investigating: a
  misplaced `--max-cost` is forwarded to the agent, and root flags such as `-c`
  cannot reach agency at all. Both currently produce a clear error rather than
  failing silently. Noted here only so they are not lost.

## Changes from revision 1

1. **Provider precedence is now specified.** Revision 1 assumed model and
   provider moved together; they merge field by field, so a lower-layer provider
   survives a model-only override. Added `ResolvedModelFlag` with
   `explicitProvider`, the clear-on-bare rule, and the sticky-provider rule.
2. **The resolver's contract is now coherent.** Revision 1 returned a provider
   but took only `string[]`, which cannot supply one. Bare names no longer
   return a provider, so `string[]` is right.
3. **The dataflow is specified**: the resolver is a Commander option parser, so
   `RunOptions.model` is already resolved and reaches `applyCliFlags` unchanged.
4. **`agency models refresh` removed as an escape.** It prints to stdout and
   persists nothing, so it cannot affect later validation. The prefix form is
   the only escape.
5. **Validation source corrected** from `getAllModels()` (68 entries, 12 of them
   not text) to `_listHostedModels()` (56 text models). Revision 1's "68 hosted
   text models" was wrong.
6. **Structural validation added** for empty provider or model components.
7. **Tests strengthened**: `applyCliFlags` cases, provider assertions in the
   integration and precedence tests, and the no-output-file assertion that
   proves validation precedes compilation.
