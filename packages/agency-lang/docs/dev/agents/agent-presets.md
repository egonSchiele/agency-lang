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

## Why the presets are read once

The preset table is read at startup, before the policy handler exists,
and kept in a `let` global. `/preset` and `listPresets` read that copy.
Reading `settings.json` inside a turn asks the user to approve the read,
and in a one-shot run the policy handler rejects it, which would make
`listPresets` report that no presets exist.

The write tools update the copy after each successful write. A resumed
session restores the copy from the checkpoint, so hand edits made between
the saved run and the resume are not seen until a fresh session.

## How the tools write

`editPresets` reads the file with `readSettingsFile`, applies one
`PresetEdit`, writes with `writeSettingsFile`, and refreshes the copy.

- `readSettingsFile` fails on a file that does not parse. `loadSettings`
  would return `{}`, and writing that back would erase every other
  setting.
- `readSettingsFile` returns the file as saved. `loadSettings` renames
  slot aliases and drops unknown slots, and writing that back would
  change keys the tools promise to leave alone.
- `writeSettingsFile` returns a `Result`. `saveSettings` only prints a
  warning, so a tool using it could not tell a rejected write from a
  saved one.
- Neither call uses `with approve`. The policy handler decides the read
  and the write. In a one-shot run it rejects them, and the tool replies
  "Not saved".

`savePreset` takes `PresetInput`, which has no `default` field, and whose
`slots` is an object with three named fields. A `Record` in a tool
parameter becomes a JSON schema that OpenAI and Anthropic reject.
Replacing the default preset keeps its `default` flag.

## The coordinator's skills folder

`brains/coordinator/skills/` holds skills about the agent itself, read
through the `coordinator_skills` tool. `skillsDir` does not fail when a
folder is missing. It builds a tool that lists nothing. So
`coordinatorInit` checks each bundled skills tool with
`missingBundledSkill(tool, skillName)` and exits if the tool does not list
a skill it should. The `code` subagent's `superpowersSkill` is checked the
same way.

## Known limits

- A `pin` with no `provider` resolves to `openai`, as `--model` does.
- `--max-cost` and `--max-time` cannot be in a preset: the launcher reads
  them before the agent process starts and does not read `settings.json`.
- `presets.agency` imports `PresetSlots` without using it by name. The
  compiled schema for `Preset` in that module refers to `PresetSlots`,
  and without the import `presets.js` fails to load with a
  `ReferenceError`.
