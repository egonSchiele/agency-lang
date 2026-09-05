# MLX tool-calling spike: results

Fill this in as you go. One row per attempt. The decision at the bottom is
what the follow-up spec (smoltalk-mlx plugin, catalog changes) builds on.

Machine: Mac Studio M5 Ultra, 256GB.
mlx-lm version: (paste `pip show mlx-lm | grep Version`)
Date:

## Server load

| Model | Server | Load time | Memory after load (Activity Monitor) | Notes |
|---|---|---|---|---|
| mlx-community/Qwen3-Coder-Next-4bit | mlx_lm.server | | | |

## Protocol check (curl-tools.sh)

| Server | tool_calls present? | Arguments correct (a=17, b=25)? | Notes |
|---|---|---|---|
| mlx_lm.server | | | |

## Spike 1: add.agency

| Server | "add called with 17 and 25" printed? | answer | Wall time | Notes |
|---|---|---|---|---|
| mlx_lm.server | | | | |

## Spike 2: two-tools.agency

| Server | Both tools called, in order? | answer (expect 64.4) | Wall time | Notes |
|---|---|---|---|---|
| mlx_lm.server | | | | |

## Spike 3: agency agent

| Server | Tools called? | Sensible answer? | Wall time | Notes |
|---|---|---|---|---|
| mlx_lm.server | | | | |

## Speed

| Model | Generation tokens/sec | Second-turn prompt cache hit? | Notes |
|---|---|---|---|
| Qwen3-Coder-Next-4bit | | | |

## Fallback: mlx-openai-server (only if something above failed)

| Check | Result | Notes |
|---|---|---|
| curl-tools.sh | | |
| add.agency | | |
| two-tools.agency | | |
| agency agent | | |

## Decision

- [ ] GO: tool calling works end to end on (server name). Build the plugin against it.
- [ ] NO-GO: (what failed, on both servers)

Anything surprising:
