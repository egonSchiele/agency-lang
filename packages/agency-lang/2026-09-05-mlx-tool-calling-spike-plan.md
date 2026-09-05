# MLX Tool-Calling Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to work through this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Most steps here are run by hand on the Mac Studio, because they need the models on its SSD and its 256GB of memory.

**Goal:** Prove, or disprove, that Agency can call tools through an MLX model served by a Python process, and record the speed.

**Architecture:** No code changes. A Python server (`mlx_lm.server`, or `mlx-openai-server` as fallback) holds the model in memory and speaks the OpenAI chat-completions API. Agency reaches it through smoltalk's existing `openai-compat` provider, selected with `--model openai-compat/<model>` and two env vars.

**Tech Stack:** mlx-lm (Python, pip), Agency CLI on branch `adit/mlx-spike`, curl.

**Spec:** `packages/agency-lang/2026-09-05-mlx-tool-calling-spike-spec.md` on the same branch. Read Part 1 of the spec first if any term below is unfamiliar.

## Global Constraints

- Machine: the Mac Studio (M5 Ultra, 256GB). The SSD with the models must be mounted at `/Volumes/Models`.
- Model for every check: `mlx-community/Qwen3-Coder-Next-4bit`. No larger model until every check passes.
- Server port: 8080 for `mlx_lm.server`, 8000 for `mlx-openai-server`.
- Python 3.11 or newer for the virtual environment. `mlx-openai-server` refuses older versions.
- Every command below that starts with `pnpm run agency` is run from `packages/agency-lang` inside the worktree.
- Never pass `--policy approve-all` to `agency agent`. Check 4 uses a scoped `--approve` instead.
- Write every result into `spikes/mlx-tool-calling/RESULTS.md` as soon as you have it. Do not keep results in your head across a model reload.

---

### Task 0: Get the branch onto the Studio

**Files:**
- None created. This task checks out the branch and builds Agency.

- [ ] **Step 1: Fetch the branch into its own worktree**

From the Studio's main agency-lang checkout:

```bash
cd ~/agency-lang
git fetch origin adit/mlx-spike
git worktree add worktree-mlx-spike adit/mlx-spike
cd worktree-mlx-spike
pnpm install
```

Expected: `pnpm install` finishes without errors. A `node_modules` directory exists under `packages/agency-lang`.

- [ ] **Step 2: Build**

```bash
cd ~/agency-lang/worktree-mlx-spike/packages/agency-lang
make
```

Expected: the build finishes and `dist/scripts/agency.js` exists.

- [ ] **Step 3: Confirm the spike files are there and parse**

```bash
ls spikes/mlx-tool-calling
pnpm run --silent ast spikes/mlx-tool-calling/add.agency > /dev/null && echo parses
```

Expected: five files listed (`start-server.sh`, `curl-tools.sh`, `add.agency`, `two-tools.agency`, `RESULTS.md`) and the word `parses`.

---

### Task 1: The Python environment and the models

**Files:**
- None in the repo. Creates `~/mlx-env` on the Studio.

- [ ] **Step 1: Check the Python version**

```bash
python3 --version
```

Expected: 3.11 or newer. If it is older, install a newer one first (Homebrew: `brew install python@3.12`) and use that binary in the next step instead of `python3`.

- [ ] **Step 2: Create the virtual environment and install mlx-lm**

```bash
python3 -m venv ~/mlx-env
~/mlx-env/bin/pip install --upgrade pip
~/mlx-env/bin/pip install mlx-lm
~/mlx-env/bin/pip show mlx-lm | grep Version
```

Expected: a version line. Paste it into the header of `RESULTS.md`.

- [ ] **Step 3: Confirm the SSD is mounted and the model is on it**

```bash
ls /Volumes/Models/hf/hub | grep -i Qwen3-Coder-Next
```

Expected: a directory named `models--mlx-community--Qwen3-Coder-Next-4bit`. If nothing is listed, the SSD is not mounted or the download did not finish. Run `~/check-repos.sh` to compare what is on disk against the Hugging Face API before going further.

- [ ] **Step 4: Find the snapshot directory, in case the server needs a plain path**

```bash
ls -d /Volumes/Models/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/*/
```

Expected: one directory. Keep this path. Task 2 uses it if the repo id does not resolve.

---

### Task 2: Check 0, the server loads the model

**Files:**
- Uses: `spikes/mlx-tool-calling/start-server.sh`
- Records into: `spikes/mlx-tool-calling/RESULTS.md`, "Server load" table

- [ ] **Step 1: Start the server in its own terminal and time the load**

```bash
cd ~/agency-lang/worktree-mlx-spike/packages/agency-lang
date
./spikes/mlx-tool-calling/start-server.sh
```

The script sets `HF_HOME=/Volumes/Models/hf` and `HF_HUB_OFFLINE=1`, so the server looks for the weights on the SSD and never tries to download. It passes `--max-tokens 16384`, because the server's default of 512 truncates every long reply and Agency does not set `max_tokens` itself.

Expected: log lines about loading the model, then a line saying the server is listening on `127.0.0.1:8080`. Note the time between `date` and that line.

- [ ] **Step 2: If the repo id does not resolve, pass the snapshot path instead**

Only if step 1 fails with a message about not finding the model:

```bash
./spikes/mlx-tool-calling/start-server.sh /Volumes/Models/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/<hash>
```

Use the directory from Task 1 step 4. If it now loads, note in `RESULTS.md` that the repo id did not resolve under `HF_HUB_OFFLINE`. That is a fact the plugin spec needs.

- [ ] **Step 3: If the server refuses the architecture**

If the failure mentions an unknown model type or a missing config key, add `--trust-remote-code` by editing the last block of `start-server.sh`, and try once more. If it still refuses, mlx-lm does not support this model yet. Record that and skip to Task 7 (the fallback server) for every remaining check.

- [ ] **Step 4: Record memory**

Open Activity Monitor, find the `python` process, and read its memory. Write load time and memory into the "Server load" table in `RESULTS.md`.

---

### Task 3: Check 1, raw protocol

**Files:**
- Uses: `spikes/mlx-tool-calling/curl-tools.sh`
- Records into: `RESULTS.md`, "Protocol check" table

- [ ] **Step 1: Send one request with a tools array**

In a second terminal, with the server still running:

```bash
cd ~/agency-lang/worktree-mlx-spike/packages/agency-lang
./spikes/mlx-tool-calling/curl-tools.sh
```

Expected: pretty-printed JSON. The pass condition is a `tool_calls` list inside `choices[0].message`, with one entry whose `function.name` is `add` and whose `function.arguments` is a JSON string containing `17` and `25`. It looks like this:

```json
"message": {
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "...",
      "type": "function",
      "function": {
        "name": "add",
        "arguments": "{\"a\": 17, \"b\": 25}"
      }
    }
  ]
}
```

A reply whose `content` is the text `42` and has no `tool_calls` is a fail. The model answered without using the tool. A reply whose `content` contains raw text like `<tool_call>{...}</tool_call>` is also a fail, and a more useful one: the model produced a tool call but the server did not parse it. Write which of the three happened into `RESULTS.md`.

- [ ] **Step 2: If it failed, retry once with a stronger instruction**

Edit the `content` string in `curl-tools.sh` to `Call the add tool with a=17 and b=25.` and run it again. If that passes and the original did not, record both. The plugin will not be able to rewrite prompts, so the original wording is what counts, but knowing the model can produce a call at all separates a parser problem from a model problem.

---

### Task 4: Check 2, one tool through Agency

**Files:**
- Uses: `spikes/mlx-tool-calling/add.agency`
- Records into: `RESULTS.md`, "Spike 1" table

- [ ] **Step 1: Run the program against the server**

```bash
cd ~/agency-lang/worktree-mlx-spike/packages/agency-lang
export OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_COMPAT_API_KEY=unused
time pnpm run agency run --model openai-compat/mlx-community/Qwen3-Coder-Next-4bit spikes/mlx-tool-calling/add.agency 2>&1 | tee /tmp/spike-add.log
```

The API key is required by smoltalk's `openai-compat` client and ignored by the server. Any non-empty string works.

Expected output, two lines in this order:

```
add called with 17 and 25
answer: 42
```

The first line is the pass condition. It is printed from inside `add`, so it can only appear if the tool was called. `answer: 42` on its own is a fail.

- [ ] **Step 2: If it failed, read the log for where it broke**

Look in `/tmp/spike-add.log` for one of these:

- `API key required` or `base URL required`: the env vars did not reach the process. Re-export them in the same shell and retry.
- A connection refused error: the server is not running or is on another port.
- An answer with no `add called` line: same as check 1 failing. Compare with the check 1 result. If check 1 passed and this fails, the difference is in how smoltalk sends the tool definition. Save the server's log lines for this request into `RESULTS.md`.

- [ ] **Step 3: Record wall time and result**

The `time` output gives wall time. Write it and the outcome into the "Spike 1" table.

---

### Task 5: Check 3, two tools chained

**Files:**
- Uses: `spikes/mlx-tool-calling/two-tools.agency`
- Records into: `RESULTS.md`, "Spike 2" table

- [ ] **Step 1: Run it**

Same shell as Task 4, so the env vars are still set:

```bash
time pnpm run agency run --model openai-compat/mlx-community/Qwen3-Coder-Next-4bit spikes/mlx-tool-calling/two-tools.agency 2>&1 | tee /tmp/spike-two.log
```

Expected output, three lines in this order:

```
getWeather called for Paris
convertToFahrenheit called with 18
answer: 64.4
```

Pass means both tool lines appear, in that order. The exact answer wording can vary; `64.4` somewhere in it is enough.

- [ ] **Step 2: Note partial results precisely**

If only `getWeather` was called and the model converted in its head, that is a partial pass worth recording as such: the model can chain, but stops early. If `convertToFahrenheit` was called with a wrong number, record the number. If `getWeather` was called with something other than `Paris`, the string argument did not survive, and that is the most important failure to write down.

---

### Task 6: Check 4, the agent

**Files:**
- None new.
- Records into: `RESULTS.md`, "Spike 3" table

- [ ] **Step 1: Run one agent turn that needs a read tool**

From `packages/agency-lang`, which has its own `CLAUDE.md` for the agent to read:

```bash
cd ~/agency-lang/worktree-mlx-spike/packages/agency-lang
export OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_COMPAT_API_KEY=unused
time pnpm run agency agent \
  --provider openai-compat \
  --model mlx-community/Qwen3-Coder-Next-4bit \
  --approve FileRead \
  --print "Read CLAUDE.md in the current directory and tell me in one sentence what the make command does." 2>&1 | tee /tmp/spike-agent.log
```

`--approve FileRead` approves the file-read capability set for this run only, so the agent can read the file without an interactive prompt. Run `pnpm run agency effects` if the name is rejected; it lists the set names the flag accepts.

Expected: the agent reads the file and answers with something close to "make builds everything". Pass means the log shows at least one tool call and the answer mentions building.

- [ ] **Step 2: Record and, on a fail, keep the server log**

If the agent looped, gave up, or produced malformed tool calls, copy the server's log lines for the run into `RESULTS.md`. The agent sends dozens of tools; this is where a weak parser shows up first.

---

### Task 7: Check 5, speed and caching

**Files:**
- None new.
- Records into: `RESULTS.md`, "Speed" table

- [ ] **Step 1: Time one long reply and compute tokens per second**

```bash
cat > /tmp/long.json <<'EOF'
{
  "model": "mlx-community/Qwen3-Coder-Next-4bit",
  "messages": [
    { "role": "system", "content": "You are a careful technical writer." },
    { "role": "user", "content": "Explain in about 400 words how a hash map handles collisions." }
  ],
  "temperature": 0,
  "max_tokens": 800
}
EOF
START=$(date +%s.%N)
curl -sS http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d @/tmp/long.json > /tmp/long-out.json
END=$(date +%s.%N)
python3 -c "
import json; u = json.load(open('/tmp/long-out.json'))['usage']
secs = $END - $START
print('completion tokens', u['completion_tokens'], 'seconds', round(secs, 1), 'tok/s', round(u['completion_tokens'] / secs, 1))
"
```

Expected: a line like `completion tokens 520 seconds 9.8 tok/s 53.1`. The tok/s number includes prompt processing time, so it is slightly low. Write it into the "Speed" table.

- [ ] **Step 2: Confirm the prompt cache hits on a second turn**

Send the same request again with one more user turn appended:

```bash
python3 - <<'EOF'
import json
req = json.load(open('/tmp/long.json'))
reply = json.load(open('/tmp/long-out.json'))['choices'][0]['message']['content']
req['messages'].append({'role': 'assistant', 'content': reply})
req['messages'].append({'role': 'user', 'content': 'Now summarize that in one sentence.'})
req['max_tokens'] = 100
json.dump(req, open('/tmp/turn2.json', 'w'))
EOF
curl -sS http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d @/tmp/turn2.json > /dev/null
```

Then look at the server terminal. The first request logged prompt-processing progress over the full prompt. If the cache hit, the second request's progress line covers only the new tokens, a few dozen, not the whole conversation. Write yes or no into the "Speed" table, with the two prompt lengths the log showed.

---

### Task 8: Fallback, only if a check failed

**Files:**
- None new.
- Records into: `RESULTS.md`, "Fallback" table

Skip this task entirely if checks 0 through 4 all passed.

- [ ] **Step 1: Stop `mlx_lm.server` and install the fallback**

Press ctrl-c in the server terminal, then:

```bash
~/mlx-env/bin/pip install mlx-openai-server
```

Expected: installs cleanly. If pip complains about the Python version, this needs 3.11 or newer; go back to Task 1 step 1.

- [ ] **Step 2: Launch it with the Qwen3-Coder parsers**

```bash
export HF_HOME=/Volumes/Models/hf
export HF_HUB_OFFLINE=1
~/mlx-env/bin/mlx-openai-server launch \
  --model-type lm \
  --model-path mlx-community/Qwen3-Coder-Next-4bit \
  --reasoning-parser qwen3_moe \
  --tool-call-parser qwen3_coder \
  --port 8000
```

This is the README's own example for this model. If the repo id does not resolve, pass the snapshot directory from Task 1 step 4 as `--model-path`.

- [ ] **Step 3: Repeat only the failed checks on port 8000**

```bash
PORT=8000 ./spikes/mlx-tool-calling/curl-tools.sh
export OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8000/v1
pnpm run agency run --model openai-compat/mlx-community/Qwen3-Coder-Next-4bit spikes/mlx-tool-calling/add.agency
pnpm run agency run --model openai-compat/mlx-community/Qwen3-Coder-Next-4bit spikes/mlx-tool-calling/two-tools.agency
```

And Task 6 step 1 with the base URL on port 8000. Same pass conditions as before. Fill in the "Fallback" table.

---

### Task 9: Record the decision and push

**Files:**
- Modify: `spikes/mlx-tool-calling/RESULTS.md`

- [ ] **Step 1: Tick GO or NO-GO**

At the bottom of `RESULTS.md`, tick one box and name the server it applies to. Under "Anything surprising", write anything that took more than one attempt, in one line each. Those lines become constraints in the plugin spec.

- [ ] **Step 2: Commit and push**

Write the commit message to a file first. A message with an apostrophe on the command line fails in this shell.

```bash
cd ~/agency-lang/worktree-mlx-spike
cat > /tmp/spike-commit.txt <<'EOF'
mlx spike: record tool-calling results on the Studio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
git add packages/agency-lang/spikes/mlx-tool-calling/RESULTS.md packages/agency-lang/spikes/mlx-tool-calling/start-server.sh packages/agency-lang/spikes/mlx-tool-calling/curl-tools.sh
git commit -F /tmp/spike-commit.txt
git push -u origin adit/mlx-spike
```

Expected: the push succeeds. The results are now on the branch for the next session, on either machine, to read.

---

## What happens after

On GO, the next document is a spec for the `smoltalk-mlx` package: an `openai-compat` subclass registered under the provider name `mlx`, with the server address from a config key or env var and a sensible default, plus the Agency-side changes to the catalog, `agency local list`, and `agency local download`. Every catalog entry gets a required `backend` field, and an entry without one is an error naming the file.

On NO-GO, the next document is a spec for a Python sidecar of our own that calls mlx-lm's generate API directly and parses tool calls itself.

Neither is started until `RESULTS.md` says which.
