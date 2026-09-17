---
title: config
description: Documents the `agency config` command, which prints the configuration Agency will use after merging agency.json and agency.local.json.
---

# config

```bash
agency config show
```

`agency config show` prints the config Agency will use, as JSON. `agency config` with no subcommand does the same thing.

Without `-c`, it reads `agency.json` and `agency.local.json` from the current directory and prints the merged result. See [Local overrides](../guide/agency-config-file.md#local-overrides) for how the two files merge.

With `-c`, it prints the config from that one file:

```bash
agency -c team.json config show
```

The command writes the list of files it read to stderr, so you can pipe the JSON to another program:

```
Loaded: /home/me/proj/agency.json, /home/me/proj/agency.local.json
```

## Secrets

The command masks API keys and these MCP server fields: client secrets, header values, and environment variable values. Each masked value shows only its last four characters. To print them in full, pass `--show-secrets`:

```bash
agency config show --show-secrets
```

Avoid `--show-secrets` in logs or bug reports you share.
