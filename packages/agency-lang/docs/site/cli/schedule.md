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

To run an agent on GitHub Actions instead of locally:

```
agency schedule add agents/foo.agency \
  --backend github \
  --every hourly \
  --secret SLACK_WEBHOOK
```

This generates `.github/workflows/foo.yml` in your repo. Commit and push it; the agent will run on GitHub's runners on the chosen cadence.

### GitHub-specific options

- `--secret NAME` (repeatable) wires a secret into the workflow's `env:` block.
- `--write` grants `contents: write` + `pull-requests: write` (e.g. for agents that open PRs).
- `--no-pin` emits `@<tag>` instead of `@<sha>` action references (less secure; default is SHA pins).
- `--force` overwrites an existing workflow file.

### Notes

- The agent file must live inside the git repo — it is referenced by relative path from the generated workflow.
- GitHub Actions enforces a 5-minute minimum cron interval. `agency schedule add --backend github` refuses cadences shorter than that (`--every minute` and any `*/N` for N < 5) since GitHub will not honor them. Use `--every hourly`, `--every daily`, or `--cron "*/5 * * * *"` or longer.
- To remove a GitHub schedule, `git rm` the workflow file. GitHub schedules are not tracked by `agency schedule list` / `remove` — the workflow file in your repo is the source of truth.
