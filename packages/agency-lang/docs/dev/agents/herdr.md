# Herdr

Herdr is a terminal workspace manager for coding agents. When `agency agent` runs in a Herdr pane, it tells Herdr what it is doing. Herdr's sidebar and `herdr agent list` then show it as `agency`, with the state `idle`, `working`, or `blocked`. Herdr can notify you when a turn finishes or an approval is waiting, `herdr agent wait` works on it, and after a Herdr server restart the pane runs `agency agent --resume <id>` to reopen the saved session.

The reporting lives in the line-mode REPL behind `std::ui/cli`'s `repl()`, so any Agency program built on `repl()` shows up the same way, under the name `agency`. Only the agent reports a resume command, because only the agent saves sessions.

## How it reports

Herdr sets `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` in every pane. `herdrReporter(process.env)` in `lib/stdlib/herdr.ts` returns a reporter that writes one JSON line per request to that socket. Outside Herdr it returns a reporter that does nothing. The protocol is Herdr's page "Add Herdr support to your agent", listed in `https://herdr.dev/llms.txt`.

| Report | When | Where |
| --- | --- | --- |
| `idle` | The REPL shows its prompt | the loop in `_runLineRepl` (`lib/stdlib/cli.ts`) |
| `working` | A submitted line goes to `onSubmit`, slash commands included | same loop |
| `blocked`, then `working` | The approval prompt is up (approvals and `question`), with its title as the message; or a nested `input()` is reading, such as the reason for a rejection, with its prompt as the message | `__agencyInterruptPrompt` and `inputOverride`, both wrapped in `whileBlocked` |
| session | `_sessionOnSubmit` saved the session | `reportHerdrSession` in `lib/stdlib/agentSessions.ts`, through the `__agencyHerdrSession` hook |
| release | The REPL exits (Ctrl+D, `/exit`) | the `finally` in `_runLineRepl` |

Once set, the session goes out as `agent_session_id` and `resume_argv` on every state report. It rides on the state reports because Herdr only takes a resume command from the source that holds the pane, and a state report always holds it.

## Rules that are easy to break

- **`seq` follows the clock.** Herdr drops a report whose `seq` is not above the last one it took from the source `agency`, and that includes reports from an earlier process. So `seq` is the time in microseconds, plus one when two reports share a tick. A plain counter would start below the last process's numbers, and Herdr would ignore the new process.
- **Only the latest state is sent.** One request is in flight at a time. A newer report replaces the one waiting in the queue, and a release replaces a waiting state.
- **Herdr never slows the REPL down.** A request with no answer in 500 ms is dropped, and so is any socket error. Nothing is printed, because Herdr is optional.
- **The resume command starts with `agency`.** Herdr requires the first word to be a command name it finds on the user's PATH, so `agency` has to be installed for a restore to work. Herdr also refuses an argument with an apostrophe, and a session id is only digits and a dash.
- **`agentSessions.ts` must not import `herdr.ts`.** `herdr.ts` uses `net` and is on the `NODE_ONLY` list in `eslint.node-exceptions.mjs`. `agentSessions.ts` is in the browser bundle, so it reaches the reporter through the `globalThis` hook, the same way `_interruptChoice` reaches the approval prompt.

## What it does not cover

- A seed prompt (`agency agent "fix the tests"`) runs before the REPL starts, so Herdr sees nothing until that turn ends.
- The menus that slash commands open, such as `/model` and `/settings`, show as `working` while the user picks.
- One-shot runs (`-p`) have no REPL and report nothing.
- Ctrl+C at an approval prompt exits at once, without a release. Herdr clears the pane by itself once the shell prompt is back.
- An `--incognito` session is never saved, so it has no resume command.

## Checking it by hand

Herdr does not show the session id or resume command of an agent that reports its own. It keeps them in `~/.config/herdr/session.json`, under `agent_resume` for the pane. To check the rest, start the agent in a Herdr pane and run `herdr agent list`. To test a restore without touching your usual session, start `herdr --session agency-test`, take one turn in the agent, run `herdr session stop agency-test`, then start `herdr --session agency-test` again. The pane should reopen the session.
