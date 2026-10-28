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

## Approval flags

The agent asks before doing anything its policy does not already
decide. Three flags shape that for a single session:

```
agency agent --policy with-writes
agency agent --approve FileRead --reject Shell
```

`--policy` picks the base policy (a built-in name or a policy-file
path); `--approve` and `--reject` overlay effects or effect-set
names on top of it. None of these change your saved `policy.json`. See
[the policy flags](/cli/policy#approving-and-rejecting-with-flags) for
the details and [`agency effects`](/cli/effects) for the names they
accept.

## Budget flags

- `agency agent --max-cost <dollars>` — abort if the agent's LLM spend exceeds this many dollars. `0` means no paid spend (local models only); negative means no limit.
- `agency agent --max-time <duration>` — abort if the agent's working time exceeds this duration, e.g. `30m`. The value needs a unit (`30s`, `5m`, `1h`, `2d`, `1w`). Time spent waiting for your input does not count. Zero or negative means no limit.

A tripped budget exits with code 3, distinct from `1` (crash) and `2` (usage error), so scripts can tell an overrun apart from a failure.

## Incognito sessions

`agency agent --incognito` starts a session that leaves no record of itself:

- no log: no `log.jsonl`, nothing on stdout, and nothing sent to a statelog server, whatever the agent was built with
- no saved session, so it does not show up in `--resume`
- no input history: your lines are not added to the history file, and up-arrow does not recall earlier sessions

Programs the agent runs from its shell inherit the setting, so they log nothing either.

Incognito only stops Agency's own records. Your messages still go to the model provider, and files the agent writes because you asked it to are still written.

You can only turn it on when the agent starts, not partway through a session. It cannot be combined with `--log`, `--trace`, `--continue`, or `--resume`. To make it your habit, use a shell alias:

```
alias agent-private='agency agent --incognito'
```

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
