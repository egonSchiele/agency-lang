# MLX tool-calling spike: results

Fill this in as you go. One row per attempt. The decision at the bottom is
what the follow-up spec (smoltalk-mlx plugin, catalog changes) builds on.

Machine: Mac Studio M1 Max, 64GB. (Not the M5 Ultra; that machine has not arrived. Speed numbers below are M1 Max numbers and need re-measuring on the Ultra.)
mlx-lm version: 0.31.3 (venv on Python 3.12; the default python3 is 3.10.9)
Date: 2026-09-06
Models SSD: /Volumes/adit-agency-models-sept-2026

## Server load

| Model | Server | Load time | Memory after load (Activity Monitor) | Notes |
|---|---|---|---|---|
| mlx-community/Qwen3-Coder-Next-4bit | mlx_lm.server | under 10 min, not measured exactly | 42.38GB, which matches the 41.8GB of weight files on disk | Server logs nothing while loading and prints no line when done, so the load could not be timed from the log. It was already serving 10 min after start. First completion request took 33s, the next 1.2s, the next 189ms. `ps` RSS stays around 3.2GB even when fully loaded, because MLX holds the weights in Metal buffers; read the memory from Activity Monitor instead. |

42.38GB of memory used.

## Protocol check (curl-tools.sh)

| Server | tool_calls present? | Arguments correct (a=17, b=25)? | Notes |
|---|---|---|---|
| mlx_lm.server | yes | yes | Passed on the first try, with the original prompt wording. `finish_reason` is `tool_calls`, so mlx-lm parsed the call itself and no fallback server is needed. Note that the message has no `content` key at all, where the OpenAI API sends `content: null`. |

Raw data:
```
{
    "id": "chatcmpl-843a15df-dded-431f-91bc-d1726adaad46",
    "system_fingerprint": "0.31.3-0.32.2-macOS-26.6.2-arm64-arm-64bit-applegpu_g13s",
    "object": "chat.completion",
    "model": "mlx-community/Qwen3-Coder-Next-4bit",
    "created": 1788751100,
    "choices": [
        {
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "name": "add",
                            "arguments": "{\"a\": 17, \"b\": 25}"
                        },
                        "type": "function",
                        "id": "cc218eed-1731-4843-84b1-dc8e4ea72051"
                    }
                ]
            }
        }
    ],
    "usage": {
        "prompt_tokens": 316,
        "completion_tokens": 31,
        "total_tokens": 347,
        "prompt_tokens_details": {
            "cached_tokens": 0
        }
    }
}
```

## Spike 1: add.agency

| Server | "add called with 17 and 25" printed? | answer | Wall time | Notes |
|---|---|---|---|---|
| mlx_lm.server | yes | 42 | 19.9s | Passed on the first try. The wall time covers compiling the Agency file and two round trips to the model: one to ask for the tool call, one to answer once the tool returned. |

## Spike 2: two-tools.agency

| Server | Both tools called, in order? | answer (expect 64.4) | Wall time | Notes |
|---|---|---|---|---|
| mlx_lm.server | yes, but with one extra call first | 64.4 | 8.2s | The string argument survived: `getWeather` got `Paris`. The model asked for both tools in round one, guessing `convertToFahrenheit(20)` before it had seen any weather. Round two, now holding "18 degrees celsius", it called `convertToFahrenheit(18)` and answered correctly. Confirmed by sending the same prompt straight to the server: round one comes back with two tool calls, `getWeather {"city": "Paris"}` and `convertToFahrenheit {"celsius": 20}`. |

## Spike 3: agency agent

| Server | Tools called? | Sensible answer? | Wall time | Notes |
|---|---|---|---|---|
| mlx_lm.server | yes, proved | yes | 16.6s (re-run); 73.8s (first attempt) | First attempt asked the agent to read `CLAUDE.md`, which the harness already loads into the system prompt. The answer was correct and mentioned the compiler, runtime, standard library and CLI, but it could have come from the prompt with no tool call. Re-run against `secret.txt`, which holds a random passphrase found nowhere else in the repository and cannot be in the model's training data. The agent returned `QX-WF875KHQ`, so a read tool definitely ran. The re-run was much faster than the first attempt, 16.6s against 73.8s, most likely because the server's prompt cache was warm by then. |

## Speed

| Model | Generation tokens/sec | Second-turn prompt cache hit? | Notes |
|---|---|---|---|
| Qwen3-Coder-Next-4bit | 36.5 | yes | 582 completion tokens in 15.9s, so 36.5 tok/s including prompt processing. On turn two the server reported 618 of 634 prompt tokens cached, and answered in 2.5s. The 16 uncached tokens are the new user message. Measured on the M1 Max; the M5 Ultra will be much faster. |

## Fallback: mlx-openai-server (only if something above failed)

Not needed. Every check passed on mlx_lm.server, so this was never installed.

| Check | Result | Notes |
|---|---|---|
| curl-tools.sh | not run | |
| add.agency | not run | |
| two-tools.agency | not run | |
| agency agent | not run | |

## Decision

- [x] GO: tool calling works end to end on mlx_lm.server 0.31.3. Build the plugin against it.
- [ ] NO-GO: (what failed, on both servers)

All five checks passed on the first server tried, with no prompt rewording and
no fallback. mlx-lm parses Qwen3-Coder's tool calls itself, string and number
arguments both survive the round trip, the model chains one tool into another,
and the full agent picks the right tool out of a large set. The prompt cache
works, which matters because an agent resends a long system prompt every turn.

Two things the plugin spec has to account for, both written up under "Anything
surprising": the model guesses arguments for tools it has not got inputs for
yet, and there is no `parallel_tool_calls` switch on either side to stop it.

Anything surprising:

- mlx_lm.server logs nothing while it loads a model, and prints no line when it
  finishes. The "listening" line comes up before any weight is read. Time the
  load with the first completion request instead.
- `ps` reports about 3.2GB for this server even when the model is fully loaded.
  Activity Monitor reports 42.38GB, which is the real figure.
- The model guesses arguments for a tool whose input it does not have yet. In
  spike 2 it asked for `getWeather("Paris")` and `convertToFahrenheit(20)` in
  the same round, then corrected to 18 once the weather came back. Here that is
  harmless, because converting a temperature changes nothing. A tool that
  writes a file or sends a message would have run for real on the guessed
  argument. This is a good argument for interrupts on this model: a user would
  see the bogus call and reject it.

  There is no switch to turn this off. `parallel_tool_calls` appears nowhere in
  mlx_lm.server 0.31.3, so the server would ignore it, and smoltalk's
  chat-completions client does not send it either. If the plugin wants one call
  per round, that has to be built.
- mlx_lm.server omits the `content` key from a tool-call reply. The OpenAI API
  sends `content: null` instead. smoltalk reads it at
  `packages/smoltalk/lib/clients/openai.ts:249` and copes, because `undefined`
  and `null` are both treated as empty downstream. Noted in smoltalk's TODO.md
  so the line gets a comment. If the plugin ever stops going through
  openai-compat, check this again.
