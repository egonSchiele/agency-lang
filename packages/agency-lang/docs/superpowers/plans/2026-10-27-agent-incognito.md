# Incognito mode for `agency agent`, set at startup

**Goal:** `agency agent --incognito` starts a session that leaves no record of itself: no statelog events (file, stdout, or remote), no saved session, and no input history. It cannot be turned on mid-session. That is a deliberate trade, chosen to keep the change small: it needs no runtime change, only a few lines in the launcher and the agent.

**One PR, based on main.** Planned against `main` at `2a1a6dcea` (v0.34.0) on 2026-10-27. It does not depend on the pause-observability plan.

---

## Why startup-only is small

The agent's logging is decided once, when the runtime is created. The settings come from the config compiled into the agent, with `AGENCY_CONFIG_OVERRIDES` layered on top (`lib/runtime/configOverrides.ts:89`). That variable can set `observability`, and `--log` already works through it: the launcher puts the setting in the variable before it starts the agent (`lib/cli/runBundledAgent.ts:149-155`, `241-247`).

So `--incognito` does the same with `observability: false`. Every statelog client is then created switched off (`lib/statelogClient.ts:226-229`), whatever the compiled-in config says. That covers the file, stdout, and the remote statelog host. Programs the agent starts inherit no logging too: `getStatelogSink` hands a subprocess the parent's `observability: false` (`lib/runtime/state/context.ts:456-480`), and `agency` commands run from the agent's shell inherit the variable, because `lib/cli/childEnv.ts` does not remove it.

Turning incognito on mid-session would need a runtime change, because a statelog client cannot be switched off after it is created. Startup-only avoids that.

The agent's own two records, saved sessions and input history, already have off paths:

- **Saved sessions.** A one-shot run never calls `startSession`, so `_current` in `lib/agents/agency-agent/lib/resume.agency` stays null and nothing is saved. Incognito takes the same path.
- **Input history.** `repl()` takes a `historyFile`, and `""` turns the history file off (`stdlib/ui/cli.agency:51`, `70`). Incognito passes `""`.

## What this does not cover

The docs say each of these:

- **The model provider still receives the whole conversation.** Incognito only stops Agency's own records.
- **Debugger attach.** A run still writes a `<pid>.json` record in `~/.agency/debug-sessions/` while it runs, so another `agency` command can attach a debugger. It holds the process id and program path, not the conversation, and is removed at exit. The user decided this is fine.
- **smoltalk's own statelog.** It is compiled in only when `--config` names a config that sets `client.statelog.host` and `projectId`, and the override cannot reach it. The shipped agent does not set it.
- **A trace compiled in with `--config`.** The override can add a trace file but not remove one compiled in. The shipped agent has none, and `--incognito --trace` is refused (decision 2).

## A finding outside this plan: the shipped agent logs by default

The built agent at `dist/lib/agents/agency-agent/agent.js:88-96` has `observability: true` and `logFile: "log.jsonl"` compiled in. The makefile compiles the agents from the package root (`makefile:119-121`), so the repo's own `agency.json` is baked in. Every `agency agent` session appends every prompt and reply to `./log.jsonl` in whatever directory it runs in.

`--incognito` works whatever is compiled in, so this plan does not depend on it. Whether the shipped agent should log by default is a separate question for the user.

## Decisions

### 1. A flag only: no slash command, no preset field

Incognito is set only by `--incognito`. A slash command would need the runtime change above.

A preset would not need a runtime change, but it would add machinery. Presets are read by the agent's Agency code, after the runtime has started logging. So the launcher would have to read `settings.json` itself and repeat `choosePreset`'s rule in TypeScript, to know before the agent starts. A shell alias gives the same result with no code:

```
alias agent-private='agency agent --incognito'
```

If a preset field is wanted later, that launcher check is the whole of the work.

### 2. Flags that contradict it are errors

These exit before the agent starts, with status 2 from the launcher or 1 from the agent, matching how each place reports errors today:

- `--incognito --log`, `--incognito --trace`: the launcher refuses. "--incognito records nothing, so it cannot be used with --log." The same with `--trace`.
- `--incognito --continue`, `--incognito --resume`: the agent refuses, next to the existing check that one-shot runs cannot resume (`lib/agents/agency-agent/agent.agency:180-187`). "--incognito sessions are not saved, so they cannot continue or resume one." Resuming a saved session and then not saving it would be confusing, and refusing is one `if`.

An inherited `AGENCY_CONFIG_OVERRIDES` that sets a log file, such as an eval harness's, is overridden: the launcher's overrides are merged on top (`runBundledAgent.ts:241-244`), so `observability: false` wins.

### 3. The agent learns it is incognito from its own flag

`args.agency` gets an `incognito` boolean flag. The launcher also reads it, from argv, the way it reads `--log`. The child gets the original argv (`runBundledAgent.ts` passes `args` through unchanged), so the agent sees the same flag. No new channel between the two is needed.

### 4. The header says so

The startup header prints one line: `Incognito: nothing from this session is logged or saved. Your messages still go to the model provider.` `/rename` already answers "No session to rename." when there is no session, which is right here.

## Changes

- `lib/cli/runBundledAgent.ts`: `scanLaunchValues` learns `--incognito` as a boolean. `resolveAgentLaunchArgs` refuses it with `--log` or `--trace`, and otherwise adds `observability: false` to the overrides.
- `lib/agents/agency-agent/lib/args.agency`: the `incognito` flag, described as "Record nothing about this session: no log, saved session, or input history. Your messages still go to the model provider."
- `lib/agents/agency-agent/agent.agency`: refuse `--incognito` with `--continue` or `--resume` (decision 2), and skip `startSession` when incognito. Keep `installSessionHooks` and `setSlashPalette`: the REPL still needs its callbacks, and they already do nothing when `_current` is null. Check that `saveSeedTurn` and `recordTurn` also do nothing then, as they do for a one-shot run.
- `lib/agents/agency-agent/lib/repl.agency`: `startInteractive` passes `historyFile: ""` when incognito. Pass it in as a parameter from `agent.agency`, not as a new global.
- The header in `lib/agents/agency-agent/lib/header.agency`: the line from decision 4.
- `docs/site/cli/agent.md`: `--incognito`, what it stops, what it does not stop (the list above), and the alias.
- `docs/dev/agents/agent-sessions.md`: one sentence that an `--incognito` session is never saved, and why it takes the one-shot path.

## Tests

Save each run's output to a file in the session's scratchpad directory.

- `lib/cli/runBundledAgent.test.ts`, in the style of the existing `--log` cases:
  - `--incognito` puts `observability: false` in the overrides.
  - With an inherited `AGENCY_CONFIG_OVERRIDES` that sets `observability: true` and a log file, the merged overrides have `observability: false`.
  - `--incognito --log` and `--incognito --trace` exit 2 and start nothing.
- An agent test in the style of `tests/agency-js/agent-session-resume/`: an interactive run with `--incognito` and a throwaway agent home answers one turn and exits. Nothing is under `sessions/`, there is no `history` file, and no `log.jsonl` in the working directory. If driving the REPL from a test is too heavy, test the two decisions directly instead: the history file argument is `""` and `startSession` is not called, and leave the end-to-end check to the hand check.
- The `--incognito --continue` refusal, wherever the existing one-shot refusal is tested.

## Check by hand

Build with `make`, then run the built CLI from an empty directory with a throwaway `--agent-home`:

1. `agency agent --incognito`: the header says incognito. Ask something, then exit. No `log.jsonl`, nothing under `sessions/`, and no `history` file.
2. `agency agent` in the same directory: `log.jsonl` appears, a session is saved, and `history` is written. This confirms the first step's result came from the flag.
3. `agency agent --incognito --log`, and `agency agent --incognito --continue`: each refuses with its message.

## Before pushing

```
make && pnpm run lint:structure && pnpm run fmt:ts -- <changed .ts files> && make -j siblings
```

Chain these with `&&`, read the log, and push only when the whole chain exits 0.
