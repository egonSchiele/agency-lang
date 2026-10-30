# Herdr

Herdr is a terminal workspace manager for coding agents. A program built on `std::ui/cli`'s `repl()` can report itself to Herdr by passing `herdrName`. Herdr then lists the pane under that name with the state `idle`, `working`, or `blocked`. `agency agent` passes `herdrName: "agency"` (`lib/agents/agency-agent/lib/repl.agency`). The default, `""`, reports nothing.

`herdrReporter(env, name)` in `lib/stdlib/herdr.ts` writes one JSON line per request to `$HERDR_SOCKET_PATH`. When `HERDR_ENV` is not `1`, or the name is empty, it does nothing. The protocol is Herdr's page "Add Herdr support to your agent", listed in `https://herdr.dev/llms.txt`.

| Report | When | Where |
| --- | --- | --- |
| `idle` | The REPL shows its prompt | the loop in `_runLineRepl` (`lib/stdlib/cli.ts`) |
| `working` | A submitted line goes to `onSubmit` | same loop |
| `blocked`, then `working` | The approval prompt is up, or a nested `input()` is reading | `__agencyInterruptPrompt` and `inputOverride`, wrapped in `whileBlocked` |
| session | The agent saved its session | `reportHerdrSession` in `lib/stdlib/agentSessions.ts`, through the `__agencyHerdrSession` hook |
| release | The REPL exits | the `finally` in `_runLineRepl` |

The session goes out as `agent_session_id` and `resume_argv` on each state report after it is set. Herdr takes a resume command only from the source that holds the pane, and a state report always holds it.

## Rules

- **`seq` follows the clock.** Herdr ignores a report whose `seq` is not above the last one it took from the same source, including one sent by an earlier process. A counter would restart at 1 and be ignored.
- **One request at a time.** A newer report replaces the one waiting in the queue. Each request is built when it is sent, so it carries the session as it is then.
- **A refused resume command drops the whole report.** Herdr answers `invalid_resume_argv` and does not apply the state either. The reporter then clears the session and sends the state again. Herdr 0.9.5 checks the shape of the command when the report arrives: it refuses a path as the first word, or an argument with an apostrophe. It does not check PATH until a restore runs `agency`, so a restore fails when `agency` is not installed.
- **Failures are silent.** A request with no answer in 500 ms is dropped, and so is a socket error. `release()` is awaited when the REPL exits, so the timeout is what keeps a hung Herdr from holding the exit.
- **`agentSessions.ts` must not import `herdr.ts`.** `herdr.ts` uses `net` and is on the `NODE_ONLY` list in `eslint.node-exceptions.mjs`. `agentSessions.ts` is in the browser bundle, so it reaches the reporter through the `globalThis` hook.

## Not reported

- A seed prompt (`agency agent "fix the tests"`) runs before the REPL starts.
- Menus opened by slash commands, such as `/model`, show as `working`.
- One-shot `-p` runs have no REPL.
- Ctrl+C at an approval prompt exits without a release. Herdr clears the pane once the shell prompt is back.

## Checking it

`herdr agent list` shows the state. Herdr does not show the session or resume command of an agent that reports its own. They are in `~/.config/herdr/session.json`, under `agent_resume` for the pane. To test a restore, start `herdr --session agency-test`, take a turn in the agent, run `herdr session stop agency-test`, and start that session again.
