---
title: The Agency assistant agent
description: Documents the `agency agent` command, which launches an interactive LLM agent that knows Agency's syntax, standard library, and idioms to help you write or debug Agency code.
---

# The Agency assistant agent

*Work in progress*

```
agency agent
```

Launches the Agency language assistant agent — an LLM agent that knows about Agency's syntax, standard library, and idioms. You can ask it to write Agency code, explain language features, debug an error, or walk through a piece of code with you.

This is a convenient way to get help with Agency without leaving your terminal.

## Budget flags

- `agency agent --max-cost <dollars>` — abort if the agent's LLM spend exceeds this many dollars. `0` means no paid spend (local models only); negative means no limit.
- `agency agent --max-time <duration>` — abort if the agent's working time exceeds this duration, e.g. `30m`. The value needs a unit (`30s`, `5m`, `1h`, `2d`, `1w`). Time spent waiting for your input does not count. Zero or negative means no limit.

A tripped budget exits with code 3, distinct from `1` (crash) and `2` (usage error), so scripts can tell an overrun apart from a failure.

## The agent home directory

The agent keeps its state — `settings.json`, `policy.json`, and conversation history — in `~/.agency-agent`. You can point it at a different directory:

```
agency agent --agent-home /path/to/dir
```

or with the `AGENCY_AGENT_HOME` environment variable:

```
AGENCY_AGENT_HOME=/path/to/dir agency agent
```

The flag wins when both are set. An empty value is treated as unset. This is useful for keeping separate agent profiles (say, different policies or model settings per project), and for sandboxing: the test harness uses it to give every test its own throwaway agent home so runs never touch your real `~/.agency-agent`.
