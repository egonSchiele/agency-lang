# Benchmarking the agency agent on Terminal-Bench

How we run the agency coding agent against **Terminal-Bench 2.0**, what we've
tested, and the results so far. This is the working reference for the
benchmarking effort. The agent lives in `lib/agents/agency-agent/`.

Most of the machinery described here lives outside this repo, in
`~/bench-agency/`, so only the agent-side and CLI-side claims can be checked
against the source tree. Treat the harness numbers and adapter details as a
snapshot of one person's setup.

## TL;DR

- **Harness:** Harbor (`harbor` 0.17.1) driving **Terminal-Bench 2.0** (89 tasks:
  4 easy / 55 medium / 30 hard), graded on hidden tests against container
  filesystem state.
- **Backend:** Daytona (`--env daytona`). The adapter installs the agent
  **per trial** in one of two modes, so you can benchmark an *unpublished*
  version with no npm publish. The first is a **local tarball**
  (`AGENCY_TARBALL`), which packs your working tree including uncommitted
  changes. The second is a **git branch** (`AGENCY_BRANCH`), cloned and built in
  the container. See [Install modes](#install-modes).
- **Adapter:** `~/bench-agency/adapter.py` (`AgencyAgent`, a
  `harbor.BaseInstalledAgent`).
- **Best result so far (honest):** Claude **Sonnet 4.5 ≈ 0.38** on the full
  suite, which is *competitive with, not clearly above,* the Sonnet-4.5 cohort.
  **Opus 4.8 ≈ 0.60** from a single run, with no TB2.0 comparator. See
  [Results](#results).
- **Interactive per-task reliability map (artifact):**
  <https://claude.ai/code/artifact/312e9a3f-3854-4f37-b22f-cd8268a1d5ff>
  (local copies in `~/bench-agency/analysis/`).

## Setup

Everything runs from `~/bench-agency/` (a separate dir, not this repo).

- **Harbor + Daytona:** `uv tool install "harbor[daytona]"`; needs
  `DAYTONA_API_KEY`. Default backend is `--env docker`; we use `--env daytona`.
- **Task cache:** the 89 TB2.0 tasks are cached under `~/.cache/harbor/tasks/*/*/`
  (each has `instruction.md`, `task.toml` with `difficulty`/`timeout_sec`, and a
  hidden `tests/` dir).
- **The adapter** (`~/bench-agency/adapter.py`) — a `BaseInstalledAgent`:
  - `install()`: base images lack curl, so `apt-get install -y curl
    ca-certificates` → NodeSource setup_22 → then one of the two
    [install modes](#install-modes) below. The old `npm i -g agency-lang`
    registry install is gone, so every mode now benchmarks a specific
    unpublished build.
  - `run()`: forwards provider keys into the container, then runs one-shot. The
    container has no env of its own, so a missing key makes the agent exit with
    `No API key for provider '<p>'`.
    ```
    agency agent --agent code --policy approve-all --verbose --debug \
      --max-tool-call-rounds 100 --provider <p> --model <m> -p -- <instruction>
    ```
    - `--policy approve-all` approves EVERY interrupt with no scoping. The
      built-in describes itself as unsafe outside a disposable sandbox
      (`lib/runtime/builtinPolicies.ts`), and a benchmark container is exactly
      that. Never use it on a real machine; `with-writes` is the everyday
      choice.
    - `-p --`: the `--` terminator is REQUIRED. Without it, an instruction that
      starts with `-`, such as a markdown bullet, is parsed as a flag and the
      agent never runs (`unknown short flag`).
    - Output is redirected to `/logs/agent/agency.txt` in-container (survives a
      wall-clock SIGKILL); harbor copies `/logs/agent` to the host at
      finalization. `populate_context_post_run` distills the `⏺` tool-call lines
      into `commands.txt`.
  - `_KEYS` forwarded: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
    `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`.

## The command

Run from `~/bench-agency` with `PYTHONPATH=.` (so `-a adapter:AgencyAgent`
resolves):

```bash
cd ~/bench-agency && PYTHONPATH=. harbor run \
  -d terminal-bench@2.0 \
  -a adapter:AgencyAgent \
  -m <provider>/<model> \
  --env daytona \
  -k <trials-per-task> \
  -n <concurrency> \
  -r 2 --retry-include EnvironmentStartTimeoutError \
  [-i <task-name> ...]
```

- `-d terminal-bench@2.0` — dataset id.
- `-m provider/model` — e.g. `anthropic/claude-sonnet-4-5`, `openai/gpt-4.1`,
  `google/gemini-2.5-flash`. The adapter splits it into `--provider`/`--model`.
- `-k` = trials per task (default 1). **Leaderboard submission requires ≥5.**
- `-n` = concurrency. The Daytona ceiling was around 8 to 10, and `-n 10` has
  held clean.
- `-r 2 --retry-include EnvironmentStartTimeoutError` retries only on Daytona
  env-start flakiness, not on task failures.
- `-i <task>`, repeatable, runs a subset. **Omit for the full suite**, which a
  valid leaderboard submission requires.
- Long runs: use `screen`/`tmux` (not `nohup`) so you can reattach; pipe through
  `tee run.log` for a record.

Results land in `~/bench-agency/jobs/<timestamp>/result.json` plus per-trial
dirs `<task>__<id>/{agent/{agency.txt,commands.txt}, verifier/reward.txt,
result.json, exception.txt}`.

## Install modes

`install()` builds/installs the agent **per trial**, in one of two modes,
selected by env vars (no per-run edits to `adapter.py`). The point of both: test
a new agent version **without publishing to npm**. Tarball wins if both are set.

### 1. Local tarball — `AGENCY_TARBALL` (recommended for iterating)

Benchmarks your **local working tree**, including uncommitted changes. There is
no git push and no npm publish, and the container does no build, because the
tarball already carries the compiled `dist/` and the stdlib. On the host, build a
tarball and point the run at it:

```bash
cd packages/agency-lang && make clean && make && npm pack   # → agency-lang-<v>.tgz
AGENCY_TARBALL=/abs/path/to/agency-lang-0.8.0.tgz \
  PYTHONPATH=. harbor run -d terminal-bench@2.0 -a adapter:AgencyAgent \
  -m anthropic/claude-sonnet-4-5 --env daytona -k 1 -n 10 -i <task>
```

The adapter uploads the `.tgz` with `environment.upload_file` and `npm i -g`s
it. `npm pack` includes `dist/` and the agency-generated `stdlib/**/*.js` via the
`files` allowlist in `package.json`, even though both are gitignored. Iterate:
edit → `make && npm pack` → rerun.

### 2. Git branch — `AGENCY_BRANCH` (default `main`)

Builds from a **pushed branch** in the container: shallow clone → `pnpm install`
→ `make` → symlink the built bin. No local build is needed, but you pay a full
`pnpm install` and `make` **inside every trial container**, so it is much slower
than the tarball. Use it to test a branch on a machine that cannot build
locally.

```bash
AGENCY_BRANCH=my-feature-branch \
  PYTHONPATH=. harbor run -d terminal-bench@2.0 -a adapter:AgencyAgent \
  -m anthropic/claude-sonnet-4-5 --env daytona -k 1 -n 10
```

Two knobs are overridable. `AGENCY_REPO` defaults to the public
`github.com/egonSchiele/agency-lang.git`, so set it to use a fork.
`AGENCY_PNPM_VERSION` defaults to `10`, which reads the repo's v9 lockfile. Note
that `--branch` takes a branch or a tag, **not** a raw commit SHA.

Both modes end with `agency --version`, so a broken install fails the trial
loudly rather than silently running a stale binary.

### Reading results (gotchas)

- Overall mean: `result.json → stats.evals.*.metrics[0].mean`.
- Pass/fail buckets: `stats.evals.*.reward_stats.reward` = `{"1.0":[...],
  "0.0":[...]}` (trial ids).
- **Per-trial reward is at `verifier_result.rewards.reward`**, nested under
  `rewards`, NOT at `verifier_result.reward`.
- Harbor reports `cost_usd: null` for our adapter because we do not feed it
  usage. Check the provider dashboard for spend.
- **Credit-death detection:** a trial that failed on billing has `credit balance
  is too low` in its `agent/agency.txt`. Those trials are not data. Drop them
  before computing a mean, as in the 22-01-06 run below.

## Results

All Terminal-Bench **2.0**. Meaningful runs (jobs are in `~/bench-agency/jobs/`;
throwaway/smoke runs archived under `jobs/_archive/`).

| Job (`~/bench-agency/jobs/`) | Model | Tasks | k | Score | Notes |
|---|---|---|---|---|---|
| `2026-07-09__15-16-12` | Sonnet 5 | 21 | 1 | 0.619 | validated the maxTokens cap fix |
| `2026-07-09__17-20-13` | Sonnet 4.5 | 89 | 1 | **0.472** | clean full baseline (single draw → optimistic) |
| `2026-07-09__20-02-03` | Opus 4.8 | 89 | 1 | **0.596** | ceiling; no TB2.0 comparator |
| `2026-07-09__22-01-06` | Sonnet 4.5 | 89 | 5 | ~~0.222~~ | **INVALID — ran out of Anthropic credits mid-run**; salvaged over the 281 real trials → **~0.35** |

**Honest read (Sonnet 4.5):** best point estimate ≈ **0.38** (combining the clean
k1 with the k5 salvage; true value ~0.35–0.45). That is **competitive with, not
clearly above,** the Sonnet-4.5 cohort on the tbench.ai TB2.0 board:

| Harness (Sonnet 4.5, TB2.0) | Score |
|---|---|
| **Agency agent (us)** | **~0.38–0.47** (needs a clean `-k 5` to pin) |
| CAMEL-AI | 46.5% |
| Goose | 43.1% |
| Terminus 2 (reference) | 42.8% |
| OpenHands | 42.6% |
| Mini-SWE-Agent | 42.5% |
| Claude Code | 40.1% |

By difficulty (Sonnet 4.5, up to 6 real trials/task): easy 4/4, medium ~0.55,
hard ~0.27. **Opus 4.8** lifts medium and hard substantially (≈0.60 overall).

**Caveats that matter:**
- A single `-k 1` run has roughly ±5% standard error over 89 tasks, so the lead
  over the 42–46% cluster is within noise. A defensible mean and confidence
  interval needs a clean **`-k 5`** run, which is 445 trials.
- The Opus-4.8 harness field is on **TB2.1**, a different dataset, where Claude
  Code scores 78.9% and Terminus 2 scores 74.6%. Our TB2.0 0.596 is **not**
  comparable to those. Opus-4.8-on-TB2.1 is the run for a real Opus-level
  harness comparison.

### The reliability map

Per-task analysis of all 89 tasks (difficulty, Sonnet-4.5 flakiness across the
two full runs, Opus ceiling, failure pattern from reading transcripts, deflake
lever):

- **Interactive:** <https://claude.ai/code/artifact/312e9a3f-3854-4f37-b22f-cd8268a1d5ff>
- **Local:** `~/bench-agency/analysis/reliability-analysis.md` (markdown table),
  `reliability-map.html` (offline copy of the page), `task-data.json` (raw).

Classification over Sonnet 4.5 real trials: **19 consistent-pass, 31 flaky, 39
consistent-fail.** Of the failing tasks, about 46 look like model capability,
which is Opus territory, and about 24 are non-capability and addressable in the
harness. Two non-capability clusters dominate: **"wrote it but never ran or
verified it"** and **output-format / spec-adherence**. Those two motivated the
prompt guidance and the verification step below.

## Agent + adapter changes made for benchmarking

Agent (published to npm; committed on `main` unless noted):
- `maxTokens: 20000` per turn (`lib/agents/agency-agent/shared.agency`). Hard
  reasoning turns were exhausting the 4096 default on thinking and returning
  empty. 20000 sits under the SDK non-streaming 10-minute guard, which trips
  above 21333.
- The `approve-all` built-in policy, which auto-approves everything in the
  sandbox. It is defined in `lib/runtime/builtinPolicies.ts` and resolved by
  `builtinPolicy()`. It replaced the old `with-bash` policy.
- Drop LLM `null` args that have defaults. A model passing `cwd: null` was
  crashing `applyAgentCwd` and `path.resolve`. See the comment in
  `lib/runtime/prompt.ts`.
- Validate that a spawn `cwd` exists before running, so the user gets a clear
  error rather than `spawn sh ENOENT` (**PR #490**).
- Prompt hard rules #13 (the deliverable is a *run-and-verified* artifact) and
  #14 (an exact output contract), plus a one-shot note saying the output is
  graded automatically.
- A **verification step** with fresh eyes in the one-shot loop (**PR #497**).
  The reviewer subagents now live under
  `lib/agents/agency-agent/brains/coordinator/subagents/`, as `review.agency`
  and `supervisor.agency`. There is no `verify.agency`.

Adapter (`~/bench-agency/adapter.py`, local, not npm): `-p --` separator; key
forwarding for all providers; `--policy approve-all`; direct-to-file transcript;
tarball / git-branch [install modes](#install-modes) (replaced the
`npm i -g agency-lang` registry install).

## Known issues / gotchas

- **Providers:** Anthropic runs need credits. A `-k 5` run drained the balance,
  which is the 22-01-06 invalid run. Gemini tool-calling fails with `Tool call
  context circulation is not enabled for models/gemini-2.5-flash` (issue
  **#495**), so use OpenAI or Anthropic. Weak OpenAI models such as
  `gpt-4o-mini` cannot drive the tool loop and thrash.
- **Incremental build:** `make agents` can leave `dist` inconsistent. A stale
  skip means a missing export, the agent will not start, and it sometimes
  surfaces as a misleading `--provider undefined` error. Use `make clean &&
  make`. Issue **#498**.
- **`review()` mis-scope and narration:** on weaker models the agent narrates a
  shell script in its reply instead of running it. `review()` then mis-parses
  that shell as Agency code and reports false errors, which blocks the run
  before verification. The fix under discussion is to make `review()` typecheck
  only the `.agency` files the agent actually wrote.

## Leaderboard submission (tbench.ai)

The tbench.ai TB2.0 board is fed by a **HuggingFace PR**, not `harbor leaderboard
submit`:

1. Run the **full 89 tasks** with **`-k 5`**, meaning at least 5 trials per
   task, a timeout multiplier of 1.0, and no resource or timeout overrides. The
   adapter already complies.
2. Fork `huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard`.
3. Add `submissions/terminal-bench/2.0/<Agent>__<Model>/` with the job folders
   and a `metadata.yaml`, already drafted at `~/bench-agency/metadata.yaml`.
4. Open a PR; a bot validates trial hashes and the ≥5-trials rule.

## Next steps

1. A clean **`-k 5` Sonnet 4.5** run, with credits loaded and no overlapping
   runs, for a real mean with a confidence interval and a submittable job.
2. An **Opus 4.8 on TB2.1** scouting run for a fair Opus-level harness comparison.
3. Land the `review()` fix and re-test the deflake-target tasks.
