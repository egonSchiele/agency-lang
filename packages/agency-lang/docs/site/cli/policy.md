---
title: Policies
description: Documents the `agency policy` CLI commands for generating and extending interrupt policy files from an Agency source file.
---

# Policies

*work in progress*

See the [policies guide](/guide/policies) for what policies are and how they're used at runtime. This page covers the CLI tools for managing them.

## Approving and rejecting with flags

`agency run`, `agency test`, and `agency agent` all take the same three
flags:

- `--policy <name|path>` — the base policy for the run: a built-in name
  (`minimal`, `recommended`, `with-writes`, `approve-all`) or a path to
  a policy JSON file.
- `--approve <effects>` — effects to auto-approve, ahead of the base
  policy's own rules.
- `--reject <effects>` — effects to auto-reject. A reject outranks an
  approve for the same effect.

`--approve` and `--reject` take a comma- or whitespace-separated list.
Each entry is an effect name (`std::write`), or the name of a built-in
capability set from [`std::capabilities`](/stdlib/capabilities), which
stands for every effect in the set:

```bash
agency agent --approve FileRead --reject Shell
agency run --policy recommended --approve std::write foo.agency
```

Run [`agency effects`](/cli/effects) to see the sets, the built-in
policies, and what each one means.

On the agent, the flags apply for that session only: they combine with
whatever policy the run resolved (your saved `policy.json`, a built-in,
or a `--policy` path) and are never written back to the saved policy
file.

## Generating a policy

```
agency policy gen foo.agency
```

Analyzes the Agency file and generates an interrupt policy for it. The generated policy lists the interrupts the agent can produce, with sensible defaults that you can then tweak by hand.

### Options

- `-o, --output <path>` — output path for the generated policy file. Defaults to `policy.json`.
- `-p, --existing <path>` — path to an existing policy file to extend. New interrupt kinds discovered in the file are merged in; existing rules are preserved.
