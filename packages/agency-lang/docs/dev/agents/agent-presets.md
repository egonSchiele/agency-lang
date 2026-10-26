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
| `lib/presets.agency` | The in-memory preset table, the startup choice, the active preset, the listing, and `applyPresetEdit`. |
| `lib/modelRequest.agency` | `ModelRequest`: startup flags, active preset, `/model` choices. Pure helpers that turn it into layers. |
| `lib/toolLimits.agency` | The two tool limits and where each value comes from. |
| `lib/session.agency` | `applyModelRequest`, `pickModelsForAgent`, `switchModel`, `switchPreset`. |
| `brains/coordinator/presetTools.agency` | The four tools and `editPresets`, the only code that writes presets to disk. |
| `brains/coordinator/skills/presets.md` | The skill that tells the model how to use the tools. |

## How a run picks its models

Every model decision goes through a `ModelRequest`:

```
{ flags: ModelFlags, preset: Preset | null, choices: ModelChoices }
```

`requestLayers` turns it into four layers, most immediate first:
`in-session` (the `/model` choices), `cli`, `preset`, `settings`. The
resolver takes the first layer that sets a slot. `/model` prints the layer
name, so a slot a preset set shows `(preset:per-slot)` or
`(preset:global-pin)`.

Any model flag (`--model`, `--fastmodel`, `--slowmodel`, `--provider`,
`--local`, including `--model embedding=...`) empties the preset layer.
The preset's model fields are dropped as a group, so a provider from one
source is never paired with a model from another.

A preset with `local` runs `configureLocalModel`, the same call `--local`
makes. A local model that fails to load ends the process, from startup or
from `/preset`.

`applyModelRequest` does not set up web search. Startup runs
`configureSearch` once. `/preset` runs it only when the switch moves
between a local and a hosted model, because `configureSearch` reads and
saves `settings.json` and can ask the user which backend to use.

The startup flags and `settings.model` are kept in `let` globals in
`session.agency`. `/model` and `/preset` resolve with them, so flags stay
above the preset all session, and neither command reads `settings.json`
inside a turn.

## Options beside the model

`settings.model`, a preset, and the session's `/model` choices can each hold
an `llmOptions` block: `llm()` options for the models beside it, such as
`{ "openRouter": { "provider": { "ignore": ["open-inference"] } } }`. The
block is defined in `lib/llmOptions.agency`. It may hold `openRouter`,
`rawAttributes`, `thinking`, `temperature`, `replyLimits`, `retries`,
`timeout`, and `validationRetries` (`LLM_OPTION_KEYS`). Keys that already
have an owner are refused: `model`, `provider`, and the two tool limits have
fields of their own, `reasoningEffort` comes from `--effort`, and `maxTokens`
comes from the capabilities settings.

`requestLlmOptions` picks the block: the session's, then the preset's, then
`settings.model`'s. The first one set wins whole, and blocks never merge,
because each was written for its own models. `rawAttributes: { "top_k": 5 }`
written for GLM would be rejected by Anthropic, so an option must not
outlive the model it was set for. For the same reason a model flag drops
the preset's block with its models, and a `/model` switch that changes a
model drops the session's block. A local preset keeps its block: a local
model has options too.

`applyModelRequest` and `switchModel` apply the block right after the
models, through `applyLlmOptions`. That calls `setLlmOptions` with every key
in `LLM_OPTION_KEYS` set to `null` and the block spread over them. A `null`
removes the key from the branch defaults, so switching from a preset with
an `openRouter` block to one without leaves no `openRouter` behind. The
nulls stop at `LLM_OPTION_KEYS`, which is why a key with another owner
cannot be in the block: every switch would undo `--effort` or the token cap.

The coordinator's `useLlmOptions` tool sets the session's block from chat.
It does not call `setLlmOptions`: a tool runs in a branch, and the branch's
defaults are dropped when it joins, so the change would vanish. The tool
records a request with `requestSessionLlmOptions`, and the REPL applies it
after the turn with `applySessionLlmOptions`, the way `/model` takes effect
on the next turn. `savePreset` takes the same block through `PresetInput`.

`presets.agency`, `presetTools.agency`, and two tests import `LlmOptions`
without using it. The compiler inlines an imported type's schema, such as
`Preset`, into the importing module but does not import the named types
that schema refers to, so without the import the module fails to load
with "LlmOptions is not defined".

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

A preset may be named `constructor`, so every lookup by name goes through
`savedEntry`, which reads a key only when the record has it.

`savePreset` takes `PresetInput`, which has no `default` field, and whose
`slots` is an object with three named fields. A `Record` in a tool
parameter becomes a JSON schema that OpenAI and Anthropic reject.
Replacing the default preset keeps its `default` flag.

## The coordinator's skills folder

`brains/coordinator/skills/` holds skills about the agent itself, read
through the `coordinator_skills` tool. `skillsDir` does not fail when a
folder is missing. It builds a tool that lists nothing. So
`coordinatorInit` checks each bundled skills tool with
`checkBundledSkill(tool, skillName)` and exits if the tool does not list a
skill it should. The `code` subagent's `superpowersSkill` is checked the
same way.

## Known limits

- A `pin` with no `provider` resolves to `openai`, as `--model` does.
- `--max-cost` and `--max-time` cannot be in a preset: the launcher reads
  them before the agent process starts and does not read `settings.json`.
