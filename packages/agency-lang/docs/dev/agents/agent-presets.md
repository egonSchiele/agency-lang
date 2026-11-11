# Agent presets

A preset is a named set of model and tool-limit settings for
`agency agent`, saved under `presets` in the agent home's
`settings.json`. `--preset <name>` starts with one, a preset marked
`"default": true` is used when no flag is given, and `/preset <name>`
switches in a session. The coordinator has four tools to manage them.

## Where things live

Paths are relative to `lib/agents/agency-agent/`.

| File | What it owns |
|---|---|
| `lib/presetRules.agency` | The `Preset` types and the rule table. `checkPreset` is the one definition of a valid preset. |
| `lib/presets.agency` | The in-memory preset table, the startup choice, the active preset, the listing, `applyPresetEdit`, and `editPresets`, the only code that writes presets to disk. |
| `lib/presetSnapshot.agency` | `sessionPreset`, which builds a preset from the session for `/preset save`, and `presetChangeLines`, which lists what a save changes. |
| `lib/modelRequest.agency` | `ModelRequest`: startup flags, active preset, `/model` choices. Pure helpers that turn it into layers. |
| `lib/toolLimits.agency` | The two tool limits and where each value comes from. |
| `lib/effort.agency` | The reasoning effort choices, the built-in default per model, and the level a run sends. |
| `lib/session.agency` | `applyModelRequest`, `pickModelsForAgent`, `switchModel`, `switchPreset`, `saveSessionPreset`. |
| `brains/coordinator/presetTools.agency` | The four tools. |
| `brains/coordinator/skills/presets.md` | The skill that tells the model how to use the tools. |

## How a run picks its models

Every model decision goes through a `ModelRequest`:

```
{ flags: ModelFlags, preset: Preset | null, choices: ModelChoices }
```

`requestLayers` turns it into four layers, most immediate first:
`in-session` (the `/model` choices), `cli`, `preset`, `settings`.
`resolveRequestAgainst` adds a fifth, `default`, which holds the default
router when its key is set (`docs/dev/agents/agent-router.md`, "The
default router"). The resolver takes the first layer that sets a slot. `/model` prints the layer
name, so a slot a preset set shows `(preset:per-slot)` or
`(preset:global-pin)`.

Any model flag (`--model`, `--fastmodel`, `--slowmodel`, `--provider`,
`--local`, including `--model embedding=...`) empties the preset layer.
The preset's model fields are dropped as a group, so a provider from one
source is never paired with a model from another.

The `router` slot (`docs/dev/agents/agent-router.md`) is set the way the
embedding slot is: `--model router=<provider>/<model>`, `slots.router` in a
preset, or `settings.model.slots.router`. Both are derived slots: the value
must name its provider, a bare `--model` never sets them, and they get no
`llmOptions`. The router accepts only the providers that answer decisions
(`DECISION_PROVIDERS` in `lib/slots.agency`), and it may be set beside
`local`. The router also accepts `off`, which turns routing off.

A preset with `local` runs `configureLocalModel`, the same call `--local`
makes. A local model that fails to load ends the process, from startup or
from `/preset`.

`applyModelRequest` does not set up web search. Startup runs
`configureSearch` once. `/preset` runs it only when the switch moves
between a local and a hosted model, because `configureSearch` reads and
saves `settings.json`.

With no saved search choice, startup selects Brave when `BRAVE_API_KEY`
is set, otherwise Tavily when `TAVILY_API_KEY` is set. Explicit saved
choices remain in effect. The choice reaches every subagent through
`setSearchMode` in `stdlib/agents/lib/search.agency`: `setActiveBackend`
passes it on, and each stdlib agent takes its client tool and its hosted
search from that module. The agent has no search tool table of its own.

The startup flags, `settings.model`, and the default slots are kept in
`let` globals in `session.agency`. `/model` and `/preset` resolve with
them, so flags stay above the preset all session, and neither command
reads `settings.json` or checks the default router's key inside a turn.

## Options beside the model

`settings.model`, a preset, and the session's `/model` choices can each hold
an `llmOptions` block: `llm()` options for the models beside it, such as
`{ "openRouter": { "provider": { "ignore": ["open-inference"] } } }`. The
block is defined in `lib/llmOptions.agency` and may hold the keys in
`LLM_OPTION_KEYS`: `openRouter`, `thinking`, `temperature`, `replyLimits`,
`retries`, `timeout`, `validationRetries`, and `baseUrl`.

`baseUrl` may only hold `mlx`, the address of an MLX server on another
machine, such as `{ "baseUrl": { "mlx": "https://studio.ts.net:8090/v1" } }`.
Every other provider sends an API key with each request, so a block with
`{ "baseUrl": { "openRouter": "https://example.com" } }` would send the
OpenRouter key to example.com. The mlx client sends a placeholder key.
`checkLlmOptions` refuses the other providers with a message, and
requires the `mlx` value to parse as an `http` or `https` URL
(`_isHttpUrl`). It runs on every path a block comes in by, so a typo is
reported when the preset is saved or loaded.

The address still needs an approval that names it. Each request carries
the whole conversation, and the server writes the model's replies, so it
chooses which tools the agent calls. `useLlmOptions` and `savePreset`
both call `confirmServerUrl`, which raises `agent::llmServer` with the
address as its data, `{ url: "https://studio.ts.net:8090/v1" }`, before
anything else. It is a separate effect from `agent::llmOptions`, so a
policy rule that approves option changes, such as a new OpenRouter
routing, does not also approve a server. A rule can still approve one
address by matching on `url`. The recommended policy has no rule for
either effect, so the user answers both. `useLlmOptions` then raises
`agent::llmOptions` as before, so setting an address asks twice.

`checkLlmOptions` returns the block it was given, cut down to the keys a
checked cast `as LlmOptions!` keeps (`keptByCast`). The cast drops a
nested key its type does not have, so `{ "openRouter": { "extra": 1 } }`
comes back as `{ "openRouter": {} }`. The block is not the cast's own
value, because the cast also fills each optional field it was not given
with `null`. `checkPreset` puts this block in the preset it returns, so a
saved or loaded preset gets the same cut as `useLlmOptions` and the
top-level `model.llmOptions`.

When the active preset sets an address, the interactive header prints it
(`serverNotice`): `Chat requests go to https://studio.ts.net:8090/v1, from
the "studio" preset.` A preset marked `default` applies with no flag, and
an address can reach `settings.json` without `savePreset`, by a hand edit
or a plain file write, so the header is the one place every path shows
up. A one-shot run prints no header, so it does not show the line.

Keys with another owner are refused. `model`, `provider`, and the two tool
limits have fields of their own, `reasoningEffort` comes from the effort
rule below, and `maxTokens` comes from the capabilities settings. `rawAttributes` is
refused until smoltalk stops it from replacing the model (smoltalk#73).

`requestLlmOptions` picks the block: the session's, then the preset's, then
`settings.model`'s. The first one set wins whole, and blocks never merge,
because each was written for its own models. For the same reason, a model
flag drops the preset's block with its models. A `/model` switch that
changes a model, or any `/preset` switch, drops the session's block. A
local preset keeps its block, since a local model has options too.

`applyModelRequest` and `switchModel` apply the block right after the
models. They call `setLlmOptions` with every key in `LLM_OPTION_KEYS` set to
`null`, then spread the block over that. A `null` removes the key from the
defaults, so switching from a preset with an `openRouter` block to one
without leaves no `openRouter` behind. The nulls stop at `LLM_OPTION_KEYS`,
which is why a key with another owner cannot be in the block: every switch
would undo the effort or the token cap.

`setLlmOptions` sets defaults for every `llm()` call, so the block reaches
every model the agent calls, the coordinator's and the subagents'. Most keys
are safe on any provider: `openRouter` and `replyLimits` are read by one
provider only, and the retry keys by Agency. `temperature` and `thinking`
are the exceptions. When the block sets one of them and the session's models
use more than one provider, the agent prints a warning
(`mixedProviderWarning`).

The coordinator's `useLlmOptions` tool sets the session's block from chat.
Options decide which company receives the rest of the session, so the tool
raises an `agent::llmOptions` interrupt, which a policy rule or the user
answers. It does not call `setLlmOptions` itself: a tool runs in a branch,
and a branch's defaults are dropped when it joins. It records a request with
`requestSessionLlmOptions` instead, and the REPL applies it after the turn
with `applySessionLlmOptions`. `savePreset` takes the same block through
`PresetInput`.

## Reasoning effort

A reasoning model takes a level that says how hard to think. One level
goes out with every `llm()` call of the session, as `reasoningEffort`.
`effortToSend` in `lib/effort.agency` picks it from three sources, first
one set wins:

1. `--effort`, kept on `ModelFlags.effort`.
2. The active preset's `effort` field.
3. The built-in default for the session's models.

The flag and the preset take `low`, `medium`, `high`, or `default`.
`default` sends no level, so the provider uses its own. It is the only
way to get a level Agency cannot name, such as GLM 5.3's `max`.

`--effort` is not a model flag. `hasModelFlags` ignores it, so
`--preset glm --effort low` keeps the preset's models, and the flag's
level stays for the whole session.

A preset's effort was chosen for its models, so it is dropped when the
models change: by a model flag, which also drops the preset's models and
`llmOptions`, or by a `/model` choice of a chat model. After
`--preset glm` with `"effort": "low"`, typing `/model claude-opus-4-8`
sends Opus no level. A `/model embedding=...` choice keeps it. This
differs from the preset's `llmOptions` block, which a `/model` switch
keeps.

A level a model does not list is still accepted. GLM 5.3 lists `low`,
`high`, and `max`. Sent `medium` through OpenRouter, it answered on four
hosts (Z.AI, Baseten, SiliconFlow, DigitalOcean) and thought about as much
as at `low`. So `checkPreset` does not check the level against the model.

The built-in default is the table `DEFAULT_EFFORT_RULES`. Each row names a
provider, a model id prefix, and a level. The table holds the models whose
provider thinks at its top level when no level is sent: GLM 5.3 and
Kimi K3 on OpenRouter, which both default to `max`. Their row says `high`.
In a replay of 18 logged agent calls on GLM 5.3 Flash, `high` took 43% less
time than `max`, and Z.ai's coding benchmark puts `high` 3 points below
`max`. The Kimi K3 row is not measured. It is there because OpenRouter
gives Kimi K3 the same levels and the same `max` default. OpenRouter lists each model's levels and its default at
`https://openrouter.ai/api/v1/models`, under `reasoning`.

`defaultEffort` returns a level only when every chat model of the session
matches a row with the same level. The level is one setting for all calls,
so a session that pairs GLM 5.3 with a model outside the table gets no
default, and each provider uses its own. `noDefaultWarning` writes the
yellow line that says so, such as "No default effort: z-ai/glm-5.3-flash
would use high, but claude-haiku-5-5 has no default. Pass --effort to set
one."

`applyRequestOptions` in `lib/session.agency` sets the level, right after
the `llmOptions` block. Startup, `/model`, and `/preset` all go through it,
so the level follows the models: switching from GLM 5.3 to a model with no
row sets `reasoningEffort` to `null`, which removes it.

A resumed session restores the `llm()` defaults it was saved with, and
`applyRequestOptions` does not run on a restore. A session saved with no
level keeps none until its first `/model` or `/preset` switch.

## Why the presets are read once

The preset table is read at startup, before the policy handler exists,
and kept in a `let` global that `/preset` and `listPresets` read. Reading
`settings.json` inside a turn asks the user to approve the read, and a
one-shot run rejects it.

A resumed session restores that copy from the checkpoint, so a hand edit
made between the saved run and the resume is not seen until a fresh
session.

## How the tools write

`editPresets` reads the file with `readSettingsFile`, applies one
`PresetEdit`, writes with `writeSettingsFile`, and refreshes the copy.

The tools use `readSettingsFile` and `writeSettingsFile` rather than
`loadSettings` and `saveSettings`:

- `loadSettings` returns `{}` for a file that does not parse, and writing
  that back would erase every other setting.
- `loadSettings` renames slot aliases and drops unknown slots, and writing
  that back would change keys the tools leave alone.
- `saveSettings` returns nothing, so a tool could not tell a rejected
  write from a saved one.

Neither call uses `with approve`. The policy handler decides the read and
the write. A one-shot run rejects them, and the tool replies "Not saved".

Before it writes a preset whose block sets `baseUrl.mlx`, `savePreset`
raises `agent::llmServer` with a message that names the preset and the
address. The `std::write` approval alone would show the address buried in
the whole file, and a policy rule that approves writes under the agent
home would skip even that. A rejection replies "Not saved" and writes
nothing.

A preset may be named `constructor`, so every lookup by name goes through
`savedEntry`, which reads a key only when the record has it.

`savePreset` takes `PresetInput`, which has no `default` field, and whose
`slots` is an object with three named fields. A `Record` in a tool
parameter becomes a JSON schema that OpenAI and Anthropic reject.
Replacing the default preset keeps its `default` flag.

## Saving the session to a preset

`/preset save` writes the session's models, effort, options, and tool
limits to the active preset, and `/preset save <name>` writes them to
that name. `saveSessionPreset` in `lib/session.agency` does the save, and
`sessionPreset` in `lib/presetSnapshot.agency` builds the preset.

The rule is that the saved preset, loaded in a fresh session with no
flags and no `/model` choices, resolves to the same models, effort,
options, and tool limits. So a preset's `effort` that the session
dropped, because `/model` changed a chat model, is dropped from the
saved preset too.

The model fields depend on where the session's provider came from:

| Provider | Model fields written |
|---|---|
| None: a local request | `local`, and `slots.embedding` and `slots.router` from the request. |
| `--provider` or the preset | `provider`, and the `pin` and `slots` of the flattened layers. |
| `settings.model.provider` | The `pin` and `slots` of the flattened layers. No `provider`: it stays in settings. |
| Detected from API keys | The derived slots of the flattened layers. If those layers name a chat model, `slots.main` and `slots.reasoning` as `provider/model`, from the resolved slots. No `provider` and no `pin`. |

The last two rows differ because of how a value is read at the next
start. Under a fixed provider, `parseModelSpec` reads the whole value as
the model name, so `openrouter/z-ai/glm-5.3` would name a model that does
not exist. With a detected provider, a bare name is resolved again: a
session that detected `anthropic` and ran `/model claude-opus-4-8` runs
Opus on Anthropic, but a preset holding only `pin: "claude-opus-4-8"`
starts on `openai` (see "Known limits"). So those slots carry their
provider. Both chat slots are written, so neither falls back to a
built-in default that depends on which keys are set.

`flattenLayers` in `lib/resolution.agency` folds the `in-session`,
`cli`, and `preset` layers into one layer that resolves every slot the
same way. Merging the layers field by field gets one case wrong. If the
preset has `slots.main` and the user types `/model x`, the session runs
`x`, because a pin beats a named slot in a less immediate layer. A merge
would write `pin: x` beside `slots.main`, and within one layer the named
slot wins, so the saved preset would run the old model. `flattenLayers`
drops a chat slot that sits below a pin.

These are not copied: values from `settings.model`, which still apply at
the next start; the default router, which is not in `requestLayers`; and
the `default` flag, which `applyPresetEdit` keeps on the saved entry.

A session that `/local` moved is refused. `/local` calls
`configureLocalModel` without changing the `ModelRequest`, so the request
no longer describes the models the session runs. The check compares the
`main` slot's `via` (`"local"`) with `requestIsLocal`.

The write uses `with approve`, as `saveSettings` does for a preference
the user just changed, and the policy in the chain still decides. The
`recommended` policy has no rule for writing `settings.json`, so the user
sees one `std::write` prompt. Unlike `savePreset`, the command raises no
`agent::llmServer` question: an address in the session's block was
approved when `useLlmOptions` set it, and an address in the preset's own
block is already in the file.

## The coordinator's skills folder

`brains/coordinator/skills/` holds skills about the agent itself, read
through the `coordinator_skills` tool. `skillsDir` does not fail when a
folder is missing. It builds a tool that lists nothing. So
`coordinatorInit` checks each bundled skills tool with
`checkBundledSkill(tool, skillName)` and exits if the tool does not list a
skill it should.

## Known limits

- A `pin` with no `provider` resolves to `openai`, as `--model` does.
- A preset named `save` cannot be reached with `/preset save`, which
  saves to the active preset. It still loads with `--preset save`.
- The first save of a preset with no `provider` and a detected provider
  reports changes even when the session changed nothing: a bare `pin`
  is rewritten as two `provider/model` slots. Later saves are stable.
- `/preset save` compares against the presets read at startup. If another
  agent session saved the same preset since this one started, the printed
  lines describe the wrong change, and "Nothing to save" can skip a write
  that was needed.
- `--max-cost` and `--max-time` cannot be in a preset: the launcher reads
  them before the agent process starts and does not read `settings.json`.
- A preset's `baseUrl.mlx` reaches only `llm()` calls. The speech, image,
  and vision functions find the server with `mlxBaseUrl()`, which reads
  `agency.json` and `MLX_BASE_URL`. A subprocess does not inherit the
  branch's `llm()` defaults.
