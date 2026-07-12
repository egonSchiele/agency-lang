# Running the agent

The agent runs in three modes: an interactive session, a one-shot command, and a
seeded session that starts with a prompt and then stays open. It picks a mode
from how you launch it.

## Interactive mode

Run `agency agent` with no arguments in a terminal. You get a REPL with a scroll
area, a status line that shows the running cost, and an input bar with history.

```bash
agency agent
```

Type a message and press Enter. The agent replies inline, and you can keep the
conversation going. Type `/help` to see the slash commands, or `/exit` to quit.

## One-shot mode

Pass a prompt on the command line, or the `--print` / `-p` flag, and the agent
runs a single turn, prints the reply, and exits. There is no REPL.

```bash
agency agent "explain the error in foo.agency"
agency agent -p "write a hello-world node"
```

The agent also reads piped input, so it works like a Unix filter:

```bash
cat error.log | agency agent "what went wrong here?"
echo "summarize this file" | agency agent
```

One-shot mode has no human to answer follow-up questions, so it runs more
autonomously and allows more tool-call rounds than an interactive session. It
still cannot approve file writes on its own. If a task needs a write, either use
a policy that allows it (see [Approvals](/agent/approvals)) or run interactively.

## Seeded interactive mode

Pass `--interactive` / `-i` together with a prompt. The agent runs that prompt as
the first turn, then hands you the REPL to continue.

```bash
agency agent -i "start a new parser module"
```

This needs a terminal. Without one, or with `--print`, the agent falls back to
one-shot mode.

## Starting with a specific agent

By default the coordinator handles your first message and routes it. To send the
first turn straight to one specialist, use `--agent`:

```bash
agency agent --agent code "add a null check to parse()"
agency agent --agent oracle "is this migration plan safe?"
```

Valid targets are `code`, `research`, `oracle`, `explorer`, and `review`. This
only changes the first turn; later turns go back through the coordinator. See
[The agent team](/agent/subagents).

## The agent home directory

The agent keeps its settings, approval policy, and input history in
`~/.agency-agent`. Point it somewhere else with `--agent-home` or the
`AGENCY_AGENT_HOME` environment variable:

```bash
agency agent --agent-home ./my-profile
AGENCY_AGENT_HOME=./my-profile agency agent
```

The flag wins when both are set. This is useful for keeping separate profiles,
such as a different policy or model per project.

## Slash commands

Inside an interactive session, a line starting with `/` runs a command instead of
talking to the agent.

| Command | What it does |
|---|---|
| `/help` | List the available commands. |
| `/exit`, `/quit` | Leave the session. |
| `/clear` | Clear the conversation transcript. |
| `/clear-history` | Clear the saved input history. |
| `/cost` | Show cumulative cost and tokens, broken down by model. |
| `/model` | Switch the model. See [Models](/agent/models). |
| `/models` | List and filter the hosted model catalog. |
| `/local` | Switch to a local model. |
| `/search` | Choose the web search backend. |
| `/settings` | View and change settings for the current model. |
| `/mcp` | List configured [MCP servers](/agent/mcp) and their tools. |
| `/paste` | Enter multi-line paste mode (Ctrl+D submits, Ctrl+C cancels). |

You can add your own commands too. See
[Project context and slash commands](/agent/project-context).

## Useful flags

A few flags help when debugging or scripting. The [CLI reference](/cli/agent)
lists them all.

- `--verbose` — echo each tool call to stdout in one-shot mode (interactive
  sessions always show tool calls).
- `--debug` — also log tool returns and timing.
- `--max-tool-call-rounds <n>` — cap the LLM tool-call rounds before a turn
  stops. Defaults to 10 interactive, 50 in one-shot mode.
- `--log-file <path>` — append structured events, one JSON object per line, for
  later inspection.
