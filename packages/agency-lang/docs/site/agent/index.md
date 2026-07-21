# The agency agent

Agency ships with a built-in coding agent. Start it using:

```bash
agency agent
```

This is a general purpose agent. You can ask it to write code, do research, et cetera. It can also provide Agency-specific help. It can review and debug your code, or teach you about Agency's features. You can also use it to get help with different CLI commands.

## One-shot mode

Running `agency agent` runs the agent in interactive mode. You can also run it in one shot mode in these ways:

```bash
# passing it a prompt on the command line
agency agent "explain the error in foo.agency"

# passing a prompt with the `-p` flag
agency agent -p "write a hello-world node"

# piping input to it
cat error.log | agency agent "what went wrong here?"
echo "summarize this file" | agency agent
```

In this case, the agent will autonomously do the work and then exit.

## Safety features
Agency comes with great support for making agents safer, and the Agency agent takes full advantage of it. Before taking most actions, the agent will pause and ask you for approval. You can also pre-approve actions by using [Agency's policies feature](/guide/policies).

The first time you start the agent, it will ask you to pick a policy:

```
Welcome to the agency agent. Please pick a policy to start.

    Don't worry, you can change this later. The policy just controls how the agent asks for your approval when it wants to do something. You can also create your own custom policy file at /Users/adityabhargava/.agency-agent/policy.json and the agent will use it automatically.


? Do you want to continue? ›
❯   minimal - minimal default policy, you do most approvals manually
    recommended - recommended default policy, allow reading files and browsing the web, no writes
```

A policy defines what actions the agent takes without asking, and it will prompt you for everything else. When it prompts you for action, you can also choose to modify the policy so that it doesn't ask you for the same action next time.

You can also run the agent with a specific policy like so:

```bash
agency agent --policy myPolicy.json
```

Here you can give it a path to a policy file, or use one of the built-in policies:

```bash
# approves everything, fully autonomous but unsafe
agency agent --policy approve-all
```

## The agent home directory

The agent keeps the policy, as well as any settings and other data, in its home directory. By default, the directory is at `~/.agency-agent`. You can point it somewhere else with `--agent-home` or the `AGENCY_AGENT_HOME` environment variable:

```bash
agency agent --agent-home ./my-profile
AGENCY_AGENT_HOME=./my-profile agency agent
```

## Slash commands

Inside an interactive session, press `/` to run a slash command:

| Command | What it does |
|---|---|
| `/help` | List the available commands. |
| `/exit`, `/quit` | Leave the session. |
| `/clear` | Clear the conversation transcript. |
| `/clear-history` | Clear the saved input history. |
| `/cost` | Show cumulative cost and tokens so far, broken down by model. |
| `/model` | Switch the model. See [Models](/agent/models). |
| `/models` | List the hosted model catalog. |
| `/local` | Switch to a local model. |
| `/search` | Choose the web search backend. |
| `/settings` | View and change settings for the current model. |
| `/mcp` | List configured [MCP servers](/agent/mcp) and their tools. |
| `/paste` | Enter multi-line paste mode (Ctrl+D submits, Ctrl+C cancels). |

I want to call out that last one. If you want to enter multiple lines into the Agency agent, you'll need to enter paste mode first, by running `/paste`.

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
- `--log <path>` — write logs to a file.
- `--max-cost` - stop the agent if the session cost gets higher than this.
- `--max-time` - stop the agent if the session takes longer than this.