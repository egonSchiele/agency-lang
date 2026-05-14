# Scheduling agents

You can schedule an Agency file to run on a recurring basis using `agency schedule`. This is useful for running an agent every morning, every hour, on weekdays only, and so on.

## Adding a schedule

```
agency schedule add foo.agency --every daily
agency schedule add foo.agency --cron "0 9 * * 1-5"
```

You can either pick a preset with `--every` or write your own cron expression with `--cron`. Exactly one of the two is required.

### Options

- `--every <preset>` — one of: `minute`, `hourly`, `daily`, `weekdays`, `weekends`, `weekly`, `monthly`.
- `--cron <expression>` — a standard 5-field cron expression.
- `--name <name>` — name for the schedule. Defaults to being derived from the filename.
- `--env-file <path>` — path to a `.env` file. Environment variables in this file are loaded into the agent's environment when it runs.

## Listing schedules

```
agency schedule list
agency schedule ls
```

## Removing a schedule

```
agency schedule remove my-agent
agency schedule rm my-agent
```

## Editing a schedule

```
agency schedule edit my-agent --every hourly
agency schedule edit my-agent --cron "0 * * * *"
```

Accepts the same `--every`, `--cron`, and `--env-file` options as `schedule add`.

## Testing the scheduler

```
agency schedule test
```

Schedules a small test agent that runs every minute. Use this to verify that cron is working on your machine.

## Run on GitHub Actions

To generate a GitHub Actions workflow for an agent:

```
agency schedule add agents/foo.agency \
  --backend github \
  --every hourly \
  --secret SLACK_WEBHOOK
```

This writes a `foo.yml` workflow file to the current directory. The command does not require git, does not look for the agent file on your filesystem, and does not assume you're inside the target repo. The agent path you pass on the command line is used verbatim as the workflow's `file:` value.

After the file is written, the next steps printed by the CLI are:

1. Move `foo.yml` into your repo at `.github/workflows/foo.yml`.
2. Open it and verify the `file:` line points to the agent's path **as it lives in your repo** (relative to the repo root). Edit it if needed.
3. In github.com → repo Settings → Secrets and variables → Actions, set `OPENAI_API_KEY` (required) and any extra `--secret`s you passed.
4. `git add` / `commit` / `push`.

You don't need to add agency-lang as a dependency to the repo — the workflow uses [`egonSchiele/run-agency-action`](https://github.com/egonSchiele/run-agency-action) which installs and runs agency-lang on the runner. agency-lang is only needed locally to *generate* the workflow file.

### GitHub-specific options

- `--secret NAME` (repeatable) wires a secret into the workflow's `env:` block.
- `--write` grants `contents: write` + `pull-requests: write` (e.g. for agents that open PRs).
- `--no-pin` emits `@<tag>` instead of `@<sha>` action references (less secure; default is SHA pins).
- `--force` overwrites an existing `<name>.yml` in the current directory.

### Notes

- GitHub Actions enforces a 5-minute minimum cron interval. `agency schedule add --backend github` refuses cadences shorter than that (`--every minute` and any `*/N` for N < 5) since GitHub will not honor them. Use `--every hourly`, `--every daily`, or `--cron "*/5 * * * *"` or longer.
- To remove a GitHub schedule, `git rm` the workflow file. GitHub schedules are not tracked by `agency schedule list` / `remove` — the workflow file in your repo is the source of truth.
