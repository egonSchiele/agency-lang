# Architecture review: Remember the Last Settings

Review of `2026-11-20-remember-last-settings.md`, made against the code on `origin/main` (`ae51d1586`).

## What was done about it

The plan has been rewritten with these changes. The findings below are as first written.

- **Finding 1, resolved by the owner differently:** the default preset goes, rather than being ranked against the last settings. One concept answers "what does a new chat start with". A preset marked default seeds the start for people upgrading, until their first change. The `setDefaultPreset` tool is removed rather than pointed at the file, so only a person's answer writes it, which is what lets the write skip an interrupt. That adds Task 5, retiring the default preset.
- **Finding 2, reversed:** with no default preset, a `-p` run with no flags would fall back to the provider's defaults, and scripts that lean on a default preset today would change models silently. So `-p` reads the last settings like a chat, and the docs tell scripts to pass `--preset` for a fixed model.
- **Finding 3, taken in part:** the stored type is built on `ModelChoices` (`{ preset, choices }`). The TS module stays, because Perry's onboarding has to write the file too. There's one TS copy of the type and one Agency copy, as with `SessionRecord`.
- **Finding 4, taken:** `noKeyStillStarts` and `badEffortInFile` are gone.
- **Finding 5, taken:** the `session-core.md` paragraph is gone, and the `agent-presets.md` section is capped at a screen.

## Major features and API

The plan touches two of the most important parts of agency-lang:

- **`ProgramStart`**, the interface every front-end starts the session program with (the terminal, Perry, tests). Its meaning changes. Today, a start with no preset and no model flag means "the default preset, then the defaults". After the change it means "whatever the person last chose, wherever they chose it". No field is added, but every front-end gets the new behavior. That's deliberate for interactive chats, but see finding 2 for one-shot runs.
- **The model-picking functions** `choosePreset`, `startPresetQuiet` and `startModels` each gain a parameter. They are internal, but they are the center of how a run picks its models (`agent-presets.md`, "How a run picks its models").

It also adds public surface: Task 1's `lib/stdlib/agentLastSettings.ts` is exported as `agency-lang/stdlib-lib/agentLastSettings.js`, because everything under `dist/lib/stdlib` is. See finding 3.

## Findings

### 1. The last settings beating the default preset makes the preset concept weaker (important; a decision for the owner)

The plan puts the last settings above the default preset. The reason was Perry's onboarding: it saves a default preset, so if the preset won, remembering would never apply in Perry.

The cost of that order:
- **A default preset stops meaning "what new chats start with"** as soon as the person changes anything once. A terminal user who marked a preset `"default": true` and then tried `/model opus` in one chat would find every later chat on Opus, with nothing pointing them to why.
- **Every other layer puts the explicit choice first.** Flags beat presets, and presets beat `settings.model`. An automatic record beating a setting someone wrote by hand is the one exception.
- **Task 4 has to teach `choosePreset` a third kind of input**, a remembered "" that must beat a default. That is the most delicate signature change in the plan.

**Recommendation:** use the order flags > default preset > last settings > `settings.model` > the provider's defaults, and fix the Perry problem in Perry:
- Onboarding writes the person's pick as the last settings, not as a default preset.
- The Perry follow-up PR covers the friends who already have an onboarding-made default preset: Settings offers to clear the default mark.

Task 4 then needs no change to `choosePreset` or `startPresetQuiet`. When the table has no default preset, the remembered preset name goes in as the `flag`. An unknown name is already a failure, which falls back.

### 2. One-shot runs shouldn't read the last settings (important)

The plan reads the file for `-p` runs too. `agency agent -p` and `perry -p` are what scripts and other tools call. Their model would then follow whatever the person last picked in an interactive chat: one `/model` in the morning, and a script changes models with no change to the script. Reproducible runs matter more there than convenience, and the default preset is still there for anyone who wants `-p` to use their usual settings.

**Recommendation:** `usesLastSettings` also requires `!(start.oneShot ?? false)`. Add a `oneShotIgnoresLast` check to Task 4.

### 3. Two copies of one type, close to one that already exists (moderate)

`LastSettings` is defined twice, in TS (Task 1) and in Agency (Task 2), as `SessionRecord` already is. Its fields are also nearly the same as `ModelChoices` (`pin`, `slots`, `effort`) plus a preset name, which is the distinction-without-a-difference pattern.

**Recommendation:**
- Store `{ preset: string; choices: ModelChoices }`, with `llmOptions` removed before writing, and define the type once, in `lastSettings.agency`.
- Read and write the file from Agency with `_read` and `_write` from `agency-lang/stdlib-lib/builtins.js`, as the toolbox does. Check the fields where `lastSettingsChoices` already checks them.
- Drop Task 1 and its public TS export.
- Perry only needs to know whether the file exists (finding 1's onboarding). It can name the file in one place, as `sessionFilesOf` names the session files.

### 4. Tests that pin what happened, not what should happen (minor)

- `noKeyStillStarts` asks the implementer to "record which way it went". A fixture of whatever came out guards nothing. Drop it: the case it was after is covered by `localPresetFallsBack`, which makes `startModels` fail for certain.
- `badEffortInFile` repeats Task 2's `badEffortDropped` through a whole session start, in a long script that every CI run pays for. Drop it.

### 5. Docs sized above the feature (minor)

The feature matters, since it decides every new chat's model, but it is one rule.
- **Keep:** the user guide paragraph (`docs/site/agent/models.md`) and the line in `cli/agent.md`.
- **Shrink:** the dev doc section in `agent-presets.md`, to the order, what is kept and why not `llmOptions`, why there is no interrupt, and the fallback. A screen at most.
- **Drop:** the `session-core.md` paragraph. The core's interface doesn't change, and `agent-presets.md` is where someone looking at model picking will look.

## Effort and impact

| Task | Effort | Impact | Must? |
|---|---|---|---|
| 1. TS file module | small | none of its own; storage only | no, if finding 3 is taken |
| 2. Choices to file and back | small | the rules for what is kept | yes |
| 3. Core writes after an answer | small | half the feature | yes |
| 4. Start reads it | medium (small with finding 1) | the other half | yes |
| 5. Docs | small | discoverability | yes, trimmed per finding 5 |

Nothing in the plan is optional, high-effort and low-impact. The only optional work is Task 1, and it's small.

## The 80/20 rule

The goal: a new chat starts with the settings the person last used, in both front-ends. I considered three other ways:

- **Perry only:** Perry's settings panel rewrites the default preset on each change, as onboarding already writes `settings.json`. Little work, but the terminal gets nothing. It's a parallel version in Perry, which Perry's rules forbid, and it would move the default mark in the person's own presets behind their back.
- **Store it as a preset:** auto-save a preset named something like `last` in `settings.json`. That unifies two concepts, but `recommended` asks before every write to `settings.json` on purpose, so each model change would ask.
- **Start from the most recent chat's run file:** no new file. But a run file can be megabytes, it holds resolved models rather than choices, and "the last chat" isn't "the last thing I chose": a chat where nothing was changed would reset it.

The plan's approach is the 80/20 already. Findings 1 and 3 make it smaller.

## Reusing code and concepts

- **Reused well:** `ModelChoices` and `ModelRequest` layering (the remembered choices go in as the in-session layer, the way `/model` puts them there), `EFFORT_CHOICES`, `activePresetName`, `notice`, `currentRecord` and `isIncognito`.
- **Not reused, and should be:** `ModelChoices` as the stored type (finding 3).
- **The new concept for users,** "new chats start with your last settings", is easy to learn, as long as an explicit default preset still wins (finding 1). Otherwise it quietly overrides a concept users already know.

## Tying concepts together

- **Remembering is tied to "a saved, non-incognito session".** That is the right tie: those are the interactive chats a person drives. It also keeps one-shot runs and tests that start with `record: null` out of it.
- **Writing from the core's answer handlers ties front-end answers to a file outside the session.** That's what we want, since both front-ends then remember the same way. The cost is that a test that drives the core against a real home would write the user's file. The session-core tests already run in a temp home (`AGENCY_AGENT_HOME`), and Task 3 should say that any new test must too.
- **Perry would know the file's name** (finding 3). That is the same kind of tie as `sessionFilesOf`, kept to one place.
