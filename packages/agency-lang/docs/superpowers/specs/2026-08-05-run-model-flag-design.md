# `agency run --model` — design

Adds a `--model` flag to `agency run` and to the bare `agency <file>` shorthand,
which sets the default model for that run.

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

### How a model gets chosen today

There are three places a model can come from, and they layer. The layering is
documented in `lib/runtime/prompt.ts:1010` and is worth stating exactly, because
the whole design depends on it:

```
baked agency.json  <  setModel() / setLlmOptions()  <  llm({ model: ... })
```

Reading that from the left:

1. **The baked default.** When agency compiles your program it writes a smoltalk
   client configuration straight into the generated JavaScript
   (`lib/backends/typescriptBuilder.ts:4413`), including
   `model: cfg.client?.defaultModel || "gpt-4o-mini"`. This is the fallback that
   applies when nothing else says otherwise.
2. **Run-wide defaults set from Agency code.** `setModel("claude-opus-4-8")`
   from `std::llm` stores a value on the active branch's `llmDefaults`, which
   applies to every later `llm()` call in that branch.
3. **Per-call options.** `llm(prompt, { model: "gpt-4o-mini" })` wins over
   everything.

Because the CLI flag will feed layer 1 — the lowest one — the requirement that
"a model set explicitly in Agency code still wins" needs no new code. It already
holds.

### How a CLI flag becomes configuration

`lib/config.ts:655` documents three configuration sources and where each is
applied:

1. `agency.json`, found by walking up from the current directory.
2. **CLI flags**, mapped onto the configuration by `applyCliFlags`. That comment
   says this is "the ONLY place that defines what each flag means in config
   terms". The result is baked into the generated program at compile time.
3. `AGENCY_CONFIG_OVERRIDES`, a JSON blob in the environment, applied at runtime.
   Its stated job is to push configuration into a process whose configuration
   was already baked and cannot be re-derived from source — precompiled agents
   and `agency pack` bundles.

`--model` belongs in source 2. Source 3 exists for programs that have already
been compiled, which is not the case here.

### Why baking at compile time costs nothing

Baking configuration into generated code raises an obvious worry: if the
compiler caches its output, changing `--model` would either be ignored or force
a full rebuild.

Neither happens. `agency run` passes an import strategy to `compile()`, and
`resolveFreshness` in `lib/compiler/buildSession.ts:104` returns `"always"`
whenever an import strategy is supplied. That means `agency run` never consults
the build manifest and recompiles every time, with or without this flag. I
confirmed this by measuring: running the same two-file program twice rewrites
the imported module's `.js` both times.

For `agency compile`, which does use the manifest, the cache key is
`deriveConfigKey(config)` — `JSON.stringify` of the whole configuration
(`lib/compiler/buildManifest.ts:131`). A changed model therefore changes the key
and correctly invalidates. Nothing needs adding for either path.

### What names models actually have

The built-in catalog, reachable through smoltalk's `getAllModels()`, holds 68
hosted text models across four providers: `openai` (28), `google` (23),
`anthropic` (12), and `openai-responses` (5). Two facts about it shape the
design, both measured rather than assumed:

- **No catalog model name contains a slash.** So a slash in the flag value is
  free to mean something.
- **No model name appears under more than one provider.** So looking a bare name
  up in the catalog gives exactly one provider, with no ambiguity to resolve.

Beyond the catalog, smoltalk ships clients for `openrouter`, `deepinfra`,
`litellm`, `openai-compat`, `ollama`, `replicate`, and `modal`, none of which
have catalog entries. And users can register **entirely new providers** of their
own: `client.providerModules` lists JavaScript files loaded at startup, each
exporting `register({ registerProvider })` (`lib/config.ts:174`). Those names are
created by imperative code at runtime, so the CLI cannot know them when it parses
the flag.

That last point decides the validation rule below.

## The flag

```
--model <name>    Model for this run's LLM calls, as `model` or `provider/model`
```

It is added to `addRunOptions`, the helper that `run` and the hidden default
command already share, so the shorthand gets it from the same line:

```bash
agency run --model claude-opus-4-8 greet.agency
agency --model claude-opus-4-8 greet.agency
```

Both forms follow the position rule shipped in #805 and #808: agency's flags go
before the filename, and everything after the filename belongs to the program.
Writing `agency run greet.agency --model x` sends `--model x` to the program and
prints the standard warning. That behaviour is inherited, not added here.

## Reading the value

Split on the **first** slash only. If there is a slash, everything before it is
the provider and everything after it is the model name.

| you write | provider | model name |
| --- | --- | --- |
| `gpt-4o-mini` | looked up in the catalog → `openai` | `gpt-4o-mini` |
| `anthropic/claude-opus-4-8` | `anthropic` | `claude-opus-4-8` |
| `openrouter/anthropic/claude-sonnet-4` | `openrouter` | `anthropic/claude-sonnet-4` |
| `my-company/my-tune` | `my-company` | `my-tune` |

Splitting on the first slash only is what makes the third row work. OpenRouter's
model identifiers contain a slash natively — `anthropic/claude-sonnet-4` is the
whole model name as far as OpenRouter is concerned — so the prefix form is how
you say which layer you mean.

The fourth row is the case that custom providers force. There is no list of
"real" provider names to check against, because a provider module can register
any name it likes at startup. So a slash means a provider was given, and agency
takes the user at their word.

**The one thing this cannot express** is a bare OpenRouter-style name. Typing
`--model anthropic/claude-sonnet-4` when you meant OpenRouter's model of that
name gives you provider `anthropic` instead. Writing
`openrouter/anthropic/claude-sonnet-4` says it unambiguously. This is a
deliberate trade: the alternative was a second `--provider` flag, and one flag
that reads left to right beats two flags with a precedence rule.

## Validation

**A bare name — no slash — must be in the catalog.** A bare name is the only
case where agency has to derive the provider itself, and the catalog is the only
thing it can derive it from. If the name is not there, agency cannot proceed
sensibly, so it stops before doing any work:

```
$ agency run --model gpt-4o-minii greet.agency
Error: unknown model "gpt-4o-minii".
  Did you mean "gpt-4o-mini"?
  For a model from another provider, write provider/model —
  e.g. openrouter/gpt-4o-minii
  Run `agency models list` to see the catalog.
```

**A prefixed name is never validated.** Agency sets the provider and model
verbatim and lets the LLM call be the judge. A custom provider registered by a
provider module is indistinguishable, at flag-parse time, from a typo — so
guessing would reject legitimate configurations.

The failure this prevents is a real one: without validation, a typo starts the
run, compiles the program, executes everything up to the first `llm()` call, and
only then fails. For an agent that can be minutes of work and real spend.

The cost is that a hosted model released after the catalog snapshot is rejected
when typed bare. There are two escapes and the error names both: write
`openai/the-new-model`, or refresh the catalog with `agency models refresh`.

### Suggestions

The "did you mean" line uses Levenshtein edit distance against the catalog
names, suggesting the closest match when its distance is at most 3 and omitting
the line otherwise. `lib/eval/grading/graders/builtinGraders.ts:106` already
contains a dependency-free implementation; it moves to `lib/levenshtein.ts` and
both callers import it, rather than a second copy being written.

## What this changes and what it does not

**Changes.** `client.defaultModel`, and `client.defaultProvider` when a prefix
was given. That is the whole configuration footprint.

**Does not change.** `setModel()` and `llm({ model })` keep winning, per the
layering above. No `--fastmodel`, `--slowmodel`, or `--provider` flag is added;
those remain specific to `agency agent`, which needs several model slots because
it runs several kinds of work. `agency run` runs one program.

**A knock-on effect worth stating.** Memory extraction resolves its model as
`memory.model` first and falls back to the top-level default
(`lib/runtime/memory/manager.ts:560`). So `--model` also changes the model used
for memory extraction and compaction. This is intended: the flag sets the run's
default model, and memory extraction is part of the run.

## Structure

Three pieces, each with one job.

**`lib/cli/modelFlag.ts`** — the parse-and-validate step, as a pure function:

```ts
export type ResolvedModel = { model: string; provider?: string };

/** Throws with a user-facing message when a bare name is not in the catalog.
 *  `catalogNames` defaults to smoltalk's `getAllModels()`. */
export function resolveModelFlag(
  value: string,
  catalogNames?: string[],
): ResolvedModel;
```

Pure and catalog-driven, so it is testable without a CLI or a network call. The
catalog arrives as a defaulted parameter so tests supply their own list instead
of depending on which models happen to ship this month.

**`lib/levenshtein.ts`** — the edit-distance function moved out of
`builtinGraders.ts`, unchanged.

**`applyCliFlags` in `lib/config.ts`** — maps the resolved value onto
`client.defaultModel` and `client.defaultProvider`. This keeps the promise the
file already makes: one place defines what a flag means in configuration terms.

`CliFlags` gains `model?: string`, and `addRunOptions` in `scripts/agency.ts`
gains the option. Both `run` and the shorthand pick it up from there.

## Errors

One error, raised before any compilation: an unknown bare model name, shown
above. It exits non-zero with the message on stderr, matching how the CLI
reports every other bad flag value.

`applyCliFlags` is not the place to raise it — that function is a pure mapping
and is called on paths that should not exit. The check runs in
`resolveModelFlag`, called from the CLI action, and the CLI turns the thrown
message into the stderr output and exit code.

## Testing

**`lib/cli/modelFlag.test.ts`** — one case per row of the resolution table, plus:

- a bare unknown name throws, and the message names the closest catalog entry
- a bare unknown name with no near match still throws, without a "did you mean"
  line
- a prefixed unknown name does **not** throw, which is the custom-provider
  guarantee and the one most likely to be broken by a later "improvement"
- `openrouter/anthropic/claude-sonnet-4` keeps the second slash in the model name

**`tests/integration/cli/test.mjs`** — the flag reaching a real run. The existing
suite makes no LLM calls, so the assertion is on the compiled output rather than
on a completed call: compile with `--model` and check the generated JavaScript
carries that model in its smoltalk client configuration. A second case asserts
that an unknown bare name exits non-zero with the error, and a third runs the
same thing through the shorthand to prove both commands share the flag.

**`lib/runtime/` precedence test** — an Agency execution test calling
`setModel()` and asserting the model actually used is the one from the code, not
the one from the flag. This is the guarantee users are relying on when they set a
model in source, and nothing else in the suite would notice if the layering
changed.

## Out of scope

- `--fastmodel` / `--slowmodel` / `--provider` for `agency run`.
- Local models. `--local` and `--local-model` remain agent-only. A local model
  reached through a provider module works today via the prefix form.
- `agency test`, `agency eval`, and `agency serve`.
- The two `agency agent` command-line gaps found while investigating this: a
  misplaced `--max-cost` is forwarded to the agent, and root flags such as `-c`
  cannot reach agency at all. Both currently produce a clear error rather than
  failing silently. They are noted here only so they are not lost.
